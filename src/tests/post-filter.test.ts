import { describe, expect, it } from 'vitest';

import { dropUntrackedUrls } from '../lib/post-filter.js';

function provenance(shas: ReadonlyArray<string>): (sha: string) => boolean {
  const set = new Set(shas);
  return (sha) => set.has(sha);
}

describe('post-filter.dropUntrackedUrls', () => {
  it('passes through sentences with no URL untouched', () => {
    const out = dropUntrackedUrls('First sentence. Second sentence. Third sentence.', {
      provenanceExists: provenance([]),
      urlSha256: new Map(),
    });
    expect(out).toBe('First sentence. Second sentence. Third sentence.');
  });

  it('drops sentences whose URL is unknown to the cache', () => {
    const txt = 'Real fact verified. According to https://hallucinated.example/x the sky is green. The verified part stays.';
    const out = dropUntrackedUrls(txt, {
      provenanceExists: provenance([]),
      urlSha256: new Map(),
    });
    expect(out).not.toContain('hallucinated.example');
    expect(out).toContain('Real fact verified');
    expect(out).toContain('The verified part stays');
  });

  it('drops sentences whose URL is in the cache map but has no provenance row', () => {
    const txt = 'According to https://example.com/x, premiums went up.';
    const out = dropUntrackedUrls(txt, {
      provenanceExists: provenance([]), // empty — no provenance for ANY sha
      urlSha256: new Map([['https://example.com/x', 'sha-of-x']]),
    });
    expect(out).toBe('');
  });

  it('keeps sentences whose URL is tracked AND has a provenance row', () => {
    const txt = 'According to https://example.com/x premiums went up. Unrelated trailing sentence.';
    const out = dropUntrackedUrls(txt, {
      provenanceExists: provenance(['sha-of-x']),
      urlSha256: new Map([['https://example.com/x', 'sha-of-x']]),
    });
    expect(out).toContain('https://example.com/x');
    expect(out).toContain('Unrelated trailing sentence');
  });

  it('strips trailing punctuation from URLs before lookup', () => {
    const txt = 'See https://example.com/x. Quoted fact.';
    const out = dropUntrackedUrls(txt, {
      provenanceExists: provenance(['sha-of-x']),
      urlSha256: new Map([['https://example.com/x', 'sha-of-x']]),
    });
    // URL stays in output; sentence kept; period preserved.
    expect(out).toContain('https://example.com/x');
  });

  it('drops a sentence when ANY URL inside is untracked', () => {
    const txt = 'Two sources: https://example.com/x and https://hallucinated.example/y agree.';
    const out = dropUntrackedUrls(txt, {
      provenanceExists: provenance(['sha-of-x']),
      urlSha256: new Map([['https://example.com/x', 'sha-of-x']]),
    });
    expect(out).toBe('');
  });
});
