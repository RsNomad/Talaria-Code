import { describe, it, expect } from 'vitest';
import { extractPreviewFiles } from './extractPreviewFiles';

describe('extractPreviewFiles — W2 T4 F-D: pure raw pre-hunk-derivation texts extractor', () => {
  it('extracts a single diff block', () => {
    expect(
      extractPreviewFiles([{ type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' }]),
    ).toEqual([{ path: 'src/a.ts', oldText: 'old', newText: 'new' }]);
  });

  it('extracts multiple diff blocks in order (multi-file edit)', () => {
    expect(
      extractPreviewFiles([
        { type: 'diff', path: 'a.ts', oldText: 'a-old', newText: 'a-new' },
        { type: 'diff', path: 'b.ts', oldText: null, newText: 'b-new' },
      ]),
    ).toEqual([
      { path: 'a.ts', oldText: 'a-old', newText: 'a-new' },
      { path: 'b.ts', oldText: null, newText: 'b-new' },
    ]);
  });

  it('ignores non-diff content blocks (text / terminal) interleaved with diffs', () => {
    expect(
      extractPreviewFiles([
        { content: { type: 'text', text: 'hello' } },
        { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
        { type: 'terminal', terminalId: 't1' },
      ]),
    ).toEqual([{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
  });

  it('returns [] for null/undefined/empty content', () => {
    expect(extractPreviewFiles(null)).toEqual([]);
    expect(extractPreviewFiles(undefined)).toEqual([]);
    expect(extractPreviewFiles([])).toEqual([]);
  });

  it('preserves oldText null (brand-new file) verbatim — no coercion', () => {
    expect(
      extractPreviewFiles([{ type: 'diff', path: 'new.ts', oldText: null, newText: 'fresh' }]),
    ).toEqual([{ path: 'new.ts', oldText: null, newText: 'fresh' }]);
  });

  it('does NOT derive hunks — the point is the raw pre-hunk texts, untouched', () => {
    const [file] = extractPreviewFiles([
      { type: 'diff', path: 'a.ts', oldText: 'line1\nline2', newText: 'line1\nline2\nline3' },
    ]);
    expect(file).toEqual({ path: 'a.ts', oldText: 'line1\nline2', newText: 'line1\nline2\nline3' });
    expect(file).not.toHaveProperty('hunks');
  });
});
