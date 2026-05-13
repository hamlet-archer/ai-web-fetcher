/**
 * ai-web-fetcher entry point.
 *
 * State as of sub-item 2 (this PR): main runs the boot self-check (parse
 * `vendor/web-allowlist.yaml` → DNS resolve → HEAD probe). On success, it
 * logs boot OK and exits 0 — the RPC server itself ships in sub-item 4
 * once Brave Search + the HTTP-GET fetcher (sub-item 3) are wired through.
 *
 * Until sub-item 4, this is not a long-running service. The daily review
 * timer can invoke it to surface allowlist drift as an event in ops.db.
 */

import { promises as dnsPromises } from 'node:dns';

import { runBootCheckOrExit } from './boot-check.js';

async function main(): Promise<void> {
  const allowlist = await runBootCheckOrExit({
    fetch: globalThis.fetch,
    dns: {
      resolve4: dnsPromises.resolve4,
      resolve6: dnsPromises.resolve6,
    },
  });
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'info',
      service: 'ai-web-fetcher',
      msg: 'boot_check_ok',
      allowlist_size: allowlist.size,
      next: 'sub_item_3_adapters_and_sub_item_4_rpc',
    }),
  );
  // Sub-items 3 + 4 will replace this exit with the long-running RPC server.
  process.exit(0);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
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
