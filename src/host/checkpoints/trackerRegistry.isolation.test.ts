import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointTracker } from './CheckpointTracker';
import { canonicalizeWorkspaceRoot } from './rootResolution';
import { CheckpointTrackerRegistry } from './trackerRegistry';
import { must } from '../../testing/must';

/**
 * WS-CK-A6 Task 16: the make-or-break ISOLATION PROOFS for the multi-root
 * shadow model. These are CHARACTERIZATION tests — they PROVE invariants the
 * current code already upholds, so both `it`s below are expected to PASS
 * as-is (no red-then-fix). A failure here is a real A6-blocking isolation
 * defect, not a test to "fix".
 *
 * The registry is constructed DIRECTLY (`new CheckpointTrackerRegistry(...)`,
 * no `makeTracker` override) rather than through the extension's factory —
 * `MULTI_ROOT_CHECKPOINTS` gates the extension WIRING, not the class, so
 * these proofs exercise the registry regardless of the flag's value.
 *
 * REAL git only (no fakes): scaffolding (mkdtemp, `execFileSync('git', ...)`)
 * mirrors `CheckpointTracker.test.ts`'s own idioms.
 */

/**
 * Recursive {relPath -> sha256 content hash} fingerprint of a directory tree.
 *
 * Tightened from the brief's `size:mtimeMs` fingerprint to a content hash
 * (per the review note: "if the two-root test flakes on mtime granularity,
 * tighten by comparing file CONTENT hashes instead — never by widening
 * tolerance"). A content hash is strictly at least as sensitive as
 * `size:mtimeMs` (any byte change is still caught) while being immune to
 * filesystem mtime-resolution flakiness (a coarse mtime tick on some
 * filesystems/CI runners could otherwise mask a same-tick rewrite, or a
 * clock/timezone quirk could falsely flag one). Applied proactively rather
 * than only after an observed flake — these are small git-internal trees, so
 * hashing costs nothing measurable.
 */
async function treeFingerprint(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, r);
      } else {
        const content = await fs.readFile(abs);
        out.set(r, createHash('sha256').update(content).digest('hex'));
      }
    }
  };
  await walk(root, '');
  return out;
}

