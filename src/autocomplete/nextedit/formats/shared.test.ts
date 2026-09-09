import { describe, it, expect } from 'vitest';
import {
  sliceLines,
  isPureInsertionAboveCursor,
  splitLinesKeepingTerminators,
  relativeCursorOffset,
  DIFF_CHAR_BUDGET,
  renderBudgetedBlocks,
  trimAtFirstStopToken,
} from './shared';

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

// ═══════════════════════ WS-F4 F4-1 (FI-12) ═══════════════════════════════
// shared.ts gains the exported splitter's own test coverage (the
// lineSplitDrift.lock.test.ts 12-probe corpus, lifted here as real
// behavioural tests — critic I-14, before F4-2 deletes that lock) plus the
// four dialect-agnostic helpers moved/generalized out of sweepV2.ts and
// genericInstruct.ts.

describe('splitLinesKeepingTerminators — the drift lock\'s 12-probe corpus, now real tests (critic I-14)', () => {
  // Lifted verbatim from lineSplitDrift.lock.test.ts's CORPUS — the exact
  // same 12 inputs, so F4-2 can delete that lock without a coverage drop.
  const CORPUS: ReadonlyArray<{ name: string; input: string }> = [
    { name: 'empty string', input: '' },
    { name: 'single line, no terminator', input: 'alpha' },
    { name: 'single line with trailing \\n', input: 'alpha\n' },
    { name: 'two lines, no trailing terminator', input: 'alpha\nbeta' },
    { name: 'two lines, trailing terminator', input: 'alpha\nbeta\n' },
    { name: 'CRLF throughout', input: 'alpha\r\nbeta\r\n' },
    { name: 'mixed CRLF and LF', input: 'alpha\r\nbeta\ngamma\r\n' },
    { name: 'lone CR (old-Mac)', input: 'alpha\rbeta' },
    { name: 'consecutive blank lines', input: 'alpha\n\n\nbeta\n' },
    { name: 'leading blank line', input: '\nalpha\n' },
    { name: 'only newlines', input: '\n\n\n' },
    { name: 'trailing whitespace before terminator', input: 'alpha   \nbeta\t\n' },
  ];

  for (const probe of CORPUS) {
    it(`round-trips and keeps each line's own terminator on: ${probe.name}`, () => {
      const lines = splitLinesKeepingTerminators(probe.input);

      // Round-trip: joining a copy's own output must reproduce the input
      // exactly — this is what "keeping terminators" MEANS.
      expect(lines.join(''), `round-trip failed for ${JSON.stringify(probe.input)}`).toBe(probe.input);

      // Terminator contract: every line but the last keeps its own '\n';
      // the last line carries one iff the input itself ended with one.
      for (let i = 0; i < lines.length - 1; i++) {
        expect(lines[i]?.endsWith('\n'), `${probe.name}: line ${i} must keep its own terminator`).toBe(true);
      }
      if (lines.length > 0) {
        expect(
          lines[lines.length - 1]?.endsWith('\n'),
          `${probe.name}: the last line's terminator presence must match the input's`,
        ).toBe(probe.input.endsWith('\n'));
      }
    });
  }

  it('the corpus really discriminates (non-vacuity: not every probe collapses to the same partition)', () => {
    const outputs = new Set(CORPUS.map((c) => JSON.stringify(splitLinesKeepingTerminators(c.input))));
    expect(outputs.size, 'a corpus that maps every input to one output would rubber-stamp anything').toBeGreaterThan(
      6,
    );
  });
});

describe('relativeCursorOffset — clamp-at-each-edge (fail-closed)', () => {
  // Region content spans three lines, each 4 chars incl. terminator
  // ('aaa\n', 'bbb\n', 'ccc\n'), mapped onto document lines 5..7.
  const region = { uri: 'file:///a.ts', filepath: 'a.ts', startLine: 5, endLine: 7, content: 'aaa\nbbb\nccc\n' };

  it('cursor line BEFORE the region clamps to offset 0', () => {
    const cursor = { uri: 'file:///a.ts', line: 2, character: 0 };
    expect(relativeCursorOffset(region, cursor)).toBe(0);
  });

  it('cursor line PAST the last line clamps to the start of the last line', () => {
    const cursor = { uri: 'file:///a.ts', line: 999, character: 0 };
    expect(relativeCursorOffset(region, cursor)).toBe(8); // start of 'ccc\n'
  });

  it('cursor character PAST the line length clamps to the line end (before its terminator)', () => {
    const cursor = { uri: 'file:///a.ts', line: 6, character: 999 };
    expect(relativeCursorOffset(region, cursor)).toBe(7); // end of 'bbb', before its '\n'
  });

  it('a mid-region cursor returns the exact offset', () => {
    const cursor = { uri: 'file:///a.ts', line: 6, character: 1 };
    expect(relativeCursorOffset(region, cursor)).toBe(5); // 'aaa\n' (4) + 1 into 'bbb'
  });
});

describe('DIFF_CHAR_BUDGET', () => {
  it('is the 4,000-char budget both formats share', () => {
    expect(DIFF_CHAR_BUDGET).toBe(4000);
  });
});

describe('renderBudgetedBlocks — whole-item skip-not-crop, a break not a skip', () => {
  it('a small block placed AFTER an over-budget block is NOT included — the break stops the scan', () => {
    const items = ['tiny', 'X'.repeat(50), 'tiny'];
    const result = renderBudgetedBlocks(items, (x) => x, 10, '\n');
    expect(result, 'the break must stop the scan at the first over-budget item, never skip past it').toBe('tiny');
  });

  it('keeps every item that fits, joined by the separator', () => {
    const result = renderBudgetedBlocks(['a', 'b', 'c'], (x) => x, 100, ',');
    expect(result).toBe('a,b,c');
  });

  it('charges the separator length as part of the added cost, and is generic over T', () => {
    // 'a' costs 1 (no prior block); the second item would cost 1 (its own
    // length) + 1 (the ',' join) = 2 more, which does not fit in a budget
    // of 2 once 'a' has already used 1.
    const result = renderBudgetedBlocks([1, 2], (n) => String(n), 2, ',');
    expect(result).toBe('1');
  });
});

describe('trimAtFirstStopToken — sequential + order-sensitive over the running result', () => {
  it('sequential: a later stop searches the ALREADY-TRIMMED text (a return-after-first-match bug would stop too early)', () => {
    // 'Y' cuts 'aXbYc' down to 'aXb' first; 'X' is STILL present in that
    // already-trimmed result and cuts it further to 'a'. A loop that
    // returned right after its first match would stop at 'aXb'.
    expect(trimAtFirstStopToken('aXbYc', ['Y', 'X'])).toBe('a');
    expect(trimAtFirstStopToken('aXbYc', ['X', 'Y'])).toBe('a');
  });

  it('order-sensitive: swapping the stop order changes the result when a stop only fits within the FULL text', () => {
    // 'AB' occurs at index 0; 'BAB' occurs at index 1 but needs both of its
    // characters, so it is only findable while the running text still has
    // its full length (>= 4). Cutting 'AB' first empties the text before
    // 'BAB' is ever searched; cutting 'BAB' first leaves 'A', too short for
    // 'AB' (2 chars) to fit — proving the trim runs over the RUNNING text,
    // not a fixed set of positions computed once against the original.
    expect(trimAtFirstStopToken('ABAB', ['AB', 'BAB'])).toBe('');
    expect(trimAtFirstStopToken('ABAB', ['BAB', 'AB'])).toBe('A');
  });
});
