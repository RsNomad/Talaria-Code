import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { snippetSetHash } from './hash';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('snippetSetHash', () => {
  it('returns the same hash for the same set', () => {
    const snippets = [
      { uri: 'file:///a.ts', startLine: 0, endLine: 5, content: 'const a = 1;' },
      { uri: 'file:///b.ts', startLine: 10, endLine: 20, content: 'const b = 2;' },
    ];

    expect(snippetSetHash(snippets)).toBe(snippetSetHash(snippets));
  });

  it('returns a different hash when the set is reordered', () => {
    const a = { uri: 'file:///a.ts', startLine: 0, endLine: 5, content: 'const a = 1;' };
    const b = { uri: 'file:///b.ts', startLine: 10, endLine: 20, content: 'const b = 2;' };

    expect(snippetSetHash([a, b])).not.toBe(snippetSetHash([b, a]));
  });

  it('returns a different hash when snippet content changes', () => {
    const base = [
      { uri: 'file:///a.ts', startLine: 0, endLine: 5, content: 'const a = 1;' },
    ];
    const changed = [
      { uri: 'file:///a.ts', startLine: 0, endLine: 5, content: 'const a = 2;' },
    ];

    expect(snippetSetHash(base)).not.toBe(snippetSetHash(changed));
  });

  it('returns the fixed empty-set constant for an empty array', () => {
    expect(snippetSetHash([])).toBe('0000000000000000');
  });

  it('always returns exactly 16 hex characters', () => {
    const snippets = [
      { uri: 'file:///a.ts', startLine: 0, endLine: 5, content: 'const a = 1;' },
      { uri: 'file:///b.ts', startLine: 10, endLine: 20, content: 'const b = 2;' },
    ];

    expect(snippetSetHash(snippets)).toMatch(/^[0-9a-f]{16}$/);
    expect(snippetSetHash([])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('matches the documented canonical form (uri:startLine-endLine:sha256(content), joined by \\n)', () => {
    const snippets = [
      { uri: 'file:///a.ts', startLine: 0, endLine: 5, content: 'const a = 1;' },
      { uri: 'file:///b.ts', startLine: 10, endLine: 20, content: 'const b = 2;' },
    ];
    const canonical = snippets
      .map((s) => `${s.uri}:${s.startLine}-${s.endLine}:${sha256(s.content)}`)
      .join('\n');
    const expected = createHash('sha256')
      .update(canonical)
      .digest('hex')
      .slice(0, 16);

    expect(snippetSetHash(snippets)).toBe(expected);
  });
});
