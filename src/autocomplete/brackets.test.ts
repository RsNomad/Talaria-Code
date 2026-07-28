import { describe, it, expect } from 'vitest';
import { balanceBrackets } from './brackets';

describe('balanceBrackets', () => {
  it('leaves a fully-balanced completion untouched', () => {
    expect(balanceBrackets('foo(a, b)', '', '')).toBe('foo(a, b)');
  });

  it('leaves nested balanced brackets untouched', () => {
    expect(balanceBrackets('{ if (x) { y() } }', '', '')).toBe(
      '{ if (x) { y() } }',
    );
  });

  it('truncates at an unmatched extra closing bracket', () => {
    expect(balanceBrackets('foo())', '', '')).toBe('foo()');
  });

  it('truncates at a mismatched closing bracket type', () => {
    expect(balanceBrackets('(]', '', '')).toBe('(');
  });

  it('allows an opening bracket to remain unclosed when the suffix already closes it', () => {
    // The file already has `)` right after the cursor, so the model's `(` doesn't
    // need to be closed within the completion itself.
    expect(balanceBrackets('foo(', '', ')')).toBe('foo(');
  });

  it('stops seeding from the suffix at the first non-bracket, non-space character', () => {
    // Suffix "= 1);" -> skip nothing (first char is not space/bracket) -> no seed,
    // so an unmatched ")" in the completion is NOT protected by this suffix.
    expect(balanceBrackets('foo())', '', '= 1);')).toBe('foo()');
  });

  it('skips leading spaces in the suffix while seeding', () => {
    expect(balanceBrackets('foo(', '', '  )')).toBe('foo(');
  });

  it('does not treat non-bracket characters in the completion specially', () => {
    expect(balanceBrackets('const x = 1; // done', '', '')).toBe(
      'const x = 1; // done',
    );
  });
});
