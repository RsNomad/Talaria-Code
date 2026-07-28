/*
 * F1a (path doc §7.1): `must()` is the test-file narrowing helper for
 * `noUncheckedIndexedAccess` fallout — a REAL runtime check (throws on
 * absence), not a `!` lie. This is its own characterization test: `must()`
 * must genuinely throw when the value is absent, not just satisfy the
 * compiler.
 */
import { describe, it, expect } from 'vitest';
import { must } from './must';

describe('must', () => {
  it('returns the value when it is present', () => {
    expect(must(42)).toBe(42);
    expect(must('x')).toBe('x');
    expect(must(0)).toBe(0); // falsy-but-present must not be treated as absent
    expect(must('')).toBe('');
    expect(must(false)).toBe(false);
  });

  it('throws when the value is undefined', () => {
    expect(() => must(undefined)).toThrow();
  });

  it('throws when the value is null', () => {
    expect(() => must(null)).toThrow();
  });

  it('includes the caller-supplied message in the thrown error', () => {
    expect(() => must(undefined, 'expected transcript[0] to exist')).toThrow(
      'expected transcript[0] to exist',
    );
  });

  it('throws a generic but identifiable message when no caller message is supplied', () => {
    expect(() => must(undefined)).toThrow(/must/i);
  });

  it('narrows an array element access at the type level (compile-time proof, exercised at runtime)', () => {
    const arr: number[] = [1, 2, 3];
    const second = must(arr[1]);
    // If `must` failed to narrow, `second + 1` below would be a type error
    // under noUncheckedIndexedAccess (arr[1] is `number | undefined`).
    expect(second + 1).toBe(3);
  });
});
