import { describe, it, expect } from 'vitest';
import { composePreviewKey, isSafePreviewId } from './previewIds';

describe('isSafePreviewId — CA-M17 (WS-BG)', () => {
  it.each(['sess-1', 'toolu_01AbC', 'edit-1', 'a.b:c'])('accepts the harness-generated id shape %s', (id) => {
    expect(isSafePreviewId(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['slash (URI delimiter)', 'a/b'],
    ['space (Map-key delimiter)', 'a b'],
    ['tab', 'a\tb'],
    ['newline', 'a\nb'],
  ])('refuses %s', (_label, id) => {
    expect(isSafePreviewId(id)).toBe(false);
  });
});

describe('composePreviewKey — the ONE compound-key constructor', () => {
  it('mints a key for safe ids and is injective on them', () => {
    const k1 = composePreviewKey('s1', 't1');
    const k2 = composePreviewKey('s2', 't1');
    const k3 = composePreviewKey('s1', 't2');
    expect(k1).toBe('s1 t1');
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it('refuses any unsafe half (the delimiter-aliasing class)', () => {
    expect(composePreviewKey('a', 'b c')).toBeUndefined();
    expect(composePreviewKey('a b', 'c')).toBeUndefined();
    expect(composePreviewKey('a/b', 'c')).toBeUndefined();
    expect(composePreviewKey('', 'c')).toBeUndefined();
    expect(composePreviewKey('a', '')).toBeUndefined();
  });
});
