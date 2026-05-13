/**
 * Output post-filter for LLM-emitted text grounded by ai-web-fetcher.
 *
 * Sub-item 3 of web-fetcher v1 (ai-ops-meta architect-backlog.md L360).
 *
 * Walks every URL the LLM put in its output and drops any sentence whose
 * URLs aren't tracked in the provenance set. This is the AP-1 mitigation
 * against hallucinated URLs — the LLM can quote text, but it cannot invent
 * a link the agent didn't actually fetch.
 *
 * The filter is sentence-scoped (not URL-scoped) because dropping a single
 * URL while keeping the surrounding sentence is the LLM's chance to claim
 * "the source supports X" without showing the source. The whole sentence
 * goes.
 *
 * The caller supplies:
 *  - `provenanceExists(sha)` — returns true iff a provenance row exists for
 *    that content hash. Backed by `WebFetcherCache.provenanceExists`.
 *  - `urlSha256` — URL → content-sha256 map the caller seeded from the cache
 *    after each fetch. URLs not in the map are dropped — we never trust an
 *    LLM-emitted URL that we didn't fetch ourselves.
 */

export interface PostFilterDeps {
  readonly provenanceExists: (contentSha256: string) => boolean;
  readonly urlSha256: ReadonlyMap<string, string>;
}

const SENTENCE_SPLIT_REGEX = /(?<=[.!?])\s+(?=[A-Z\d"(`])/;
const URL_REGEX = /https?:\/\/[^\s)\]<>'"]+/g;
const URL_TRAILING_PUNCT_REGEX = /[.,;:!?)\]]+$/;

/**
 * Return the input with any sentence containing an untracked URL removed.
 *
 * A "tracked" URL is one whose hostname matches a URL the caller has fetched
 * (its content-sha256 lives in `deps.urlSha256`) AND whose content-sha256
 * has a provenance row (`deps.provenanceExists` is true).
 *
 * Sentences with no URL at all pass through untouched — the post-filter is
 * narrowly scoped to URL-bearing sentences. A sentence with multiple URLs is
 * kept only if EVERY URL is tracked.
 */
export function dropUntrackedUrls(text: string, deps: PostFilterDeps): string {
  if (text.length === 0) return text;
  const sentences = text.split(SENTENCE_SPLIT_REGEX).filter((s) => s.trim().length > 0);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const urls = extractUrls(sentence);
    if (urls.length === 0) {
      kept.push(sentence);
      continue;
    }
    let allTracked = true;
    for (const u of urls) {
      const sha = deps.urlSha256.get(u);
      if (!sha || !deps.provenanceExists(sha)) {
        allTracked = false;
        break;
      }
    }
    if (allTracked) kept.push(sentence);
  }
  return kept.join(' ').trim();
}

function extractUrls(sentence: string): ReadonlyArray<string> {
  const matches = sentence.match(URL_REGEX) ?? [];
  return matches.map((u) => u.replace(URL_TRAILING_PUNCT_REGEX, ''));
}
