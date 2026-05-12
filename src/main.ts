/**
 * ai-web-fetcher entry point — SCAFFOLD ONLY.
 *
 * See README + ai-ops-meta `architect-backlog.md` Phase 3 grounding-source
 * agents section. Design lives in `docs/architecture.md` §6.8 in the same
 * repo. Introduces the `external-read` blast-radius tier.
 *
 * When implemented, this file boots:
 *   1. Boot self-check (AP-3 + AP-4): DNS-resolve + HEAD-probe every entry in
 *      `registry/web-allowlist.yaml`. Failure = exit-1.
 *   2. Brave Search API client (search backend).
 *   3. Plain HTTP GET + Mozilla Readability (fetch backend).
 *   4. Unix-socket RPC server accepting `web.search.v1` + `web.fetch.v1`.
 *   5. Per-fetch provenance row + output post-filter (drops URLs not in
 *      provenance set).
 */

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'ai-web-fetcher',
      msg: 'scaffold_only',
      hint: 'see ai-ops-meta architect-backlog.md Phase 3 grounding-source agents',
    }),
  );
  process.exit(1);
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
