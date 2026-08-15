import { describe, expect, it } from 'vitest';

import { estimateTokenCount } from './tokenEstimate';

describe('estimateTokenCount', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('estimates ~4 chars per token, rounded up', () => {
    expect(estimateTokenCount('a'.repeat(400))).toBe(100);
    expect(estimateTokenCount('a'.repeat(401))).toBe(101);
    expect(estimateTokenCount('abc')).toBe(1);
  });

  it('is monotonically non-decreasing in text length', () => {
    const short = estimateTokenCount('a'.repeat(40));
    const long = estimateTokenCount('a'.repeat(4000));
    expect(long).toBeGreaterThan(short);
  });

  // AU-36:R14 — `len/4` badly undercounts CJK/emoji text (each such
  // character is ~1 token, not ~0.25), which lets `astChunker.ts` believe an
  // oversized non-ASCII-heavy chunk still fits the budget. CJK/emoji
  // characters must weigh ~1 token each; plain ASCII keeps the existing
  // ~4-chars/token estimate (asserted above) so healthy English/code text is
  // unaffected.
  describe('AU-36:R14 — CJK/emoji must not be undercounted', () => {
    it('counts CJK characters as ~1 token each, not ~4x undercounted', () => {
      const cjk = '你'.repeat(20); // 20x U+4F60 "你" (BMP, 1 UTF-16 unit each)
      // Old `len/4` gives ceil(20/4) = 5 — a 4x undercount. Real weight ~1/char.
      expect(estimateTokenCount(cjk)).toBe(20);
    });

    it('counts astral-plane emoji as ~1 token each (surrogate pairs, not 2 UTF-16 units)', () => {
      const emoji = '\u{1f600}'.repeat(10); // 10x 😀, each a surrogate pair (2 UTF-16 units)
      // Old `len/4` gives ceil(20/4) = 5 — undercounts by half. Real weight ~1/emoji.
      expect(estimateTokenCount(emoji)).toBe(10);
    });

    it('mixes ASCII (~4 chars/token) and CJK (~1 char/token) in one estimate', () => {
      const mixed = 'hello ' + '你好'; // 6 ASCII + 2 CJK ("你好")
      // ceil(6/4 + 2) = ceil(1.5 + 2) = 4. Old `len/4` gives ceil(8/4) = 2.
      expect(estimateTokenCount(mixed)).toBe(4);
    });
  });
});
