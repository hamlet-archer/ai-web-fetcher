/**
 * Handler for `web.fetch.v1` — wraps the fetch pipeline (cache → HTTP GET →
 * Readability → cache write + provenance). Pure async.
 *
 * Response shape (we own this side; not contract-schema-validated):
 *   success     → { ok: true, contract_id, trace_id, status, url, origin,
 *                   title, plaintext, content_sha256, byte_size, fetched_at }
 *   low_signal  → { ok: false, code: 'low_signal', reason, url, origin?, trace_id }
 *   off_allowlist → { ok: false, code: 'not_allowlisted', url, trace_id }
 *
 * Errors that aren't part of the contract's success shape go through the same
 * `HandlerError` envelope used by the search handler — the RPC server
 * serialises them.
 */

import type { Allowlist } from '../lib/allowlist.js';
import type { WebFetcherCache } from '../cache.js';
import type { ContractEnvelope } from '../contracts.js';
import { fetchAndExtract, type FetchPipelineDeps } from '../lib/fetch-pipeline.js';

export interface WebFetchDeps {
  readonly cache: WebFetcherCache;
  readonly allowlist: Allowlist;
  readonly pipelineDeps: Omit<FetchPipelineDeps, 'cache' | 'allowlist'>;
}

export interface WebFetchSuccess {
  readonly ok: true;
  readonly contract_id: 'web.fetch.v1';
  readonly trace_id: string;
  readonly status: 'ok' | 'cache_hit';
  readonly url: string;
  readonly origin: string;
  readonly title: string | null;
  readonly plaintext: string;
  readonly content_sha256: string;
  readonly byte_size: number;
  readonly fetched_at: string;
}

export interface WebFetchLowSignal {
  readonly ok: false;
  readonly code: 'low_signal' | 'not_allowlisted';
  readonly reason?: string;
  readonly url: string;
  readonly origin?: string;
  readonly trace_id: string;
}

export interface HandlerError {
  readonly ok: false;
  readonly code: 'bad_query' | 'budget_exhausted' | 'internal_error';
  readonly message: string;
  readonly trace_id?: string;
}

export async function handleWebFetch(
  envelope: ContractEnvelope,
  deps: WebFetchDeps,
): Promise<WebFetchSuccess | WebFetchLowSignal | HandlerError> {
  const url = typeof envelope.url === 'string' ? envelope.url : '';
  if (!url) {
    return {
      ok: false,
      code: 'bad_query',
      message: 'url is missing',
      trace_id: envelope.trace_id,
    };
  }
  const freshness = typeof envelope.freshness === 'string' ? envelope.freshness : 'cached';

  const outcome = await fetchAndExtract(
    {
      url,
      requestingAgentId: envelope.caller_agent_id,
      taskId: typeof envelope.source_ref === 'string' ? envelope.source_ref : null,
      bypassCache: freshness === 'realtime',
    },
    {
      cache: deps.cache,
      allowlist: deps.allowlist,
      ...deps.pipelineDeps,
    },
  );

  if (outcome.status === 'off_allowlist') {
    return {
      ok: false,
      code: 'not_allowlisted',
      url: outcome.url,
      trace_id: envelope.trace_id,
    };
  }
  if (outcome.status === 'low_signal') {
    return {
      ok: false,
      code: 'low_signal',
      reason: outcome.reason,
      url: outcome.url,
      origin: outcome.origin,
      trace_id: envelope.trace_id,
    };
  }

  return {
    ok: true,
    contract_id: 'web.fetch.v1',
    trace_id: envelope.trace_id,
    status: outcome.status,
    url: outcome.url,
    origin: outcome.origin,
    title: outcome.title,
    plaintext: outcome.plaintext,
    content_sha256: outcome.contentSha256,
    byte_size: outcome.byteSize,
    fetched_at: outcome.fetchedAt,
  };
}
