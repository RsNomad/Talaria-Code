import { describe, expect, it } from 'vitest';

import { parseNameStatusZ } from './nameStatus';

describe('parseNameStatusZ (CKP-04)', () => {
  it('parses plain A/M/D records', () => {
    expect(parseNameStatusZ('A\0new.txt\0M\0mod.txt\0D\0gone.txt\0')).toEqual([
      { path: 'new.txt', status: 'added' },
      { path: 'mod.txt', status: 'modified' },
      { path: 'gone.txt', status: 'deleted' },
    ]);
  });

  it('RENAME emits deleted(OLDPATH) + modified(NEWPATH) — the CKP-04 landmine fix', () => {
    expect(parseNameStatusZ('R100\0old.txt\0new.txt\0')).toEqual([
      { path: 'old.txt', status: 'deleted' },
      { path: 'new.txt', status: 'modified' },
    ]);
  });

  it('COPY emits modified(NEWPATH) ONLY — the source still exists in the target tree and must NOT be deleted', () => {
    expect(parseNameStatusZ('C075\0src.txt\0copy.txt\0')).toEqual([
      { path: 'copy.txt', status: 'modified' },
    ]);
  });

  it('a 3-token R record never desynchronizes the token walk for following records', () => {
    expect(parseNameStatusZ('R100\0old.txt\0new.txt\0M\0after.txt\0')).toEqual([
      { path: 'old.txt', status: 'deleted' },
      { path: 'new.txt', status: 'modified' },
      { path: 'after.txt', status: 'modified' },
    ]);
  });

  it('empty / trailing-NUL input', () => {
    expect(parseNameStatusZ('')).toEqual([]);
    expect(parseNameStatusZ('\0')).toEqual([]);
  });
});
