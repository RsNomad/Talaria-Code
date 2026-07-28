import { describe, expect, it } from 'vitest';

import { fuseHybridRows, type StoredRow } from './fuseHybridRows';
import { must } from '../../testing/must';

function row(id: string, overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id,
    path: `src/${id}.ts`,
    startLine: 0,
    endLine: 1,
    content: `content-${id}`,
    language: 'typescript',
    ...overrides,
  };
}

describe('fuseHybridRows', () => {
  it('returns [] when both result pages are empty', () => {
    expect(fuseHybridRows([], [], 10)).toEqual([]);
  });

  it('ranks an item present in both pages above one present in only one', () => {
    const vecRows = [row('a'), row('b'), row('c')];
    const ftsRows = [row('z'), row('b'), row('y')];

    const hits = fuseHybridRows(vecRows, ftsRows, 10);

    expect(must(hits[0]).id).toBe('b');
  });

  it('truncates to the requested k', () => {
    const vecRows = [row('a'), row('b'), row('c'), row('d')];
    const hits = fuseHybridRows(vecRows, [], 2);
    expect(hits).toHaveLength(2);
  });

  it('carries through row data (path, lines, content, language) and a numeric score', () => {
    const vecRows = [row('a', { path: 'src/a.ts', startLine: 5, endLine: 9, content: 'hello', language: 'ts' })];
    const hits = fuseHybridRows(vecRows, [], 10);

    expect(hits[0]).toMatchObject({
      id: 'a',
      path: 'src/a.ts',
      startLine: 5,
      endLine: 9,
      content: 'hello',
      language: 'ts',
    });
    expect(typeof must(hits[0]).score).toBe('number');
  });

  it('prefers the vector-page row data when the same id appears in both pages', () => {
    const vecRows = [row('a', { content: 'from-vec' })];
    const ftsRows = [row('a', { content: 'from-fts' })];

    const hits = fuseHybridRows(vecRows, ftsRows, 10);

    expect(must(hits[0]).content).toBe('from-vec');
  });
});
