/**
 * Prompt-injection mitigation wrapper for ai-web-fetcher.
 *
 * Sub-item 3 of web-fetcher v1 (ai-ops-meta architect-backlog.md L360).
 *
 * Fetched plaintext is rendered into LLM prompts wrapped in
 * `<UNTRUSTED_WEB origin=<domain> sha256=<hex>>…</UNTRUSTED_WEB>` delimiters.
 * The LLM is then instructed to treat content inside the delimiter as data,
 * never as instruction.
 *
 * This is one layer of the prompt-injection defence stack described in
 * docs/architecture.md §6.8:
 *  - render-then-ingest (this module + Readability — never raw HTML to the LLM)
 *  - typed JSON output from the LLM (caller schema)
 *  - per-fetch provenance row (cache.ts)
 *  - output post-filter drops URLs not in provenance set (post-filter.ts)
 *
 * The helper is intentionally a typed function — not a freeform string —
 * because the consumer pattern "wrap user-supplied text in delimiters" is
 * exactly the prompt-injection trap if a `'>'` character in the plaintext
 * closes the tag prematurely. This wrapper escapes the close-bracket form.
 */

const CLOSE_TAG = '</UNTRUSTED_WEB>';
const ESCAPED_CLOSE_TAG = '<!- UNTRUSTED_WEB-ESCAPED -!>';

export interface UntrustedWebSegment {
  readonly origin: string;
  readonly sha256: string;
  readonly plaintext: string;
}

/**
 * Wrap fetched plaintext in the `<UNTRUSTED_WEB …>` delimiter.
 *
 * The caller passes:
 *  - `origin`  — `https://<host>` form, from `FetchedDocument.origin`.
 *  - `sha256`  — lowercase hex SHA256 of the canonicalised plaintext, from
 *                the same hash the cache + provenance row uses (sub-item 1's
 *                `content_sha256`).
 *  - `plaintext` — Readability output (sub-item 3's `extractMainContent`).
 *
 * The plaintext is scrubbed of any literal close-tag occurrences before
 * being placed inside the wrapper — a malicious page could otherwise emit
 * `</UNTRUSTED_WEB>` in its content to close the delimiter early.
 */
export function renderUntrustedWebSegment(segment: UntrustedWebSegment): string {
  const safe = segment.plaintext.replaceAll(CLOSE_TAG, ESCAPED_CLOSE_TAG);
  return `<UNTRUSTED_WEB origin=${segment.origin} sha256=${segment.sha256}>\n${safe}\n${CLOSE_TAG}`;
}
