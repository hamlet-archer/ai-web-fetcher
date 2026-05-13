/**
 * Integration tests for the Unix-socket RPC server (sub-item 4a).
 *
 * Spins up a real `net.createServer` on a temp socket path and exercises
 * full request/response round-trips with stubbed handler deps. Verifies
 * the five acceptance scenarios from the backlog row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { WebFetcherCache } from '../cache.js';
import { Allowlist, type AllowlistEntry } from '../lib/allowlist.js';
import { buildContractValidator } from '../contracts.js';
import { startRpcServer, type RunningRpcServer } from '../rpc-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(here, '..', '..', 'contracts');

const ARTICLE_HTML = `<!doctype html>
<html><head><title>Fixture Page</title></head>
<body><article><h1>Fixture</h1><p>${'lorem ipsum '.repeat(60)}</p></article></body></html>`;

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function localAllowlist(): Allowlist {
  const entries: AllowlistEntry[] = [
    { domain: '127.0.0.1', purpose: 'rpc-test', ttl_class: 'generic', added_at: '2026-05-13' },
  ];
  return new Allowlist(entries);
}

function makeFakeFetch(opts: {
  searchResults?: ReadonlyArray<{ title: string; url: string; description: string }>;
  pageHtml?: string;
  pageStatus?: number;
  searchStatus?: number;
}): typeof fetch {
  return (async (urlInput: string | URL | Request) => {
    const url = String(urlInput);
    if (url.includes('api.search.brave.com')) {
      const status = opts.searchStatus ?? 200;
      const body = { web: { results: opts.searchResults ?? [] } };
      return new Response(JSON.stringify(body), { status });
    }
    // page fetch
    const status = opts.pageStatus ?? 200;
    return new Response(opts.pageHtml ?? ARTICLE_HTML, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
}

interface Harness {
  readonly running: RunningRpcServer;
  readonly socketPath: string;
  readonly tmpDir: string;
  readonly cache: WebFetcherCache;
}

async function makeHarness(overrides?: {
  fetch?: typeof fetch;
}): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'web-fetcher-rpc-'));
  const socketPath = join(tmpDir, 'query.sock');
  const cache = new WebFetcherCache(join(tmpDir, 'cache.db'));
  const allowlist = localAllowlist();
  const validator = buildContractValidator(CONTRACTS_DIR);
  const fakeFetch =
    overrides?.fetch ??
    makeFakeFetch({
      searchResults: [
        { title: 'Allowlisted', url: 'http://127.0.0.1:9/x', description: 'snippet' },
        { title: 'Off allowlist', url: 'https://random.example/y', description: 'snippet' },
      ],
    });
  const running = await startRpcServer({
    socketPath,
    cache,
    allowlist,
    validator,
    braveApiKey: 'test-key',
    fetch: fakeFetch,
    httpFetchDeps: { fetch: fakeFetch },
    logger: silentLogger(),
  });
  return { running, socketPath, tmpDir, cache };
}

async function teardown(h: Harness): Promise<void> {
  await h.running.close();
  h.cache.close();
  rmSync(h.tmpDir, { recursive: true, force: true });
}

async function roundTrip(socketPath: string, request: unknown): Promise<unknown> {
  return await new Promise((resolveFn, rejectFn) => {
    const sock: Socket = createConnection({ path: socketPath });
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        sock.end();
        try {
          resolveFn(JSON.parse(line));
        } catch (e) {
          rejectFn(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    sock.on('error', rejectFn);
    sock.write(JSON.stringify(request) + '\n');
  });
}

describe('rpc-server', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await teardown(harness);
  });

  it('chmods the socket to 0600 on listen', () => {
    const stats = statSync(harness.socketPath);
    // mode includes file-type bits; mask to permission bits.
    expect((stats.mode & 0o777).toString(8)).toBe('600');
  });

  it('dispatches a valid web.search.v1 envelope and returns allowlist-filtered results', async () => {
    const response = (await roundTrip(harness.socketPath, {
      contract_id: 'web.search.v1',
      trace_id: '01234567-89ab-7cde-8f01-23456789abcd',
      dedupe_key: 'sha256:abc',
      source_ref: 'task:1',
      caller_agent_id: 'chief-of-staff',
      query: 'fixture query',
      top_n: 5,
    })) as { ok: boolean; results: Array<{ url: string }> };
    expect(response.ok).toBe(true);
    expect(response.results).toBeDefined();
    // Off-allowlist row was filtered out by the brave-search adapter.
    expect(response.results.every((r) => r.url.startsWith('http://127.0.0.1'))).toBe(true);
  });

  it('dispatches a valid web.fetch.v1 envelope and returns extracted plaintext', async () => {
    // Note: this exercises the cache path — fetch goes through fetch-pipeline
    // which honours the allowlist. 127.0.0.1 is allowlisted in the test
    // fixture and the fakeFetch returns ARTICLE_HTML.
    const response = (await roundTrip(harness.socketPath, {
      contract_id: 'web.fetch.v1',
      trace_id: '01234567-89ab-7cde-8f01-23456789abcd',
      dedupe_key: 'sha256:fedcba',
      source_ref: 'task:2',
      caller_agent_id: 'chief-of-staff',
      url: 'http://127.0.0.1:9/article',
    })) as { ok: boolean; plaintext?: string; status?: string };
    expect(response.ok).toBe(true);
    expect(response.status).toBe('ok');
    expect(response.plaintext).toContain('lorem ipsum');
  });

  it('returns validation_failed for an unknown contract_id', async () => {
    const response = (await roundTrip(harness.socketPath, {
      contract_id: 'web.unknown.v999',
      trace_id: 'x',
    })) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('validation_failed');
  });

  it('returns bad_query for invalid JSON', async () => {
    const response = await new Promise<unknown>((resolveFn, rejectFn) => {
      const sock: Socket = createConnection({ path: harness.socketPath });
      let buffer = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl !== -1) {
          sock.end();
          try {
            resolveFn(JSON.parse(buffer.slice(0, nl)));
          } catch (e) {
            rejectFn(e);
          }
        }
      });
      sock.on('error', rejectFn);
      sock.write('not-json\n');
    });
    expect(response).toMatchObject({ ok: false, code: 'bad_query' });
  });

  it('enforces per-task budget — 6th request for the same source_ref returns budget_exhausted', async () => {
    const base = {
      contract_id: 'web.search.v1' as const,
      trace_id: '01234567-89ab-7cde-8f01-23456789abcd',
      source_ref: 'task:budget-test',
      caller_agent_id: 'chief-of-staff',
      query: 'fixture',
      top_n: 1,
    };
    // First 5 should pass (WEB_OPS_PER_TASK = 5).
    for (let i = 0; i < 5; i++) {
      const ok = (await roundTrip(harness.socketPath, {
        ...base,
        dedupe_key: `sha256:b${i}`,
      })) as { ok: boolean };
      expect(ok.ok).toBe(true);
    }
    // 6th should fail with budget_exhausted.
    const denied = (await roundTrip(harness.socketPath, {
      ...base,
      dedupe_key: 'sha256:b6',
    })) as { ok: boolean; code: string };
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('budget_exhausted');
  });

  it('survives a handler exception — server stays up for a subsequent valid envelope', async () => {
    // Force the brave-search adapter to throw by returning a non-Response
    // object — the adapter's response.ok check will throw a TypeError, the
    // RPC server's try/catch returns a handler_error envelope.
    const blowupFetch = (async () => {
      throw new Error('synthetic upstream blowup');
    }) as unknown as typeof fetch;
    await teardown(harness);
    harness = await makeHarness({ fetch: blowupFetch });

    const first = (await roundTrip(harness.socketPath, {
      contract_id: 'web.search.v1',
      trace_id: '01234567-89ab-7cde-8f01-23456789abcd',
      dedupe_key: 'sha256:fail',
      source_ref: 'task:1',
      caller_agent_id: 'chief-of-staff',
      query: 'will-blow-up',
    })) as { ok: boolean; code?: string };
    expect(first.ok).toBe(false);
    // brave-search wraps the upstream error in BraveSearchError → handler
    // returns upstream_error rather than letting it bubble to the AP-2
    // catch. Either is a valid not-crashed signal — assert the server is
    // still up by issuing another envelope that should succeed against the
    // search code path (it will also return upstream_error, but the server
    // must still respond).
    const second = (await roundTrip(harness.socketPath, {
      contract_id: 'web.search.v1',
      trace_id: '01234567-89ab-7cde-8f01-23456789abce',
      dedupe_key: 'sha256:fail2',
      source_ref: 'task:1',
      caller_agent_id: 'chief-of-staff',
      query: 'will-also-blow',
    })) as { ok: boolean };
    expect(second).toBeDefined();
    expect(second.ok).toBe(false);
  });
});
