/**
 * Magic-number register for ai-web-fetcher.
 *
 * Constants kept colocated so a single read tells a reviewer the entire
 * envelope of the agent's operating budget. Each entry carries a
 * PATCH-EXPIRY comment per G3 — the rule lands in `docs/architecture.md`
 * §1.8 and architect-backlog.md L322 (the parent web-fetcher v1 row's
 * magic-number register).
 *
 * Sub-items 2-4 import from this module:
 *  - sub-item 2 boot self-check uses `WEB_FETCH_TIMEOUT_MS` for the HEAD probe
 *  - sub-item 3 HTTP fetcher uses `WEB_FETCH_TIMEOUT_MS` + `WEB_FETCH_MAX_BYTES`
 *  - sub-item 3 search/fetch dispatch uses the TTL constants
 *  - sub-item 4 RPC server uses `WEB_OPS_PER_TASK` for the per-task budget
 *    guard
 *  - the daily review timer reads `WEB_OPS_PER_DAY` + `WEB_BUDGET_USD_MONTH`
 *    for the ops-budget tombstone
 */

// ---------------------------------------------------------------------------
// Operations budget (per-day, per-task, per-month USD).
// ---------------------------------------------------------------------------

/**
 * Hard cap on Brave Search + plain-HTTP-GET ops per UTC day across the agent.
 * Empirical basis: §6.8 deployment plan ~10 grounding lookups/day at peak
 * with ×5 headroom rounded to 50; ×3 cheaper than letting an LLM-driven loop
 * run unbounded.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const WEB_OPS_PER_DAY = 50;

/**
 * Hard cap on search + fetch ops per upstream task. A single chief-of-staff
 * Phase 3 body section should make at most one external lookup; the cap is
 * set deliberately tight so a runaway-loop bug surfaces as `BudgetExhausted`
 * (sub-item 4) rather than a quiet $50 invoice.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const WEB_OPS_PER_TASK = 5;

/**
 * Monthly USD ceiling on Brave Search spend. Brave Search is ~$3/1k queries;
 * 50 ops/day × 30 days = 1500 ops/month ≈ $4.50; rounded to 5. Over-cap is
 * not a soft warning — sub-item 4's review timer tombstones with `BudgetExhausted`.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const WEB_BUDGET_USD_MONTH = 5;

// ---------------------------------------------------------------------------
// Per-fetch bounds.
// ---------------------------------------------------------------------------

/**
 * Hard byte cap on a single HTTP GET response body. Empirical basis: the
 * Readability extractor handles ~50–80 KB of typical article HTML cleanly;
 * 200 KB leaves room for embedded SVG / large nav blocks while bounding the
 * worst-case memory footprint. Over-cap responses are aborted mid-stream and
 * recorded as `low_signal: true, reason: 'over_size_cap'` per AP-1.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const WEB_FETCH_MAX_BYTES = 200_000;

/**
 * Per-request HTTP timeout. Empirical basis: a well-behaved public allowlist
 * domain responds in <2 s; 8 s leaves room for a slow CDN handshake while
 * keeping the chief-of-staff Phase 3 enrichment latency budget bounded.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const WEB_FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// TTL classes (seconds). Different content rots at different rates.
// ---------------------------------------------------------------------------

/**
 * Insurance-comparator + medical-info TTL. Daily refresh keeps premium quotes
 * + clinical guidelines reasonably current without churning the cache. The
 * `ttl_class: 'insurance-med'` allowlist entries draw on this constant.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const TTL_INSURANCE_MED_S = 86_400;

/**
 * Airline / flight-info TTL. Flight schedules + fare classes change
 * intra-day; 1 hour is the right grain. The `ttl_class: 'airline'` allowlist
 * entries draw on this constant.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const TTL_AIRLINE_S = 3_600;

/**
 * Fallback TTL for general reference / vendor-neutral knowledge bases. One
 * week is the right grain for governmental info pages and stable docs. The
 * `ttl_class: 'generic'` allowlist entries draw on this constant.
 *
 * PATCH-EXPIRY: 2026-08-10 owner=web-fetcher reason=architect-backlog.md L322 magic-number register
 */
export const TTL_GENERIC_S = 604_800;

/**
 * Symbolic TTL class labels for the allowlist YAML. Sub-item 2 validates
 * each allowlist entry's `ttl_class` against this union.
 */
export type TtlClass = 'insurance-med' | 'airline' | 'generic';

export function ttlSecondsFor(ttlClass: TtlClass): number {
  switch (ttlClass) {
    case 'insurance-med':
      return TTL_INSURANCE_MED_S;
    case 'airline':
      return TTL_AIRLINE_S;
    case 'generic':
      return TTL_GENERIC_S;
  }
}
