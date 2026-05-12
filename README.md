# ai-web-fetcher

Allowlist-gated `external-read` web grounding for the ai-ops fleet. Brave Search API + plain HTTP GET + Mozilla Readability backends. Backs Phase 3 task body enrichment grounding when sections require external citation.

## Status

**Scaffold only.** No real fetching yet. Implementation tracked in [ai-ops-meta `architect-backlog.md`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/architect-backlog.md) under Phase 3 grounding-source agents (ships SECOND after `calendar-adviser`).

Design: [`docs/architecture.md` §6.8](https://github.com/hamlet-archer/ai-ops-meta/blob/main/docs/architecture.md) — introduces the `external-read` blast-radius tier added to §1 principle 5 in v0.45.

## Contracts

Accepts:
- [`web.search.v1`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/contracts/web.search.v1.json) — Brave Search API
- [`web.fetch.v1`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/contracts/web.fetch.v1.json) — plain HTTP GET + Mozilla Readability

## Allowlist + safety

- `registry/web-allowlist.yaml` in `ai-ops-meta` lists the ~15 seed domains. Boot self-check DNS-resolves and HEAD-probes every entry; failure = exit-1.
- Prompt-injection mitigations layered: render-then-ingest plaintext only; `<UNTRUSTED_WEB origin sha256>` delimiters in LLM prompts; constrained JSON output; per-fetch provenance row; output post-filter drops URLs not in provenance set.
- No headless browser, no LLM-built-in web search. Captcha/paywall returns flagged `low_signal: true`; Phase 3 emits "(external lookup unavailable for X)" rather than the captcha text (AP-1).

## Magic numbers (PATCH-EXPIRY 2026-08-10)

| Constant | Value |
|---|---|
| `WEB_OPS_PER_DAY` | 50 |
| `WEB_OPS_PER_TASK` | 5 |
| `WEB_BUDGET_USD_MONTH` | 5 |
| `WEB_FETCH_MAX_BYTES` | 200_000 |
| `WEB_FETCH_TIMEOUT_MS` | 8_000 |
| `TTL_INSURANCE_MED_S` | 86_400 |
| `TTL_AIRLINE_S` | 3_600 |
| `TTL_GENERIC_S` | 604_800 |

## Develop

```
npm install
npm test
npm run build
```
