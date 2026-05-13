/**
 * Handler for `web.search.v1` — runs a Brave Search query, filtered by the
 * allowlist, and records provenance for the search itself (one `kind:'search'`
 * row per call).
 *
 * Response shape (we own this side; not contract-schema-validated):
 *   { ok: true, contract_id: 'web.search.v1', trace_id, query, top_n,
 *     freshness, results: [{title, url, snippet, origin}], filtered_out }
 *
 * Errors return `{ ok: false, code, message, trace_id }` — the RPC server
 * serialises both forms back to the caller.
 */

import type { Allowlist } from '../lib/allowlist.js';
import type { WebFetcherCache } from '../cache.js';
import type { ContractEnvelope } from '../contracts.js';
import { search as braveSearch, BraveSearchError } from '../adapters/brave-search.js';

export interface WebSearchDeps {
  readonly cache: WebFetcherCache;
  readonly allowlist: Allowlist;
  readonly fetch: typeof fetch;
  readonly braveApiKey: string;
  /** Inject for deterministic tests. */
  readonly nowMs?: () => number;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly origin: string;
}

export interface WebSearchResponse {
  readonly ok: true;
  readonly contract_id: 'web.search.v1';
  readonly trace_id: string;
  readonly query: string;
  readonly top_n: number;
  readonly freshness: string;
  readonly results: ReadonlyArray<WebSearchResult>;
}

export interface HandlerError {
  readonly ok: false;
  readonly code: 'bad_query' | 'budget_exhausted' | 'internal_error' | 'upstream_error';
  readonly message: string;
  readonly trace_id?: string;
}

function nowIso(deps: WebSearchDeps): string {
  return new Date(deps.nowMs?.() ?? Date.now()).toISOString();
}

function originOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return rawUrl;
  }
}

export async function handleWebSearch(
  envelope: ContractEnvelope,
  deps: WebSearchDeps,
): Promise<WebSearchResponse | HandlerError> {
  const query = String(envelope.query ?? '').trim();
  if (!query) {
    return { ok: false, code: 'bad_query', message: 'query is empty', trace_id: envelope.trace_id };
  }
  const topN =
    typeof envelope.top_n === 'number' && Number.isFinite(envelope.top_n) ? envelope.top_n : 5;
  const freshness = typeof envelope.freshness === 'string' ? envelope.freshness : 'any';

  // Optional `site_filter` — must be a subset of the allowlist. Off-allowlist
  // hostnames return bad_query rather than silent fall-through (AP-1).
  const siteFilterRaw = envelope.site_filter;
  if (siteFilterRaw !== undefined) {
    if (!Array.isArray(siteFilterRaw)) {
      return {
        ok: false,
        code: 'bad_query',
        message: 'site_filter must be an array of hostnames',
        trace_id: envelope.trace_id,
      };
    }
    for (const host of siteFilterRaw) {
      if (typeof host !== 'string') {
        return {
          ok: false,
          code: 'bad_query',
          message: 'site_filter entries must be strings',
          trace_id: envelope.trace_id,
        };
      }
      // `Allowlist.has(url)` expects a URL; wrap the bare hostname so the
      // hostname-extraction path runs (subdomain matching included).
      if (!deps.allowlist.has(`https://${host}/`)) {
        return {
          ok: false,
          code: 'bad_query',
          message: `site_filter hostname not on allowlist: ${host}`,
          trace_id: envelope.trace_id,
        };
      }
    }
  }

  let raw;
  try {
    raw = await braveSearch(
      { query, count: topN },
      { fetch: deps.fetch, apiKey: deps.braveApiKey, allowlist: deps.allowlist },
    );
  } catch (err) {
    if (err instanceof BraveSearchError) {
      return {
        ok: false,
        code: 'upstream_error',
        message: `brave_search: ${err.message}`,
        trace_id: envelope.trace_id,
      };
    }
    throw err;
  }

  const siteFilter = Array.isArray(siteFilterRaw) ? new Set(siteFilterRaw as string[]) : null;
  const filtered = raw.results
    .filter((r) => {
      if (!siteFilter) return true;
      try {
        return siteFilter.has(new URL(r.url).hostname);
      } catch {
        return false;
      }
    })
    .slice(0, topN);

  const fetchedAt = nowIso(deps);
  // Record one provenance row per search call (kind='search'). The URL stored
  // is the Brave endpoint shaped as a synthetic search-url; the
  // content_sha256 is over the canonical `<query>:<top_n>:<freshness>`. This
  // gives the output post-filter a way to recognise that the *search* was
  // sanctioned — distinct from per-fetch provenance written in fetch-pipeline.
  const synthUrl = `brave-search://${encodeURIComponent(query)}?top_n=${topN}&freshness=${freshness}`;
  const synthOrigin = 'brave-search://';
  const provenanceSha = await import('node:crypto').then((c) =>
    c.createHash('sha256').update(`${query}:${topN}:${freshness}`, 'utf8').digest('hex'),
  );
  deps.cache.recordProvenance({
    url: synthUrl,
    origin: synthOrigin,
    contentSha256: provenanceSha,
    fetchedAt,
    requestingAgentId: envelope.caller_agent_id,
    taskId: typeof envelope.source_ref === 'string' ? envelope.source_ref : null,
    kind: 'search',
  });

  return {
    ok: true,
    contract_id: 'web.search.v1',
    trace_id: envelope.trace_id,
    query,
    top_n: topN,
    freshness,
    results: filtered.map((r) => ({ ...r, origin: originOf(r.url) })),
  };
}
