import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { CheckpointsData } from '../../shared/protocol';
import type { RestoreResult } from './CheckpointTracker';
import { shadowDirFor } from './CheckpointTracker';
import { canonicalizeWorkspaceRoot, findContainingWorkspaceRoot } from './rootResolution';
import { CheckpointTrackerRegistry } from './trackerRegistry';
import type { RegistryTrackerLike } from './trackerRegistry';

/**
 * WS-CK-A6 Task 13: `CheckpointTrackerRegistry` core. Every scenario drives
 * through the PUBLIC `reconcile()` method (a Task-13 STUB that just
 * (re-)adds every listed folder, unconditionally, every call — Task 14
 * replaces it with the full serialized pass) so the private `addRoot`/
 * `removeRoot` primitives stay private, mirroring `rootRegistry.test.ts`'s
 * posture of driving everything through the public surface.
 *
 * NO real git subprocess anywhere in this file: `makeTracker` is always a
 * fake satisfying `RegistryTrackerLike` via `vi.fn()` spies. Only the
 * symlink/adopt-by-rename scenarios touch real fs (temp dirs + junctions),
 * matching `rootResolution.test.ts`'s own `CAN_SYMLINK` gating idiom.
 */

/** Mirrors rootResolution.test.ts's own capability probe (junction on Windows needs no elevation; symlink does). */
function detectSymlinkSupport(): boolean {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-symcap-'));
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

type FakeTracker = RegistryTrackerLike & {
  init: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  disposeAndFlush: ReturnType<typeof vi.fn>;
};

function makeFakeTracker(
  overrides: {
    init?: () => Promise<void>;
    disposeAndFlush?: (deadlineMs?: number) => Promise<'flushed' | 'deadline' | 'failed'>;
  } = {},
): FakeTracker {
  return {
    snapshot: vi.fn(async (): Promise<null> => null),
    list: vi.fn(async (): Promise<CheckpointsData> => ({ checkpoints: [] })),
    restore: vi.fn(async (): Promise<RestoreResult> => ({ restored: false, reason: 'fake' })),
    redo: vi.fn(async (): Promise<RestoreResult> => ({ restored: false, reason: 'fake' })),
    redoAll: vi.fn(async (): Promise<RestoreResult> => ({ restored: false, reason: 'fake' })),
    init: vi.fn(overrides.init ?? ((): Promise<void> => Promise.resolve())),
    cleanup: vi.fn(async (): Promise<void> => undefined),
    dispose: vi.fn((): void => undefined),
    disposeAndFlush: vi.fn(overrides.disposeAndFlush ?? ((): Promise<'flushed'> => Promise.resolve('flushed'))),
    shadowGitDir: path.join('fake', '.git'),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Any log call whose line includes `substr`. */
function loggedSubstring(log: ReturnType<typeof vi.fn>, substr: string): boolean {
  return log.mock.calls.some((args: unknown[]) => typeof args[0] === 'string' && args[0].includes(substr));
}

describe('CheckpointTrackerRegistry (WS-CK-A6 Task 13 core)', () => {
  describe('construction + get', () => {
    it('0 folders -> size 0, get returns undefined for anything', async () => {
      const log = vi.fn();
      const registry = new CheckpointTrackerRegistry({ storageDir: '/store', listFolders: () => [], log });

      await registry.reconcile();

      expect(registry.size).toBe(0);
      expect(registry.get('/anything')).toBeUndefined();
      expect(registry.allTrackers()).toEqual([]);
    });
  });

  describe.runIf(CAN_SYMLINK)('key === hash-input by construction', () => {
    it('a folder listed via a symlinked path mints its tracker from the CANONICAL string; the lexical path misses', async () => {
      const real = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-real-'));
      const linkParent = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-link-'));
      const link = path.join(linkParent, 'ws');
      symlinkSync(real, link, 'junction');
      try {
        const canonicalRoot = canonicalizeWorkspaceRoot(link);
        const lexical = path.resolve(link);
        expect(lexical).not.toBe(canonicalRoot); // sanity: this IS the symlinked case

        const log = vi.fn();
        const makeTracker = vi.fn((_canonicalRoot: string) => makeFakeTracker());
        const registry = new CheckpointTrackerRegistry({
          storageDir: path.join(os.tmpdir(), 'hermes-a6-store-nonexistent'),
          listFolders: () => [link],
          log,
          makeTracker,
        });

        await registry.reconcile();

        expect(makeTracker).toHaveBeenCalledWith(canonicalRoot);
        expect(registry.get(canonicalRoot)).toBeDefined();
        expect(registry.get(lexical)).toBeUndefined();
      } finally {
        rmSync(linkParent, { recursive: true, force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });
  });

  describe('hash-collision refusal', () => {
    it('a second canonical root whose shadowDir collides with an existing owner is refused, not registered', async () => {
      const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-collide-a-'));
      const rootB = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-collide-b-'));
      try {
        const canonicalA = canonicalizeWorkspaceRoot(rootA);
        const canonicalB = canonicalizeWorkspaceRoot(rootB);
        const log = vi.fn();
        const makeTracker = vi.fn(() => makeFakeTracker());
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => [rootA, rootB],
          log,
          makeTracker,
          shadowDirForImpl: () => '/fixed/shadow/dir', // constant seam — forces a collision
        });

        await registry.reconcile();

        expect(registry.size).toBe(1);
        expect(registry.get(canonicalA)).toBeDefined();
        expect(registry.get(canonicalB)).toBeUndefined();
        expect(loggedSubstring(log, 'REFUSING')).toBe(true);
      } finally {
        rmSync(rootA, { recursive: true, force: true });
        rmSync(rootB, { recursive: true, force: true });
      }
    });
  });

  describe.runIf(CAN_SYMLINK)('symlinked-root adopt-by-rename', () => {
    it('success: an existing lexical shadow dir is renamed to the canonical shadow dir, preserving its contents', async () => {
      const storageDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-store-'));
      const real = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-real-'));
      const linkParent = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-link-'));
      const link = path.join(linkParent, 'ws');
      symlinkSync(real, link, 'junction');
      try {
        const canonicalRoot = canonicalizeWorkspaceRoot(link);
        const lexical = path.resolve(link);
        const lexDir = shadowDirFor(storageDir, lexical);
        mkdirSync(lexDir, { recursive: true });
        writeFileSync(path.join(lexDir, 'marker.txt'), 'hello');

        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir,
          listFolders: () => [link],
          log,
          makeTracker: () => makeFakeTracker(),
        });

        await registry.reconcile();

        const canonicalShadowDir = shadowDirFor(storageDir, canonicalRoot);
        expect(existsSync(path.join(canonicalShadowDir, 'marker.txt'))).toBe(true);
        expect(registry.get(canonicalRoot)).toBeDefined();
        expect(loggedSubstring(log, 'could not adopt')).toBe(false);
      } finally {
        rmSync(storageDir, { recursive: true, force: true });
        rmSync(linkParent, { recursive: true, force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });

    it('failure disclosure: a pre-existing canonical shadow dir makes the rename impossible -> fresh + "could not adopt" log (never silent)', async () => {
      const storageDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-store-'));
      const real = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-real-'));
      const linkParent = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-link-'));
      const link = path.join(linkParent, 'ws');
      symlinkSync(real, link, 'junction');
      try {
        const canonicalRoot = canonicalizeWorkspaceRoot(link);
        const lexical = path.resolve(link);
        const lexDir = shadowDirFor(storageDir, lexical);
        const canonicalShadowDir = shadowDirFor(storageDir, canonicalRoot);
        mkdirSync(lexDir, { recursive: true });
        writeFileSync(path.join(lexDir, 'marker.txt'), 'hello');
        mkdirSync(canonicalShadowDir, { recursive: true }); // BOTH pre-exist -> rename is impossible

        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir,
          listFolders: () => [link],
          log,
          makeTracker: () => makeFakeTracker(),
        });

        await registry.reconcile();

        expect(loggedSubstring(log, 'could not adopt')).toBe(true);
        expect(registry.get(canonicalRoot)).toBeDefined(); // continues fresh, still registered
      } finally {
        rmSync(storageDir, { recursive: true, force: true });
        rmSync(linkParent, { recursive: true, force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });
  });

  describe.runIf(CAN_SYMLINK)('adopt-by-rename POSIX-safety guard (review fix)', () => {
    it('an existing EMPTY canonical shadowDir is never clobbered by rename (spy-proven)', async () => {
      const storageDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-store-'));
      const real = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-real-'));
      const linkParent = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-link-'));
      const link = path.join(linkParent, 'ws');
      symlinkSync(real, link, 'junction');
      const renameSpy = vi.spyOn(fsPromises, 'rename');
      try {
        const canonicalRoot = canonicalizeWorkspaceRoot(link);
        const lexical = path.resolve(link);
        const lexDir = shadowDirFor(storageDir, lexical);
        const canonicalShadowDir = shadowDirFor(storageDir, canonicalRoot);
        mkdirSync(lexDir, { recursive: true });
        writeFileSync(path.join(lexDir, 'marker.txt'), 'hello');
        mkdirSync(canonicalShadowDir, { recursive: true }); // pre-exists, EMPTY — the dangerous case on POSIX

        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir,
          listFolders: () => [link],
          log,
          makeTracker: () => makeFakeTracker(),
        });

        await registry.reconcile();

        // The guard must skip the rename attempt entirely — never call it
        // when the target already exists (POSIX `fs.rename` onto an existing
        // EMPTY dir SUCCEEDS and would silently clobber it).
        expect(renameSpy).not.toHaveBeenCalled();
        expect(existsSync(path.join(lexDir, 'marker.txt'))).toBe(true); // history retained, not clobbered
        expect(existsSync(path.join(canonicalShadowDir, 'marker.txt'))).toBe(false); // canonical shadow untouched
        expect(loggedSubstring(log, 'could not adopt')).toBe(true); // disclosed, never silent
      } finally {
        renameSpy.mockRestore();
        rmSync(storageDir, { recursive: true, force: true });
        rmSync(linkParent, { recursive: true, force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });
  });

  describe('adopt-by-rename mis-adoption contract guard (review fix)', () => {
    it("does not adopt a nested descendant folder's own shadow into its containing root's canonical shadow", async () => {
      const parentRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-nest-parent-'));
      const storageDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-nest-store-'));
      const childDir = path.join(parentRoot, 'child');
      mkdirSync(childDir, { recursive: true });
      const renameSpy = vi.spyOn(fsPromises, 'rename');
      try {
        const canonicalParent = canonicalizeWorkspaceRoot(parentRoot);
        // Sanity: the nested child is genuinely a DIFFERENT real directory
        // from the parent — this is NOT a symlink-alias case.
        expect(canonicalizeWorkspaceRoot(childDir)).not.toBe(canonicalParent);

        const childLexical = path.resolve(childDir);
        const childShadowDir = shadowDirFor(storageDir, childLexical);
        mkdirSync(childShadowDir, { recursive: true });
        writeFileSync(path.join(childShadowDir, 'marker.txt'), 'child-history');

        const log = vi.fn();
        // Both the parent AND its nested child are listed — `reconcile()`
        // maps the child's rawFolderPath to the PARENT's canonical root
        // (`findContainingWorkspaceRoot`), which is exactly the confusion
        // the fix must not act on.
        const registry = new CheckpointTrackerRegistry({
          storageDir,
          listFolders: () => [parentRoot, childDir],
          log,
          makeTracker: () => makeFakeTracker(),
        });

        await registry.reconcile();

        const parentShadowDir = shadowDirFor(storageDir, canonicalParent);
        expect(renameSpy).not.toHaveBeenCalledWith(childShadowDir, expect.anything());
        expect(existsSync(path.join(childShadowDir, 'marker.txt'))).toBe(true); // child's own history untouched
        expect(existsSync(path.join(parentShadowDir, 'marker.txt'))).toBe(false); // never merged into the parent
        expect(loggedSubstring(log, 'could not adopt')).toBe(false); // nothing to adopt — not even disclosed
      } finally {
        renameSpy.mockRestore();
        rmSync(parentRoot, { recursive: true, force: true });
        rmSync(storageDir, { recursive: true, force: true });
      }
    });
  });

  describe('per-root init isolation', () => {
    it("root B's init rejection degrades ONLY root B — root A stays registered", async () => {
      const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-iso-a-'));
      const rootB = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-iso-b-'));
      try {
        const canonicalA = canonicalizeWorkspaceRoot(rootA);
        const canonicalB = canonicalizeWorkspaceRoot(rootB);
        const trackerA = makeFakeTracker();
        const trackerB = makeFakeTracker({ init: () => Promise.reject(new Error('boom')) });
        const makeTracker = vi.fn((canonicalRoot: string) => (canonicalRoot === canonicalA ? trackerA : trackerB));
        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => [rootA, rootB],
          log,
          makeTracker,
        });

        await registry.reconcile();
        await vi.waitFor(() => {
          expect(registry.get(canonicalB)).toBeUndefined();
        });

        expect(registry.get(canonicalA)).toBeDefined();
        expect(loggedSubstring(log, 'unavailable for')).toBe(true);
      } finally {
        rmSync(rootA, { recursive: true, force: true });
        rmSync(rootB, { recursive: true, force: true });
      }
    });

    it('instance-check: a LATE rejection from a dead B instance never evicts its healthy successor', async () => {
      const rootB = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-iso-late-'));
      try {
        const canonicalB = canonicalizeWorkspaceRoot(rootB);
        const deferred = createDeferred<void>();
        const deadTracker = makeFakeTracker({ init: () => deferred.promise });
        const healthyTracker = makeFakeTracker();
        let calls = 0;
        const makeTracker = vi.fn(() => {
          calls += 1;
          return calls === 1 ? deadTracker : healthyTracker;
        });
        const log = vi.fn();
        let folders: string[] = [rootB];
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => folders,
          log,
          makeTracker,
        });

        await registry.reconcile(); // mints deadTracker; its init() is still pending
        expect(registry.get(canonicalB)).toBe(deadTracker);

        // Task 14's reconcile() skips an already-registered root (idempotency
        // guard), so re-calling it with the SAME folder list is now a no-op —
        // churn the folder list to force a genuine remove+re-add cycle,
        // producing a real successor instance for the SAME canonical root.
        folders = [];
        await registry.reconcile(); // removes deadTracker (disposeAndFlush -> default 'flushed')
        expect(registry.get(canonicalB)).toBeUndefined();

        folders = [rootB];
        await registry.reconcile(); // mints healthyTracker, a genuine successor
        expect(registry.get(canonicalB)).toBe(healthyTracker);

        // The FIRST (now-superseded) instance's init() finally rejects, LATE.
        deferred.reject(new Error('late failure from a dead instance'));
        await vi.waitFor(() => {
          expect(loggedSubstring(log, 'unavailable for')).toBe(true);
        });

        // Instance-checked removal: the late rejection must NOT evict the successor.
        expect(registry.get(canonicalB)).toBe(healthyTracker);
      } finally {
        rmSync(rootB, { recursive: true, force: true });
      }
    });
  });

  describe('disposeAll', () => {
    it('calls disposeAndFlush exactly once per tracker, then clears both maps', async () => {
      const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-disposeall-a-'));
      const rootB = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-disposeall-b-'));
      try {
        const canonicalA = canonicalizeWorkspaceRoot(rootA);
        const canonicalB = canonicalizeWorkspaceRoot(rootB);
        const trackerA = makeFakeTracker();
        const trackerB = makeFakeTracker();
        const makeTracker = vi.fn((canonicalRoot: string) => (canonicalRoot === canonicalA ? trackerA : trackerB));
        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => [rootA, rootB],
          log,
          makeTracker,
        });

        await registry.reconcile();
        expect(registry.size).toBe(2);

        await registry.disposeAll();

        expect(trackerA.disposeAndFlush).toHaveBeenCalledTimes(1);
        expect(trackerB.disposeAndFlush).toHaveBeenCalledTimes(1);
        expect(registry.size).toBe(0);
        expect(registry.get(canonicalA)).toBeUndefined();
        expect(registry.get(canonicalB)).toBeUndefined();
        expect(registry.allTrackers()).toEqual([]);
      } finally {
        rmSync(rootA, { recursive: true, force: true });
        rmSync(rootB, { recursive: true, force: true });
      }
    });
  });

  describe('removeRoot disposeAndFlush outcome disclosure (driven through disposeAll)', () => {
    it("'flushed' -> no deadline/failure disclosure line", async () => {
      const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-outcome-flushed-'));
      try {
        const tracker = makeFakeTracker({ disposeAndFlush: () => Promise.resolve('flushed') });
        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => [rootA],
          log,
          makeTracker: () => tracker,
        });
        await registry.reconcile();

        await registry.disposeAll();

        expect(tracker.disposeAndFlush).toHaveBeenCalledTimes(1);
        expect(loggedSubstring(log, 'hit its deadline')).toBe(false);
        expect(loggedSubstring(log, 'reported a repack failure')).toBe(false);
      } finally {
        rmSync(rootA, { recursive: true, force: true });
      }
    });

    it("'deadline' -> discloses the deadline line, NEVER silent", async () => {
      const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-outcome-deadline-'));
      try {
        const tracker = makeFakeTracker({ disposeAndFlush: () => Promise.resolve('deadline') });
        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => [rootA],
          log,
          makeTracker: () => tracker,
        });
        await registry.reconcile();

        await registry.disposeAll();

        expect(loggedSubstring(log, 'hit its deadline')).toBe(true);
      } finally {
        rmSync(rootA, { recursive: true, force: true });
      }
    });

    it("'failed' -> discloses the repack-failure line, NEVER silent", async () => {
      const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-outcome-failed-'));
      try {
        const tracker = makeFakeTracker({ disposeAndFlush: () => Promise.resolve('failed') });
        const log = vi.fn();
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => [rootA],
          log,
          makeTracker: () => tracker,
        });
        await registry.reconcile();

        await registry.disposeAll();

        expect(loggedSubstring(log, 'reported a repack failure')).toBe(true);
      } finally {
        rmSync(rootA, { recursive: true, force: true });
      }
    });
  });

  /**
   * WS-CK-A6 Task 14: the real reconcile pass — resolver-derived desired set
   * (ONE containment rule, spec req 5), single-flight serialization + a
   * chain-mutex (spec req 4), construct-before-dispose (spec req 4), and
   * promotion notice (spec req 6b, option b). Task 13's `reconcile()` stub
   * (unconditional re-add, every folder, every call, NO removal) is replaced
   * here — these scenarios exercise removal/serialization/promotion that the
   * stub never implemented.
   */
  describe('reconcile — Task 14 real pass', () => {
    describe('first-listed-wins desired set (spec req 5)', () => {
      it('child listed FIRST: the resolver keeps both child and parent as their own root (2 trackers)', async () => {
        const parent = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-t14-fw-parent-'));
        const child = path.join(parent, 'child');
        mkdirSync(child, { recursive: true });
        try {
          const canonicalParent = canonicalizeWorkspaceRoot(parent);
          const canonicalChild = canonicalizeWorkspaceRoot(child);
          const log = vi.fn();
          const registry = new CheckpointTrackerRegistry({
            storageDir: '/store',
            listFolders: () => [child, parent], // child listed FIRST
            log,
            makeTracker: () => makeFakeTracker(),
          });

          await registry.reconcile();

          expect(registry.size).toBe(2);
          expect(registry.get(canonicalChild)).toBeDefined();
          expect(registry.get(canonicalParent)).toBeDefined();
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }
      });

      it('parent listed FIRST: the desired set collapses to the parent alone (1 tracker); a cwd inside the child still routes there — no spurious NO_TRACKER', async () => {
        const parent = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-t14-fw-parent2-'));
        const child = path.join(parent, 'child');
        mkdirSync(child, { recursive: true });
        try {
          const canonicalParent = canonicalizeWorkspaceRoot(parent);
          const canonicalChild = canonicalizeWorkspaceRoot(child);
          const folders = [parent, child]; // parent listed FIRST
          const log = vi.fn();
          const registry = new CheckpointTrackerRegistry({
            storageDir: '/store',
            listFolders: () => folders,
            log,
            makeTracker: () => makeFakeTracker(),
          });

          await registry.reconcile();

          expect(registry.size).toBe(1);
          expect(registry.get(canonicalParent)).toBeDefined();
          expect(registry.get(canonicalChild)).toBeUndefined();

          // cwd-routing companion: a file inside the child resolves (via the
          // SAME resolver the runtime routes with) to a root the registry
          // covers — no spurious NO_TRACKER for a cwd already tracked.
          const childFile = path.join(child, 'some-file.ts');
          const routedRoot = canonicalizeWorkspaceRoot(findContainingWorkspaceRoot(childFile, folders));
          expect(registry.get(routedRoot)).toBeDefined();
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }
      });
    });

    describe('serialized convergence (spec req 4) — single-flight prevents overlap', () => {
      it('a burst of un-awaited reconcile() calls converges to exactly the last folder state; no root is ever minted twice while its predecessor is still live', async () => {
        const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-t14-conv-a-'));
        const rootB = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-t14-conv-b-'));
        try {
          const canonicalA = canonicalizeWorkspaceRoot(rootA);
          const canonicalB = canonicalizeWorkspaceRoot(rootB);

          // Per-root LIVE-COUNT: mint++ when makeTracker(root) is called,
          // dispose-- only once THAT instance's disposeAndFlush actually
          // SETTLES (not merely invoked) — proves no root ever has two live
          // instances outstanding at once, not just that calls don't overlap
          // textually.
          const live = new Map<string, number>();
          const maxLive = new Map<string, number>();
          const bumpLive = (root: string, delta: number): void => {
            const next = (live.get(root) ?? 0) + delta;
            live.set(root, next);
            maxLive.set(root, Math.max(maxLive.get(root) ?? 0, next));
          };

          const gateA = createDeferred<'flushed'>();
          const makeTracker = vi.fn((canonicalRoot: string) => {
            bumpLive(canonicalRoot, 1);
            const isA = canonicalRoot === canonicalA;
            return makeFakeTracker({
              disposeAndFlush: async (): Promise<'flushed' | 'deadline' | 'failed'> => {
                const outcome = isA ? await gateA.promise : ('flushed' as const);
                bumpLive(canonicalRoot, -1);
                return outcome;
              },
            });
          });

          const log = vi.fn();
          let folders: string[] = [rootA];
          const registry = new CheckpointTrackerRegistry({
            storageDir: '/store',
            listFolders: () => folders,
            log,
            makeTracker,
          });

          // Prime: A alone, fully settled (establishes the tracker whose
          // removal this test gates).
          await registry.reconcile();
          expect(registry.get(canonicalA)).toBeDefined();

          // Burst: mutate folders [A]->[A,B]->[B], firing reconcile() for
          // each WITHOUT awaiting either call before the last one.
          folders = [rootA, rootB];
          void registry.reconcile();
          folders = [rootB];
          const p2 = registry.reconcile();

          // While A's removal is gated-slow: B is already up
          // (construct-before-dispose runs the adds before the removes) and
          // A is already unreachable (removeRegistration precedes the
          // flush) — but B must have been minted only ONCE, proving the
          // second (queued) call never ran its own construct step
          // concurrently with the first.
          await vi.waitFor(() => {
            expect(registry.get(canonicalB)).toBeDefined();
          });
          expect(registry.get(canonicalA)).toBeUndefined();
          expect(makeTracker.mock.calls.filter(([r]) => r === canonicalB)).toHaveLength(1);

          gateA.resolve('flushed');
          await p2;

          expect(registry.size).toBe(1);
          expect(registry.get(canonicalB)).toBeDefined();
          expect(registry.get(canonicalA)).toBeUndefined();
          expect(makeTracker.mock.calls.filter(([r]) => r === canonicalB)).toHaveLength(1);
          expect(maxLive.get(canonicalA)).toBeLessThanOrEqual(1);
          expect(maxLive.get(canonicalB)).toBeLessThanOrEqual(1);
        } finally {
          rmSync(rootA, { recursive: true, force: true });
          rmSync(rootB, { recursive: true, force: true });
        }
      });
    });

    describe('promotion detection (spec req 6b, option b)', () => {
      it('a child no longer covered by its parent is promoted to its own root exactly once; re-adding the parent later re-mints it (same canonical root) without re-firing promotion', async () => {
        const parentRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-t14-promo-parent-'));
        const childDir = path.join(parentRoot, 'child');
        mkdirSync(childDir, { recursive: true });
        try {
          const canonicalParent = canonicalizeWorkspaceRoot(parentRoot);
          const canonicalChild = canonicalizeWorkspaceRoot(childDir);

          const parentTrackers: FakeTracker[] = [];
          const childTrackers: FakeTracker[] = [];
          const makeTracker = vi.fn((canonicalRoot: string) => {
            const t = makeFakeTracker();
            if (canonicalRoot === canonicalParent) parentTrackers.push(t);
            else childTrackers.push(t);
            return t;
          });
          const onPromotion = vi.fn();
          const log = vi.fn();
          let folders: string[] = [parentRoot, childDir]; // parent listed first
          const registry = new CheckpointTrackerRegistry({
            storageDir: '/store',
            listFolders: () => folders,
            log,
            makeTracker,
            onPromotion,
          });

          await registry.reconcile(); // only the parent is tracked
          expect(registry.get(canonicalParent)).toBe(parentTrackers[0]);
          expect(registry.get(canonicalChild)).toBeUndefined();

          folders = [childDir]; // parent no longer listed — child now covers itself
          await registry.reconcile();

          expect(onPromotion).toHaveBeenCalledTimes(1);
          expect(onPromotion).toHaveBeenCalledWith(canonicalChild, canonicalParent);
          expect(registry.get(canonicalChild)).toBe(childTrackers[0]); // fresh instance
          expect(registry.get(canonicalParent)).toBeUndefined();
          expect(parentTrackers[0]?.disposeAndFlush).toHaveBeenCalledTimes(1); // retention: flush, not delete
          expect(parentTrackers[0]?.dispose).not.toHaveBeenCalled();

          folders = [childDir, parentRoot]; // re-add: child listed first, both now desired
          await registry.reconcile();

          expect(registry.get(canonicalParent)).toBe(parentTrackers[1]); // re-minted, SAME canonical root
          expect(parentTrackers).toHaveLength(2);
          expect(onPromotion).toHaveBeenCalledTimes(1); // does NOT re-fire
        } finally {
          rmSync(parentRoot, { recursive: true, force: true });
        }
      });
    });

    describe('0-roots pass (after having trackers)', () => {
      it('folders become empty -> every tracker is disposed and removed, size 0', async () => {
        const rootA = mkdtempSync(path.join(os.tmpdir(), 'hermes-a6-t14-zero-a-'));
        try {
          const tracker = makeFakeTracker();
          const log = vi.fn();
          let folders: string[] = [rootA];
          const registry = new CheckpointTrackerRegistry({
            storageDir: '/store',
            listFolders: () => folders,
            log,
            makeTracker: () => tracker,
          });

          await registry.reconcile();
          expect(registry.size).toBe(1);

          folders = [];
          await registry.reconcile();

          expect(registry.size).toBe(0);
          expect(tracker.disposeAndFlush).toHaveBeenCalledTimes(1);
          expect(registry.allTrackers()).toEqual([]);
        } finally {
          rmSync(rootA, { recursive: true, force: true });
        }
      });
    });
  });
});
