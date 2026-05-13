/**
 * SQLite cache + provenance store for ai-web-fetcher.
 *
 * Sub-item 1 of web-fetcher v1 (ai-ops-meta architect-backlog.md L329). Pure
 * local code — no Brave / no HTTP round-trip yet. Sub-item 2 (allowlist + boot
 * self-check), sub-item 3 (Brave + HTTP-GET adapters), and sub-item 4
 * (Unix-socket RPC + deploy) all import from this module.
 *
 * Schema is idempotent (`CREATE TABLE IF NOT EXISTS`) so reopening an existing
 * DB file is a no-op. WAL journal mode keeps writes durable without blocking
 * readers (the daily review timer reads from the same file the long-running
 * RPC server writes to).
 *
 * Two tables:
 *  - `fetched_pages` — content cache, keyed by URL. Holds the extracted
 *    plaintext and a SHA256 of the canonical content so sub-item 3's output
 *    post-filter can verify URLs in LLM output against the provenance set.
 *  - `provenance` — append-only audit log. Every search/fetch op writes one
 *    row. `provenanceExists(content_sha256)` is the lookup sub-item 3 uses
 *    to drop hallucinated URLs from LLM output.
 */

import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FetchedPageRow {
  /** The fetched URL — primary key. Caller normalises before insert (sub-item 3). */
  readonly url: string;
  /** The origin (`https://<domain>`) — denormalised so the per-origin TTL query can run without re-parsing URLs. */
  readonly origin: string;
  /** SHA256 hex of the canonicalised plaintext. Hex lowercase per the §6.8 fingerprint convention. */
  readonly contentSha256: string;
  /** Rendered plaintext extracted by Mozilla Readability (sub-item 3). */
  readonly plaintext: string;
  /** Document title, if Readability surfaced one. */
  readonly title: string | null;
  /** ISO 8601 timestamp of when the fetch landed in the cache. */
  readonly fetchedAt: string;
  /** TTL the caller derived from the allowlist `ttl_class` (sub-item 2 wires this). */
  readonly ttlSeconds: number;
  /** True when sub-item 3's heuristics flagged the response as a captcha / paywall / login-wall. */
  readonly lowSignal: boolean;
  /** Byte size of the response body that produced this plaintext. */
  readonly byteSize: number;
}

export interface FetchedPageQuery {
  /** Exact URL to look up. */
  readonly url: string;
  /** Cache-hit gate: if the row is older than this, treat as a miss. */
  readonly maxAgeSeconds: number;
  /**
   * Optional "now" clock for testability. Defaults to `Date.now()`. Tests
   * pass a fixed value so they don't have to depend on real time.
   */
  readonly nowMs?: number;
}

