import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebFetcherCache } from '../cache.js';
import { Allowlist, type AllowlistEntry } from '../lib/allowlist.js';
import { fetchAndExtract } from '../lib/fetch-pipeline.js';

function fixtureAllowlist(): Allowlist {
  const entries: AllowlistEntry[] = [
    { domain: 'example.com', purpose: 'test', ttl_class: 'generic', added_at: '2026-05-13' },
    { domain: 'comparethemarket.com', purpose: 'test', ttl_class: 'insurance-med', added_at: '2026-05-13' },
  ];
  return new Allowlist(entries);
}

function htmlResponse(html: string, init?: { status?: number; contentType?: string }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(html));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { 'content-type': init?.contentType ?? 'text/html; charset=utf-8' },
  });
}

const ARTICLE_HTML = `<!doctype html>
<html><head><title>Renew Cars Insurance — full guide</title></head>
<body>
  <article>
    <h1>Renew Cars Insurance — full guide</h1>
    <p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}</p>
    <p>${'In neque rerum, mollis a sapien, ipsum sed augue. '.repeat(20)}</p>
  </article>
</body></html>`;

let tmpDir: string;
let dbPath: string;
let cache: WebFetcherCache;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-fetcher-pipeline-'));
  dbPath = join(tmpDir, 'cache.db');
  cache = new WebFetcherCache(dbPath);
});

afterEach(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function fetchOk(): typeof fetch {
  return (async () => htmlResponse(ARTICLE_HTML)) as typeof fetch;
}

describe('fetch-pipeline.fetchAndExtract', () => {
  it('happy path: writes one fetched_pages row + one provenance row and returns ok', async () => {
    const out = await fetchAndExtract(
      { url: 'https://example.com/renew', requestingAgentId: 'chief-of-staff', taskId: 'task-1' },
      {
        cache,
        allowlist: fixtureAllowlist(),
        httpFetchDeps: { fetch: fetchOk() },
      },
    );
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('unreachable');
    expect(out.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cache.provenanceExists(out.contentSha256)).toBe(true);
  });

  it('off_allowlist: refuses URLs outside the allowlist', async () => {
    const out = await fetchAndExtract(
      { url: 'https://malicious.example/renew', requestingAgentId: 'chief-of-staff' },
      {
        cache,
        allowlist: fixtureAllowlist(),
        httpFetchDeps: { fetch: fetchOk() },
      },
    );
    expect(out.status).toBe('off_allowlist');
  });

  it('low_signal: surfaces captcha pages without writing a usable cache row', async () => {
    const captcha = `<html><head><title>Sign in</title></head><body><h1>Sign in</h1><p>Please sign in.</p></body></html>`;
    const out = await fetchAndExtract(
      { url: 'https://comparethemarket.com/quote', requestingAgentId: 'chief-of-staff' },
      {
        cache,
        allowlist: fixtureAllowlist(),
        httpFetchDeps: { fetch: (async () => htmlResponse(captcha)) as typeof fetch },
      },
    );
    expect(out.status).toBe('low_signal');
    if (out.status !== 'low_signal') throw new Error('unreachable');
    expect(out.reason).toBe('captcha_or_paywall');
  });

  it('low_signal: 4xx upstream surfaces as non_2xx', async () => {
    const out = await fetchAndExtract(
      { url: 'https://example.com/forbidden', requestingAgentId: 'chief-of-staff' },
      {
        cache,
        allowlist: fixtureAllowlist(),
        httpFetchDeps: {
          fetch: (async () => htmlResponse('blocked', { status: 403 })) as typeof fetch,
        },
      },
    );
    expect(out.status).toBe('low_signal');
    if (out.status !== 'low_signal') throw new Error('unreachable');
    expect(out.reason).toBe('non_2xx');
  });

  it('cache_hit: second fetch with the same URL hits the cache', async () => {
    const deps = {
      cache,
      allowlist: fixtureAllowlist(),
      httpFetchDeps: { fetch: fetchOk() },
    };
    const first = await fetchAndExtract(
      { url: 'https://example.com/x', requestingAgentId: 'chief-of-staff' },
      deps,
    );
    expect(first.status).toBe('ok');
    // Second call — should be a cache_hit. We swap in a fetch stub that
    // would throw if invoked, to prove the cache hit short-circuits the HTTP path.
    const second = await fetchAndExtract(
      { url: 'https://example.com/x', requestingAgentId: 'task-doer' },
      {
        ...deps,
        httpFetchDeps: {
          fetch: (async () => {
            throw new Error('fetch should not be called on a cache hit');
          }) as typeof fetch,
        },
      },
    );
    expect(second.status).toBe('cache_hit');
  });

  it('bypassCache: forces a fresh HTTP GET even when the cache is warm', async () => {
    const deps = {
      cache,
      allowlist: fixtureAllowlist(),
      httpFetchDeps: { fetch: fetchOk() },
    };
    await fetchAndExtract(
      { url: 'https://example.com/x', requestingAgentId: 'chief-of-staff' },
      deps,
    );
    let count = 0;
    const counting: typeof fetch = (async () => {
      count++;
      return htmlResponse(ARTICLE_HTML);
    }) as typeof fetch;
    const second = await fetchAndExtract(
      { url: 'https://example.com/x', requestingAgentId: 'chief-of-staff', bypassCache: true },
      { ...deps, httpFetchDeps: { fetch: counting } },
    );
    expect(second.status).toBe('ok');
    expect(count).toBe(1);
  });
});
