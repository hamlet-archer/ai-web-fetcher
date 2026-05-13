import { describe, expect, it } from 'vitest';

import { httpGet } from '../adapters/http-fetch.js';

function bodyStream(chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(next);
      }
    },
  });
}

function htmlResponse(html: string, init?: { status?: number; contentType?: string; url?: string }): Response {
  const encoder = new TextEncoder();
  const status = init?.status ?? 200;
  const contentType = init?.contentType ?? 'text/html; charset=utf-8';
  const url = init?.url;
  const stream = bodyStream([encoder.encode(html)]);
  return new Response(stream, {
    status,
    headers: { 'content-type': contentType },
    ...(url ? {} : {}),
  });
}

function staticResponse(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

describe('http-fetch.httpGet', () => {
  it('returns the decoded body on a 200 HTML response', async () => {
    const out = await httpGet('https://example.com/x', {
      fetch: staticResponse(htmlResponse('<html><body>hello</body></html>')),
    });
    expect(out.lowSignal).toBe(false);
    expect(out.status).toBe(200);
    expect(out.bodyText).toContain('hello');
    expect(out.contentType).toContain('text/html');
    expect(out.byteSize).toBeGreaterThan(0);
  });

  it('flags lowSignal on a 4xx response', async () => {
    const out = await httpGet('https://example.com/x', {
      fetch: staticResponse(htmlResponse('blocked', { status: 403 })),
    });
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('non_2xx');
    expect(out.status).toBe(403);
  });

  it('flags lowSignal on non-HTML content-type', async () => {
    const out = await httpGet('https://example.com/x.pdf', {
      fetch: staticResponse(
        new Response('binary', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      ),
    });
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('invalid_content_type');
  });

  it('aborts and flags over_size_cap when the response exceeds the byte cap', async () => {
    // Body composed of many 1 KB chunks; cap at 4 KB → we hit cap on the 5th chunk.
    const chunk = new Uint8Array(1024).fill(65 /* 'A' */);
    const chunks: Uint8Array[] = [chunk, chunk, chunk, chunk, chunk, chunk];
    const stream = bodyStream(chunks);
    const response = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const out = await httpGet('https://example.com/big', {
      fetch: staticResponse(response),
      maxBytes: 4 * 1024,
    });
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('over_size_cap');
    expect(out.byteSize).toBeGreaterThan(4 * 1024);
  });

  it('returns transport_error when fetch throws', async () => {
    const erroringFetch: typeof fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const out = await httpGet('https://example.com/x', { fetch: erroringFetch });
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('transport_error');
    expect(out.status).toBe(0);
  });

  it('returns timeout when the abort signal fires', async () => {
    const abortFetch: typeof fetch = (async (_url, init) => {
      // Throw AbortError synchronously, mimicking fetch's behaviour when the signal aborts.
      const err = new Error('aborted');
      err.name = 'AbortError';
      // Honour the input signal if present.
      void init?.signal;
      throw err;
    }) as typeof fetch;
    const out = await httpGet('https://example.com/slow', { fetch: abortFetch, timeoutMs: 1 });
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('timeout');
  });
});
