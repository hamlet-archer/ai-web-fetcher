/**
 * Tests for the Brave API key loader. AP-3 fail-loud — main.ts converts
 * `null` to a fatal-at-boot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadBraveApiKey } from '../lib/brave-api-key.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'brave-key-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadBraveApiKey', () => {
  it('returns the direct env var when set', () => {
    expect(loadBraveApiKey({ env: { BRAVE_SEARCH_API_KEY: 'k-direct' } })).toBe('k-direct');
  });

  it('returns the systemd LoadCredential file when env unset', () => {
    const credsDir = tmpDir;
    writeFileSync(join(credsDir, 'brave-api-key'), 'k-from-creds\n');
    expect(loadBraveApiKey({ env: { CREDENTIALS_DIRECTORY: credsDir } })).toBe('k-from-creds');
  });

  it('prefers the env var over the systemd file when both are present', () => {
    writeFileSync(join(tmpDir, 'brave-api-key'), 'k-from-creds');
    expect(
      loadBraveApiKey({
        env: { BRAVE_SEARCH_API_KEY: 'k-direct', CREDENTIALS_DIRECTORY: tmpDir },
      }),
    ).toBe('k-direct');
  });

  it('returns null when neither env nor file resolves (AP-3 fail-loud at boot)', () => {
    expect(loadBraveApiKey({ env: {} })).toBeNull();
  });

  it('returns null when CREDENTIALS_DIRECTORY is set but the file is missing', () => {
    expect(loadBraveApiKey({ env: { CREDENTIALS_DIRECTORY: tmpDir } })).toBeNull();
  });

  it('returns null when the credentials file exists but is empty', () => {
    writeFileSync(join(tmpDir, 'brave-api-key'), '   \n');
    expect(loadBraveApiKey({ env: { CREDENTIALS_DIRECTORY: tmpDir } })).toBeNull();
  });

  it('treats an empty env var as unset (falls through to CREDENTIALS_DIRECTORY)', () => {
    writeFileSync(join(tmpDir, 'brave-api-key'), 'k-fallback');
    expect(
      loadBraveApiKey({
        env: { BRAVE_SEARCH_API_KEY: '', CREDENTIALS_DIRECTORY: tmpDir },
      }),
    ).toBe('k-fallback');
  });
});
