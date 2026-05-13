/**
 * ai-web-fetcher entry point.
 *
 * Lifecycle:
 *   1. runBootCheck — parse allowlist YAML, DNS-resolve every domain,
 *      HEAD-probe each, fail loud on any drift.
 *   2. Open cache (better-sqlite3 at WEB_DB_PATH).
 *   3. startRpcServer — long-running Unix-socket daemon at /run/...
 *
 * `BRAVE_SEARCH_API_KEY` is loaded from env. systemd `LoadCredential`
 * exposes the secret via `CREDENTIALS_DIRECTORY/brave-api-key` in
 * production (sub-item 4b); for local dev, set BRAVE_SEARCH_API_KEY
 * directly. Boot fails loud (AP-3) if neither path resolves.
 *
 * Graceful shutdown: SIGTERM / SIGINT close the listener and remove the
 * socket file. systemd issues SIGTERM on `systemctl stop` + waits the
 * unit's `TimeoutStopSec` before SIGKILL.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promises as dnsPromises } from 'node:dns';

import { runBootCheck } from './boot-check.js';
import { WebFetcherCache } from './cache.js';
import { buildContractValidator } from './contracts.js';
import { loadBraveApiKey } from './lib/brave-api-key.js';
import { startRpcServer, type RunningRpcServer } from './rpc-server.js';

const DEFAULT_DB_PATH = '/var/lib/ai-web-fetcher/cache.db';
// systemd RuntimeDirectory=ai-web-fetcher creates /run/ai-web-fetcher/.
// /var/run is a compat symlink to /run on every modern systemd distribution.
const DEFAULT_SOCKET_PATH = '/run/ai-web-fetcher/query.sock';

async function main(): Promise<number> {
  const dbPath = process.env.WEB_DB_PATH ?? DEFAULT_DB_PATH;
  const socketPath = process.env.WEB_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;

  const braveApiKey = loadBraveApiKey();
  if (!braveApiKey) {
    // AP-3: fail loud at boot rather than at first search call.
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-web-fetcher',
        phase: 'boot',
        msg: 'brave_api_key_missing',
        hint: 'set BRAVE_SEARCH_API_KEY env var OR provision via systemd LoadCredential (CREDENTIALS_DIRECTORY/brave-api-key)',
      }),
    );
    return 1;
  }

  // 1. Boot self-check (allowlist parse + DNS + HEAD).
  const bootResult = await runBootCheck({
    fetch: globalThis.fetch,
    dns: {
      resolve4: dnsPromises.resolve4,
      resolve6: dnsPromises.resolve6,
    },
  });
  if (bootResult.status !== 'ok') {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-web-fetcher',
        phase: 'boot-check',
        msg: 'boot_check_failed',
        step: bootResult.step,
        dependency: bootResult.dependency,
        upstream_error: bootResult.upstreamError,
        ranked_causes: bootResult.rankedCauses,
      }),
    );
    return 1;
  }
  const allowlist = bootResult.allowlist;

  // 2. Open cache.
  const cache = new WebFetcherCache(dbPath);

  // 3. Long-running RPC server.
  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    try {
      await mkdir(socketDir, { recursive: true });
    } catch {
      // Best-effort. systemd RuntimeDirectory typically creates /run/...
    }
  }
  const validator = buildContractValidator();
  let running: RunningRpcServer;
  try {
    running = await startRpcServer({
      socketPath,
      cache,
      allowlist,
      validator,
      braveApiKey,
      fetch: globalThis.fetch,
      httpFetchDeps: { fetch: globalThis.fetch },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-web-fetcher',
        phase: 'rpc',
        msg: 'listen_failed',
        socket_path: socketPath,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    cache.close();
    return 1;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'ai-web-fetcher',
        phase: 'shutdown',
        msg: 'signal_received',
        signal,
      }),
    );
    try {
      await running.close();
    } finally {
      cache.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Keep the event loop alive — the RPC server is a long-running process.
  return await new Promise<number>(() => {});
}

// Only invoke main() when run as the entry point — tests import other
// modules in this file and must not trigger the long-running daemon.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('main.js') || process.argv[1].endsWith('main.ts'));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-web-fetcher',
        msg: 'unhandled_rejection',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(2);
  });
}
