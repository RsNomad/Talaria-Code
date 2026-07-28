import { execFileSync, spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, promises as fs, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckpointTracker, WorktreeScanTimeoutError } from './CheckpointTracker';
import { GitTimeoutError, __setSpawnForTests } from './gitProcess';
import { must } from '../../testing/must';

/** A stalled `git` child: never emits `close` unless a test does so explicitly. */
class FakeGitChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { on: (): void => undefined, write: (): void => undefined, end: (): void => undefined };
  kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true);
}

/** Read the tracker's on-disk metadata index (`<shadow>/index.json`). */
async function readDiskIndex(
  tracker: CheckpointTracker,
): Promise<{ currentBaselineId: string | null; checkpoints: { id: string }[] }> {
  const shadowDir = path.dirname(tracker.shadowGitDir);
  const raw = await fs.readFile(path.join(shadowDir, 'index.json'), 'utf8');
  return JSON.parse(raw) as { currentBaselineId: string | null; checkpoints: { id: string }[] };
}

/** Runs a REAL git command against the user-visible repo (test scaffolding only). */
function realGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Can this platform create a symlink/junction to a directory WITHOUT elevation?
 * (Plain symlinks need admin/Developer-Mode on Windows; NTFS junctions do not,
 * and Node reports them as `isSymbolicLink()`. On POSIX the `type` arg is
 * ignored and a normal dir symlink is made.) Used to gate the S-M1 escape test.
 */