export interface ProvenanceRow {
  /** The URL that produced this row (a search-result URL for `kind='search'`, the fetched URL for `kind='fetch'`). */
  readonly url: string;
  /** Origin of the URL — denormalised so the post-filter can group by domain without re-parsing. */
  readonly origin: string;
  /** SHA256 hex of the canonical content. Same hex value as `fetched_pages.content_sha256` for `kind='fetch'` rows. */
  readonly contentSha256: string;
  /** ISO 8601 timestamp of when the op landed. */
  readonly fetchedAt: string;
  /** Agent ID that issued the request — `chief-of-staff`, `task-doer`, etc. */
  readonly requestingAgentId: string;
  /** Notion task ID this op was grounding, if any. */
  readonly taskId: string | null;
  /** `'search'` for Brave Search results, `'fetch'` for plain HTTP-GET pages. */
  readonly kind: 'search' | 'fetch';
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS fetched_pages (
  url TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  plaintext TEXT NOT NULL,
  title TEXT,
  fetched_at TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  low_signal INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS fetched_pages_origin_fetched_at
  ON fetched_pages (origin, fetched_at);

CREATE TABLE IF NOT EXISTS provenance (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  requesting_agent_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('search', 'fetch'))
);

CREATE INDEX IF NOT EXISTS provenance_content_sha256
  ON provenance (content_sha256);
`;

export class WebFetcherCache {
  readonly #db: DatabaseType;
  readonly #upsertFetchedPage: Statement;
  readonly #selectFetchedPage: Statement;
  readonly #insertProvenance: Statement;
  readonly #provenanceExists: Statement;

  constructor(dbPath: string) {
    const isNew = !existsSync(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    if (isNew) {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best-effort. Deploy story locks down /var/lib/ai-web-fetcher/
        // itself; refusing to boot over a missing chmod would be worse than
        // a slightly-too-readable cache file.
      }
    }
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(SCHEMA_DDL);

    this.#upsertFetchedPage = this.#db.prepare(`
      INSERT INTO fetched_pages (url, origin, content_sha256, plaintext, title,
                                 fetched_at, ttl_seconds, low_signal, byte_size)
      VALUES (@url, @origin, @contentSha256, @plaintext, @title,
              @fetchedAt, @ttlSeconds, @lowSignal, @byteSize)
      ON CONFLICT(url) DO UPDATE SET
        origin = excluded.origin,
        content_sha256 = excluded.content_sha256,
        plaintext = excluded.plaintext,
        title = excluded.title,
        fetched_at = excluded.fetched_at,
        ttl_seconds = excluded.ttl_seconds,
        low_signal = excluded.low_signal,
        byte_size = excluded.byte_size
    `);

    this.#selectFetchedPage = this.#db.prepare(`
      SELECT url, origin, content_sha256 AS contentSha256, plaintext, title,
             fetched_at AS fetchedAt, ttl_seconds AS ttlSeconds,
             low_signal AS lowSignal, byte_size AS byteSize
      FROM fetched_pages
      WHERE url = ?
    `);

    this.#insertProvenance = this.#db.prepare(`
      INSERT INTO provenance (url, origin, content_sha256, fetched_at,
                              requesting_agent_id, task_id, kind)
      VALUES (@url, @origin, @contentSha256, @fetchedAt,
              @requestingAgentId, @taskId, @kind)
    `);

    this.#provenanceExists = this.#db.prepare(`
      SELECT 1
      FROM provenance
      WHERE content_sha256 = ?
      LIMIT 1
    `);
  }

  upsertFetchedPage(row: FetchedPageRow): void {
    this.#upsertFetchedPage.run({
      url: row.url,
      origin: row.origin,
      contentSha256: row.contentSha256,
      plaintext: row.plaintext,
      title: row.title,
      fetchedAt: row.fetchedAt,
      ttlSeconds: row.ttlSeconds,
      lowSignal: row.lowSignal ? 1 : 0,
      byteSize: row.byteSize,
    });
  }

  /**
   * Return the row when present AND younger than `maxAgeSeconds`; otherwise
   * `null`. The TTL gate runs at read time (not write time) so per-origin
   * TTLs can be tuned by callers without re-keying existing rows.
   */
  getFetchedPage(query: FetchedPageQuery): FetchedPageRow | null {
    const raw = this.#selectFetchedPage.get(query.url) as
      | (Omit<FetchedPageRow, 'lowSignal'> & { lowSignal: number })
      | undefined;
    if (raw === undefined) {
      return null;
    }
    const fetchedAtMs = Date.parse(raw.fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
      return null;
    }
    const nowMs = query.nowMs ?? Date.now();
    const ageSeconds = (nowMs - fetchedAtMs) / 1000;
    if (ageSeconds > query.maxAgeSeconds) {
      return null;
    }
    return {
      url: raw.url,
      origin: raw.origin,
      contentSha256: raw.contentSha256,
      plaintext: raw.plaintext,
      title: raw.title,
      fetchedAt: raw.fetchedAt,
      ttlSeconds: raw.ttlSeconds,
      lowSignal: raw.lowSignal === 1,
      byteSize: raw.byteSize,
    };
  }

  recordProvenance(row: ProvenanceRow): void {
    this.#insertProvenance.run(row);
  }

  /**
   * True when at least one provenance row exists with the given
   * `content_sha256`. Sub-item 3's output post-filter uses this to drop
   * sentences whose URL's hashed content isn't tracked — the AP-1 mitigation
   * against hallucinated URLs.
   */
  provenanceExists(contentSha256: string): boolean {
    const row = this.#provenanceExists.get(contentSha256);
    return row !== undefined;
  }

  close(): void {
    this.#db.close();
  }
}
