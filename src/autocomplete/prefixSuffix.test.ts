import { describe, it, expect } from 'vitest';
import {
  constructPrefixSuffix,
  estimateTokens,
  pruneToBudget,
} from './prefixSuffix';
import type { PositionLike, TextDocumentLike } from './prefixSuffix';
import { must } from '../testing/must';

function fakeDoc(text: string): TextDocumentLike {
  return {
    getText: () => text,
    offsetAt: (pos: PositionLike) => {
      const lines = text.split('\n');
      let offset = 0;
      for (let i = 0; i < pos.line; i++) {
        offset += must(lines[i]).length + 1; // +1 for the stripped '\n'
      }
      return offset + pos.character;
    },
  };
}

describe('constructPrefixSuffix', () => {
  it('splits the document at the cursor offset', () => {
    const doc = fakeDoc('line0\nline1\nline2');
    const { prefix, suffix } = constructPrefixSuffix(doc, {
      line: 1,
      character: 2,
    });
    expect(prefix).toBe('line0\nli');
    expect(suffix).toBe('ne1\nline2');
  });

  it('handles the cursor at the very start of the document', () => {
    const doc = fakeDoc('hello world');
    const { prefix, suffix } = constructPrefixSuffix(doc, {
      line: 0,
      character: 0,
    });
    expect(prefix).toBe('');
    expect(suffix).toBe('hello world');
  });

  it('handles the cursor at the very end of the document', () => {
    const doc = fakeDoc('hello world');
    const { prefix, suffix } = constructPrefixSuffix(doc, {
      line: 0,
      character: 11,
    });
    expect(prefix).toBe('hello world');
    expect(suffix).toBe('');
  });
});

describe('estimateTokens', () => {
  it('approximates tokens at ~4 chars/token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abc')).toBe(1); // rounds up
  });
});

describe('pruneToBudget', () => {
  const opts = {
    maxPromptTokens: 100,
    prefixPercentage: 0.3,
    maxSuffixPercentage: 0.2,
  };
  // prefix budget = 30 tokens = 120 chars; suffix budget = 20 tokens = 80 chars

  it('leaves short prefix/suffix untouched', () => {
    const result = pruneToBudget('short prefix', 'short suffix', opts);
    expect(result.prefix).toBe('short prefix');
    expect(result.suffix).toBe('short suffix');
  });

  it('truncates an over-budget prefix, keeping the END (closest to the cursor)', () => {
    const longPrefix = 'x'.repeat(200);
    const result = pruneToBudget(longPrefix, '', opts);
    expect(result.prefix.length).toBe(120);
    expect(result.prefix).toBe('x'.repeat(120));
  });

  it('truncates an over-budget suffix, keeping the START (closest to the cursor)', () => {
    const longSuffix = 'y'.repeat(200);
    const result = pruneToBudget('', longSuffix, opts);
    expect(result.suffix.length).toBe(80);
    expect(result.suffix).toBe('y'.repeat(80));
  });

  it('prunes both independently when both are over budget', () => {
    const result = pruneToBudget('a'.repeat(500), 'b'.repeat(500), opts);
    expect(result.prefix).toBe('a'.repeat(120));
    expect(result.suffix).toBe('b'.repeat(80));
  });
});
