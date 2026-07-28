import { describe, it, expect } from 'vitest';
import {
  extractSingleBlockText,
  extractToolCallOutputText,
  extractDiffs,
  previewRawInput,
} from './contentBlocks';
import { must } from '../../../testing/must';

describe('extractSingleBlockText', () => {
  it('returns the text of a text block', () => {
    expect(extractSingleBlockText({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('returns empty string for non-text blocks or missing input', () => {
    expect(extractSingleBlockText({ type: 'image', data: 'x', mimeType: 'image/png' })).toBe('');
    expect(extractSingleBlockText(null)).toBe('');
    expect(extractSingleBlockText(undefined)).toBe('');
  });
});

describe('extractToolCallOutputText', () => {
  it('joins text blocks and ignores diff/terminal entries', () => {
    const content = [
      { content: { type: 'text', text: 'first' } },
      { type: 'diff' as const, path: 'a.ts', oldText: 'x', newText: 'y' },
      { content: { type: 'text', text: 'second' } },
      { type: 'terminal' as const, terminalId: 't-1' },
    ];
    expect(extractToolCallOutputText(content)).toBe('first\nsecond');
  });

  it('returns empty string for null/undefined/empty content', () => {
    expect(extractToolCallOutputText(null)).toBe('');
    expect(extractToolCallOutputText(undefined)).toBe('');
    expect(extractToolCallOutputText([])).toBe('');
  });
});

describe('extractDiffs', () => {
  it('extracts diff entries and computes hunks', () => {
    const content = [
      { content: { type: 'text', text: 'ignored' } },
      { type: 'diff' as const, path: 'src/a.ts', oldText: 'a\nb', newText: 'a\nB' },
    ];
    const diffs = extractDiffs(content);
    expect(diffs).toHaveLength(1);
    const diff0 = must(diffs[0]);
    expect(diff0.path).toBe('src/a.ts');
    expect(diff0.hunks.length).toBeGreaterThan(0);
  });

  it('returns [] when there are no diff entries', () => {
    expect(extractDiffs([{ content: { type: 'text', text: 'x' } }])).toEqual([]);
    expect(extractDiffs(null)).toEqual([]);
  });
});

describe('previewRawInput', () => {
  it('prefers well-known keys in priority order', () => {
    expect(previewRawInput({ command: 'npm test' })).toBe('npm test');
    expect(previewRawInput({ path: 'src/x.ts' })).toBe('src/x.ts');
  });

  it('falls back to JSON for arbitrary shapes and returns undefined for empty', () => {
    expect(previewRawInput({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(previewRawInput({})).toBeUndefined();
    expect(previewRawInput(null)).toBeUndefined();
    expect(previewRawInput(undefined)).toBeUndefined();
  });
});
