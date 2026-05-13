/**
 * Mozilla Readability wrapper + captcha/paywall heuristics for ai-web-fetcher.
 *
 * Sub-item 3 of web-fetcher v1 (ai-ops-meta architect-backlog.md L360).
 *
 * Two responsibilities:
 *   1. Parse the fetched HTML with `@mozilla/readability` over a `jsdom`
 *      document; surface the extracted main content as plain text + title.
 *   2. Apply heuristics that flag the doc `lowSignal: true` when the content
 *      looks like a captcha / paywall / sign-in wall — Phase 3 then emits
 *      `(external lookup unavailable for X)` per AP-1, never the captcha text.
 *
 * Heuristics (any one trips low-signal):
 *   - title matches `/sign[-\s]?in|log[-\s]?in|access denied|captcha/i`
 *   - first 500 chars of body match `/captcha|are you human|recaptcha|cloudflare ray id/i`
 *   - extracted plaintext < 200 chars (after trim)
 *
 * Why heuristics rather than HTTP-status checks: captcha / paywall pages
 * routinely return HTTP 200 with a "Sign in" body — the upstream Mozilla
 * Readability extractor is robust to most templated noise but cannot
 * distinguish "real article" from "paywall stub".
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export type ReadabilityLowSignalReason =
  | 'captcha_or_paywall'
  | 'empty'
  | 'parse_error';

export interface ReadabilityResult {
  readonly title: string | null;
  readonly plaintext: string;
  readonly lowSignal: boolean;
  readonly reason?: ReadabilityLowSignalReason;
}

const TITLE_CAPTCHA_REGEX = /\b(sign[-\s]?in|log[-\s]?in|access denied|captcha)\b/i;
const BODY_CAPTCHA_REGEX = /captcha|are you human|recaptcha|cloudflare ray id/i;
const BODY_PREFIX_SCAN_CHARS = 500;
const MIN_USEFUL_PLAINTEXT_CHARS = 200;

export function extractMainContent(html: string, url: string): ReadabilityResult {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url });
  } catch (e) {
    return {
      title: null,
      plaintext: '',
      lowSignal: true,
      reason: 'parse_error',
    };
  }

  let article: ReturnType<Readability['parse']> | null = null;
  try {
    article = new Readability(dom.window.document).parse();
  } catch (e) {
    return {
      title: null,
      plaintext: '',
      lowSignal: true,
      reason: 'parse_error',
    };
  }

  if (!article) {
    return {
      title: null,
      plaintext: '',
      lowSignal: true,
      reason: 'parse_error',
    };
  }

  const title = article.title?.trim() || null;
  const plaintext = (article.textContent ?? '').replace(/\s+/g, ' ').trim();

  if (title && TITLE_CAPTCHA_REGEX.test(title)) {
    return { title, plaintext, lowSignal: true, reason: 'captcha_or_paywall' };
  }
  if (BODY_CAPTCHA_REGEX.test(plaintext.slice(0, BODY_PREFIX_SCAN_CHARS))) {
    return { title, plaintext, lowSignal: true, reason: 'captcha_or_paywall' };
  }
  if (plaintext.length < MIN_USEFUL_PLAINTEXT_CHARS) {
    return { title, plaintext, lowSignal: true, reason: 'empty' };
  }

  return { title, plaintext, lowSignal: false };
}
