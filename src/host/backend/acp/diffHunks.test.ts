import { describe, it, expect } from 'vitest';
import { buildDiffHunks } from './diffHunks';
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
