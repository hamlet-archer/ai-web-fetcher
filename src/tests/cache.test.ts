import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WebFetcherCache,
  type FetchedPageRow,
  type ProvenanceRow,
} from '../cache.js';

let tmpDir: string;
let dbPath: string;
let cache: WebFetcherCache;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-fetcher-cache-'));
  dbPath = join(tmpDir, 'web-fetcher.db');
  cache = new WebFetcherCache(dbPath);
});

afterEach(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function fixturePage(overrides: Partial<FetchedPageRow> = {}): FetchedPageRow {
  return {
    url: 'https://example.com/article',
    origin: 'https://example.com',
    contentSha256: 'a'.repeat(64),
    plaintext: 'Hello world',
    title: 'Example Article',
    fetchedAt: '2026-05-13T07:00:00+00:00',
    ttlSeconds: 3600,
    lowSignal: false,
    byteSize: 1234,
    ...overrides,
  };
}

function fixtureProvenance(overrides: Partial<ProvenanceRow> = {}): ProvenanceRow {
  return {
    url: 'https://example.com/article',
    origin: 'https://example.com',
    contentSha256: 'a'.repeat(64),
    fetchedAt: '2026-05-13T07:00:00+00:00',
    requestingAgentId: 'chief-of-staff',
    taskId: 'task-123',
    kind: 'fetch',
    ...overrides,
  };
}

describe('WebFetcherCache.fetchedPages', () => {
  it('round-trips a page within the TTL window (cache hit)', () => {
    const row = fixturePage();
    cache.upsertFetchedPage(row);
    // 30 minutes after fetchedAt; well inside the 1h TTL.
    const got = cache.getFetchedPage({
      url: row.url,
      maxAgeSeconds: 3600,
      nowMs: Date.parse('2026-05-13T07:30:00+00:00'),
    });
    expect(got).toEqual(row);
  });

  it('returns null when the row is older than maxAgeSeconds (cache miss — TTL gate)', () => {
    cache.upsertFetchedPage(fixturePage());
    const got = cache.getFetchedPage({
      url: 'https://example.com/article',
      maxAgeSeconds: 1800,
      nowMs: Date.parse('2026-05-13T07:31:00+00:00'),
    });
    expect(got).toBeNull();
  });

  it('returns null for an unknown URL', () => {
    const got = cache.getFetchedPage({
      url: 'https://example.com/missing',
      maxAgeSeconds: 3600,
    });
    expect(got).toBeNull();
  });

  it('upsert overwrites prior content for the same URL', () => {
    cache.upsertFetchedPage(fixturePage({ plaintext: 'old' }));
    cache.upsertFetchedPage(fixturePage({ plaintext: 'new', contentSha256: 'b'.repeat(64) }));
    const got = cache.getFetchedPage({
      url: 'https://example.com/article',
      maxAgeSeconds: 3600,
      nowMs: Date.parse('2026-05-13T07:30:00+00:00'),
    });
    expect(got?.plaintext).toBe('new');
    expect(got?.contentSha256).toBe('b'.repeat(64));
  });

  it('preserves the low_signal flag through round-trip', () => {
    cache.upsertFetchedPage(fixturePage({ lowSignal: true }));
    const got = cache.getFetchedPage({
      url: 'https://example.com/article',
      maxAgeSeconds: 3600,
      nowMs: Date.parse('2026-05-13T07:30:00+00:00'),
    });
    expect(got?.lowSignal).toBe(true);
  });
});

describe('WebFetcherCache.provenance', () => {
  it('recordProvenance + provenanceExists round-trip', () => {
    cache.recordProvenance(fixtureProvenance());
    expect(cache.provenanceExists('a'.repeat(64))).toBe(true);
  });

  it('provenanceExists returns false for unrecorded content', () => {
    expect(cache.provenanceExists('z'.repeat(64))).toBe(false);
  });

  it('two provenance rows can share the same content_sha256 (append-only audit)', () => {
    cache.recordProvenance(fixtureProvenance({ requestingAgentId: 'chief-of-staff' }));
    cache.recordProvenance(fixtureProvenance({ requestingAgentId: 'task-doer', kind: 'search' }));
    // Both rows lookable up via the shared hash.
    expect(cache.provenanceExists('a'.repeat(64))).toBe(true);
  });

  it('accepts a null task_id (search ops are not always task-scoped)', () => {
    cache.recordProvenance(fixtureProvenance({ taskId: null, kind: 'search' }));
    expect(cache.provenanceExists('a'.repeat(64))).toBe(true);
  });

  it('rejects unknown kind via SQLite CHECK constraint', () => {
    expect(() =>
      cache.recordProvenance(fixtureProvenance({ kind: 'invalid' as 'fetch' })),
    ).toThrow();
  });
});

describe('WebFetcherCache.schema', () => {
  it('re-opening the DB file is a no-op (idempotent DDL)', () => {
    cache.upsertFetchedPage(fixturePage());
    cache.close();
    const reopened = new WebFetcherCache(dbPath);
    const got = reopened.getFetchedPage({
      url: 'https://example.com/article',
      maxAgeSeconds: 3600,
      nowMs: Date.parse('2026-05-13T07:30:00+00:00'),
    });
    reopened.close();
    expect(got?.url).toBe('https://example.com/article');
  });

  // POSIX-only — Windows CI doesn't honour chmod permissions.
  it.runIf(platform() !== 'win32')(
    'sets the DB file to mode 0600 on first creation',
    () => {
      const stat = statSync(dbPath);
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );
});
