import { describe, it, expect } from 'vitest';
import { buildDiffHunks, DIFF_TOO_LARGE_HEADER, MAX_LCS_CELLS } from './diffHunks';
import { must } from '../../../testing/must';

describe('buildDiffHunks', () => {
  it('returns no hunks for identical text', () => {
    expect(buildDiffHunks('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('treats a null oldText as a brand-new file (all additions)', () => {
    const hunks = buildDiffHunks(null, 'line1\nline2');
    expect(hunks).toHaveLength(1);
    expect(must(hunks[0])).toEqual({
      header: '@@ -0,0 +1,2 @@',
      lines: [
        { sign: '+', text: 'line1' },
        { sign: '+', text: 'line2' },
      ],
    });
  });

  it('produces a single hunk with context for a mid-file single-line change', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const newText = ['a', 'b', 'X', 'd', 'e'].join('\n');
    const hunks = buildDiffHunks(oldText, newText, 1);
    expect(hunks).toHaveLength(1);
    const hunk0 = must(hunks[0]);
    expect(hunk0.header).toBe('@@ -2,3 +2,3 @@');
    expect(hunk0.lines).toEqual([
      { sign: ' ', text: 'b' },
      { sign: '-', text: 'c' },
      { sign: '+', text: 'X' },
      { sign: ' ', text: 'd' },
    ]);
  });

  it('splits far-apart changes into separate hunks', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const lines = oldText.split('\n');
    lines[1] = 'CHANGED1';
    lines[18] = 'CHANGED18';
    const newText = lines.join('\n');
    const hunks = buildDiffHunks(oldText, newText, 2);
    expect(hunks).toHaveLength(2);
  });

  it('merges nearby changes into one hunk', () => {
    const oldText = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    const lines = oldText.split('\n');
    lines[3] = 'CHANGED3';
    lines[5] = 'CHANGED5';
    const newText = lines.join('\n');
    const hunks = buildDiffHunks(oldText, newText, 3);
    expect(hunks).toHaveLength(1);
  });

  it('handles a pure deletion (newText shorter, empty string allowed)', () => {
    const hunks = buildDiffHunks('a\nb\nc', 'a\nc', 0);
    // GNU-diff-style convention for a 0-count side: the line number is the
    // count of the OTHER file's lines already emitted before this point (here:
    // 1, since "a" precedes the deleted "b").
    expect(hunks).toEqual([
      {
        header: '@@ -2,1 +1,0 @@',
        lines: [{ sign: '-', text: 'b' }],
      },
    ]);
  });
});

describe('CA-02 (WS-AC): oversized inputs return a placeholder, never the O(n·m) matrix', () => {
  it('above MAX_LCS_CELLS: the fixed placeholder hunk (closed literal + bounded counts)', () => {
    // Pin the boundary constant itself (noUnusedLocals forbids an import
    // used only inside a string literal — this makes the doc a real read).
    expect(MAX_LCS_CELLS).toBe(25_000_000);
    // 5100×5100 lines → (5101)² ≈ 26.0M cells > 25M. NOTE: the RED run of
    // this test makes today's code actually compute the 26M-cell diff
    // (seconds + ~200MB transient) — expected once; GREEN returns instantly.
    const oldText = Array.from({ length: 5100 }, (_, i) => `old-${i}`).join('\n');
    const newText = Array.from({ length: 5100 }, (_, i) => `new-${i}`).join('\n');
    expect(buildDiffHunks(oldText, newText)).toEqual([
      {
        header: DIFF_TOO_LARGE_HEADER,
        lines: [{ sign: ' ', text: '(5100 → 5100 lines — too large to preview)' }],
      },
    ]);
  });

  it('an under-cap diff still produces real hunks (no false trip)', () => {
    const hunks = buildDiffHunks('a\nb\nc', 'a\nX\nc');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header).not.toBe(DIFF_TOO_LARGE_HEADER);
    expect(hunks[0]?.lines).toContainEqual({ sign: '+', text: 'X' });
  });

  it('the placeholder path is fast (no matrix allocation) — bounded wall-clock', () => {
    const oldText = Array.from({ length: 20_000 }, (_, i) => `o${i}`).join('\n');
    const newText = Array.from({ length: 20_000 }, (_, i) => `n${i}`).join('\n');
    const t0 = Date.now();
    const hunks = buildDiffHunks(oldText, newText);
    expect(Date.now() - t0).toBeLessThan(1000); // pre-fix this is a ~400M-cell OOM/stall
    expect(hunks[0]?.header).toBe(DIFF_TOO_LARGE_HEADER);
  });
});
