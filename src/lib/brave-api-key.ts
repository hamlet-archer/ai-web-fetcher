/**
 * Resolves the Brave Search API key from env or systemd LoadCredential.
 *
 * Sub-item 4b ships this helper. Production wires the key via systemd
 * `LoadCredential=brave-api-key:/etc/ai-web-fetcher/brave-api-key`; the
 * runtime path resolves via `$CREDENTIALS_DIRECTORY/brave-api-key`. Local
 * dev sets `BRAVE_SEARCH_API_KEY` directly.
 *
 * Returns `null` when neither source resolves — main.ts converts that to
 * a fatal-at-boot per AP-3 (fail loud, never silent fallback).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BraveApiKeyEnv {
  readonly env: NodeJS.ProcessEnv;
}

export function loadBraveApiKey(opts: BraveApiKeyEnv = { env: process.env }): string | null {
  const direct = opts.env.BRAVE_SEARCH_API_KEY;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const credsDir = opts.env.CREDENTIALS_DIRECTORY;
  if (typeof credsDir === 'string' && credsDir.length > 0) {
    const credPath = resolve(credsDir, 'brave-api-key');
    if (existsSync(credPath)) {
      try {
        const contents = readFileSync(credPath, 'utf8').trim();
        if (contents.length > 0) return contents;
      } catch {
        return null;
      }
    }
  }
  return null;
}
