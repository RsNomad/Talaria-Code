import { describe, expect, it } from 'vitest';

import { missingObjects, type RunGit } from './objectClosure';

/** A fake {@link RunGit} that answers `ls-tree` and `cat-file --batch-check`. */
function fakeGit(cfg: {
  lsTree?: { code: number; stdout: string };
  missing?: ReadonlySet<string>; // OIDs the batch-check reports as `missing`
  onBatchInput?: (oids: string[]) => void;
}): RunGit {
  return async (args, opts) => {
    if (args[0] === 'ls-tree') {
      return cfg.lsTree ?? { code: 0, stdout: '' };
    }
    if (args[0] === 'cat-file' && args.includes('--batch-check')) {
      const oids = (opts?.input ?? '').split('\n').filter((s) => s.length > 0);
      cfg.onBatchInput?.(oids);
      const stdout =
        oids.map((o) => (cfg.missing?.has(o) ? `${o} missing` : `${o} blob 12`)).join('\n') + '\n';
      return { code: 0, stdout };
    }
    throw new Error(`fakeGit: unexpected git ${args.join(' ')}`);
  };
}

const TREE = 'a'.repeat(40);
const BLOB1 = 'b'.repeat(40);
const BLOB2 = 'c'.repeat(40);
const SUBTREE = 'd'.repeat(40);

/** One `ls-tree -z -r -t` entry: `<mode> <type> <oid>\t<path>\0`. */
function entry(type: 'blob' | 'tree', oid: string, p: string): string {
  const mode = type === 'tree' ? '040000' : '100644';
  return `${mode} ${type} ${oid}\t${p}\0`;
}

describe('missingObjects', () => {
  it('returns [] when the whole closure is present', async () => {
    const git = fakeGit({
      lsTree: { code: 0, stdout: entry('blob', BLOB1, 'a.ts') + entry('blob', BLOB2, 'b.ts') },
    });
    expect(await missingObjects(TREE, git)).toEqual([]);
  });

  it('returns the pruned leaf blob while ls-tree still exits 0', async () => {
    const git = fakeGit({
      lsTree: { code: 0, stdout: entry('blob', BLOB1, 'a.ts') + entry('blob', BLOB2, 'b.ts') },
      missing: new Set([BLOB2]),
    });
    expect(await missingObjects(TREE, git)).toEqual([BLOB2]);
  });

  it('reports the top tree itself when it is missing', async () => {
    const git = fakeGit({
      lsTree: { code: 0, stdout: entry('blob', BLOB1, 'a.ts') },
      missing: new Set([TREE]),
    });
    expect(await missingObjects(TREE, git)).toEqual([TREE]);
  });

  it('returns [tree] when a sub-tree is gone (ls-tree exits non-zero)', async () => {
    const git = fakeGit({ lsTree: { code: 128, stdout: '' } });
    expect(await missingObjects(TREE, git)).toEqual([TREE]);
  });

  it('parses OIDs correctly when a path contains a newline (the -z pin)', async () => {
    const git = fakeGit({
      lsTree: {
        code: 0,
        stdout: entry('blob', BLOB1, 'weird\nname.ts') + entry('tree', SUBTREE, 'dir'),
      },
    });
    expect(await missingObjects(TREE, git)).toEqual([]);
  });

  it('batch-checks the tree itself plus every listed OID, deduped', async () => {
    let seen: string[] = [];
    const git = fakeGit({
      lsTree: { code: 0, stdout: entry('blob', BLOB1, 'a.ts') + entry('blob', BLOB1, 'dup.ts') },
      onBatchInput: (oids) => {
        seen = oids;
      },
    });
    await missingObjects(TREE, git);
    expect(seen).toContain(TREE);
    expect(seen).toContain(BLOB1);
    expect(seen.filter((o) => o === BLOB1)).toHaveLength(1); // deduped
  });
});
