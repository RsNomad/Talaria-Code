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
});
