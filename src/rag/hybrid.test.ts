import { describe, expect, it } from 'vitest';

import { rrfFuse } from './hybrid';
import { must } from '../testing/must';

describe('rrfFuse', () => {
  it('preserves order and scores a single list by 1/(k+rank)', () => {
    const fused = rrfFuse([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]], { k: 60 });

    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(must(fused[0]).score).toBeCloseTo(1 / 61);
    expect(must(fused[1]).score).toBeCloseTo(1 / 62);
    expect(must(fused[2]).score).toBeCloseTo(1 / 63);
  });

  it('an item appearing in both lists outranks one appearing in only one', () => {
    const vec = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const fts = [{ id: 'z' }, { id: 'b' }, { id: 'y' }];

    const fused = rrfFuse([vec, fts], { k: 60 });

    const byId = new Map(fused.map((f) => [f.id, f.score]));
    // b: rank 2 in both lists -> 2 * 1/62. a: rank 1 in vec only -> 1/61 (lower than b's combined score).
    expect(byId.get('b')).toBeCloseTo(2 * (1 / 62));
    expect(byId.get('b') as number).toBeGreaterThan(byId.get('a') as number);
    expect(must(fused[0]).id).toBe('b');
  });

  it('respects a custom k', () => {
    const fused = rrfFuse([[{ id: 'a' }]], { k: 1 });
    expect(must(fused[0]).score).toBeCloseTo(1 / 2);
  });

  it('applies per-list weights', () => {
    const fused = rrfFuse([[{ id: 'a' }], [{ id: 'b' }]], { k: 60, weights: [2, 1] });
    const byId = new Map(fused.map((f) => [f.id, f.score]));
    expect(byId.get('a')).toBeCloseTo(2 * (1 / 61));
    expect(byId.get('b')).toBeCloseTo(1 * (1 / 61));
  });

  it('returns [] for no lists / all-empty lists', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  it('includes an item present in only the second list', () => {
    const fused = rrfFuse([[{ id: 'a' }], [{ id: 'only-in-second' }]]);
    expect(fused.map((f) => f.id)).toContain('only-in-second');
  });
});
