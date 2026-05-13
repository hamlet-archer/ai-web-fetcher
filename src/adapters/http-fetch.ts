/**
 * Plain HTTPS GET fetcher for ai-web-fetcher.
 *
 * Sub-item 3 of web-fetcher v1 (ai-ops-meta architect-backlog.md L360).
 *
 * Streaming body reader with a hard byte cap — never buffers the whole
 * response if oversized. The body is read off the `Response.body`
 * `ReadableStream`; once `WEB_FETCH_MAX_BYTES` is exceeded the reader is
 * cancelled and the returned doc carries `lowSignal: true, reason:
 * 'over_size_cap'` per AP-1 (the LLM sees `(external lookup unavailable
 * for X)`, never partial captcha text).
 *
 * Why `fetch` rather than `node:https.get`: streaming with byte-bound
 * cancellation is straightforward through `ReadableStream.getReader()` +
 * `reader.cancel()`. The boot self-check already uses `fetch` for HEAD
 * probes; using the same primitive here keeps the stub surface in tests
 * identical (`deps.fetch`).
 *
 * Pure-of-side-effects against the cache: the wrapper in `lib/fetch-pipeline.ts`
 * is responsible for `cache.upsertFetchedPage` + `recordProvenance`. This
 * adapter just talks to the network.
 */

import { WEB_FETCH_MAX_BYTES, WEB_FETCH_TIMEOUT_MS } from '../lib/web-config.js';

export type LowSignalReason =
  | 'over_size_cap'
  | 'non_2xx'
  | 'timeout'
  | 'invalid_content_type'
  | 'transport_error';

export interface FetchedDocument {
  /** Post-redirect URL (matches `response.url` when present, else the requested URL). */
  readonly url: string;
  /** Origin of the post-redirect URL (`https://<host>`). */
  readonly origin: string;
  /** HTTP status code. `0` when no response (timeout or transport error). */
  readonly status: number;
  /** Verbatim `content-type` header value, lowercased; `null` when absent. */
  readonly contentType: string | null;
  /** Decoded UTF-8 body. Empty string when `lowSignal` is true. */
  readonly bodyText: string;
  /** Bytes read off the wire (capped by `WEB_FETCH_MAX_BYTES`). */
  readonly byteSize: number;
  /** Set when the doc is unusable for grounding. AP-1 enforces this is checked. */
  readonly lowSignal: boolean;
  /** Populated only when `lowSignal === true`. */
  readonly reason?: LowSignalReason;
}

export interface HttpFetchDeps {
  readonly fetch: typeof fetch;
  /** Inject a test clock so timeout tests don't have to wait the real timeout. */
  readonly nowMs?: () => number;
  /** Override the byte cap for tests; defaults to `WEB_FETCH_MAX_BYTES`. */
  readonly maxBytes?: number;
  /** Override the timeout for tests; defaults to `WEB_FETCH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

function originFor(url: string, fallback: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

export async function httpGet(url: string, deps: HttpFetchDeps): Promise<FetchedDocument> {
  const requestedOrigin = originFor(url, url);
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? WEB_FETCH_MAX_BYTES;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(timer);
    const isAbort = (e as Error)?.name === 'AbortError';
    return {
      url,
      origin: requestedOrigin,
      status: 0,
      contentType: null,
      bodyText: '',
      byteSize: 0,
      lowSignal: true,
      reason: isAbort ? 'timeout' : 'transport_error',
    };
  }

  const finalUrl = response.url || url;
  const origin = originFor(finalUrl, requestedOrigin);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? null;

  if (response.status < 200 || response.status >= 400) {
    clearTimeout(timer);
    return {
      url: finalUrl,
      origin,
      status: response.status,
      contentType,
      bodyText: '',
      byteSize: 0,
      lowSignal: true,
      reason: 'non_2xx',
    };
  }

  if (contentType && !contentType.startsWith('text/html') && !contentType.startsWith('application/xhtml')) {
    clearTimeout(timer);
    // Drain so the connection can be reused.
    await response.body?.cancel().catch(() => {});
    return {
      url: finalUrl,
      origin,
      status: response.status,
      contentType,
      bodyText: '',
      byteSize: 0,
      lowSignal: true,
      reason: 'invalid_content_type',
    };
  }

  if (!response.body) {
    clearTimeout(timer);
    return {
      url: finalUrl,
      origin,
      status: response.status,
      contentType,
      bodyText: '',
      byteSize: 0,
      lowSignal: true,
      reason: 'transport_error',
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        clearTimeout(timer);
        return {
          url: finalUrl,
          origin,
          status: response.status,
          contentType,
          bodyText: '',
          byteSize: total,
          lowSignal: true,
          reason: 'over_size_cap',
        };
      }
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    clearTimeout(timer);
    const isAbort = (e as Error)?.name === 'AbortError';
    return {
      url: finalUrl,
      origin,
      status: response.status,
      contentType,
      bodyText: '',
      byteSize: total,
      lowSignal: true,
      reason: isAbort ? 'timeout' : 'transport_error',
    };
  }
  clearTimeout(timer);

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(combined);

  return {
    url: finalUrl,
    origin,
    status: response.status,
    contentType,
    bodyText,
    byteSize: total,
    lowSignal: false,
  };
}
