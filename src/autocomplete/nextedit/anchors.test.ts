import { describe, it, expect } from 'vitest';
import { regionAroundCursor, remapRange } from './anchors';

describe('regionAroundCursor', () => {
  it.each([
    [50, 200, 10, { startLine: 40, endLine: 60 }],
    [3, 200, 10, { startLine: 0, endLine: 13 }],       // clamp at file start
    [198, 200, 10, { startLine: 188, endLine: 199 }],  // clamp at file end
    [0, 1, 10, { startLine: 0, endLine: 0 }],          // one-line file
  ])('cursor %i in %i lines, ±%i', (cursor, count, win, expected) => {
    const r = regionAroundCursor(cursor, count, win);
    expect(r).toEqual(expected);
    expect(r.startLine).toBeLessThanOrEqual(cursor);
    expect(r.endLine).toBeGreaterThanOrEqual(cursor);
  });

  it.each([
    [5, 100, 0, { startLine: 5, endLine: 5 }],
    [5, 100, -2, { startLine: 5, endLine: 5 }],   // M-T3-1: must never invert
    [0, 1, -5, { startLine: 0, endLine: 0 }],
  ])('non-positive window degrades to a cursor-only region: cursor %i, %i lines, ±%i', (cursor, count, win, expected) => {
    const r = regionAroundCursor(cursor, count, win);
    expect(r).toEqual(expected);
    expect(r.startLine).toBeLessThanOrEqual(r.endLine);
  });
});

describe('remapRange', () => {
  const range = { startLine: 40, endLine: 60 };
  it('shifts down when a change above adds lines', () =>
    expect(remapRange(range, [{ startLine: 5, endLine: 7, newLineCount: 6 }]))
      .toEqual({ startLine: 43, endLine: 63 }));
  it('shifts up when a change above removes lines', () =>
    expect(remapRange(range, [{ startLine: 5, endLine: 10, newLineCount: 1 }]))
      .toEqual({ startLine: 35, endLine: 55 }));
  it('unchanged for a change entirely below', () =>
    expect(remapRange(range, [{ startLine: 70, endLine: 71, newLineCount: 5 }])).toEqual(range));
  it.each([
    [{ startLine: 60, endLine: 62, newLineCount: 3 }],
    [{ startLine: 39, endLine: 40, newLineCount: 2 }],
    [{ startLine: 45, endLine: 50, newLineCount: 6 }],
    [{ startLine: 30, endLine: 70, newLineCount: 41 }],
  ])('ANY overlap returns null (never guess a partial remap): %o', (change) =>
    expect(remapRange(range, [change])).toBeNull());
  it('applies multi-change sequences in event order and null-propagates', () => {
    expect(remapRange(range, [
      { startLine: 0, endLine: 0, newLineCount: 3 },
      { startLine: 100, endLine: 100, newLineCount: 1 },
    ])).toEqual({ startLine: 42, endLine: 62 });
    expect(remapRange(range, [
      { startLine: 0, endLine: 0, newLineCount: 3 },
      { startLine: 50, endLine: 51, newLineCount: 1 },   // overlaps the SHIFTED range
    ])).toBeNull();
  });
});
