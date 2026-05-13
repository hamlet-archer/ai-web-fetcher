import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBootCheck, type BootCheckDeps } from '../boot-check.js';

let tmpDir: string;
let allowlistPath: string;

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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-fetcher-boot-test-'));
  allowlistPath = join(tmpDir, 'allowlist.yaml');
  writeFileSync(allowlistPath, GOOD_YAML);
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeHappyDeps(): BootCheckDeps {
  return {
    fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    dns: {
      resolve4: vi.fn(async () => ['93.184.216.34']),
      resolve6: vi.fn(async () => []),
    },
    allowlistPath,
  };
}

describe('runBootCheck', () => {
  it('returns status=ok when allowlist parses, DNS resolves, and HEAD probes 200', async () => {
    const r = await runBootCheck(makeHappyDeps());
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.allowlist.size).toBe(2);
    }
  });

  it('returns status=fail step=parse when allowlist YAML is malformed', async () => {
    writeFileSync(allowlistPath, 'entries: []');
    const r = await runBootCheck(makeHappyDeps());
    expect(r.status).toBe('fail');
    if (r.status === 'fail') {
      expect(r.step).toBe('parse');
      expect(r.dependency).toContain('allowlist.yaml');
      expect(r.rankedCauses.length).toBeGreaterThan(1);
    }
  });

  it('returns status=fail step=parse when allowlist file is missing', async () => {
    const deps = {
      ...makeHappyDeps(),
      allowlistPath: '/no/such/file.yaml',
    };
    const r = await runBootCheck(deps);
    expect(r.status).toBe('fail');
    if (r.status === 'fail') {
      expect(r.step).toBe('parse');
    }
  });

  it('returns status=fail step=dns when a domain has no A nor AAAA records', async () => {
    const deps: BootCheckDeps = {
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      dns: {
        // gov.uk has no records in this test
        resolve4: vi.fn(async (d) => (d === 'example.com' ? ['1.2.3.4'] : [])),
        resolve6: vi.fn(async () => []),
      },
      allowlistPath,
    };
    const r = await runBootCheck(deps);
    expect(r.status).toBe('fail');
    if (r.status === 'fail') {
      expect(r.step).toBe('dns');
      expect(r.dependency).toBe('gov.uk');
      expect(r.entryIndex).toBe(1);
      expect(r.rankedCauses[0]).toMatch(/decommissioned|renamed/i);
    }
  });

  it('returns status=fail step=dns when DNS itself throws', async () => {
    const deps: BootCheckDeps = {
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      dns: {
        resolve4: vi.fn(async () => {
          throw new Error('DNS server unreachable');
        }),
        resolve6: vi.fn(async () => {
          throw new Error('DNS server unreachable');
        }),
      },
      allowlistPath,
    };
    const r = await runBootCheck(deps);
    expect(r.status).toBe('fail');
    if (r.status === 'fail') {
      expect(r.step).toBe('dns');
    }
  });

  it('returns status=fail step=head when HEAD returns 5xx', async () => {
    let callCount = 0;
    const deps: BootCheckDeps = {
      fetch: vi.fn(async () => {
        callCount++;
        // first call OK, second call 503
        return new Response(null, { status: callCount === 1 ? 200 : 503 });
      }) as unknown as typeof fetch,
      dns: {
        resolve4: vi.fn(async () => ['1.2.3.4']),
        resolve6: vi.fn(async () => []),
      },
      allowlistPath,
    };
    const r = await runBootCheck(deps);
    expect(r.status).toBe('fail');
    if (r.status === 'fail') {
      expect(r.step).toBe('head');
      expect(r.dependency).toBe('gov.uk');
      expect(r.upstreamError).toMatch(/503/);
    }
  });

  it('returns status=fail step=head when fetch throws (network error)', async () => {
    const deps: BootCheckDeps = {
      fetch: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
      dns: {
        resolve4: vi.fn(async () => ['1.2.3.4']),
        resolve6: vi.fn(async () => []),
      },
      allowlistPath,
    };
    const r = await runBootCheck(deps);
    expect(r.status).toBe('fail');
    if (r.status === 'fail') {
      expect(r.step).toBe('head');
      expect(r.upstreamError).toMatch(/ECONNRESET/);
    }
  });

  it('uses WEB_ALLOWLIST_PATH env override when no explicit path passed', async () => {
    const prev = process.env.WEB_ALLOWLIST_PATH;
    process.env.WEB_ALLOWLIST_PATH = allowlistPath;
    try {
      const deps: BootCheckDeps = {
        fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
        dns: {
          resolve4: vi.fn(async () => ['1.2.3.4']),
          resolve6: vi.fn(async () => []),
        },
        // No allowlistPath — env override kicks in.
      };
      const r = await runBootCheck(deps);
      expect(r.status).toBe('ok');
    } finally {
      if (prev === undefined) delete process.env.WEB_ALLOWLIST_PATH;
      else process.env.WEB_ALLOWLIST_PATH = prev;
    }
  });

  it('AAAA-only resolution is sufficient (no IPv4 record needed)', async () => {
    const deps: BootCheckDeps = {
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      dns: {
        resolve4: vi.fn(async () => []),
        resolve6: vi.fn(async () => ['2001:db8::1']),
      },
      allowlistPath,
    };
    const r = await runBootCheck(deps);
    expect(r.status).toBe('ok');
  });

  it('treats 3xx as a passing HEAD response', async () => {
    const deps: BootCheckDeps = {
      fetch: vi.fn(async () => new Response(null, { status: 301 })) as unknown as typeof fetch,
      dns: {
        resolve4: vi.fn(async () => ['1.2.3.4']),
        resolve6: vi.fn(async () => []),
      },
      allowlistPath,
    };
    const r = await runBootCheck(deps);
    expect(r.status).toBe('ok');
  });
});