describe('CheckpointTrackerRegistry — isolation proofs (WS-CK-A6 Task 16)', () => {
  describe('two-root shadow disjointness', () => {
    let storage: string;
    let wsA: string;
    let wsB: string;

    beforeEach(async () => {
      storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-iso-store-'));
      wsA = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-iso-wsA-'));
      wsB = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-iso-wsB-'));
    });

    afterEach(async () => {
      await fs.rm(storage, { recursive: true, force: true });
      await fs.rm(wsA, { recursive: true, force: true });
      await fs.rm(wsB, { recursive: true, force: true });
    });

    it("a full snapshot+restore cycle on root A touches NOTHING under root B's shadow", async () => {
      // Registry over real CheckpointTrackers: two mkdtemp roots, one storage dir.
      const registry = new CheckpointTrackerRegistry({
        storageDir: storage,
        listFolders: () => [wsA, wsB],
        log: () => undefined,
      });
      await registry.reconcile();
      const trackerA = must(registry.get(canonicalizeWorkspaceRoot(wsA)));
      const trackerB = must(registry.get(canonicalizeWorkspaceRoot(wsB)));

      // Settle B's OWN one-shot registry-bootstrap housekeeping BEFORE
      // establishing the baseline (test-setup correctness, not tolerance-
      // widening — the equality assertion below stays byte-exact).
      // `addRoot()` fires `tracker.init().then(() => { ...; void
      // tracker.cleanup(); })` WITHOUT awaiting it (mirrors the pre-existing
      // single-root `extension.ts` posture) — `reconcile()` resolving does
      // NOT mean that bootstrap `cleanup()` (a real `git gc`) has run yet.
      // Both it and a fresh `snapshot()` call race to `await this.init()`
      // on the SAME already-pending promise; `snapshot()` reaches its own
      // `enqueue()` one microtask sooner (no intervening await), so it
      // reliably wins that race and the bootstrap `gc` lands LATER —
      // repacking B's loose objects into a pack + `packed-refs` at an
      // indeterminate point that would otherwise fall inside this test's
      // measurement window and be misread as A leaking into B. Awaiting
      // `cleanup()` explicitly, twice in sequence, drains it deterministically
      // regardless of which position it queued into: the tracker's internal
      // work queue is strict FIFO (`enqueue()`), so two full round-trips
      // guarantee any job enqueued during the first round-trip has also
      // completed by the time the second one resolves.
      await (trackerB as CheckpointTracker).cleanup();
      await (trackerB as CheckpointTracker).cleanup();

      // Neither wsA nor wsB is a real git repo in this fixture, so
      // `hasRealGitAlternates` stays false for both -> the debounced
      // localize timer (armed only when real alternates exist, see
      // CheckpointTracker.ts) never fires for B -- the fingerprint window
      // below cannot be perturbed by B's own idle-timer background work.
      // Prime B once so its shadow exists, then fingerprint it.
      await fs.writeFile(path.join(wsB, 'b.txt'), 'b1');
      await trackerB.snapshot(1);
      const bShadow = path.dirname((trackerB as CheckpointTracker).shadowGitDir);
      const before = await treeFingerprint(bShadow);

      // Full cycle on A: snapshot, mutate, snapshot, restore, redo.
      await fs.writeFile(path.join(wsA, 'a.txt'), 'a1');
      const cp1 = await trackerA.snapshot(1);
      await fs.writeFile(path.join(wsA, 'a.txt'), 'a2');
      await trackerA.snapshot(2);
      await trackerA.restore(must(cp1).id);
      await trackerA.redoAll();

      // GIVEN a checkpoint op on root A WHEN it runs THEN it touches NO ref, lock,
      // object, config, or hook under root B's shadow .git.
      expect(await treeFingerprint(bShadow)).toEqual(before);
      await registry.disposeAll();
    });
  });

  it('INV-A6-GITDIR: a git repo planted at an ANCESTOR of the storage dir is byte-untouched by shadow ops', async () => {
    // Layout: outer/ is a REAL git repo. BOTH the tracker storage dir
    // (outer/storage/) AND the workspace (outer/ws/, the cwd of every
    // mutating shadow op) live INSIDE outer's worktree. So if any shadow op
    // ever dropped GIT_DIR, discovery-by-cwd would attach to outer/.git and
    // mutate it — the byte-untouched assertion below is therefore directly
    // sensitive to a discovery escape on the mutating ops themselves, not
    // merely in aggregate. Every tracker op sets GIT_DIR to the per-root
    // shadow (INV-A6-GITDIR), so the correct behavior is that outer/.git is
    // NEVER discovered and stays byte-identical.
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-anc-'));
    let tracker: CheckpointTracker | undefined;
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: outer });
      execFileSync('git', ['-C', outer, 'config', 'user.email', 't@t'], { encoding: 'utf8' });
      execFileSync('git', ['-C', outer, 'config', 'user.name', 't'], { encoding: 'utf8' });
      const plantedGit = path.join(outer, '.git');
      const nestedStorage = path.join(outer, 'storage');
      await fs.mkdir(nestedStorage, { recursive: true });
      const ws = path.join(outer, 'ws');
      await fs.mkdir(ws, { recursive: true });
      await fs.writeFile(path.join(ws, 'f.txt'), 'x');

      const before = await treeFingerprint(plantedGit);
      tracker = new CheckpointTracker(nestedStorage, ws);
      await tracker.init();
      const cp = await tracker.snapshot(1);
      expect(cp).not.toBeNull();

      // THEN: the per-root shadow .git received the objects/refs…
      const refs = execFileSync('git', ['--git-dir', tracker.shadowGitDir, 'for-each-ref'], {
        encoding: 'utf8',
      });
      expect(refs).toMatch(/refs\/hermes\/checkpoints\//);
      // …AND the planted ancestor repo is byte-untouched.
      expect(await treeFingerprint(plantedGit)).toEqual(before);
    } finally {
      tracker?.dispose();
      await fs.rm(outer, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
