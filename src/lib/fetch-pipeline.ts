/**
 * Fetch pipeline — orchestrates http-fetch + readability + cache writes.
 *
 * Sub-item 3 of web-fetcher v1 (ai-ops-meta architect-backlog.md L360).
 *
 * The RPC layer (sub-item 4) calls `fetchAndExtract` for each
 * `web.fetch.v1` envelope; this module composes the per-fetch flow:
 *   1. Refuse off-allowlist URLs up front (defence-in-depth — the search
 *      adapter already filtered, but `web.fetch.v1` callers can pass any
 *      URL).
 *   2. Plain HTTPS GET with size cap (`adapters/http-fetch`).
 *   3. Mozilla Readability extraction + captcha/paywall heuristics
 *      (`lib/readability`).
 *   4. SHA256 of the canonical plaintext (`node:crypto`).
 *   5. `cache.upsertFetchedPage` + `cache.recordProvenance({kind: 'fetch'})`.
 *
 * Returns a typed `FetchAndExtractOutcome` — the RPC handler surfaces
 * either the cached/fetched plaintext or a typed low-signal envelope.
 *
 * No LLM rendering happens here; the consumer wraps successful plaintext in
 * `renderUntrustedWebSegment` before placing it in a prompt.
 */

import { createHash } from 'node:crypto';

import type { WebFetcherCache } from '../cache.js';
import { httpGet, type FetchedDocument, type HttpFetchDeps } from '../adapters/http-fetch.js';
import { extractMainContent, type ReadabilityResult } from './readability.js';
import { Allowlist } from './allowlist.js';
import { ttlSecondsFor } from './web-config.js';

export type FetchOutcomeStatus = 'ok' | 'cache_hit' | 'low_signal' | 'off_allowlist';

export interface FetchSuccess {
  readonly status: 'ok' | 'cache_hit';
  readonly url: string;
  readonly origin: string;
  readonly title: string | null;
  readonly plaintext: string;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly fetchedAt: string;
}

export interface FetchLowSignal {
  readonly status: 'low_signal';
  readonly url: string;
  readonly origin: string;
  readonly reason: string;
}

export interface FetchOffAllowlist {
  readonly status: 'off_allowlist';
  readonly url: string;
}

export type FetchAndExtractOutcome = FetchSuccess | FetchLowSignal | FetchOffAllowlist;

export interface FetchAndExtractRequest {
  readonly url: string;
  readonly requestingAgentId: string;
  readonly taskId?: string | null;
  /**
   * Cache-bypass control. When true, skip the cache lookup and force a
   * fresh HTTP GET. The provenance row is still recorded so the post-filter
   * recognises the URL.
   */
  readonly bypassCache?: boolean;
}

export interface FetchPipelineDeps {
  readonly cache: WebFetcherCache;
  readonly allowlist: Allowlist;
  readonly httpFetchDeps: HttpFetchDeps;
  /** Inject a test clock for deterministic `fetched_at` values. */
  readonly nowMs?: () => number;
}

function nowIso(deps: FetchPipelineDeps): string {
  return new Date(deps.nowMs?.() ?? Date.now()).toISOString();
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function fetchAndExtract(
  req: FetchAndExtractRequest,
  deps: FetchPipelineDeps,
): Promise<FetchAndExtractOutcome> {
  const entry = deps.allowlist.lookup(req.url);
  if (!entry) {
    return { status: 'off_allowlist', url: req.url };
  }
  const ttlSeconds = ttlSecondsFor(entry.ttl_class);

  if (!req.bypassCache) {
    const cached = deps.cache.getFetchedPage({ url: req.url, maxAgeSeconds: ttlSeconds });
    if (cached) {
      deps.cache.recordProvenance({
        url: cached.url,
        origin: cached.origin,
        contentSha256: cached.contentSha256,
        fetchedAt: nowIso(deps),
        requestingAgentId: req.requestingAgentId,
        taskId: req.taskId ?? null,
        kind: 'fetch',
      });
      if (cached.lowSignal) {
        return { status: 'low_signal', url: cached.url, origin: cached.origin, reason: 'cached_low_signal' };
      }
      return {
        status: 'cache_hit',
        url: cached.url,
        origin: cached.origin,
        title: cached.title,
        plaintext: cached.plaintext,
        contentSha256: cached.contentSha256,
        byteSize: cached.byteSize,
        fetchedAt: cached.fetchedAt,
      };
    }
  }

  const doc: FetchedDocument = await httpGet(req.url, deps.httpFetchDeps);
  const fetchedAt = nowIso(deps);

  if (doc.lowSignal) {
    // Still record provenance for the URL so the post-filter knows we
    // attempted the fetch. The plaintext is empty; the LLM won't be able to
    // ground anything on it (the section emits `(external lookup
    // unavailable)`).
    deps.cache.upsertFetchedPage({
      url: doc.url,
      origin: doc.origin,
      contentSha256: sha256Hex(`__low_signal__:${doc.url}`),
      plaintext: '',
      title: null,
      fetchedAt,
      ttlSeconds,
      lowSignal: true,
      byteSize: doc.byteSize,
    });
    return {
      status: 'low_signal',
      url: doc.url,
      origin: doc.origin,
      reason: doc.reason ?? 'unknown_low_signal',
    };
  }

  const extracted: ReadabilityResult = extractMainContent(doc.bodyText, doc.url);
  if (extracted.lowSignal) {
    const sha = sha256Hex(`__low_signal__:${doc.url}`);
    deps.cache.upsertFetchedPage({
      url: doc.url,
      origin: doc.origin,
      contentSha256: sha,
      plaintext: '',
      title: extracted.title,
      fetchedAt,
      ttlSeconds,
      lowSignal: true,
      byteSize: doc.byteSize,
    });
    return {
      status: 'low_signal',
      url: doc.url,
      origin: doc.origin,
      reason: extracted.reason ?? 'unknown_low_signal',
    };
  }

  const contentSha256 = sha256Hex(extracted.plaintext);
  deps.cache.upsertFetchedPage({
    url: doc.url,
    origin: doc.origin,
    contentSha256,
    plaintext: extracted.plaintext,
    title: extracted.title,
    fetchedAt,
    ttlSeconds,
    lowSignal: false,
    byteSize: doc.byteSize,
  });
  deps.cache.recordProvenance({
    url: doc.url,
    origin: doc.origin,
    contentSha256,
    fetchedAt,
    requestingAgentId: req.requestingAgentId,
    taskId: req.taskId ?? null,
    kind: 'fetch',
  });

  return {
    status: 'ok',
    url: doc.url,
    origin: doc.origin,
    title: extracted.title,
    plaintext: extracted.plaintext,
    contentSha256,
    byteSize: doc.byteSize,
    fetchedAt,
  };
}
