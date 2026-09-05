import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { must } from '../../testing/must';
import { CheckpointTracker } from './CheckpointTracker';

/** Same junction-probe gate as CheckpointTracker.test.ts (plain symlinks need elevation on stock Windows). */
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
const CAN_SYMLINK = detectSymlinkSupport();

describe.runIf(CAN_SYMLINK)('CA-05: restore containment re-assertion (raced ancestor-symlink swap)', () => {
  let ws: string;
  let storage: string;
  let outside: string;
  let tracker: CheckpointTracker;

  /** Swap ws/sub for a symlink pointing at outside/sub. */
  async function swapSubForEscapeLink(): Promise<void> {
    await fs.rm(path.join(ws, 'sub'), { recursive: true, force: true });
    symlinkSync(path.join(outside, 'sub'), path.join(ws, 'sub'), 'junction');
  }

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-ca05-ws-'));
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-ca05-st-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-ca05-out-'));
    await fs.mkdir(path.join(outside, 'sub'), { recursive: true });
    await fs.mkdir(path.join(ws, 'sub'), { recursive: true });
    await fs.writeFile(path.join(ws, 'sub', 'file.txt'), 'v1');
    tracker = new CheckpointTracker(storage, ws);
    await tracker.init();
  });

  afterEach(async () => {
    tracker.dispose();
    vi.restoreAllMocks();
    for (const d of [ws, storage, outside]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTwoCheckpoints(): Promise<string> {
    const cp1 = await tracker.snapshot(1);
    expect(cp1).not.toBeNull();
    await fs.writeFile(path.join(ws, 'sub', 'file.txt'), 'v2');
    const cp2 = await tracker.snapshot(2);
    expect(cp2).not.toBeNull();
    return must(cp1).id; // restore target: brings sub/file.txt back to v1 (a WRITE)
  }

  it('swap raced in between removeIfSymlink and the write -> path skipped, NOTHING lands outside', async () => {
    const targetId = await makeTwoCheckpoints();
    const victimAbs = path.join(ws, 'sub', 'file.txt');

    // removeIfSymlink is the ONLY fs.lstat caller on the victim path inside
    // the apply loop — hook it: after the real lstat resolves, perform the swap
    // (deterministically inside the removeIfSymlink→write window).
    const realLstat = fs.lstat.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (p, o?) => {
      const st = await realLstat(p as string, o as never);
      if (!swapped && String(p) === victimAbs) {
        swapped = true;
        await swapSubForEscapeLink();
      }
      return st;
    });

    const result = await tracker.restore(targetId);
    expect(swapped).toBe(true);
    expect(result.restored).toBe(true);
    if (result.restored) {
      expect(result.skippedPaths ?? []).toContain('sub/file.txt');
      expect(result.changedPaths).not.toContain('sub/file.txt');
    }
    // THE point: no content escaped the worktree.
    await expect(fs.access(path.join(outside, 'sub', 'file.txt'))).rejects.toBeDefined();
  });

  it('swap raced in during the awaited git show (mkdir hook) -> path skipped, NOTHING lands outside', async () => {
    const targetId = await makeTwoCheckpoints();
    const victimDir = path.join(ws, 'sub');

    // The apply loop's mkdir(dirname) runs immediately BEFORE the awaited
    // `git show` — swapping right after it resolves plants the escape link for
    // the whole subprocess window.
    const realMkdir = fs.mkdir.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (p, o?) => {
      const r = await realMkdir(p as string, o as never);
      if (!swapped && String(p) === victimDir) {
        swapped = true;
        await swapSubForEscapeLink();
      }
      return r as never;
    });

    const result = await tracker.restore(targetId);
    expect(swapped).toBe(true);
    expect(result.restored).toBe(true);
    if (result.restored) {
      expect(result.skippedPaths ?? []).toContain('sub/file.txt');
    }
    await expect(fs.access(path.join(outside, 'sub', 'file.txt'))).rejects.toBeDefined();
  });

  it('legit in-workspace symlinked subdir (points INSIDE the root) still restores through (net rule preserved)', async () => {
    const targetId = await makeTwoCheckpoints();
    // Swap ws/sub for a link to ws/real-sub (inside the root).
    await fs.mkdir(path.join(ws, 'real-sub'), { recursive: true });
    const realLstat = fs.lstat.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (p, o?) => {
      const st = await realLstat(p as string, o as never);
      if (!swapped && String(p) === path.join(ws, 'sub', 'file.txt')) {
        swapped = true;
        await fs.rm(path.join(ws, 'sub'), { recursive: true, force: true });
        symlinkSync(path.join(ws, 'real-sub'), path.join(ws, 'sub'), 'junction');
      }
      return st;
    });
    const result = await tracker.restore(targetId);
    expect(result.restored).toBe(true);
    if (result.restored) {
      // In-root realpath -> the re-assertion PASSES; the write proceeds.
      expect(result.skippedPaths ?? []).not.toContain('sub/file.txt');
    }
    expect(await fs.readFile(path.join(ws, 'real-sub', 'file.txt'), 'utf8')).toBe('v1');
  });
});
