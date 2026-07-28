import { describe, expect, it } from 'vitest';

import { chunkByLines } from './lineWindowChunker';
import { must } from '../../testing/must';

describe('chunkByLines', () => {
  it('returns [] for empty/whitespace-only content', () => {
    expect(chunkByLines('')).toEqual([]);
    expect(chunkByLines('   \n  \n')).toEqual([]);
  });

  it('returns a single chunk when content is shorter than the window', () => {
    const contents = ['a', 'b', 'c'].join('\n');
    const chunks = chunkByLines(contents, 40, 10);
    expect(chunks).toEqual([{ content: 'a\nb\nc', startLine: 0, endLine: 2 }]);
  });

  it('produces overlapping windows that fully cover the file', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const contents = lines.join('\n');

    const chunks = chunkByLines(contents, 4, 1);

    expect(chunks).toEqual([
      { content: lines.slice(0, 4).join('\n'), startLine: 0, endLine: 3 },
      { content: lines.slice(3, 7).join('\n'), startLine: 3, endLine: 6 },
      { content: lines.slice(6, 10).join('\n'), startLine: 6, endLine: 9 },
    ]);
  });

  it('the overlap between consecutive chunks equals overlapLines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const chunks = chunkByLines(lines.join('\n'), 40, 10);

    expect(must(chunks[0]).endLine - must(chunks[1]).startLine + 1).toBe(10);
    expect(must(chunks[1]).startLine).toBe(30);
    expect(must(chunks[chunks.length - 1]).endLine).toBe(99);
  });
});
