import { describe, it, expect } from 'vitest';

import { mapChangesToRows, commitSubject } from './gitMappers';
import type { ChangeLike } from './gitMappers';

function change(fsPath: string): ChangeLike {
  return { uri: { fsPath } };
}

describe('mapChangesToRows — pure git.d.ts Change[] → changedPaths() row mapper', () => {
  it('empty input maps to an empty array', () => {
    expect(mapChangesToRows([], false)).toEqual([]);
  });

  it('maps uri.fsPath → path, and stamps every row with the given `staged` flag', () => {
    const rows = mapChangesToRows([change('/repo/a.ts'), change('/repo/b.ts')], true);
    expect(rows).toEqual([
      { path: '/repo/a.ts', staged: true },
      { path: '/repo/b.ts', staged: true },
    ]);
  });

  it('staged:false for workingTreeChanges-shaped input', () => {
    const rows = mapChangesToRows([change('/repo/c.ts')], false);
    expect(rows).toEqual([{ path: '/repo/c.ts', staged: false }]);
  });

  it('preserves input order', () => {
    const rows = mapChangesToRows([change('z'), change('a'), change('m')], false);
    expect(rows.map((r) => r.path)).toEqual(['z', 'a', 'm']);
  });

  it('is structurally satisfied by anything with a `.uri.fsPath` — no other Change field is read', () => {
    const wideChange = { uri: { fsPath: '/repo/wide.ts' }, status: 5, originalUri: {}, extra: 'ignored' };
    const rows = mapChangesToRows([wideChange as unknown as ChangeLike], true);
    expect(rows).toEqual([{ path: '/repo/wide.ts', staged: true }]);
  });
});

describe('commitSubject — pure Commit.message → subject-line extractor', () => {
  it('a single-line message is returned unchanged', () => {
    expect(commitSubject('fix: the bug')).toBe('fix: the bug');
  });

  it('a multi-line message keeps only the first line', () => {
    expect(commitSubject('fix: the bug\n\nLonger body text\nsecond body line')).toBe('fix: the bug');
  });

  it('an empty message maps to an empty string', () => {
    expect(commitSubject('')).toBe('');
  });

  it('a message that is a single trailing newline maps to an empty first line', () => {
    expect(commitSubject('\nbody')).toBe('');
  });
});
