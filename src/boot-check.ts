/**
 * Boot self-check for ai-web-fetcher (AP-3 + AP-4).
 *
 * Sub-item 2 of web-fetcher v1 (ai-ops-meta architect-backlog.md L334).
 *
 * Three steps, run before any RPC bind in sub-item 4. Any failure → exit 1
 * with a structured stderr diagnostic naming:
 *   1. The dependency that failed.
 *   2. The verbatim upstream error.
 *   3. **Ranked likely root causes** — per AP-4 ("encoded wrong root cause
 *      as official" anchor), the diagnostic must rank candidate causes, not
 *      assert one.
 *
 * Steps:
 *   1. Parse + validate `vendor/web-allowlist.yaml` (or env-override path).
 *      Failure = malformed entry / empty list / missing file.
 *   2. DNS-resolve every allowlist domain (`dns.promises.resolve4` OR
 *      `resolve6` — first non-empty wins). Any unresolvable entry exits 1.
 *   3. HEAD-probe each allowlist domain at `https://<domain>/`. Non-2xx/3xx
 *      response exits 1 with the ranked-cause diagnostic.
 *
 * Idempotent: re-running boot-check after a successful previous run is safe.
 * No side effects on disk or network beyond DNS + HEAD probes.
 */

import { promises as dnsPromises } from 'node:dns';

import { loadAllowlist, parseAllowlist, Allowlist, AllowlistParseError } from './lib/allowlist.js';
import { WEB_FETCH_TIMEOUT_MS } from './lib/web-config.js';

export const DEFAULT_ALLOWLIST_PATH = 'vendor/web-allowlist.yaml';
const HEAD_PROBE_TIMEOUT_MS = 5_000;

export interface BootCheckOk {
  readonly status: 'ok';
  readonly allowlist: Allowlist;
}

export interface BootCheckFail {
  readonly status: 'fail';
  readonly step: 'parse' | 'dns' | 'head';
  readonly dependency: string;
  readonly upstreamError: string;
  readonly rankedCauses: ReadonlyArray<string>;
  readonly entryIndex?: number;
}

export type BootCheckResult = BootCheckOk | BootCheckFail;

/**
 * Minimal port surfaces so unit tests can substitute. Production callers
 * pass the real Node `fetch` + `dns.promises`.
 */
export interface BootCheckDeps {
  readonly fetch: typeof fetch;
  readonly dns: {
    resolve4: typeof dnsPromises.resolve4;
    resolve6: typeof dnsPromises.resolve6;
  };
  /** Path to the allowlist YAML — defaults to env `WEB_ALLOWLIST_PATH` then `vendor/web-allowlist.yaml`. */
  readonly allowlistPath?: string;
}

/**
 * Run the 3-step boot self-check. Returns a typed result; the caller (main)
 * is responsible for converting fail → exit 1.
 *
 * `runBootCheckOrExit` is the convenience wrapper that calls process.exit
 * directly (used by main.ts in sub-item 4); this function is unit-test
 * friendly and returns the structured result.
 */
export async function runBootCheck(deps: BootCheckDeps): Promise<BootCheckResult> {
  const path =
    deps.allowlistPath ?? process.env.WEB_ALLOWLIST_PATH ?? DEFAULT_ALLOWLIST_PATH;

  // ---- Step 1: parse ----
  let allowlist: Allowlist;
  try {
    const entries = parseAllowlist(path);
    allowlist = new Allowlist(entries);
  } catch (e) {
    if (e instanceof AllowlistParseError) {
      return {
        status: 'fail',
        step: 'parse',
        dependency: e.file,
        upstreamError: e.message,
        rankedCauses: [
          'allowlist file missing or malformed YAML',
          'allowlist file path env override (WEB_ALLOWLIST_PATH) points at the wrong file',
          'vendor/ copy out of sync with canonical ai-ops-meta registry/web-allowlist.yaml',
        ],
        entryIndex: e.index,
      };
    }
    return {
      status: 'fail',
      step: 'parse',
      dependency: path,
      upstreamError: (e as Error).message,
      rankedCauses: ['unexpected parse exception', 'filesystem permission'],
    };
  }

  // ---- Step 2: DNS resolve ----
  for (let i = 0; i < allowlist.list().length; i++) {
    const entry = allowlist.list()[i];
    const domain = entry.domain;
    try {
      const a4 = await deps.dns.resolve4(domain).catch(() => []);
      const a6 = await deps.dns.resolve6(domain).catch(() => []);
      if ((a4?.length ?? 0) === 0 && (a6?.length ?? 0) === 0) {
        return {
          status: 'fail',
          step: 'dns',
          dependency: domain,
          upstreamError: 'ENOTFOUND (no A or AAAA records)',
          rankedCauses: [
            'domain decommissioned or renamed',
            'allowlist entry typo',
            'DNS resolver transient outage (re-run boot-check after 30s)',
          ],
          entryIndex: i,
        };
      }
    } catch (e) {
      return {
        status: 'fail',
        step: 'dns',
        dependency: domain,
        upstreamError: (e as Error).message,
        rankedCauses: [
          'domain decommissioned or renamed',
          'DNS resolver transient outage',
          'host-side network filter blocking DNS',
        ],
        entryIndex: i,
      };
    }
  }

  // ---- Step 3: HEAD probe ----
  for (let i = 0; i < allowlist.list().length; i++) {
    const entry = allowlist.list()[i];
    const domain = entry.domain;
    const url = `https://${domain}/`;
    let status: number;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEAD_PROBE_TIMEOUT_MS);
      try {
        const response = await deps.fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'manual',
        });
        status = response.status;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return {
        status: 'fail',
        step: 'head',
        dependency: domain,
        upstreamError: (e as Error).message,
        rankedCauses: [
          'host unreachable / TCP-level outage',
          'HEAD probe blocked by WAF (try GET in sub-item 3, but only at fetch time, not at boot)',
          'transient transport hiccup (re-run boot-check after 30s)',
        ],
        entryIndex: i,
      };
    }
    if (status < 200 || status >= 400) {
      return {
        status: 'fail',
        step: 'head',
        dependency: domain,
        upstreamError: `HTTP ${status}`,
        rankedCauses: [
          'domain decommissioned (5xx persistent)',
          'HEAD blocked by WAF (try GET when sub-item 3 ships; do not rewrite boot probe)',
          'transient outage (re-run boot-check after 30s)',
        ],
        entryIndex: i,
      };
    }
  }

  return { status: 'ok', allowlist };
}

/**
 * Convenience wrapper for production: run the boot check and exit 1 on any
 * failure. Unit tests should call `runBootCheck` directly and inspect the
 * structured result.
 *
 * `console.error` writes JSON so journald + cron logs are grep-friendly.
 */
export async function runBootCheckOrExit(deps: BootCheckDeps): Promise<Allowlist> {
  const result = await runBootCheck(deps);
  if (result.status === 'ok') {
    return result.allowlist;
  }
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'ai-web-fetcher',
      msg: 'boot_check_failed',
      step: result.step,
      dependency: result.dependency,
      upstream_error: result.upstreamError,
      ranked_causes: result.rankedCauses,
      entry_index: result.entryIndex ?? null,
    }),
  );
  process.exit(1);
}

/** Re-export for the convenience caller. */
export { loadAllowlist, WEB_FETCH_TIMEOUT_MS };
