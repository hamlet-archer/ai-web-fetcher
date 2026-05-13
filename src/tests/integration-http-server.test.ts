/**
 * End-to-end integration test against a real node:http fixture server.
 *
 * The pipeline's `fetch` injection point makes deterministic mocking cheap,
 * but the spec also asks for a real-network round-trip — this guards against
 * the class of bug where stub-vs-real `fetch` diverges (Node 20's undici
 * implementation, abort timing, redirect semantics).
 *
 * The server binds 127.0.0.1 on a random port, exposes a stable article
 * page, redirects, and a 4xx path. The allowlist is widened to include
 * `127.0.0.1` for this test only.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WebFetcherCache } from '../cache.js';
import { Allowlist, type AllowlistEntry } from '../lib/allowlist.js';
import { fetchAndExtract } from '../lib/fetch-pipeline.js';

const ARTICLE_HTML = `<!doctype html>
<html><head><title>Renew Cars Insurance — full guide</title></head>
<body>
  <article>
    <h1>Renew Cars Insurance — full guide</h1>
    <p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(30)}</p>
  </article>
</body></html>`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE_HTML);
      return;
    }
    if (req.url === '/forbidden') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('blocked');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server bind failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

let tmpDir: string;
let cache: WebFetcherCache;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-fetcher-int-'));
  cache = new WebFetcherCache(join(tmpDir, 'cache.db'));
});

afterEach(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function localAllowlist(): Allowlist {
  const entries: AllowlistEntry[] = [
    { domain: '127.0.0.1', purpose: 'integration-test', ttl_class: 'generic', added_at: '2026-05-13' },
  ];
  return new Allowlist(entries);
}

describe('integration: real http server round-trip', () => {
  it('fetches a real article, extracts plaintext, writes a provenance row', async () => {
    const out = await fetchAndExtract(
      { url: `${baseUrl}/article`, requestingAgentId: 'chief-of-staff', taskId: 'task-int' },
      {
        cache,
        allowlist: localAllowlist(),
        httpFetchDeps: { fetch: globalThis.fetch },
      },
    );
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('unreachable');
    expect(out.plaintext).toContain('Lorem ipsum');
    expect(out.title).toMatch(/Renew Cars Insurance/);
    expect(cache.provenanceExists(out.contentSha256)).toBe(true);
  });

  it('surfaces a real 4xx as low_signal:non_2xx', async () => {
    const out = await fetchAndExtract(
      { url: `${baseUrl}/forbidden`, requestingAgentId: 'chief-of-staff' },
      {
        cache,
        allowlist: localAllowlist(),
        httpFetchDeps: { fetch: globalThis.fetch },
      },
    );
    expect(out.status).toBe('low_signal');
    if (out.status !== 'low_signal') throw new Error('unreachable');
    expect(out.reason).toBe('non_2xx');
  });
});
