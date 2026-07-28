import { describe, it, expect } from 'vitest';
import { sliceLines, isPureInsertionAboveCursor } from './shared';

describe('sliceLines', () => {
  const text = 'aaa\nbbb\nccc\n';

  it('first line', () => expect(sliceLines(text, 0, 0)).toBe('aaa\n'));
  it('last line', () => expect(sliceLines(text, 2, 2)).toBe('ccc\n'));
  it('mid-file single line', () => expect(sliceLines(text, 1, 1)).toBe('bbb\n'));
  it('mid-file range spanning multiple lines, each terminator preserved', () =>
    expect(sliceLines(text, 0, 1)).toBe('aaa\nbbb\n'));
  it('whole file', () => expect(sliceLines(text, 0, 2)).toBe(text));

  describe('no trailing newline', () => {
    const noTrailing = 'aaa\nbbb\nccc';
    it('last line omits the terminator it never had', () =>
      expect(sliceLines(noTrailing, 2, 2)).toBe('ccc'));
    it('first line still keeps its own terminator', () =>
      expect(sliceLines(noTrailing, 0, 0)).toBe('aaa\n'));
    it('whole-file range reproduces the source exactly', () =>
      expect(sliceLines(noTrailing, 0, 2)).toBe(noTrailing));
  });

  it('out-of-range end clamps to the last line (no throw)', () =>
    expect(sliceLines(text, 1, 99)).toBe('bbb\nccc\n'));
  it('range entirely past the end returns empty', () =>
    expect(sliceLines(text, 5, 8)).toBe(''));
});

describe('isPureInsertionAboveCursor', () => {
  const block = 'aaa\nbbb\nccc\n';               // cursor on line 1 ("bbb") → relativeCursor = 4
  it('true: only new lines inserted above, cursor line + suffix intact', () =>
    expect(isPureInsertionAboveCursor(block, 'aaa\nNEW\nbbb\nccc\n', 4)).toBe(true));
  it('false: the cursor line itself changed', () =>
    expect(isPureInsertionAboveCursor(block, 'aaa\nBBB!\nccc\n', 4)).toBe(false));
  it('false: unchanged completion (no-op is a separate concern — 04 §1.5)', () =>
    expect(isPureInsertionAboveCursor(block, 'aaa\nbbb\nccc\n', 4)).toBe(false));
  it('relativeCursor === 0 does not read the LAST line via [-1] (the vendor reference bug)', () =>
    expect(isPureInsertionAboveCursor(block, 'X\naaa\nbbb\nccc\n', 0)).toBe(false));
  it('false: blank cursor line', () =>
    expect(isPureInsertionAboveCursor('aaa\n\nccc\n', 'aaa\nNEW\n\nccc\n', 4)).toBe(false));
});
