import { describe, it, expect } from 'vitest';

/**
 * WS-F3 F3-4 (FI-06, FI-27) — the DIRECT pins `nextEditEgress.ts`'s move
 * makes possible, mirroring `nextEditRoute.test.ts`'s pattern (kept in its
 * own file, not added to `nextedit.golden.pure.test.ts` /
 * `nextedit.golden.shell.test.ts`, so those two stay pristine/0-edit).
 *
 * `filterEgressableDiffs` was module-private in `shell.vscode.ts` as
 * `partitionEgressableDiffs`, so F3-1's golden could only pin the KEPT list
 * INDIRECTLY, via the algebraic identity `diffs.filter(d =>
 * diffMayEgress(d, sentinels))` applied to the exported `diffMayEgress`
 * (`nextedit.golden.pure.test.ts:284-295`) — it never called the wrapper
 * function by name. Now that `filterEgressableDiffs` is exported, this file
 * calls it directly, so a regression INSIDE the wrapper itself (not just the
 * predicate) is caught — the golden's identity pin would NOT catch, say, the
 * wrapper accidentally returning the dropped set instead of the kept one.
 *
 * `computeChangesAboveCursor` and `toContentChangeLites` also move here and
 * were never pinned directly by name in the F3-1 golden (only observed
 * indirectly through the `NextEditRequest` handed to the mocked backend), so
 * this file adds a direct pin for each.
 *
 * This module is pure (no `vscode`, no `./config`), so — unlike
 * `nextEditRoute.test.ts` — no `vi.mock` is needed at all.
 */
import { computeChangesAboveCursor, filterEgressableDiffs, toContentChangeLites, type ContentChangeLike } from './nextEditEgress';
import type { RecentDiff } from './types';

const SENTINELS = ['<|next|>', '<|editable_region_start|>'];

function makeDiff(over: Partial<RecentDiff>): RecentDiff {
  return {
    uri: 'file:///w/a.ts',
    filepath: 'a.ts',
    startLine: 0,
    endLine: 1,
    before: 'const a = 1;\n',
    after: 'const a = 2;\n',
    ...over,
  };
}

describe('filterEgressableDiffs (FI-27): returns the KEPT list only, .dropped is gone', () => {
  const CLEAN = makeDiff({});
  const SENTINEL_BEARING = makeDiff({ after: 'x <|next|> y' });
  const ABOVE_CURSOR_INSERTION = makeDiff({
    uri: 'file:///w/b.ts',
    filepath: 'b.ts',
    startLine: 0,
    endLine: 0,
    before: '',
    after: 'const inserted = true;\n',
  });
  const EMPTY = makeDiff({ before: '', after: '' });

  it('reach: the corpus mixes a dropped diff among kept ones', () => {
    const result = filterEgressableDiffs([CLEAN, SENTINEL_BEARING, ABOVE_CURSOR_INSERTION, EMPTY], SENTINELS);
    expect(result.length).toBeLessThan(4);
    expect(result.length).toBeGreaterThan(0);
  });

  it('drops the sentinel-bearing diff, keeps the rest, in order, with no `.dropped` field on the return value', () => {
    const result = filterEgressableDiffs([CLEAN, SENTINEL_BEARING, ABOVE_CURSOR_INSERTION, EMPTY], SENTINELS);
    expect(result).toEqual([CLEAN, ABOVE_CURSOR_INSERTION, EMPTY]);
    expect(Array.isArray(result)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, 'dropped')).toBe(false);
  });

  it('an empty input yields an empty kept list', () => {
    expect(filterEgressableDiffs([], SENTINELS)).toEqual([]);
  });
});

describe('computeChangesAboveCursor', () => {
  it('true when the most recent tracked diff for this uri ends strictly above the cursor line', () => {
    const diffs: readonly RecentDiff[] = [makeDiff({ uri: 'file:///w/a.ts', endLine: 2 })];
    expect(computeChangesAboveCursor(diffs, 'file:///w/a.ts', 5)).toBe(true);
  });

  it('false when the tracked diff ends AT the cursor line', () => {
    const diffs: readonly RecentDiff[] = [makeDiff({ uri: 'file:///w/a.ts', endLine: 5 })];
    expect(computeChangesAboveCursor(diffs, 'file:///w/a.ts', 5)).toBe(false);
  });

  it('false when the tracked diff ends BELOW the cursor line', () => {
    const diffs: readonly RecentDiff[] = [makeDiff({ uri: 'file:///w/a.ts', endLine: 9 })];
    expect(computeChangesAboveCursor(diffs, 'file:///w/a.ts', 5)).toBe(false);
  });

  it('false when no tracked diff exists for this uri', () => {
    const diffs: readonly RecentDiff[] = [makeDiff({ uri: 'file:///w/other.ts', endLine: 0 })];
    expect(computeChangesAboveCursor(diffs, 'file:///w/a.ts', 5)).toBe(false);
  });
});

describe('toContentChangeLites: ordering + newLineCount', () => {
  function change(startLine: number, character: number, endLine: number, text: string): ContentChangeLike {
    return { range: { start: { line: startLine, character }, end: { line: endLine } }, text };
  }

  it('sorts multi-part unsorted input DESCENDING by start position (line, then character tiebreak)', () => {
    const input: readonly ContentChangeLike[] = [
      change(1, 0, 1, 'a'),
      change(3, 5, 3, 'b'),
      change(3, 2, 3, 'c'),
      change(0, 0, 0, 'd'),
    ];
    const result = toContentChangeLites(input);
    expect(result.map((r) => r.startLine)).toEqual([3, 3, 1, 0]);
    // The two startLine===3 entries must break the tie on descending character.
    expect(result[0]).toEqual({ startLine: 3, endLine: 3, newLineCount: 1 });
    expect(result[1]).toEqual({ startLine: 3, endLine: 3, newLineCount: 1 });
  });

  it('computes newLineCount as (number of \\n in text) + 1', () => {
    const input: readonly ContentChangeLike[] = [change(0, 0, 0, 'no newline'), change(1, 0, 1, 'a\nb\nc')];
    const result = toContentChangeLites(input);
    const zero = result.find((r) => r.startLine === 0);
    const one = result.find((r) => r.startLine === 1);
    expect(zero?.newLineCount).toBe(1);
    expect(one?.newLineCount).toBe(3);
  });

  it('does not mutate the input array (copies before sorting) and leaves endLine intact', () => {
    const input: readonly ContentChangeLike[] = [change(5, 0, 6, 'x'), change(2, 0, 2, 'y')];
    const before = input.map((c) => c.range.start.line);
    toContentChangeLites(input);
    expect(input.map((c) => c.range.start.line)).toEqual(before);
    expect(toContentChangeLites(input).find((r) => r.startLine === 5)?.endLine).toBe(6);
  });
});
