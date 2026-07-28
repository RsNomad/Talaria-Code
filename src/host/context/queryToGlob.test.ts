import { describe, it, expect } from 'vitest';

import { queryToGlob } from './queryToGlob';

describe('queryToGlob — pure, safe substring → include-glob builder', () => {
  it('wraps a plain query in a **/*…* substring-match glob', () => {
    expect(queryToGlob('foo')).toBe('**/*foo*');
  });

  it('trims surrounding whitespace before wrapping', () => {
    expect(queryToGlob('  foo  ')).toBe('**/*foo*');
  });

  it('an empty query matches everything', () => {
    expect(queryToGlob('')).toBe('**/*');
  });

  it('a whitespace-only query matches everything', () => {
    expect(queryToGlob('   ')).toBe('**/*');
  });

  it('escapes glob metacharacters so a webview-supplied query is a literal substring, never a pattern (§2e)', () => {
    expect(queryToGlob('*')).toBe('**/*\\**');
    expect(queryToGlob('a?b')).toBe('**/*a\\?b*');
    expect(queryToGlob('[abc]')).toBe('**/*\\[abc\\]*');
    expect(queryToGlob('{a,b}')).toBe('**/*\\{a,b\\}*');
    expect(queryToGlob('(x)')).toBe('**/*\\(x\\)*');
    expect(queryToGlob('a!b')).toBe('**/*a\\!b*');
    expect(queryToGlob('a+b')).toBe('**/*a\\+b*');
    expect(queryToGlob('@foo')).toBe('**/*\\@foo*');
  });

  it('escapes a literal backslash in the query BEFORE any other char (order-safe single pass)', () => {
    expect(queryToGlob('a\\b')).toBe('**/*a\\\\b*');
  });

  it('a query attempting `**` traversal is neutralized to a literal substring', () => {
    expect(queryToGlob('**/etc/passwd')).toBe('**/*\\*\\*/etc/passwd*');
  });

  it('ordinary path separators and dots pass through unescaped', () => {
    expect(queryToGlob('src/foo.ts')).toBe('**/*src/foo.ts*');
  });
});
