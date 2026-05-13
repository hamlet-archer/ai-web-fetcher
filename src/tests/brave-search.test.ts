import { describe, expect, it } from 'vitest';

import { BraveSearchError, search } from '../adapters/brave-search.js';
import { Allowlist, type AllowlistEntry } from '../lib/allowlist.js';

function fixtureAllowlist(domains: ReadonlyArray<string>): Allowlist {
  const entries: AllowlistEntry[] = domains.map((domain) => ({
    domain,
    purpose: 'test',
    ttl_class: 'generic',
    added_at: '2026-05-13',
  }));
  return new Allowlist(entries);
}

function jsonFetch(body: unknown, init?: { status?: number; ok?: boolean }): typeof fetch {
  return (async () => {
    const status = init?.status ?? 200;
    const ok = init?.ok ?? status < 400;
    return {
      ok,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() {
        return body;
      },
    } as unknown as Response;
  }) as typeof fetch;
}

describe('brave-search.search', () => {
  it('returns allowlist-filtered results on the happy path', async () => {
    const allowlist = fixtureAllowlist(['example.com', 'gov.uk']);
    const payload = {
      web: {
        results: [
          { title: 'Example article', url: 'https://example.com/x', description: 'snip1' },
          { title: 'Gov page', url: 'https://www.gov.uk/y', description: 'snip2' },
        ],
      },
    };
    const out = await search(
      { query: 'test query', count: 5 },
      { fetch: jsonFetch(payload), apiKey: 'test-key', allowlist },
    );
    expect(out.results).toEqual([
      { title: 'Example article', url: 'https://example.com/x', snippet: 'snip1' },
      { title: 'Gov page', url: 'https://www.gov.uk/y', snippet: 'snip2' },
    ]);
  });

  it('drops results whose URL is outside the allowlist', async () => {
    const allowlist = fixtureAllowlist(['example.com']);
    const payload = {
      web: {
        results: [
          { title: 'Inside', url: 'https://example.com/x', description: 'snip1' },
          { title: 'Outside', url: 'https://malicious.example/y', description: 'snip2' },
        ],
      },
    };
    const out = await search(
      { query: 'q' },
      { fetch: jsonFetch(payload), apiKey: 'test-key', allowlist },
    );
    expect(out.results.map((r) => r.url)).toEqual(['https://example.com/x']);
  });

  it('drops malformed Brave result entries', async () => {
    const allowlist = fixtureAllowlist(['example.com']);
    const payload = {
      web: {
        results: [
          { title: 'ok', url: 'https://example.com/x', description: 'snip' },
          { title: 'no-url' }, // malformed
          { url: 'https://example.com/y', description: 'snip2' }, // no title
        ],
      },
    };
    const out = await search(
      { query: 'q' },
      { fetch: jsonFetch(payload), apiKey: 'test-key', allowlist },
    );
    expect(out.results.length).toBe(1);
    expect(out.results[0]?.url).toBe('https://example.com/x');
  });

  it('throws BraveSearchError on non-2xx HTTP', async () => {
    const allowlist = fixtureAllowlist(['example.com']);
    await expect(
      search(
        { query: 'q' },
        {
          fetch: jsonFetch({ error: 'unauthorized' }, { status: 401, ok: false }),
          apiKey: 'bad-key',
          allowlist,
        },
      ),
    ).rejects.toBeInstanceOf(BraveSearchError);
  });

  it('passes the query + count through as URL params and the API key as header', async () => {
    const allowlist = fixtureAllowlist(['example.com']);
    let capturedUrl: string | null = null;
    let capturedHeaders: HeadersInit | undefined;
    const spyFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return { web: { results: [] } };
        },
      } as unknown as Response;
    }) as typeof fetch;
    await search(
      { query: 'renew car insurance', count: 3 },
      { fetch: spyFetch, apiKey: 'live-key', allowlist },
    );
    expect(capturedUrl).not.toBeNull();
    const u = new URL(capturedUrl!);
    expect(u.searchParams.get('q')).toBe('renew car insurance');
    expect(u.searchParams.get('count')).toBe('3');
    const hdrs = new Headers(capturedHeaders);
    expect(hdrs.get('x-subscription-token')).toBe('live-key');
  });
});
