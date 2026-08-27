import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { CheckpointsData } from '../../shared/protocol';
import type { RestoreResult } from './CheckpointTracker';
import { shadowDirFor } from './CheckpointTracker';
import { canonicalizeWorkspaceRoot } from './rootResolution';
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
        const registry = new CheckpointTrackerRegistry({
          storageDir: '/store',
          listFolders: () => [rootB],
          log,
          makeTracker,
        });

        await registry.reconcile(); // mints deadTracker; its init() is still pending
        expect(registry.get(canonicalB)).toBe(deadTracker);

        await registry.reconcile(); // stub unconditionally re-adds -> mints healthyTracker, replaces the entry
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
});