function detectSymlinkSupport(): boolean {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-symcap-'));
    symlinkSync(os.tmpdir(), path.join(dir, 'l'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Can this platform create a file whose NAME contains a newline? (Illegal on Windows.) */
function detectNewlineFilenameSupport(): boolean {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-nlcap-'));
    writeFileSync(path.join(dir, 'a\nb.txt'), 'x');
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

const CAN_SYMLINK = detectSymlinkSupport();
const CAN_NEWLINE_FILENAME = detectNewlineFilenameSupport();

describe('CheckpointTracker', () => {
  let workspaceRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-ckpt-ws-'));
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-ckpt-store-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string | Buffer): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  async function readFile(relPath: string): Promise<string> {
    return fs.readFile(path.join(workspaceRoot, relPath), 'utf8');
  }

  async function fileExists(relPath: string): Promise<boolean> {
    try {
      await fs.access(path.join(workspaceRoot, relPath));
      return true;
    } catch {
      return false;
    }
  }

  describe('init', () => {
    it('works standalone (no alternates) when the workspace has no real .git', async () => {
      await writeFile('a.txt', 'hello');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);

      await tracker.init();

      expect(tracker.hasRealGitAlternates).toBe(false);
      // Still fully functional standalone. The public id is the tree hash plus
      // the turn ordinal (`<hash>-<ordinal>`) so no-change turns stay unique.
      const ckpt = (await tracker.snapshot(1, 'first'))!;
      expect(ckpt.id).toMatch(/^[0-9a-f]{40,64}-\d+$/);
    });

    it('links the shadow object store to the real repo via alternates, and can read through it', async () => {
      realGit(workspaceRoot, ['init', '--quiet']);
      realGit(workspaceRoot, ['config', 'user.email', 'a@b.c']);
      realGit(workspaceRoot, ['config', 'user.name', 'Test']);
      await writeFile('big.txt', 'unique-real-repo-content-xyz\n'.repeat(200));
      realGit(workspaceRoot, ['add', 'big.txt']);
      realGit(workspaceRoot, ['commit', '-q', '-m', 'seed']);
      const blobHash = realGit(workspaceRoot, ['rev-parse', 'HEAD:big.txt']).trim();

      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();

      expect(tracker.hasRealGitAlternates).toBe(true);

      // Prove the shadow repo can read an object that physically lives only
      // in the real repo's object store (the whole point of `alternates`).
      const shown = realGit(workspaceRoot, [
        '--git-dir',
        tracker.shadowGitDir,
        '--work-tree',
        workspaceRoot,
        'cat-file',
        '-p',
        blobHash,
      ]);
      expect(shown).toContain('unique-real-repo-content-xyz');
    });

    it('sets up alternates when the workspace is a subdirectory of an ancestor real repo (nested case)', async () => {
      realGit(workspaceRoot, ['init', '--quiet']);
      await writeFile('README.md', 'outer repo');
      const inner = path.join(workspaceRoot, 'inner');
      await fs.mkdir(inner, { recursive: true });

      const tracker = new CheckpointTracker(storageDir, inner);
      await tracker.init();

      expect(tracker.hasRealGitAlternates).toBe(true);
      const alternatesContent = await fs.readFile(
        path.join(tracker.shadowGitDir, 'objects', 'info', 'alternates'),
        'utf8',
      );
      const expectedObjectsDir = path.join(workspaceRoot, '.git', 'objects').replace(/\\/g, '/');
      expect(alternatesContent.trim().replace(/\\/g, '/')).toBe(expectedObjectsDir);
    });

    it('gracefully ignores nested .git dirs inside the workspace (submodule-like) instead of failing', async () => {
      // NOTE: deliberately NOT named "vendor" — that's one of the shared
      // `DEFAULT_IGNORE_PATTERNS` (build-artifact dirs), which would exclude
      // the whole subtree and defeat the point of this test.
      await writeFile('submod-dir/lib/.git/HEAD', 'ref: refs/heads/main\n');
      await writeFile('submod-dir/lib/file.txt', 'vendored v1');

      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckptA = (await tracker.snapshot(1, 'a'))!;

      // Change both the nested-.git internals and the real vendored file.
      await writeFile('submod-dir/lib/.git/HEAD', 'ref: refs/heads/other\n');
      await writeFile('submod-dir/lib/file.txt', 'vendored v2');
      const ckptB = (await tracker.snapshot(2, 'b'))!;

      const changed = await tracker.diff(ckptA.id, ckptB.id);
      const paths = changed.map((c) => c.path);
      expect(paths).toContain('submod-dir/lib/file.txt');
      expect(paths.some((p) => p.includes('.git'))).toBe(false);
    });
  });

  describe('snapshot + diff', () => {
    it('excludes ignored files and oversized files from the snapshot (invisible to diff)', async () => {
      await writeFile('src/index.ts', 'export const x = 1;');
      await writeFile('node_modules/pkg/index.js', 'module.exports = 1;');
      await writeFile('.gitignore', 'secret.txt\n');
      await writeFile('secret.txt', 'shh');
      await writeFile('big.bin', Buffer.alloc(3 * 1024 * 1024, 1)); // 3 MiB > 2 MiB cutoff

      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt = (await tracker.snapshot(1, 'baseline'))!;

      // Modify everything, including the excluded files.
      await writeFile('src/index.ts', 'export const x = 2;');
      await writeFile('node_modules/pkg/index.js', 'module.exports = 2;');
      await writeFile('secret.txt', 'still secret but changed');
      await writeFile('big.bin', Buffer.alloc(3 * 1024 * 1024, 2));

      const changed = await tracker.diff(ckpt.id);
      const paths = changed.map((c) => c.path);

      expect(paths).toEqual(['src/index.ts']);
    });

    it('diff(id, otherId) reports files changed between two checkpoints', async () => {
      await writeFile('a.txt', 'A1');
      await writeFile('b.txt', 'B1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;

      await writeFile('a.txt', 'A2');
      await writeFile('c.txt', 'C1');
      const ckpt2 = (await tracker.snapshot(2, 'second'))!;

      const changed = await tracker.diff(ckpt1.id, ckpt2.id);
      const byPath = Object.fromEntries(changed.map((c) => [c.path, c.status]));

      expect(byPath['a.txt']).toBe('modified');
      expect(byPath['c.txt']).toBe('added');
      expect(byPath['b.txt']).toBeUndefined();
    });

    it('rejects diff() for an unknown checkpoint id', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      await expect(tracker.diff('deadbeef')).rejects.toThrow(/not found/i);
    });
  });

  describe('list', () => {
    it('returns checkpoints newest-first with age/label/turnOrdinal/filesChanged', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      await tracker.snapshot(1, 'first');
      await writeFile('a.txt', 'A2');
      await tracker.snapshot(2, 'second');

      const { checkpoints } = await tracker.list();

      expect(checkpoints).toHaveLength(2);
      const newest = must(checkpoints[0], 'expected checkpoints[0] (newest-first)');
      const older = must(checkpoints[1], 'expected checkpoints[1] (newest-first)');
      expect(newest.label).toBe('second');
      expect(older.label).toBe('first');
      expect(newest.turnOrdinal).toBe(2);
      expect(typeof newest.age).toBe('string');
      expect(newest.age.length).toBeGreaterThan(0);
      expect(newest.filesChanged).toBe(1);
      expect(typeof newest.timestamp).toBe('string');
    });
  });

  describe('restore', () => {
    it('restores a prior checkpoint when the worktree is clean, and reports what changed', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;

      await writeFile('a.txt', 'A2');
      await tracker.snapshot(2, 'second');

      // Worktree currently matches checkpoint 2 exactly -> not dirty -> restore allowed.
      const result = await tracker.restore(ckpt1.id);

      expect(result.restored).toBe(true);
      if (result.restored) {
        expect(result.changedPaths).toContain('a.txt');
      }
      await expect(readFile('a.txt')).resolves.toBe('A1');
    });

    it('F1: refuses cleanly (no partial mutation) when a captured object was pruned from the store', async () => {
      await writeFile('a.txt', 'A1-original');
      await writeFile('b.txt', 'B1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;

      // Move the worktree forward so a restore to ckpt1 WOULD rewrite a.txt.
      await writeFile('a.txt', 'A2-current');
      await tracker.snapshot(2, 'second');

      // Simulate an external `gc --prune` reaping a captured leaf blob: find a
      // blob OID in ckpt1's tree and delete its loose object from the store.
      const tree = ckpt1.id.replace(/-\d+$/, '');
      const shadowGitDir = tracker.shadowGitDir;
      const lsTree = execFileSync('git', ['--git-dir', shadowGitDir, 'ls-tree', '-r', tree], {
        encoding: 'utf8',
      });
      const blobOid = /\bblob\s+([0-9a-f]+)\t/.exec(lsTree)?.[1];
      expect(blobOid).toBeTruthy();
      rmSync(path.join(shadowGitDir, 'objects', blobOid!.slice(0, 2), blobOid!.slice(2)), {
        force: true,
      });

      const baselineBefore = (await readDiskIndex(tracker)).currentBaselineId;

      const result = await tracker.restore(ckpt1.id);

      // Clean refusal at R1 — NOT the pre-fix partial-restore-then-throw.
      expect(result.restored).toBe(false);
      if (!result.restored) {
        expect(result.reason).toMatch(/missing/i);
      }
      // Worktree byte-identical and the baseline untouched (no desync).
      await expect(readFile('a.txt')).resolves.toBe('A2-current');
      expect((await readDiskIndex(tracker)).currentBaselineId).toBe(baselineBefore);
    });

    it('refuses to restore over uncommitted changes without force, and does not touch disk', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;

      await writeFile('a.txt', 'A2');
      const ckpt2 = (await tracker.snapshot(2, 'second'))!;
      await tracker.restore(ckpt1.id); // baseline is now ckpt1, worktree == 'A1'

      // Dirty edit with NO snapshot taken afterward.
      await writeFile('a.txt', 'UNSAVED-DIRTY-EDIT');

      const refused = await tracker.restore(ckpt2.id);
      expect(refused.restored).toBe(false);
      if (!refused.restored) {
        expect(refused.reason).toMatch(/force/i);
      }
      await expect(readFile('a.txt')).resolves.toBe('UNSAVED-DIRTY-EDIT');

      const forced = await tracker.restore(ckpt2.id, { force: true });
      expect(forced.restored).toBe(true);
      await expect(readFile('a.txt')).resolves.toBe('A2');
    });

    it('deletes files that were created after the restore target', async () => {
      await writeFile('keep.txt', 'keep');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;

      await writeFile('new-file.txt', 'created later');
      await tracker.snapshot(2, 'second');

      await tracker.restore(ckpt1.id);

      expect(await fileExists('new-file.txt')).toBe(false);
      expect(await fileExists('keep.txt')).toBe(true);
    });

    it('rejects restore() for an unknown checkpoint id', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      await expect(tracker.restore('deadbeef')).rejects.toThrow(/not found/i);
    });
  });

  describe('restore — P4 (C5, corr-M3): baseline persist is disk-first', () => {
    it('a failed baseline persist leaves the cache consistent with DISK — the next restore still dirty-guards', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      const ckpt1 = (await tracker.snapshot(1, 'one'))!;
      await writeFile('a.txt', 'v2');
      await tracker.snapshot(2, 'two');
      const targetTree = ckpt1.id.slice(0, ckpt1.id.lastIndexOf('-'));
      const baselineBefore = (await readDiskIndex(tracker)).currentBaselineId;

      // Fail exactly the persist that records the moved baseline (payload-matched so
      // the assertion survives Task 6 adding an earlier anchor persist to restore()).
      const realWriteFile = fs.writeFile.bind(fs);
      const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, ...rest) => {
        if (
          typeof data === 'string' &&
          String(file).includes('index.json.tmp-') &&
          data.includes(`"currentBaselineId": "${targetTree}"`)
        ) {
          throw new Error('simulated index write failure');
        }
        return realWriteFile(file as never, data as never, ...(rest as unknown as never[]));
      });
      try {
        await expect(tracker.restore(ckpt1.id)).rejects.toThrow('simulated index write failure');
      } finally {
        spy.mockRestore();
      }

      // Disk never recorded the move…
      expect((await readDiskIndex(tracker)).currentBaselineId).toBe(baselineBefore);
      // …and the cache agrees: the retry must DIRTY-GUARD (worktree=v1 vs recorded
      // baseline=v2), not silently proceed off a phantom in-memory baseline.
      const retry = await tracker.restore(ckpt1.id);
      expect(retry.restored).toBe(false);
      // Forcing is the honest way through, and it repairs disk.
      const forced = await tracker.restore(ckpt1.id, { force: true });
      expect(forced.restored).toBe(true);
      expect((await readDiskIndex(tracker)).currentBaselineId).toBe(targetTree);
    });
  });

  describe('P5 (A4): cache invalidation under the lock (cross-window)', () => {
    it("a second window's checkpoint rows survive this window's next snapshot (cache re-read under lock)", async () => {
      const windowA = new CheckpointTracker(storageDir, workspaceRoot);
      const windowB = new CheckpointTracker(storageDir, workspaceRoot); // same shadow dir
      await writeFile('f.txt', 'one');
      await windowA.snapshot(1, 'A1'); // A's cache: [1]
      await writeFile('f.txt', 'two');
      await windowB.snapshot(2, 'B2'); // disk: [1,2] — A's cache is now STALE
      await writeFile('f.txt', 'three');
      await windowA.snapshot(3, 'A3'); // OLD code: persists A's stale cache + row 3 → B2 erased

      const disk = await readDiskIndex(windowA);
      expect(disk.checkpoints.map((c) => c.id.slice(c.id.lastIndexOf('-') + 1))).toEqual(['1', '2', '3']);
    });
  });

  describe('P2: index schema — unified persistIndex construction preserves unknown fields', () => {
    it('fields unknown to snapshot() (redo, anchorSeq) survive a non-dedup snapshot persist (unified spread construction)', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      await tracker.snapshot(1, 'seed');

      // Simulate a future/other-window writer having persisted Phase-1 state.
      const shadowDir = path.dirname(tracker.shadowGitDir);
      const indexPath = path.join(shadowDir, 'index.json');
      const onDisk = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      onDisk.anchorSeq = 7;
      onDisk.redo = { anchorId: 'x-a7', cursorId: 'y-1' };
      await fs.writeFile(indexPath, JSON.stringify(onDisk, null, 2), 'utf8');

      await writeFile('a.txt', 'v2');
      await tracker.snapshot(2, 'next'); // P5 re-reads disk under the lock; the persist must KEEP the fields
      // (snapshot(2) has a positive ordinal — after Task 7 it will CLEAR `redo`, so
      // pin the field-preservation assertion on anchorSeq, which nothing clears.)
      const after = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      expect(after.anchorSeq).toBe(7);
      expect(after.checkpoints).toHaveLength(2);
    });
  });

  describe('P1 — anchor capture inside restore()', () => {
    it('undo right after a settled turn REUSES the newest row as the anchor — dedup cannot eat it (the P1 trap)', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      const before1 = (await tracker.snapshot(1, 'before'))!;
      await writeFile('a.txt', 'v2');
      const after1 = (await tracker.snapshot(1, undefined, { phase: 'after' }))!; // tree B (the forward tip)

      const result = await tracker.restore(before1.id); // live tree === B === newest row
      expect(result.restored).toBe(true);

      const disk = (await readDiskIndex(tracker)) as unknown as {
        checkpoints: { id: string }[];
        redo?: { anchorId: string; cursorId: string };
      };
      expect(disk.checkpoints).toHaveLength(2); // NO new row — the newest row IS the anchor
      expect(disk.redo).toEqual({ anchorId: after1.id, cursorId: before1.id });
      expect(await readFile('a.txt')).toBe('v1');
    });

    it('undo with a diverged worktree (forced) APPENDS an anchor row (phase anchor, id <tree>-a<seq>) and pins its ref BEFORE mutating files', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      const before1 = (await tracker.snapshot(1, 'before'))!;
      await writeFile('a.txt', 'v2');
      await tracker.snapshot(1, undefined, { phase: 'after' });
      await writeFile('a.txt', 'v3-manual'); // diverge past the baseline

      const refused = await tracker.restore(before1.id);
      expect(refused.restored).toBe(false); // dirty-guard still first — and NO anchor row on refusal
      expect((await readDiskIndex(tracker)).checkpoints).toHaveLength(2);

      const forced = await tracker.restore(before1.id, { force: true });
      expect(forced.restored).toBe(true);

      const disk = (await readDiskIndex(tracker)) as unknown as {
        checkpoints: { id: string; phase?: string; label?: string }[];
        redo?: { anchorId: string };
        anchorSeq?: number;
      };
      expect(disk.checkpoints).toHaveLength(3);
      const anchor = must(disk.checkpoints[2]);
      expect(anchor.phase).toBe('anchor');
      expect(anchor.label).toBe('Before restore');
      expect(anchor.id).toMatch(/^[0-9a-f]{40,64}-a1$/);
      expect(disk.anchorSeq).toBe(1);
      expect(disk.redo?.anchorId).toBe(anchor.id);
      // The dirty v3 state is really restorable: its tree is ref-pinned in the shadow.
      const refs = realGit(workspaceRoot, ['--git-dir', tracker.shadowGitDir, 'show-ref']);
      expect(refs).toContain(anchor.id.slice(0, anchor.id.lastIndexOf('-a')));
    });

    it('a deeper restore keeps the ORIGINAL anchor and moves only the cursor; restoring the anchor row consumes the pointer', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      const c1 = (await tracker.snapshot(1, 'one'))!;
      await writeFile('a.txt', 'v2');
      const c2 = (await tracker.snapshot(2, 'two'))!;
      await writeFile('a.txt', 'v3');
      const c3 = (await tracker.snapshot(3, 'three'))!; // forward tip

      await tracker.restore(c2.id); // first undo → anchor = c3
      let disk = (await readDiskIndex(tracker)) as unknown as { redo?: { anchorId: string; cursorId: string } };
      expect(disk.redo).toEqual({ anchorId: c3.id, cursorId: c2.id });

      await tracker.restore(c1.id); // deeper undo → anchor UNCHANGED, cursor moves
      disk = (await readDiskIndex(tracker)) as unknown as { redo?: { anchorId: string; cursorId: string } };
      expect(disk.redo).toEqual({ anchorId: c3.id, cursorId: c1.id });

      await tracker.restore(c3.id); // manual restore of the anchor row ≡ redo-all
      disk = (await readDiskIndex(tracker)) as unknown as { redo?: { anchorId: string; cursorId: string } };
      expect(disk.redo).toBeUndefined(); // pointer consumed
      expect(await readFile('a.txt')).toBe('v3');
    });
  });

  describe('Task 7 — forward-stack invalidation (never truncates the list)', () => {
    it('a new positive-ordinal snapshot clears the redo pointer WITHOUT truncating the checkpoint list (no Roo trap)', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      const c1 = (await tracker.snapshot(1, 'one'))!;
      await writeFile('a.txt', 'v2');
      await tracker.snapshot(2, 'two');
      await tracker.restore(c1.id); // undo → redo pointer set
      expect(((await readDiskIndex(tracker)) as unknown as { redo?: unknown }).redo).toBeDefined();

      await writeFile('a.txt', 'v1-then-new-turn');
      await tracker.snapshot(3, 'new turn'); // the C1 before-snapshot of the next turn

      const disk = (await readDiskIndex(tracker)) as unknown as { redo?: unknown; checkpoints: unknown[] };
      expect(disk.redo).toBeUndefined(); // pointer invalidated…
      expect(disk.checkpoints).toHaveLength(3); // …but NOTHING was truncated (rows 1, 2, 3)
    });

    it('a session-baseline snapshot (negative ordinal) leaves the redo pointer intact', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      const c1 = (await tracker.snapshot(1, 'one'))!;
      await writeFile('a.txt', 'v2');
      await tracker.snapshot(2, 'two');
      await tracker.restore(c1.id);

      await tracker.snapshot(-1, 'Session start'); // VS Code restart / New Session must not kill redo

      expect(((await readDiskIndex(tracker)) as unknown as { redo?: unknown }).redo).toBeDefined();
    });
  });

  describe('redo / redoAll (anchored redo)', () => {
    /** seed: c1(v1) → c2(v2) → c3(v3=forward tip), then undo to c1. */
    async function seedUndone(tracker: CheckpointTracker) {
      await writeFile('a.txt', 'v1');
      const c1 = (await tracker.snapshot(1, 'one'))!;
      await writeFile('a.txt', 'v2');
      const c2 = (await tracker.snapshot(2, 'two'))!;
      await writeFile('a.txt', 'v3');
      const c3 = (await tracker.snapshot(3, 'three'))!;
      await tracker.restore(c1.id);
      return { c1, c2, c3 };
    }

    it('redoAll(): restores the anchor tree and clears the pointer', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await seedUndone(tracker);
      const result = await tracker.redoAll();
      expect(result.restored).toBe(true);
      expect(await readFile('a.txt')).toBe('v3');
      expect((await tracker.list()).redo).toBeUndefined();
    });

    it('redo(): steps the cursor ONE stored row toward the anchor', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      const { c2, c3 } = await seedUndone(tracker);
      const step1 = await tracker.redo();
      expect(step1.restored).toBe(true);
      expect(await readFile('a.txt')).toBe('v2');
      expect((await tracker.list()).redo).toEqual({ anchorId: c3.id, cursorId: c2.id });
      const step2 = await tracker.redo();
      expect(step2.restored).toBe(true);
      expect(await readFile('a.txt')).toBe('v3'); // reached the anchor…
      expect((await tracker.list()).redo).toBeUndefined(); // …pointer consumed
    });

    it('R2: manual edits after undo make redo REFUSE without force (direction-agnostic dirty-guard) and succeed with force', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await seedUndone(tracker);
      await writeFile('a.txt', 'manual-edit-while-reverted');
      const refused = await tracker.redoAll();
      expect(refused.restored).toBe(false);
      expect(await readFile('a.txt')).toBe('manual-edit-while-reverted'); // untouched
      const forced = await tracker.redoAll({ force: true });
      expect(forced.restored).toBe(true);
      expect(await readFile('a.txt')).toBe('v3');
    });

    it('R1: a pruned anchor tree → honest {restored:false}, pointer cleared, worktree untouched', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      const { c3 } = await seedUndone(tracker);
      // Re-stage the CURRENT (undone, v1) worktree first: the undo's own
      // writeTreeFromWorktree left the v3 content staged in the WARM shadow
      // index, and `git gc` treats index-referenced objects (incl. cache-tree)
      // as reachable — without this step the prune below would silently keep
      // the anchor tree alive and the test would pass vacuously. A NEGATIVE
      // ordinal keeps the redo pointer intact (Task 7 rule 5).
      await tracker.snapshot(-9, 'probe restage');
      // Prune the anchor's tree out of the shadow store (simulates external gc/tamper).
      const anchorTree = c3.id.slice(0, c3.id.lastIndexOf('-'));
      realGit(workspaceRoot, ['--git-dir', tracker.shadowGitDir, 'update-ref', '-d', `refs/hermes/checkpoints/${anchorTree}`]);
      realGit(workspaceRoot, ['--git-dir', tracker.shadowGitDir, 'gc', '--prune=now']);

      const result = await tracker.redoAll();
      expect(result.restored).toBe(false);
      expect(result).toMatchObject({ reason: expect.stringContaining('no longer') });
      expect(await readFile('a.txt')).toBe('v1'); // nothing was touched
      expect((await tracker.list()).redo).toBeUndefined(); // honest: redo can never succeed → cleared
    });

    it('redo with no outstanding undo → {restored:false, reason: "No redo available."}', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      await tracker.snapshot(1, 'one');
      expect(await tracker.redo()).toEqual({ restored: false, reason: 'No redo available.' });
      expect(await tracker.redoAll()).toEqual({ restored: false, reason: 'No redo available.' });
    });

    it('restore() itself pre-checks the target tree exists (R1 for plain restores; state kept)', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'v1');
      const c1 = (await tracker.snapshot(1, 'one'))!;
      await writeFile('a.txt', 'v2');
      await tracker.snapshot(2, 'two');
      const tree1 = c1.id.slice(0, c1.id.lastIndexOf('-'));
      realGit(workspaceRoot, ['--git-dir', tracker.shadowGitDir, 'update-ref', '-d', `refs/hermes/checkpoints/${tree1}`]);
      realGit(workspaceRoot, ['--git-dir', tracker.shadowGitDir, 'gc', '--prune=now']);

      const result = await tracker.restore(c1.id);
      expect(result.restored).toBe(false); // clean refusal, not a mid-apply git error
      expect(await readFile('a.txt')).toBe('v2');
    });
  });

  describe('ref-lifetime retention invariant (Phase 3 prune contract)', () => {
    it('A→B→A: a recurring tree shares ONE ref across rows, and undo/redo cycles never delete any ref', async () => {
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await writeFile('a.txt', 'A');
      const c1 = (await tracker.snapshot(1, 'A'))!; // tree A
      await writeFile('a.txt', 'B');
      await tracker.snapshot(2, 'B'); // tree B
      await writeFile('a.txt', 'A');
      (await tracker.snapshot(3, 'A again'))!; // tree A AGAIN (A→B→A)

      const refsBefore = realGit(workspaceRoot, ['--git-dir', tracker.shadowGitDir, 'show-ref'])
        .trim().split('\n').filter((l) => l.includes('refs/hermes/checkpoints/'));
      expect(refsBefore).toHaveLength(2); // two distinct trees ⇒ two refs (shared by three rows)

      await tracker.restore(c1.id); // undo (anchor = row 3, same tree as row 1 — the shared-ref case)
      await tracker.redoAll(); // redo

      const refsAfter = realGit(workspaceRoot, ['--git-dir', tracker.shadowGitDir, 'show-ref'])
        .trim().split('\n').filter((l) => l.includes('refs/hermes/checkpoints/'));
      expect(refsAfter.sort()).toEqual(refsBefore.sort()); // refs are CREATE-ONLY: none deleted, none re-pointed

      // Every persisted row's tree is still ref-pinned (the refcount-sweep contract).
      const disk = (await readDiskIndex(tracker)) as unknown as { checkpoints: { id: string }[] };
      for (const row of disk.checkpoints) {
        const tree = row.id.slice(0, row.id.search(/-a?\d+$/));
        expect(refsAfter.some((l) => l.endsWith(`refs/hermes/checkpoints/${tree}`))).toBe(true);
      }
    });
  });

  describe('cleanup', () => {
    it('runs git gc without destroying checkpoint history (refs keep trees reachable)', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;
      await writeFile('a.txt', 'A2');
      await tracker.snapshot(2, 'second');

      await expect(tracker.cleanup(0)).resolves.toBeUndefined();

      const { checkpoints } = await tracker.list();
      expect(checkpoints).toHaveLength(2);

      // The older checkpoint's tree must still be intact/diffable after gc.
      const changed = await tracker.diff(ckpt1.id);
      expect(Array.isArray(changed)).toBe(true);
    });
  });

  describe('restore — dirty-guard hardening (review CRITICAL #1)', () => {
    it('overwrite direction: refuses to overwrite live oversized content no checkpoint captured, unless forced', async () => {
      // `.dat` is NOT in DEFAULT_IGNORE_PATTERNS, so inclusion is decided purely
      // by the size cutoff — the exact include/exclude boundary crossing.
      // 1 MiB "V1" — <= 2 MiB cutoff, so it IS captured in ckpt1.
      await writeFile('payload.dat', Buffer.alloc(1 * 1024 * 1024, 0x41)); // 'A'
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'v1'))!;

      // Grow to 3 MiB "V2" — now > 2 MiB cutoff, so it is EXCLUDED and never
      // captured by ckpt2 (or anywhere).
      await writeFile('payload.dat', Buffer.alloc(3 * 1024 * 1024, 0x42)); // 'B'
      await tracker.snapshot(2, 'v2-excluded');

      // currentTree (excludes payload.dat) === baseline ckpt2 (also excludes) ->
      // the naive tree-hash dirty check sees "clean" and would silently
      // overwrite the live 3 MiB with ckpt1's 1 MiB.
      const refused = await tracker.restore(ckpt1.id);
      expect(refused.restored).toBe(false);
      if (!refused.restored) expect(refused.reason).toMatch(/force/i);

      const afterRefuse = await fs.readFile(path.join(workspaceRoot, 'payload.dat'));
      expect(afterRefuse.length).toBe(3 * 1024 * 1024);
      expect(afterRefuse[0]).toBe(0x42);

      // Explicit force is the user opting into the loss.
      const forced = await tracker.restore(ckpt1.id, { force: true });
      expect(forced.restored).toBe(true);
      const afterForce = await fs.readFile(path.join(workspaceRoot, 'payload.dat'));
      expect(afterForce.length).toBe(1 * 1024 * 1024);
      expect(afterForce[0]).toBe(0x41);
    });

    it('remove direction: does NOT silently delete a live oversized file the target lacks', async () => {
      await writeFile('keep.txt', 'keep');
      // 3 MiB — excluded, never captured by ANY checkpoint.
      await writeFile('big.bin', Buffer.alloc(3 * 1024 * 1024, 0x43)); // 'C'
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!; // captured tree: {keep.txt}

      await writeFile('later.txt', 'created later');
      await tracker.snapshot(2, 'second'); // captured tree: {keep.txt, later.txt}

      // Clean wrt captured files, so restore proceeds without force.
      const res = await tracker.restore(ckpt1.id);
      expect(res.restored).toBe(true);

      // later.txt (captured in ckpt2) is rewound; big.bin (never captured) is
      // never touched by restore, so its live bytes survive intact.
      expect(await fileExists('later.txt')).toBe(false);
      expect(await fileExists('big.bin')).toBe(true);
      const stillBig = await fs.readFile(path.join(workspaceRoot, 'big.bin'));
      expect(stillBig.length).toBe(3 * 1024 * 1024);
      expect(stillBig[0]).toBe(0x43);
    });
  });

  describe('non-ASCII filenames (review IMPORTANT #2)', () => {
    it('round-trips a non-ASCII filename through snapshot -> diff -> restore', async () => {
      await writeFile('café.txt', 'accented-v1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;

      await writeFile('café.txt', 'accented-v2');
      const ckpt2 = (await tracker.snapshot(2, 'second'))!;

      // With core.quotepath's default and no -z, git would return a C-quoted
      // literal like `"caf\303\251.txt"` here, breaking the match.
      const changed = await tracker.diff(ckpt1.id, ckpt2.id);
      expect(changed.map((c) => c.path)).toContain('café.txt');

      const res = await tracker.restore(ckpt1.id);
      expect(res.restored).toBe(true);
      await expect(readFile('café.txt')).resolves.toBe('accented-v1');

      // No garbage-named sibling was written by a mis-parsed path.
      const entries = await fs.readdir(workspaceRoot);
      expect(entries.filter((e) => e.includes('caf')).sort()).toEqual(['café.txt']);
    });
  });

  describe('restore realpath/traversal guard (S-M1)', () => {
    (CAN_SYMLINK ? it : it.skip)(
      'refuses to write THROUGH an in-worktree symlink/junction that escapes the worktree',
      async () => {
        // A victim OUTSIDE the worktree that a restore must never touch.
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-ckpt-outside-'));
        await fs.writeFile(path.join(outside, 'victim.txt'), 'ORIGINAL-OUTSIDE');
        try {
          await writeFile('keep.txt', 'keep');
          await writeFile('sub/victim.txt', 'INSIDE-V1'); // captured under a REAL dir
          const tracker = new CheckpointTracker(storageDir, workspaceRoot);
          await tracker.init();
          const ckpt = (await tracker.snapshot(1, 'has-sub'))!;

          // Drop the real subtree + re-snapshot so restoring `ckpt` WRITES sub/victim.txt.
          await fs.rm(path.join(workspaceRoot, 'sub'), { recursive: true, force: true });
          await tracker.snapshot(2, 'no-sub');

          // Replace `sub/` with an escaping link (junction = no elevation on win32,
          // reported as a symlink by readdir so scanWorktree skips it).
          await fs.symlink(outside, path.join(workspaceRoot, 'sub'), 'junction');

          // Would, unguarded + forced, follow `sub` -> outside and clobber victim.txt.
          const res = await tracker.restore(ckpt.id, { force: true });

          expect(res.restored).toBe(true);
          if (res.restored) expect(res.skippedPaths ?? []).toContain('sub/victim.txt');

          // The out-of-worktree victim is intact — the escape was refused.
          await expect(fs.readFile(path.join(outside, 'victim.txt'), 'utf8')).resolves.toBe(
            'ORIGINAL-OUTSIDE',
          );
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      },
    );

    it('leaves a normal restore unaffected (no skips)', async () => {
      await writeFile('x.txt', 'X1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const c1 = (await tracker.snapshot(1, 'first'))!;
      await writeFile('x.txt', 'X2');
      await tracker.snapshot(2, 'second');

      const res = await tracker.restore(c1.id);
      expect(res.restored).toBe(true);
      if (res.restored) {
        expect(res.changedPaths).toContain('x.txt');
        expect(res.skippedPaths ?? []).toEqual([]);
      }
      await expect(readFile('x.txt')).resolves.toBe('X1');
    });
  });

  describe('restore — partial I/O failure honesty (T-C3, closes V-3)', () => {
    it('a write failure on one of several paths is disclosed via skippedPaths (not thrown), and the baseline still persists', async () => {
      await writeFile('a.txt', 'A1');
      await writeFile('b.txt', 'B1');
      await writeFile('c.txt', 'C1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!;
      const targetTree = ckpt1.id.slice(0, ckpt1.id.lastIndexOf('-'));

      await writeFile('a.txt', 'A2');
      await writeFile('b.txt', 'B2');
      await writeFile('c.txt', 'C2');
      await tracker.snapshot(2, 'second');

      // Inject a write failure for EXACTLY b.txt — a Fedora-realistic
      // ENOSPC/EACCES mid-apply — WITHOUT creating any real FS contention (per
      // T-C3's test-hygiene constraint: this file has a KNOWN Windows EBUSY
      // flake from real locking elsewhere; new tests must inject, never create,
      // a write failure).
      const bPath = path.join(workspaceRoot, 'b.txt');
      const realWriteFile = fs.writeFile.bind(fs);
      const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, ...rest) => {
        if (String(file) === bPath) {
          throw new Error("simulated EACCES: permission denied, open 'b.txt'");
        }
        return realWriteFile(file as never, data as never, ...(rest as unknown as never[]));
      });

      let result: Awaited<ReturnType<typeof tracker.restore>>;
      try {
        result = await tracker.restore(ckpt1.id);
      } finally {
        spy.mockRestore();
      }

      expect(result.restored).toBe(true);
      if (result.restored) {
        expect(result.changedPaths.sort()).toEqual(['a.txt', 'c.txt']);
        expect(result.skippedPaths ?? []).toEqual(['b.txt']);
      }

      // The baseline still moves to the target tree — the partial restore is
      // durably recorded, not silently discarded. Pre-fix (V-3): the throw
      // propagated OUT of restoreInternal before persistIndex(:702) ever ran,
      // so the index stayed pointed at the pre-restore (second-snapshot) tree.
      expect((await readDiskIndex(tracker)).currentBaselineId).toBe(targetTree);

      // The two paths that DID apply carry the target's content...
      await expect(readFile('a.txt')).resolves.toBe('A1');
      await expect(readFile('c.txt')).resolves.toBe('C1');
      // ...while the failed path is left exactly as it was (never partially written).
      await expect(readFile('b.txt')).resolves.toBe('B2');
    });
  });

  describe('newline-in-filename staging (S-M6b)', () => {
    (CAN_NEWLINE_FILENAME ? it : it.skip)(
      'captures + diffs + restores a file whose name contains a newline',
      async () => {
        const name = 'we\nird.txt';
        await writeFile(name, 'newline-name-v1');
        const tracker = new CheckpointTracker(storageDir, workspaceRoot);
        await tracker.init();
        const c1 = (await tracker.snapshot(1, 'first'))!;

        await writeFile(name, 'newline-name-v2');
        const c2 = (await tracker.snapshot(2, 'second'))!;

        // The newline-named path must appear as a SINGLE changed entry, not be
        // split by the pathspec delimiter into bogus paths.
        const changed = await tracker.diff(c1.id, c2.id);
        expect(changed.map((c) => c.path)).toContain(name);

        const res = await tracker.restore(c1.id);
        expect(res.restored).toBe(true);
        await expect(readFile(name)).resolves.toBe('newline-name-v1');
      },
    );
  });

  describe('newline-in-filename REMOVE path (M-5)', () => {
    (CAN_NEWLINE_FILENAME ? it : it.skip)(
      'drops a newline/control-char-named file from the index (NUL-delimited rm --cached) when it is deleted, and the tree reflects it',
      async () => {
        // A control char (tab) AND a newline in the name — both would be split by
        // the default LF/space pathspec delimiter into bogus pathspecs if the
        // remove path were not `--pathspec-file-nul --literal-pathspecs`.
        const name = 'rm\tme\nnow.txt';
        const survivor = 'keep.txt';
        await writeFile(survivor, 'K1');
        await writeFile(name, 'doomed-v1');
        const tracker = new CheckpointTracker(storageDir, workspaceRoot);
        await tracker.init();
        const c1 = (await tracker.snapshot(1, 'first'))!; // tree: {keep.txt, rm\tme\nnow.txt}

        // Delete the newline/tab-named file → it must leave the warm index via the
        // NUL-delimited `git rm --cached` REMOVE path (a plain `git add <list>`
        // would never notice a deleted file).
        await fs.rm(path.join(workspaceRoot, name));
        const c2 = (await tracker.snapshot(2, 'second'))!; // tree: {keep.txt}

        // If the remove path split the name, the stale entry would linger and the
        // diff would NOT show it deleted. Exactly-one deleted entry proves the
        // NUL-delimited removal targeted the right (single) path.
        const changed = await tracker.diff(c1.id, c2.id);
        expect(changed).toEqual([{ path: name, status: 'deleted' }]);

        // And restore round-trips: rewinding to c1 re-materializes the file.
        const res = await tracker.restore(c1.id, { force: true });
        expect(res.restored).toBe(true);
        await expect(readFile(name)).resolves.toBe('doomed-v1');
        await expect(readFile(survivor)).resolves.toBe('K1');
      },
    );
  });

  describe('checkpoint id uniqueness under dedup (W2-F2, supersedes the Z9 dup-id workaround)', () => {
    it('dedups a no-change snapshot: returns null, stores no duplicate row, restore-by-id intact', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const c1 = await tracker.snapshot(1);
      expect(c1).not.toBeNull();
      const c2 = await tracker.snapshot(2); // identical worktree -> identical write-tree -> deduped
      expect(c2).toBeNull();
      expect((await tracker.list()).checkpoints).toHaveLength(1);

      await writeFile('a.txt', 'A2');
      await tracker.snapshot(3);
      const res = await tracker.restore(c1!.id);
      expect(res.restored).toBe(true);
      await expect(readFile('a.txt')).resolves.toBe('A1');
    });

    it('A→B→A keeps ids unique (same tree may recur across ordinals, never within one)', async () => {
      await writeFile('a.txt', 'A');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      await tracker.snapshot(1);
      await writeFile('a.txt', 'B');
      await tracker.snapshot(1, undefined, { phase: 'after' });
      await writeFile('a.txt', 'A');
      await tracker.snapshot(2, undefined, { phase: 'after' }); // tree repeats turn 1's BEFORE tree
      const { checkpoints } = await tracker.list();
      expect(checkpoints).toHaveLength(3);
      expect(new Set(checkpoints.map((c) => c.id)).size).toBe(3);
    });

    it("defaults labels per phase ('Before turn N' / 'After turn N')", async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const before = await tracker.snapshot(7);
      expect(before!.label).toBe('Before turn 7');
      await writeFile('a.txt', 'A2');
      const after = await tracker.snapshot(7, undefined, { phase: 'after' });
      expect(after!.label).toBe('After turn 7');
    });
  });

  describe('W2-F2 Phase 0: after-snapshots + tree-hash dedup', () => {
    it('persists phase and exposes it on the public checkpoint; legacy rows stay phaseless', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      await tracker.snapshot(1); // before (default)
      await writeFile('a.txt', 'A2');
      await tracker.snapshot(1, 'agent finished', { phase: 'after' });
      const { checkpoints } = await tracker.list(); // newest first
      expect(checkpoints[0]).toMatchObject({ phase: 'after', label: 'agent finished', turnOrdinal: 1 });
      expect(must(checkpoints[1]).phase).toBe('before');
    });

    it('FORCE-FREE UNDO (the Phase 0 acceptance): after-snapshot captures the post-edit tree so restoring the before-point needs no force', async () => {
      await writeFile('a.txt', 'original');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const before = await tracker.snapshot(1, 'user prompt');
      await writeFile('a.txt', 'agent-edited');       // the agent's turn edits
      await writeFile('new.txt', 'agent-created');
      const after = await tracker.snapshot(1, undefined, { phase: 'after' });
      expect(after).not.toBeNull();

      const res = await tracker.restore(before!.id);  // NO force
      expect(res.restored).toBe(true);
      await expect(readFile('a.txt')).resolves.toBe('original');
      await expect(fs.access(path.join(workspaceRoot, 'new.txt'))).rejects.toThrow();
    });

    it('a deduped snapshot still refreshes a diverged currentBaselineId (restore → manual re-create → clean restore)', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const c1 = await tracker.snapshot(1);
      await writeFile('a.txt', 'A2');
      const c2 = await tracker.snapshot(1, undefined, { phase: 'after' });
      expect(c2).not.toBeNull();
      await tracker.restore(c1!.id);                  // baseline -> c1.tree
      await writeFile('a.txt', 'A2');                 // user manually re-creates c2's tree
      const deduped = await tracker.snapshot(2);      // tree === c2.tree -> null, but baseline MUST move
      expect(deduped).toBeNull();
      const res = await tracker.restore(c1!.id);      // clean guard: no force needed
      expect(res.restored).toBe(true);
    });
  });

  describe('W4-T5b: checkpoint-row session labels (DISPLAY-ONLY — R8)', () => {
    it('persists sessionLabel onto the row when provided, and surfaces it on the public checkpoint (list() too)', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();

      const ckpt = await tracker.snapshot(1, 'first', { sessionLabel: 'Session ab12cd34' });

      expect(ckpt!.sessionLabel).toBe('Session ab12cd34');
      const { checkpoints } = await tracker.list();
      expect(must(checkpoints[0]).sessionLabel).toBe('Session ab12cd34');
    });

    it('omits sessionLabel when not provided — legacy/no-label rows stay clean (no key at all, mirrors phase)', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();

      const ckpt = await tracker.snapshot(1, 'first');

      expect(ckpt).not.toHaveProperty('sessionLabel');
      const { checkpoints } = await tracker.list();
      expect(checkpoints[0]).not.toHaveProperty('sessionLabel');
    });

    it('sessionLabel never affects the (turnOrdinal, phase) correlation / id / dedup — two DIFFERENT session labels at consecutive ordinals still dedup on tree content alone', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();

      const c1 = await tracker.snapshot(1, undefined, { sessionLabel: 'Session AAAA' });
      expect(c1).not.toBeNull();
      // Identical worktree, a DIFFERENT session's label, a later ordinal —
      // still dedups (returns null, no row), proving sessionLabel plays no
      // part in the dedup/id computation (tree hash alone decides it).
      const c2 = await tracker.snapshot(2, undefined, { sessionLabel: 'Session BBBB' });
      expect(c2).toBeNull();
      const { checkpoints } = await tracker.list();
      expect(checkpoints).toHaveLength(1);
      expect(must(checkpoints[0]).sessionLabel).toBe('Session AAAA'); // the FIRST stored row's label, untouched by the deduped call
    });

    it('id stays exactly <tree>-<turnOrdinal>, never folded with sessionLabel', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();

      const withLabel = await tracker.snapshot(1, undefined, { sessionLabel: 'Session AAAA' });
      const [tree] = withLabel!.id.split('-');
      expect(withLabel!.id).toBe(`${tree}-1`);
    });
  });

  describe('object durability vs real-repo gc (S-M6g)', () => {
    it('keeps a checkpoint restorable after the real repo prunes a shared (borrowed) blob', async () => {
      realGit(workspaceRoot, ['init', '--quiet']);
      realGit(workspaceRoot, ['config', 'user.email', 'a@b.c']);
      realGit(workspaceRoot, ['config', 'user.name', 'Test']);
      // No trailing newline so autocrlf can't alter the blob: the shadow's
      // `git add` yields the SAME oid the real repo committed, so the blob is
      // genuinely BORROWED (physically only in the real repo) at snapshot time.
      await writeFile('foo.txt', 'V1-BORROWED-CONTENT');
      realGit(workspaceRoot, ['add', 'foo.txt']);
      realGit(workspaceRoot, ['commit', '-q', '-m', 'v1']);
      const b1 = realGit(workspaceRoot, ['rev-parse', 'HEAD:foo.txt']).trim();

      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      expect(tracker.hasRealGitAlternates).toBe(true);
      const ckpt1 = (await tracker.snapshot(1, 'v1'))!;

      // corr-I1: localization (`repack -a -d`) is now DEFERRED off the snapshot
      // barrier (debounced / on cleanup), so the checkpoint's borrowed objects
      // are not yet in the shadow store the instant snapshot() resolves. The
      // durability guarantee is that localization runs before a REAL gc — so we
      // flush it explicitly here (as extension activation's cleanup() or a
      // shutdown hook would) BEFORE pruning the real repo.
      await tracker.flushLocalization();

      // Rewrite real-repo history so the v1 blob/tree become unreachable, then prune.
      await writeFile('foo.txt', 'V2-CONTENT');
      realGit(workspaceRoot, ['add', 'foo.txt']);
      realGit(workspaceRoot, ['commit', '-q', '--amend', '--no-edit']);
      realGit(workspaceRoot, ['reflog', 'expire', '--expire=now', '--all']);
      realGit(workspaceRoot, ['gc', '--prune=now', '--quiet']);

      // Precondition: the real repo really dropped b1 (else this proves nothing).
      expect(() => realGit(workspaceRoot, ['cat-file', '-e', b1])).toThrow();

      // Only succeeds because the shadow kept its own copy of the borrowed objects.
      const res = await tracker.restore(ckpt1.id, { force: true });
      expect(res.restored).toBe(true);
      await expect(readFile('foo.txt')).resolves.toBe('V1-BORROWED-CONTENT');
    });
  });

  describe('object durability — auto-localization on the shortened debounce (I-2)', () => {
    afterEach(() => {
      __setSpawnForTests(null);
    });

    it('auto-localizes a borrowing snapshot via the debounce (NO explicit flush) so it survives a real-repo prune', async () => {
      realGit(workspaceRoot, ['init', '--quiet']);
      realGit(workspaceRoot, ['config', 'user.email', 'a@b.c']);
      realGit(workspaceRoot, ['config', 'user.name', 'Test']);
      await writeFile('foo.txt', 'V1-BORROWED-AUTO');
      realGit(workspaceRoot, ['add', 'foo.txt']);
      realGit(workspaceRoot, ['commit', '-q', '-m', 'v1']);
      const b1 = realGit(workspaceRoot, ['rev-parse', 'HEAD:foo.txt']).trim();

      // Record every git spawn so we can observe the debounce auto-fire a repack.
      const gitCalls: string[][] = [];
      __setSpawnForTests(
        ((command: string, args: string[], options: unknown) => {
          gitCalls.push([...args]);
          return realSpawn(command as never, args as never, options as never);
        }) as unknown as Parameters<typeof __setSpawnForTests>[0],
      );

      // Short debounce so localization auto-fires quickly — the I-2 window shrink.
      const tracker = new CheckpointTracker(storageDir, workspaceRoot, { localizeDebounceMs: 30 });
      await tracker.init();
      expect(tracker.hasRealGitAlternates).toBe(true);
      const ckpt1 = (await tracker.snapshot(1, 'v1'))!;

      // The debounce fires the localization repack on its OWN — we never call
      // flushLocalization() before this point (that is the whole I-2 property:
      // the earliest checkpoints become durable without a shutdown flush).
      await vi.waitFor(
        () => {
          expect(gitCalls.some((a) => a[0] === 'repack')).toBe(true);
        },
        { timeout: 3000, interval: 20 },
      );
      // Drain the queue so the auto repack is fully settled before we prune (no-op
      // localization if already done — it does NOT re-run repack).
      await tracker.flushLocalization();

      // Rewrite + prune the real repo so the borrowed v1 blob would vanish if the
      // shadow had not already copied it in on the debounced path.
      await writeFile('foo.txt', 'V2-CONTENT');
      realGit(workspaceRoot, ['add', 'foo.txt']);
      realGit(workspaceRoot, ['commit', '-q', '--amend', '--no-edit']);
      realGit(workspaceRoot, ['reflog', 'expire', '--expire=now', '--all']);
      realGit(workspaceRoot, ['gc', '--prune=now', '--quiet']);
      expect(() => realGit(workspaceRoot, ['cat-file', '-e', b1])).toThrow();

      const res = await tracker.restore(ckpt1.id, { force: true });
      expect(res.restored).toBe(true);
      await expect(readFile('foo.txt')).resolves.toBe('V1-BORROWED-AUTO');
      tracker.dispose();
    });
  });

  describe('wall-clock timeout on a stalled git (arch A#1 / C1-safe)', () => {
    afterEach(() => {
      __setSpawnForTests(null);
    });

    it('rejects the snapshot when git stalls, leaving currentBaselineId uncorrupted', async () => {
      await writeFile('a.txt', 'A1');
      // Small git timeout so the stalled write-tree fails fast in the test.
      const tracker = new CheckpointTracker(storageDir, workspaceRoot, { gitTimeoutMs: 300 });
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!; // real, succeeds

      const baselineBefore = (await readDiskIndex(tracker)).currentBaselineId;
      expect(baselineBefore).not.toBeNull();

      // Make ONLY `write-tree` hang (all other git calls run for real). write-tree
      // is the step whose completion gates `currentBaselineId`, so a stall here is
      // the exact C1-safety case: the baseline must NOT move.
      __setSpawnForTests(
        ((command: string, args: string[], options: unknown) => {
          if (Array.isArray(args) && args.includes('write-tree')) {
            return new FakeGitChild();
          }
          return realSpawn(command as never, args as never, options as never);
        }) as unknown as Parameters<typeof __setSpawnForTests>[0],
      );

      await writeFile('a.txt', 'A2-EDIT'); // give the (doomed) snapshot something to stage
      await expect(tracker.snapshot(2, 'second')).rejects.toBeInstanceOf(GitTimeoutError);

      // Baseline uncorrupted: no half-tree became the baseline, no phantom record.
      const after = await readDiskIndex(tracker);
      expect(after.currentBaselineId).toBe(baselineBefore);
      expect(after.checkpoints).toHaveLength(1);
      expect(must(after.checkpoints[0]).id).toBe(ckpt1.id);

      // The tracker's in-memory view agrees (fail-open: turn would proceed unprotected).
      const { checkpoints } = await tracker.list();
      expect(checkpoints).toHaveLength(1);
    });
  });

  describe('repack relocated OFF the snapshot barrier (corr-I1)', () => {
    afterEach(() => {
      __setSpawnForTests(null);
    });

    it('does not run repack (or read-tree --empty) inside snapshot(); runs repack on flush', async () => {
      // Real repo so the shadow borrows objects (localization is meaningful).
      realGit(workspaceRoot, ['init', '--quiet']);
      realGit(workspaceRoot, ['config', 'user.email', 'a@b.c']);
      realGit(workspaceRoot, ['config', 'user.name', 'Test']);
      await writeFile('foo.txt', 'BORROWED');
      realGit(workspaceRoot, ['add', 'foo.txt']);
      realGit(workspaceRoot, ['commit', '-q', '-m', 'seed']);

      const gitCalls: string[][] = [];
      __setSpawnForTests(
        ((command: string, args: string[], options: unknown) => {
          gitCalls.push([...args]);
          return realSpawn(command as never, args as never, options as never);
        }) as unknown as Parameters<typeof __setSpawnForTests>[0],
      );

      // Long debounce so the ONLY repack in this test is the explicit flush below.
      const tracker = new CheckpointTracker(storageDir, workspaceRoot, {
        localizeDebounceMs: 60_000,
      });
      await tracker.init();
      expect(tracker.hasRealGitAlternates).toBe(true);

      gitCalls.length = 0;
      await tracker.snapshot(1, 'v1');

      // The barrier's critical path ran NO repack and NO index-wiping read-tree.
      expect(gitCalls.some((a) => a[0] === 'repack')).toBe(false);
      expect(gitCalls.some((a) => a.includes('read-tree'))).toBe(false);

      // Localization still happens — on the deferred path.
      gitCalls.length = 0;
      await tracker.flushLocalization();
      expect(gitCalls.some((a) => a[0] === 'repack')).toBe(true);

      tracker.dispose();
    });
  });

  describe('scanWorktree wall-clock deadline (I-1 / arch A#1)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects the snapshot when the worktree walk wedges (fs never resolves) before any git subprocess, leaving currentBaselineId uncorrupted', async () => {
      await writeFile('a.txt', 'A1');
      // Small budget so the wedged walk fails fast. gitTimeoutMs IS the scan
      // deadline (I-1 reuses the same budget as the git ops).
      const tracker = new CheckpointTracker(storageDir, workspaceRoot, { gitTimeoutMs: 300 });
      await tracker.init();
      const ckpt1 = (await tracker.snapshot(1, 'first'))!; // real, succeeds

      const baselineBefore = (await readDiskIndex(tracker)).currentBaselineId;
      expect(baselineBefore).not.toBeNull();

      // Wedge the worktree walk itself: `fs.readdir` never resolves — the exact
      // NFS/sshfs / FS-stall the timeout comment cites. This step runs BEFORE any
      // git subprocess, so the git-child timeout can't fire; only a walk deadline
      // can bound it. (A late resolution must NOT set the baseline.)
      const readdirSpy = vi
        .spyOn(fs, 'readdir')
        .mockReturnValue(new Promise(() => undefined) as never);

      await writeFile('a.txt', 'A2-EDIT'); // give the (doomed) snapshot a real change
      await expect(tracker.snapshot(2, 'second')).rejects.toBeInstanceOf(WorktreeScanTimeoutError);
      readdirSpy.mockRestore();

      // C1-safe: the barrier rejected BEFORE write-tree, so no half-tree became
      // the baseline and no phantom record was written.
      const after = await readDiskIndex(tracker);
      expect(after.currentBaselineId).toBe(baselineBefore);
      expect(after.checkpoints).toHaveLength(1);
      expect(must(after.checkpoints[0]).id).toBe(ckpt1.id);

      // In-memory view agrees (fail-open: the turn would proceed unprotected).
      const { checkpoints } = await tracker.list();
      expect(checkpoints).toHaveLength(1);
    });
  });

  describe('warm index keeps the captured tree exact (corr-I1)', () => {
    afterEach(() => {
      __setSpawnForTests(null);
    });

    it('never runs read-tree --empty, yet captures add/modify/delete exactly across snapshots', async () => {
      await writeFile('keep.txt', 'K1');
      await writeFile('drop.txt', 'D1');

      const gitCalls: string[][] = [];
      __setSpawnForTests(
        ((command: string, args: string[], options: unknown) => {
          gitCalls.push([...args]);
          return realSpawn(command as never, args as never, options as never);
        }) as unknown as Parameters<typeof __setSpawnForTests>[0],
      );

      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const c1 = (await tracker.snapshot(1, 'first'))!; // {keep.txt, drop.txt}

      // modify keep.txt, DELETE drop.txt, ADD new.txt — the delete is the key
      // warm-index staleness risk (a plain `git add <list>` would miss it).
      await writeFile('keep.txt', 'K2');
      await fs.rm(path.join(workspaceRoot, 'drop.txt'));
      await writeFile('new.txt', 'N1');
      const c2 = (await tracker.snapshot(2, 'second'))!;

      // Warm-index invariant: the stat-cache is never wiped between snapshots.
      expect(gitCalls.some((a) => a.includes('read-tree'))).toBe(false);

      const byPath = Object.fromEntries((await tracker.diff(c1.id, c2.id)).map((c) => [c.path, c.status]));
      expect(byPath['keep.txt']).toBe('modified');
      expect(byPath['drop.txt']).toBe('deleted');
      expect(byPath['new.txt']).toBe('added');

      // And a restore round-trips exactly (proves the captured tree content is right).
      const restored = await tracker.restore(c1.id, { force: true });
      expect(restored.restored).toBe(true);
      await expect(readFile('keep.txt')).resolves.toBe('K1');
      await expect(readFile('drop.txt')).resolves.toBe('D1');
      expect(await fileExists('new.txt')).toBe(false);
    });

    it('drops a file from the tree when it crosses the size cutoff out of the tracked set', async () => {
      // 1 MiB <= 2 MiB cutoff → captured in c1.
      await writeFile('payload.dat', Buffer.alloc(1 * 1024 * 1024, 0x41));
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const c1 = (await tracker.snapshot(1, 'v1'))!;

      // Grow to 3 MiB > cutoff → now EXCLUDED. The warm index must drop the stale
      // entry via `git rm --cached` even though the file still exists on disk.
      await writeFile('payload.dat', Buffer.alloc(3 * 1024 * 1024, 0x42));
      const c2 = (await tracker.snapshot(2, 'v2'))!;

      const changed = await tracker.diff(c1.id, c2.id);
      expect(changed.map((c) => c.path)).toEqual(['payload.dat']);
      expect(must(changed[0]).status).toBe('deleted'); // gone from the captured set
      // The live file is untouched by the index removal (--cached).
      const live = await fs.readFile(path.join(workspaceRoot, 'payload.dat'));
      expect(live.length).toBe(3 * 1024 * 1024);
    });
  });

  describe('saveIndex failure leaves cache + baseline consistent with disk (corr-M3)', () => {
    it('a failed index write does not corrupt the in-memory index or baseline', async () => {
      await writeFile('a.txt', 'A1');
      const tracker = new CheckpointTracker(storageDir, workspaceRoot);
      await tracker.init();
      const c1 = (await tracker.snapshot(1, 'first'))!; // real, persisted

      const baselineBefore = (await readDiskIndex(tracker)).currentBaselineId;

      // Fail the NEXT atomic index write (the rename step of persistIndex).
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated ENOSPC'));

      await writeFile('a.txt', 'A2');
      await expect(tracker.snapshot(2, 'second')).rejects.toThrow(/ENOSPC/);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      renameSpy.mockRestore();

      // Cache is NOT ahead of disk: no phantom ckpt2, baseline unchanged.
      const { checkpoints: cached } = await tracker.list();
      expect(cached).toHaveLength(1);
      expect(must(cached[0]).id).toBe(c1.id);
      const disk = await readDiskIndex(tracker);
      expect(disk.currentBaselineId).toBe(baselineBefore);
      expect(disk.checkpoints).toHaveLength(1);

      // A subsequent successful snapshot yields exactly two records (the failed
      // one never lingered in memory to be silently persisted later).
      const c3 = (await tracker.snapshot(3, 'third'))!;
      const { checkpoints: after } = await tracker.list();
      expect(after.map((c) => c.id).sort()).toEqual([c1.id, c3.id].sort());
    });
  });
});
