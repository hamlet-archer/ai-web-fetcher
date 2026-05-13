/**
 * Allowlist loader + per-fetch guard for ai-web-fetcher.
 *
 * Sub-item 2 of web-fetcher v1 (ai-ops-meta architect-backlog.md L334).
 *
 * Two responsibilities:
 *   1. Parse `vendor/web-allowlist.yaml` (or an env-override path) into a
 *      typed list with schema-level validation (domain shape, ttl_class
 *      enum, added_at ISO date). Empty entries → throw; malformed entry →
 *      throw with the file line / index for the diagnostic.
 *   2. Expose `isOnAllowlist(url)` for sub-item 3's per-fetch gate. Strict
 *      domain match plus subdomain support (per the spec — sub-item 3
 *      passes URLs verbatim, the allowlist matches by hostname).
 *
 * The boot self-check (see boot-check.ts) uses `parseAllowlist` for step 1;
 * sub-item 3 uses `Allowlist.has` for the per-fetch gate.
 *
 * Pure local code — no network, no SQLite. Sub-item 3 calls `isOnAllowlist`
 * inside the HTTP-GET fetcher; sub-item 4 invokes the boot self-check before
 * binding the RPC socket.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import type { TtlClass } from './web-config.js';

const VALID_TTL_CLASSES: ReadonlySet<TtlClass> = new Set<TtlClass>([
  'insurance-med',
  'airline',
  'generic',
]);

/** Bare-hostname regex. Permits ASCII + numbers + hyphens + dots. */
const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** ISO 8601 date (YYYY-MM-DD) — added_at field shape. */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface AllowlistEntry {
  readonly domain: string;
  readonly purpose: string;
  readonly ttl_class: TtlClass;
  readonly added_at: string;
}

export class AllowlistParseError extends Error {
  constructor(message: string, readonly file: string, readonly index?: number) {
    super(message);
    this.name = 'AllowlistParseError';
  }
}

/**
 * Parse + validate an allowlist YAML file. Throws AllowlistParseError on any
 * shape violation; the boot self-check converts that into an exit-1 with the
 * file path + index.
 */
export function parseAllowlist(filePath: string): AllowlistEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new AllowlistParseError(
      `cannot read ${filePath}: ${(e as Error).message}`,
      filePath,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new AllowlistParseError(
      `yaml parse error: ${(e as Error).message}`,
      filePath,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    throw new AllowlistParseError(`top-level "entries" key missing`, filePath);
  }
  const entries = (parsed as { entries: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new AllowlistParseError(`"entries" is not an array`, filePath);
  }
  if (entries.length === 0) {
    throw new AllowlistParseError(`"entries" is empty`, filePath);
  }
  const out: AllowlistEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (typeof e !== 'object' || e === null) {
      throw new AllowlistParseError(`entry ${i} is not an object`, filePath, i);
    }
    const r = e as Record<string, unknown>;
    const domain = r.domain;
    const purpose = r.purpose;
    const ttl_class = r.ttl_class;
    const added_at = r.added_at;
    if (typeof domain !== 'string' || !DOMAIN_REGEX.test(domain)) {
      throw new AllowlistParseError(
        `entry ${i} has invalid "domain": ${JSON.stringify(domain)}`,
        filePath,
        i,
      );
    }
    if (typeof purpose !== 'string' || purpose.length === 0) {
      throw new AllowlistParseError(
        `entry ${i} ("${domain}") has invalid "purpose"`,
        filePath,
        i,
      );
    }
    if (typeof ttl_class !== 'string' || !VALID_TTL_CLASSES.has(ttl_class as TtlClass)) {
      throw new AllowlistParseError(
        `entry ${i} ("${domain}") has invalid "ttl_class": ${JSON.stringify(ttl_class)}`,
        filePath,
        i,
      );
    }
    if (typeof added_at !== 'string' || !ISO_DATE_REGEX.test(added_at)) {
      throw new AllowlistParseError(
        `entry ${i} ("${domain}") has invalid "added_at": ${JSON.stringify(added_at)}`,
        filePath,
        i,
      );
    }
    // Validate added_at parses as a real date
    const dt = new Date(added_at);
    if (isNaN(dt.getTime())) {
      throw new AllowlistParseError(
        `entry ${i} ("${domain}") "added_at" is not a real date: ${added_at}`,
        filePath,
        i,
      );
    }
    out.push({ domain, purpose, ttl_class: ttl_class as TtlClass, added_at });
  }
  return out;
}

/**
 * Typed allowlist with `has(url)` membership check.
 *
 * Matches by hostname only (port + path ignored). Sub-domain support: a URL
 * whose hostname is `foo.bar.gov.uk` matches an entry for `gov.uk` (the
 * search backend returns subdomain-pinned results occasionally — narrowly
 * scoped, but the per-fetch gate must accept them).
 */
export class Allowlist {
  private readonly domains: ReadonlySet<string>;
  private readonly entries: ReadonlyArray<AllowlistEntry>;

  constructor(entries: ReadonlyArray<AllowlistEntry>) {
    this.entries = entries;
    this.domains = new Set(entries.map((e) => e.domain));
  }

  /** Returns true iff the URL's hostname matches some allowlisted domain
   * exactly OR as a subdomain. Returns false on any URL parse error.
   */
  has(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (this.domains.has(host)) return true;
    // subdomain match: split host into labels, walk right-to-left.
    const labels = host.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join('.');
      if (this.domains.has(candidate)) return true;
    }
    return false;
  }

  /** Returns the matching allowlist entry for an in-set URL, or null. */
  lookup(url: string): AllowlistEntry | null {
    if (!this.has(url)) return null;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    // Find the most specific match (longest suffix).
    let bestIndex = -1;
    let bestLength = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const d = this.entries[i].domain;
      if (host === d || host.endsWith(`.${d}`)) {
        if (d.length > bestLength) {
          bestLength = d.length;
          bestIndex = i;
        }
      }
    }
    return bestIndex >= 0 ? this.entries[bestIndex] : null;
  }

  get size(): number {
    return this.entries.length;
  }

  list(): ReadonlyArray<AllowlistEntry> {
    return this.entries;
  }
}

/**
 * Convenience: parse + wrap into an Allowlist in one call. Used by
 * boot-check.ts and (in sub-item 3) the HTTP-GET fetcher.
 */
export function loadAllowlist(filePath: string): Allowlist {
  return new Allowlist(parseAllowlist(filePath));
}

/**
 * Tiny free function used by sub-item 3's per-fetch gate. Caller usually
 * holds an Allowlist instance; this is the one-shot path for unit tests or
 * cold-start callers.
 */
export function isOnAllowlist(url: string, allowlist: Allowlist): boolean {
  return allowlist.has(url);
}
