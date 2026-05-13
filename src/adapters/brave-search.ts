/**
 * Brave Search adapter for ai-web-fetcher.
 *
 * Sub-item 3 of web-fetcher v1 (ai-ops-meta architect-backlog.md L359).
 *
 * Calls the Brave Search v1 web endpoint, normalises results into
 * `{title, url, snippet}` shape, and filters by the allowlist BEFORE
 * returning so a caller cannot accidentally fetch off-allowlist URLs from
 * search results.
 *
 * Failures (missing API key at boot, HTTP error, malformed JSON) surface as
 * thrown `BraveSearchError` — sub-item 4's RPC handler converts them into
 * typed error envelopes via the AP-2 per-handler `try/catch`.
 *
 * Pure-of-side-effects against the cache + provenance: the RPC dispatch
 * layer in sub-item 4 is responsible for `cache.recordProvenance({kind:
 * 'search', ...})`. This adapter just talks to Brave.
 */

import type { Allowlist } from '../lib/allowlist.js';

const BRAVE_API_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export interface BraveSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface BraveSearchResponse {
  readonly results: ReadonlyArray<BraveSearchResult>;
}

export interface BraveSearchOptions {
  readonly query: string;
  readonly count?: number;
}

export interface BraveSearchDeps {
  readonly fetch: typeof fetch;
  readonly apiKey: string;
  readonly allowlist: Allowlist;
}

export class BraveSearchError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BraveSearchError';
  }
}

interface BraveResultRaw {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly description?: unknown;
}

interface BraveWebResultsRaw {
  readonly web?: { readonly results?: ReadonlyArray<BraveResultRaw> };
}

/**
 * Run a Brave Search query. Returns results filtered by the allowlist; URLs
 * outside the allowlist are dropped before the caller sees them.
 */
export async function search(
  opts: BraveSearchOptions,
  deps: BraveSearchDeps,
): Promise<BraveSearchResponse> {
  const url = new URL(BRAVE_API_ENDPOINT);
  url.searchParams.set('q', opts.query);
  if (opts.count !== undefined) {
    url.searchParams.set('count', String(opts.count));
  }

  let response: Response;
  try {
    response = await deps.fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': deps.apiKey,
      },
    });
  } catch (e) {
    throw new BraveSearchError(`brave_search_transport_error: ${(e as Error).message}`, e);
  }

  if (!response.ok) {
    throw new BraveSearchError(`brave_search_http_${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (e) {
    throw new BraveSearchError(`brave_search_invalid_json: ${(e as Error).message}`, e);
  }

  const raw = (payload as BraveWebResultsRaw).web?.results ?? [];
  const out: BraveSearchResult[] = [];
  for (const r of raw) {
    if (
      typeof r.title !== 'string' ||
      typeof r.url !== 'string' ||
      typeof r.description !== 'string'
    ) {
      continue;
    }
    if (!deps.allowlist.has(r.url)) {
      continue;
    }
    out.push({ title: r.title, url: r.url, snippet: r.description });
  }

  return { results: out };
}
