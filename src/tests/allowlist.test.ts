import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseAllowlist,
  Allowlist,
  loadAllowlist,
  isOnAllowlist,
  AllowlistParseError,
} from '../lib/allowlist.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-fetcher-allowlist-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(content: string): string {
  const p = join(tmpDir, 'allowlist.yaml');
  writeFileSync(p, content);
  return p;
}

const GOOD_YAML = `
entries:
  - domain: example.com
    purpose: test
    ttl_class: generic
    added_at: 2026-05-13
  - domain: gov.uk
    purpose: government services
    ttl_class: generic
    added_at: 2026-05-13
`;

describe('parseAllowlist', () => {
  it('parses a well-formed YAML file', () => {
    const p = writeYaml(GOOD_YAML);
    const entries = parseAllowlist(p);
    expect(entries.length).toBe(2);
    expect(entries[0].domain).toBe('example.com');
    expect(entries[0].ttl_class).toBe('generic');
    expect(entries[0].added_at).toBe('2026-05-13');
  });

  it('throws when the file is missing', () => {
    expect(() => parseAllowlist('/no/such/file.yaml')).toThrow(AllowlistParseError);
  });

  it('throws when entries is empty', () => {
    const p = writeYaml('entries: []');
    expect(() => parseAllowlist(p)).toThrow(/empty/i);
  });

  it('throws when top-level entries key is missing', () => {
    const p = writeYaml('foo: bar');
    expect(() => parseAllowlist(p)).toThrow(/entries.*missing/i);
  });

  it('throws when an entry has invalid domain', () => {
    const p = writeYaml(`
entries:
  - domain: NOT.A.HOSTNAME
    purpose: bad case
    ttl_class: generic
    added_at: 2026-05-13
`);
    expect(() => parseAllowlist(p)).toThrow(/invalid "domain"/);
  });

  it('throws when ttl_class is not in the enum', () => {
    const p = writeYaml(`
entries:
  - domain: example.com
    purpose: bad class
    ttl_class: weekly
    added_at: 2026-05-13
`);
    expect(() => parseAllowlist(p)).toThrow(/ttl_class/);
  });

  it('throws when added_at is not ISO date shape', () => {
    const p = writeYaml(`
entries:
  - domain: example.com
    purpose: bad date
    ttl_class: generic
    added_at: yesterday
`);
    expect(() => parseAllowlist(p)).toThrow(/added_at/);
  });

  it('throws when purpose is empty string', () => {
    const p = writeYaml(`
entries:
  - domain: example.com
    purpose: ""
    ttl_class: generic
    added_at: 2026-05-13
`);
    expect(() => parseAllowlist(p)).toThrow(/purpose/);
  });

  it('reports the entry index in AllowlistParseError', () => {
    const p = writeYaml(`
entries:
  - domain: example.com
    purpose: ok
    ttl_class: generic
    added_at: 2026-05-13
  - domain: BAD..!!
    purpose: bad
    ttl_class: generic
    added_at: 2026-05-13
`);
    try {
      parseAllowlist(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AllowlistParseError);
      expect((e as AllowlistParseError).index).toBe(1);
    }
  });
});

describe('Allowlist.has', () => {
  it('matches exact domain', () => {
    const list = new Allowlist([
      { domain: 'example.com', purpose: 'x', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    expect(list.has('https://example.com/path?q=1')).toBe(true);
    expect(list.has('http://example.com/')).toBe(true);
  });

  it('matches subdomain', () => {
    const list = new Allowlist([
      { domain: 'gov.uk', purpose: 'x', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    expect(list.has('https://hmrc.gov.uk/path')).toBe(true);
    expect(list.has('https://www.gov.uk/')).toBe(true);
  });

  it('rejects non-allowlisted domains', () => {
    const list = new Allowlist([
      { domain: 'example.com', purpose: 'x', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    expect(list.has('https://random-site.com/')).toBe(false);
    expect(list.has('https://example.com.evil.com/')).toBe(false); // suffix-trick
  });

  it('rejects malformed URLs', () => {
    const list = new Allowlist([
      { domain: 'example.com', purpose: 'x', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    expect(list.has('not a url')).toBe(false);
    expect(list.has('')).toBe(false);
  });

  it('lowercases the URL hostname before matching', () => {
    const list = new Allowlist([
      { domain: 'gov.uk', purpose: 'x', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    expect(list.has('https://HMRC.GOV.UK/path')).toBe(true);
  });
});

describe('Allowlist.lookup', () => {
  it('returns the most specific match (longest suffix wins)', () => {
    const list = new Allowlist([
      { domain: 'gov.uk', purpose: 'broad', ttl_class: 'generic', added_at: '2026-05-13' },
      { domain: 'hmrc.gov.uk', purpose: 'narrow', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    const entry = list.lookup('https://hmrc.gov.uk/x');
    expect(entry?.domain).toBe('hmrc.gov.uk');
    expect(entry?.purpose).toBe('narrow');
  });

  it('returns null for non-allowlisted URLs', () => {
    const list = new Allowlist([
      { domain: 'gov.uk', purpose: 'x', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    expect(list.lookup('https://other.com/')).toBeNull();
  });
});

describe('loadAllowlist + isOnAllowlist', () => {
  it('loadAllowlist returns an Allowlist with the parsed entries', () => {
    const p = writeYaml(GOOD_YAML);
    const list = loadAllowlist(p);
    expect(list.size).toBe(2);
    expect(list.has('https://example.com/')).toBe(true);
  });

  it('isOnAllowlist accepts pre-wrapped Allowlist instances', () => {
    const list = new Allowlist([
      { domain: 'example.com', purpose: 'x', ttl_class: 'generic', added_at: '2026-05-13' },
    ]);
    expect(isOnAllowlist('https://example.com/', list)).toBe(true);
    expect(isOnAllowlist('https://other.com/', list)).toBe(false);
  });
});
