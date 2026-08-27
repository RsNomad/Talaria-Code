import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { must } from '../../testing/must';
import { CheckpointTracker } from './CheckpointTracker';

const POSIX = process.platform !== 'win32';

/** Read the tracker's on-disk metadata index (same helper as CheckpointTracker.test.ts). */
async function readDiskIndex(tracker: CheckpointTracker): Promise<{
  currentBaselineId: string | null;
  checkpoints: { id: string; phase?: string }[];
  redo?: { anchorId: string; cursorId: string };
}> {
  const shadowDir = path.dirname(tracker.shadowGitDir);
  const raw = await fs.readFile(path.join(shadowDir, 'index.json'), 'utf8');
  return JSON.parse(raw) as never;
}

/** Recursive {relPath -> content} snapshot of a directory tree (mode captured on POSIX). */
async function treeSnapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        const content = await fs.readFile(abs, 'utf8');
        const mode = POSIX ? (await fs.stat(abs)).mode & 0o111 : 0;
        out.set(r, `${content}|x:${mode !== 0 ? 1 : 0}`);
      }
    }
  };
  await walk(root, '');
  return out;
}

describe('FUNC-CKPT-RESTORE characterization — full fixture-tree golden master', () => {
  let ws: string;
  let storage: string;
  let tracker: CheckpointTracker;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-char-ws-'));
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-char-st-'));
    tracker = new CheckpointTracker(storage, ws);
    await tracker.init();
  });

  afterEach(async () => {
    tracker.dispose();
    await fs.rm(ws, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
  });

  it('pins snapshot→mutate→restore→redo across nested dirs, deletions, additions and exec bits', async () => {
    // Fixture tree A.
    await fs.mkdir(path.join(ws, 'a/b'), { recursive: true });
    await fs.writeFile(path.join(ws, 'root.txt'), 'root-1');
    await fs.writeFile(path.join(ws, 'a/one.txt'), 'one-1');
    await fs.writeFile(path.join(ws, 'a/b/two.txt'), 'two-1');
    if (POSIX) {
      await fs.writeFile(path.join(ws, 'run.sh'), '#!/bin/sh\n');
      await fs.chmod(path.join(ws, 'run.sh'), 0o755);
    }
    const cp1 = await tracker.snapshot(1);
    expect(cp1).not.toBeNull();
    const stateA = await treeSnapshot(ws);

    // Mutate to tree B: modify, delete, add, flip exec bit.
    await fs.writeFile(path.join(ws, 'root.txt'), 'root-2');
    await fs.rm(path.join(ws, 'a/b/two.txt'));
    await fs.writeFile(path.join(ws, 'added.txt'), 'added');
    if (POSIX) await fs.chmod(path.join(ws, 'run.sh'), 0o644);
    const cp2 = await tracker.snapshot(2);
    expect(cp2).not.toBeNull();
    const stateB = await treeSnapshot(ws);

    // Restore A: worktree byte+mode identical to stateA; disclosure exact.
    const r1 = await tracker.restore(must(cp1).id);
    expect(r1.restored).toBe(true);
    if (r1.restored) {
      expect([...r1.changedPaths].sort()).toEqual(
        POSIX
          ? ['a/b/two.txt', 'added.txt', 'root.txt', 'run.sh']
          : ['a/b/two.txt', 'added.txt', 'root.txt'],
      );
      expect(r1.skippedPaths).toBeUndefined();
    }
    expect(await treeSnapshot(ws)).toEqual(stateA);

    // Index pins: baseline moved to cp1's tree; redo pointer established at cp2 (the anchor).
    const idx1 = await readDiskIndex(tracker);
    expect(idx1.currentBaselineId).toBe(must(cp1).id.split('-')[0]);
    expect(idx1.redo).toBeDefined();

    // Redo-all: forward tip restored, pointer consumed, worktree === stateB.
    const r2 = await tracker.redoAll();
    expect(r2.restored).toBe(true);
    expect(await treeSnapshot(ws)).toEqual(stateB);
    const idx2 = await readDiskIndex(tracker);
    expect(idx2.redo).toBeUndefined();
  });

  it('pins the dirty-guard refusal + forced restore appending an anchor row', async () => {
    await fs.writeFile(path.join(ws, 'f.txt'), 'v1');
    const cp1 = await tracker.snapshot(1);
    await fs.writeFile(path.join(ws, 'f.txt'), 'v2');
    await tracker.snapshot(2);

    // Dirty (uncaptured edit) -> refusal with the exact reason family.
    await fs.writeFile(path.join(ws, 'f.txt'), 'v3-dirty');
    const refused = await tracker.restore(must(cp1).id);
    expect(refused.restored).toBe(false);
    if (!refused.restored) expect(refused.reason).toMatch(/force: true/);

    // Forced -> anchor row captures the dirty tree first (nothing ever lost).
    const forced = await tracker.restore(must(cp1).id, { force: true });
    expect(forced.restored).toBe(true);
    const idx = await readDiskIndex(tracker);
    expect(idx.checkpoints.some((c) => c.phase === 'anchor')).toBe(true);
    expect(await fs.readFile(path.join(ws, 'f.txt'), 'utf8')).toBe('v1');
  });
});
