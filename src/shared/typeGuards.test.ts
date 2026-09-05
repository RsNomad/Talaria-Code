import { describe, it, expect } from 'vitest';
import { asShape, isRecord } from './typeGuards';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('rejects null and undefined', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isRecord('x')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });

  it('rejects arrays (stricter than the errorText local copy — matches the control-plane copies)', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });
});

describe('asShape', () => {
  interface Point {
    x: number;
  }
  const isPoint = (v: unknown): v is Point => isRecord(v) && typeof v.x === 'number';

  it('returns the SAME reference when the guard passes (no copy, no coercion)', () => {
    const raw: unknown = { x: 1 };
    expect(asShape(raw, isPoint)).toBe(raw);
  });

  it('returns undefined when the guard refuses', () => {
    expect(asShape({ x: 'nope' }, isPoint)).toBeUndefined();
    expect(asShape(null, isPoint)).toBeUndefined();
    expect(asShape(undefined, isPoint)).toBeUndefined();
    expect(asShape([], isPoint)).toBeUndefined();
    expect(asShape('x=1', isPoint)).toBeUndefined();
  });

  it('narrows: the returned value is usable as T without a cast', () => {
    const shaped = asShape({ x: 2 } as unknown, isPoint);
    expect(shaped?.x).toBe(2);
  });
});
