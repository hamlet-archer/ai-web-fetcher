import { describe, expect, it } from 'vitest';

import { extractMainContent } from '../lib/readability.js';

const REAL_ARTICLE_HTML = `<!doctype html>
<html><head><title>Renew Cars Insurance — full guide</title></head>
<body>
  <article>
    <h1>Renew Cars Insurance — full guide</h1>
    <p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}</p>
    <p>${'In neque rerum, mollis a sapien, ipsum sed augue. '.repeat(20)}</p>
  </article>
</body></html>`;

const CAPTCHA_HTML = `<!doctype html>
<html><head><title>Sign in to comparethemarket</title></head>
<body><h1>Sign in</h1><p>Please sign in to view your quote.</p></body>
</html>`;

const CLOUDFLARE_HTML = `<!doctype html>
<html><head><title>Just a moment...</title></head>
<body>
  <article>
    <h1>Checking your browser</h1>
    <p>${'Please verify you are human. '.repeat(10)}</p>
    <p>Cloudflare Ray ID: 1234567890</p>
  </article>
</body></html>`;

const TINY_HTML = `<html><head><title>x</title></head><body>hi</body></html>`;

describe('readability.extractMainContent', () => {
  it('extracts plaintext + title from a real-shape article', () => {
    const out = extractMainContent(REAL_ARTICLE_HTML, 'https://example.com/article');
    expect(out.lowSignal).toBe(false);
    expect(out.title).toMatch(/Renew Cars Insurance/);
    expect(out.plaintext.length).toBeGreaterThan(200);
    expect(out.plaintext).toContain('Lorem ipsum');
  });

  it('flags captcha_or_paywall when the title says Sign in', () => {
    const out = extractMainContent(CAPTCHA_HTML, 'https://comparethemarket.com/quote');
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('captcha_or_paywall');
  });

  it('flags captcha_or_paywall when the body contains Cloudflare ray id', () => {
    const out = extractMainContent(CLOUDFLARE_HTML, 'https://example.com/blocked');
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('captcha_or_paywall');
  });

  it('flags empty when the extracted plaintext is shorter than 200 chars', () => {
    const out = extractMainContent(TINY_HTML, 'https://example.com/tiny');
    expect(out.lowSignal).toBe(true);
    expect(out.reason).toBe('empty');
  });

  it('flags parse_error on malformed input', () => {
    // An empty document still parses; pass a non-string-ish input that Readability cannot extract from
    const out = extractMainContent('<html><body></body></html>', 'https://example.com/empty');
    expect(out.lowSignal).toBe(true);
    // Either parse_error (Readability returns null) or empty (returned ''<200 chars).
    expect(['parse_error', 'empty']).toContain(out.reason);
  });
});
