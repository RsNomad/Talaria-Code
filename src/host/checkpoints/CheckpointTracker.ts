import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type {
  Checkpoint,
  CheckpointPhase,
  CheckpointRedoState,
  CheckpointsData,
} from '../../shared/protocol';
// T-19 (C1+C2): moved out of rag/ — host/checkpoints/ importing from rag/ was a zone-crossing edge.
import { createIgnoreFilter } from '../../shared/ignoreFilter';
import { resolveWithinWorkspaceReal } from '../backend/acp/pathConfine';
import { sanitizeGitEnv } from './gitEnv';
import { runGit, runGitBinary, type RunGitOptions } from './gitProcess';
import { missingObjects, type RunGit } from './objectClosure';
import { acquireLock } from './shadowLock';

// Re-export so consumers (e.g. AcpBackend) can distinguish a transient,
// retryable lock timeout from a permanent checkpoint failure without reaching
// into shadowLock directly.
export { CheckpointLockTimeoutError } from './shadowLock';

/**
 * CheckpointTracker — an extension-side, OpenCode-derived shadow-git engine.
 *
 * Design (grounded in `docs/specs/research-checkpoints-cline.md` §4 and
 * summarized in `docs/specs/wave-1-golive.md` Zone CKPT):
 *
 * - **Shadow repo, not the real one.** `GIT_DIR` lives under extension
 *   storage (`<storageDir>/checkpoints/<hash(workspaceRoot)>/.git`),
 *   `GIT_WORK_TREE` is the real workspace root. The user's real `.git` (if
 *   any) is never written to.
 * - **Object-database sharing.** When the workspace sits inside a real git
 *   repo, `objects/info/alternates` points at that repo's object store, so
 *   unchanged file content is never re-hashed/re-written into the shadow
 *   store (OpenCode's big perf win over Roo/Cline-classic's plain `git add .`).
 * - **`write-tree` snapshots, not commits.** Cheaper than a full commit (no
 *   parent chain), still content-addressable and diffable/restorable. Because
 *   the hash is content-addressed, an identical worktree yields an identical
 *   tree, so a snapshot whose tree equals the LAST STORED checkpoint's is
 *   deduped for FREE (W2-F2): no row is written and `snapshot()` returns `null`
 *   — a no-op turn (or a before/after pair that changed nothing) stores nothing.
 *   That dedup is also what keeps the public id (`<tree>-<turnOrdinal>`) unique
 *   WITHOUT folding the phase into it: two CONSECUTIVE stored checkpoints can
 *   never share a tree (the equal case is exactly the deduped one that is not
 *   stored), and a before(N)/after(N) pair landing on the same tree IS that
 *   deduped case (only one row survives) — so `<tree>-<ordinal>` can never
 *   repeat, even though the same tree may legitimately recur across
 *   NON-consecutive ordinals (an A→B→A worktree).
 * - **One exclusion engine.** Reuses `src/shared/ignoreFilter.ts`'s
 *   `createIgnoreFilter` (T-19: moved from `src/rag/gitignore.ts`, shared
 *   with RAG indexing) plus a live ~2 MiB per-file size cutoff — no second,
 *   parallel exclusion catalogue.
 * - **Dirty-worktree guard on restore.** Cline/Roo's `reset --hard` +
 *   `clean -fd` silently destroys anything not covered by a checkpoint.
 *   Here, `restore()` refuses (unless `{ force: true }`) whenever the live
 *   worktree doesn't match the last known checkpoint baseline, and even then
 *   only ever touches paths that changed between the current baseline and the
 *   restore target — files that were never captured by any checkpoint
 *   (gitignored/oversized/excluded) are never touched, restored, or deleted.
 * - **Real GC.** `cleanup()` runs `git gc --prune=<n>.days.ago`; each
 *   checkpoint's tree is kept reachable via a dedicated ref
 *   (`refs/hermes/checkpoints/<treeHash>`) so gc never reaps live checkpoints.
 * - **Sanitized env.** Every shadow-git invocation strips any inherited
 *   `GIT_DIR`/`GIT_WORK_TREE`/etc. before applying our own (critical on
 *   Fedora dev-containers / direnv shells — see `gitEnv.ts`).
 *
 * Concurrency: all git-index-touching operations (`snapshot`/`diff`/
 * `restore`/`cleanup`) are serialized *within one process* through an internal
 * promise queue, AND *across processes* through a stale-tolerant advisory
 * lockfile in the shadow dir (`shadowLock.ts`) — so two VS Code windows or a
 * racing extension-host restart on the same workspace can't corrupt the shared
 * on-disk git index / metadata. A gap neither Roo nor Cline-current guards.
 */

/** Tunables for a {@link CheckpointTracker} instance. */
export interface CheckpointTrackerOptions {
  /** Extra ignore globs beyond `.gitignore`/`.hermesignore` (e.g. `talaria.rag.excludeGlobs`). */
  extraIgnoreGlobs?: readonly string[];
  /** Per-file size cutoff in bytes; larger files are excluded even if not gitignored. Default 2 MiB. */
  maxFileBytes?: number;
  /** Default `git gc --prune` age (days) used by {@link CheckpointTracker.cleanup} when no override is given. */
  pruneDays?: number;
  /** Cross-process lock: steal a lockfile older than this (ms). Default 30 s. */
  lockStaleMs?: number;
  /** Cross-process lock: max wait for a live lock before failing (ms). Default 10 s. */
  lockMaxWaitMs?: number;
  /**
   * Wall-clock timeout (ms) for each barrier/foreground shadow-git op; on expiry
   * the git child is SIGKILLed and the op rejects (arch A#1). Default 15 s.
   * Background maintenance (`repack`/`gc`) is intentionally exempt (unbounded).
   */
  gitTimeoutMs?: number;
  /**
   * Debounce (ms) before the background alternate-object localization (`repack`)
   * runs off the snapshot barrier (corr-I1). Coalesces a burst of turns into one
   * repack. Default 500 ms (I-2: shortened from 2 s to shrink the durability
   * window — the span in which a borrowing checkpoint's blobs live only in the
   * real repo and a real-repo `gc --prune` could orphan them).
   */
  localizeDebounceMs?: number;
}

/** One file's change status between two trees (or a tree and the live worktree). */
export type DiffStatus = 'added' | 'modified' | 'deleted';

/** One entry of a {@link CheckpointTracker.diff} result. */
export interface CheckpointDiffEntry {
  /** POSIX-relative path from the workspace root. */
  path: string;
  status: DiffStatus;
}

/** Result of {@link CheckpointTracker.restore}. */
export type RestoreResult =
  | {
      restored: true;
      filesChanged: number;
      changedPaths: string[];
      /**
       * Paths the restore REFUSED to touch because their real (symlink-resolved)
       * location escapes the worktree root (review S-M1). Present only when
       * non-empty; the write/delete for each was skipped, not applied.
       */
      skippedPaths?: string[];
    }
  | { restored: false; reason: string };

/** Thrown when the `git` executable itself cannot be found/run. */
export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitUnavailableError';
  }
}

/**
 * Thrown when the pre-turn worktree scan ({@link CheckpointTracker.scanWorktree})
 * blows its wall-clock deadline (I-1). `scanWorktree` is the FIRST step of the
 * snapshot barrier and runs BEFORE any git subprocess, so the git-child timeout
 * in `gitProcess` (arch A#1) cannot bound it: a stalled workspace FS (NFS/sshfs,
 * an FS stall) would otherwise wedge `fs.readdir`/`fs.stat` in the libuv
 * threadpool → the awaited barrier never settles → the user's prompt is silently
 * never sent. This error is the walk's counterpart to {@link GitTimeoutError}:
 * it flows to the barrier's EXISTING fail-open path (turn proceeds unprotected)
 * exactly the same way, and — because the walk precedes `write-tree` — a
 * timed-out scan can never set `currentBaselineId` (C1-safe: bound-and-reject,
 * not finish-late).
 */
export class WorktreeScanTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeScanTimeoutError';
  }
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // ~2 MiB, mirrors OpenCode's live size cutoff.
const DEFAULT_PRUNE_DAYS = 7; // mirrors OpenCode's `prune = "7.days"`.
const DEFAULT_GIT_TIMEOUT_MS = 15_000; // wall-clock bound per barrier/foreground git op (arch A#1).
// I-2: shortened 2 s -> 500 ms so a borrowing checkpoint is localized (made
// self-contained) sooner, shrinking the window in which a real-repo `gc --prune`
// could orphan its still-borrowed blobs. The debounce is NON-resetting (fires
// ~this long after the FIRST pending mark), so the earliest, most-exposed
// checkpoints of a session become durable within one short interval. Kept OFF
// the pre-turn barrier (Fix-A): repack never runs synchronously before a prompt.
const DEFAULT_LOCALIZE_DEBOUNCE_MS = 500; // debounce before an off-barrier localization repack (corr-I1 / I-2).

interface PersistedCheckpoint {
  /**
   * Public, per-turn-UNIQUE id (`<tree>-<turnOrdinal>`) — this IS the public
   * `Checkpoint.id`. The `write-tree` hash alone can recur across
   * NON-consecutive turns (W2-F2 dedup rules out two CONSECUTIVE stored
   * checkpoints sharing a tree, but an A→B→A worktree recurs an earlier tree at
   * a later ordinal), which would collide downstream (duplicate React keys in
   * the panel); folding in the turn ordinal makes the id unique per checkpoint.
   */
  id: string;
  /** `write-tree` hash — the tree-ish used for ALL git operations (may repeat across NON-consecutive turns). */
  tree: string;
  label: string;
  /** ISO-8601. */
  timestamp: string;
  /**
   * WAS required — now optional (P2): anchor rows (`phase: 'anchor'`, W2-F2
   * Phase 1) capture a boundary-less pre-restore snapshot and carry no turn.
   */
  turnOrdinal?: number;
  filesChanged: number;
  /**
   * W2-F2: which side of the turn this snapshot captured (`'before'` = the
   * undo target, `'after'` = the post-edit state that makes undo force-free).
   * OPTIONAL on disk: legacy (pre-W2) index rows have no `phase` and parse
   * unchanged — NO migration/backfill (an absent phase is treated as legacy
   * before-turn by consumers, so a synthetic value would only lie). Phase 1
   * adds `'anchor'` — see {@link CheckpointPhase}.
   */
  phase?: CheckpointPhase;
  /**
   * W4-T5b: DISPLAY-ONLY (R8) — see `Checkpoint.sessionLabel`'s doc
   * (`src/shared/protocol.ts`). Stored verbatim from `snapshot()`'s
   * `opts.sessionLabel` when supplied; never read back, never part of the
   * dedup/id computation.
   */
  sessionLabel?: string;
}

interface CheckpointIndexFile {
  workspaceRoot: string;
  /** Tree hash the live worktree is currently known to match, or `null` before the first snapshot/restore. */
  currentBaselineId: string | null;
  checkpoints: PersistedCheckpoint[];
  /**
   * W2-F2 Phase 1: monotonic counter for anchor-row ids (`<tree>-a<seq>`).
   * Absent on legacy indexes (≙ 0). Never reused/decremented.
   */
  anchorSeq?: number;
  /**
   * W2-F2 Phase 1: the live redo pointer; ABSENT when no undo is outstanding.
   */
  redo?: CheckpointRedoState;
}

export class CheckpointTracker {
  private readonly workspaceRoot: string;
  private readonly storageDir: string;
  private readonly maxFileBytes: number;
  private readonly extraIgnoreGlobs: readonly string[];
  private readonly defaultPruneDays: number;
  private readonly lockStaleMs: number;
  private readonly lockMaxWaitMs: number;
  private readonly gitTimeoutMs: number;
  private readonly localizeDebounceMs: number;

  private readonly shadowDir: string;
  private readonly gitDir: string;
  private readonly indexPath: string;

  private initPromise: Promise<void> | null = null;
  private cachedIndex: CheckpointIndexFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** True while a snapshot has borrowed objects not yet localized into the shadow (corr-I1). */
  private localizePending = false;
  /** Pending debounced localization timer, or undefined when none is scheduled. */
  private localizeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Set once {@link init} resolves: whether the shadow store shares objects with a real repo. */
  private _hasRealGitAlternates = false;

  constructor(
    storageDir: string,
    workspaceRoot: string,
    options: CheckpointTrackerOptions = {},
  ) {
    this.storageDir = path.resolve(storageDir);
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.extraIgnoreGlobs = options.extraIgnoreGlobs ?? [];
    this.defaultPruneDays = options.pruneDays ?? DEFAULT_PRUNE_DAYS;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    this.lockMaxWaitMs = options.lockMaxWaitMs ?? 10_000;
    this.gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.localizeDebounceMs = options.localizeDebounceMs ?? DEFAULT_LOCALIZE_DEBOUNCE_MS;

    const hash = createHash('sha256').update(this.workspaceRoot).digest('hex').slice(0, 16);
    this.shadowDir = path.join(this.storageDir, 'checkpoints', hash);
    this.gitDir = path.join(this.shadowDir, '.git');
    this.indexPath = path.join(this.shadowDir, 'index.json');
  }

  /** Absolute path to the shadow repo's `GIT_DIR` (useful for logging/debugging by the controller). */
  get shadowGitDir(): string {
    return this.gitDir;
  }

  /** Whether the shadow object store is linked (via `alternates`) to a real repo's object database. */
  get hasRealGitAlternates(): boolean {
    return this._hasRealGitAlternates;
  }

  // --- public API -------------------------------------------------------

  /**
   * Idempotent. Creates/locates the shadow repo, wires `alternates` when the
   * workspace sits inside a real git repo, and loads/creates the metadata
   * index. Safe to call repeatedly and from every other method (they all
   * auto-init lazily).
   */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initInternal().catch((err: unknown) => {
        this.initPromise = null; // allow a retry on the next call
        throw err;
      });
    }
    return this.initPromise;
  }

  /**
   * Stage the live worktree (filtered by the shared ignore engine + size
   * cutoff), `write-tree`, and record a {@link Checkpoint}. `opts.phase`
   * defaults to `'before'`; `label` defaults to a phase-aware
   * `Before turn <n>` / `After turn <n>`. `filesChanged` counts paths that
   * differ from the previous checkpoint (or, for the very first checkpoint, the
   * number of files captured).
   *
   * W2-F2 tree-hash dedup (howto §3.1 / review Q5): `write-tree` is
   * content-addressed, so an identical worktree yields an identical hash. When
   * the computed tree equals the LAST STORED checkpoint's tree we write NO new
   * row and resolve `null` — a no-op turn (or a before/after pair that changed
   * nothing) stores nothing, and this is exactly what keeps `<tree>-<ordinal>`
   * ids collision-free (two consecutive STORED trees can never be equal). The
   * only side effect on that deduped path is a possible `currentBaselineId`
   * refresh (see below) — the dirty-guard keys on the baseline, so it must not
   * be left stale.
   */
  async snapshot(
    turnOrdinal: number,
    label?: string,
    opts: { phase?: CheckpointPhase; sessionLabel?: string } = {},
  ): Promise<Checkpoint | null> {
    const phase = opts.phase ?? 'before';
    await this.init();
    return this.enqueue(() => this.withLock(async () => {
      const index = await this.loadIndex();
      const { tree, files } = await this.writeTreeFromWorktree();

      const previous = index.checkpoints[index.checkpoints.length - 1];

      // W2-F2 dedup: computed tree === the LAST STORED checkpoint's tree ⇒ this
      // turn changed nothing (identical `write-tree`). Create no record and
      // return null. BUT `currentBaselineId` (what the restore dirty-guard keys
      // on) may have DIVERGED from this tree — e.g. a restore moved the baseline
      // to an older tree, then the user manually re-created this exact tree. If
      // we left the baseline stale, the next restore would see a "dirty"
      // worktree and wrongly demand `{ force: true }` even though the worktree
      // is byte-for-byte a known checkpoint. So refresh it — corr-M3: persist to
      // DISK first, then mutate the in-memory cache. (No ref/localization work:
      // this tree is `previous`'s, already anchored by its ref when it was
      // first stored, so nothing new is borrowed.)
      if (previous && previous.tree === tree) {
        // Task 7 (forward-stack invalidation): a new TURN (positive ordinal)
        // clears the redo pointer even on the deduped path — a fresh prompt
        // discards the forward stack (editor undo/redo semantics). Session
        // baselines (negative ordinals) never invalidate it.
        const clearRedo = turnOrdinal > 0 && index.redo !== undefined;
        if (index.currentBaselineId !== tree || clearRedo) {
          // P2: ONE construction rule for every persist — spread the loaded
          // index so fields this code path doesn't know about (anchorSeq,
          // redo, future additions) survive; persist disk-first, then swap
          // the cache reference.
          const next: CheckpointIndexFile = { ...index, currentBaselineId: tree };
          if (clearRedo) delete next.redo;
          await this.persistIndex(next);
          this.cachedIndex = next;
        }
        return null;
      }

      // Non-dedup path: a `previous` here always has a DIFFERENT tree (the equal
      // case returned above), so the diff is guaranteed non-empty and the old
      // `previous.tree === tree ? 0 : …` short-circuit is now unreachable.
      const filesChanged = previous
        ? (await this.diffTrees(previous.tree, tree)).length
        : files.length;

      await runGit(['update-ref', refName(tree), tree], this.shadowOpts());

      const record: PersistedCheckpoint = {
        id: checkpointId(tree, turnOrdinal),
        tree,
        // Phase-aware fallback label (W2-F2): a 'before' checkpoint captures the
        // worktree at the START of the turn (before the agent acts); an 'after'
        // one captures the post-edit state that makes undoing the turn
        // force-free. An explicit `label` always wins.
        label: label ?? (phase === 'after' ? `After turn ${turnOrdinal}` : `Before turn ${turnOrdinal}`),
        timestamp: new Date().toISOString(),
        turnOrdinal,
        filesChanged,
        phase,
        // W4-T5b: DISPLAY-ONLY (R8) — stored verbatim, never read back by
        // this class. Omitted (not `sessionLabel: undefined`) when the
        // caller supplied none, mirroring `phase`'s own legacy-compat posture.
        ...(opts.sessionLabel ? { sessionLabel: opts.sessionLabel } : {}),
      };

      // corr-M3 + P2: persist to DISK first, and swap the in-memory cache ONLY
      // after the durable write succeeds. If the write throws, the cache stays
      // exactly consistent with disk (no phantom checkpoint, `currentBaselineId`
      // unchanged) so the "turn ran unprotected" signal the caller logs stays
      // truthful — instead of an in-memory index silently ahead of disk that a
      // later save would persist as a checkpoint the turn reported as missing.
      // Spreading `index` (rather than rebuilding field-by-field) is what keeps
      // fields this code path doesn't know about (anchorSeq, redo) from being
      // silently dropped (the P2 bug this unifies).
      const next: CheckpointIndexFile = {
        ...index,
        currentBaselineId: tree,
        checkpoints: [...index.checkpoints, record],
      };
      // Task 7 (forward-stack invalidation): a new TURN (positive ordinal)
      // kills the redo pointer — never the list (append-only, always). The
      // anchor row stays restorable manually even after this fires.
      if (turnOrdinal > 0) delete next.redo;
      await this.persistIndex(next);
      this.cachedIndex = next;

      // S-M6(g) durability, relocated OFF the barrier (corr-I1): `repack -a -d`
      // (copy borrowed alternate objects into the shadow store) is O(worktree)
      // and MUST NOT run synchronously inside every snapshot — that was seconds
      // of first-token stall per turn and, under two windows, could exceed the
      // cross-process lock wait so the barrier fails open (turn unprotected). The
      // tree is already anchored by its ref above, so localization runs LATER
      // (debounced, and unconditionally in cleanup()) and still copies every
      // object this checkpoint references before a real-repo gc could orphan it.
      // See {@link markLocalizeNeeded} / {@link flushLocalization}.
      this.markLocalizeNeeded();

      return toPublicCheckpoint(record);
    }));
  }

  /**
   * Returns all known checkpoints, newest first, per the frozen `CheckpointsData`
   * shape. W2-F2 Phase 1: `redo` is surfaced verbatim from the index when an undo
   * is outstanding (drives the panel's Redo banner); omitted otherwise.
   */
  async list(): Promise<CheckpointsData> {
    await this.init();
    const index = await this.loadIndex();
    const checkpoints = [...index.checkpoints].reverse().map(toPublicCheckpoint);
    return index.redo ? { checkpoints, redo: index.redo } : { checkpoints };
  }

  /**
   * Restore the worktree to checkpoint `id`.
   *
   * **Dirty-worktree guard**: if the live worktree doesn't match the last
   * known checkpoint baseline (i.e. there are changes — including changes to
   * files excluded from tracking entirely — that no checkpoint has captured),
   * this refuses instead of silently discarding them. Pass `{ force: true }`
   * to override. Only paths that actually differ between the current
   * baseline and the target are touched (written or deleted); anything never
   * tracked by any checkpoint is left alone.
   *
   * **Symlink-escape guard (S-M1)**: even under `force`, each write/delete
   * target is realpath-resolved and re-checked for containment in the worktree
   * root; a target whose real path escapes (via an in-worktree symlink at the
   * leaf or an ancestor) is refused — skipped and reported in `skippedPaths` —
   * so a restore can never follow a link to read/write/delete outside the tree.
   */
  async restore(id: string, opts: { force?: boolean } = {}): Promise<RestoreResult> {
    await this.init();
    return this.enqueue(() => this.withLock(() => this.restoreInternal(id, opts)));
  }

  /**
   * W2-F2 Phase 1: single-step redo — restore the next stored row after the
   * cursor, toward the anchor (the forward tip captured at undo time). Shares
   * EVERY restore guard (R2 dirty-guard, uncaptured-clobber, symlink skip)
   * because it IS a restore. `{restored:false}` with a reason when no redo is
   * outstanding or the anchor's tree vanished (R1 — pointer then cleared: a
   * redo that can never succeed must say so, not restore a phantom).
   */
  async redo(opts: { force?: boolean } = {}): Promise<RestoreResult> {
    await this.init();
    return this.enqueue(() => this.withLock(async () => {
      const index = await this.loadIndex();
      if (!index.redo) return { restored: false, reason: 'No redo available.' };
      const gone = await this.clearRedoIfAnchorMissing(index);
      if (gone) return gone;
      const cursorIdx = index.checkpoints.findIndex((c) => c.id === index.redo!.cursorId);
      const stepTarget = cursorIdx >= 0 ? index.checkpoints[cursorIdx + 1] : undefined;
      // Degenerate cursor (missing row / already at the tip): fall through to the anchor.
      return this.restoreInternal(stepTarget ? stepTarget.id : index.redo.anchorId, opts);
    }));
  }

  /** W2-F2 Phase 1: redo-all — restore the anchor row itself (the forward tip captured at undo time). */
  async redoAll(opts: { force?: boolean } = {}): Promise<RestoreResult> {
    await this.init();
    return this.enqueue(() => this.withLock(async () => {
      const index = await this.loadIndex();
      if (!index.redo) return { restored: false, reason: 'No redo available.' };
      const gone = await this.clearRedoIfAnchorMissing(index);
      if (gone) return gone;
      return this.restoreInternal(index.redo.anchorId, opts);
    }));
  }

  /**
   * R1 for redo: if the ANCHOR's tree object is gone, redo can never succeed —
   * clear the pointer (disk-first) and return the honest refusal. Distinct from
   * {@link restoreInternal}'s own target pre-check, which refuses but KEEPS
   * state (a plain restore's failure says nothing about the anchor). Callers
   * MUST already hold the lock (`redo`/`redoAll`).
   */
  private async clearRedoIfAnchorMissing(index: CheckpointIndexFile): Promise<RestoreResult | undefined> {
    const anchorRow = index.checkpoints.find((c) => c.id === index.redo!.anchorId);
    const anchorTree = anchorRow?.tree;
    // F1 closure check (not just the top tree): an anchor whose closure has a
    // pruned blob/sub-tree can never be redone, so clear the pointer honestly.
    const closureIntact =
      anchorTree !== undefined && (await missingObjects(anchorTree, this.shadowGit())).length === 0;
    if (closureIntact) return undefined;
    const next: CheckpointIndexFile = { ...index };
    delete next.redo;
    await this.persistIndex(next);
    this.cachedIndex = next;
    return {
      restored: false,
      reason: 'Redo is no longer available: the anchor checkpoint\'s tree is no longer in the shadow store.',
    };
  }

  /**
   * Restore the worktree to checkpoint `id`.
   *
   * **Dirty-worktree guard**: if the live worktree doesn't match the last
   * known checkpoint baseline (i.e. there are changes — including changes to
   * files excluded from tracking entirely — that no checkpoint has captured),
   * this refuses instead of silently discarding them. Pass `{ force: true }`
   * to override. Only paths that actually differ between the current
   * baseline and the target are touched (written or deleted); anything never
   * tracked by any checkpoint is left alone.
   *
   * **Symlink-escape guard (S-M1)**: even under `force`, each write/delete
   * target is realpath-resolved and re-checked for containment in the worktree
   * root; a target whose real path escapes (via an in-worktree symlink at the
   * leaf or an ancestor) is refused — skipped and reported in `skippedPaths` —
   * so a restore can never follow a link to read/write/delete outside the tree.
   *
   * **W2-F2 Phase 1 (P1) anchor pre-capture**: BEFORE any file is written or
   * deleted, the pre-restore live tree is guaranteed to exist as a restorable
   * row (reusing the newest row that already holds it, or appending a fresh
   * `phase: 'anchor'` row) and the persisted `redo` pointer is established/
   * moved/consumed per the state machine documented on {@link
   * CheckpointIndexFile.redo}. Callers MUST already hold the lock+queue
   * (`restore`/`redo`/`redoAll` are the only call sites).
   */
  private async restoreInternal(id: string, opts: { force?: boolean }): Promise<RestoreResult> {
    const target = await this.findCheckpoint(id);
    const index = await this.loadIndex();

    // R1 (universal target pre-check, F1 closure check): refuse cleanly if ANY
    // object in the target tree's closure — the tree, its sub-trees, or a leaf
    // blob — is gone from the shadow store (external `gc --prune`, a deleted
    // storage dir, tampering) BEFORE the apply loop below mutates the worktree
    // per-path and `git show <tree>:<path>` dies mid-flight on the missing blob
    // (a HALF-restored worktree + stale baseline — the live F1 defect). The old
    // check validated only the top tree object (`cat-file -e <tree>^{tree}`), so
    // a pruned leaf blob slipped past it. State (the baseline, any redo pointer)
    // is left untouched — a plain restore's failure says nothing about the anchor
    // (see {@link clearRedoIfAnchorMissing} for the redo-specific variant that
    // DOES clear the pointer).
    const targetMissing = await missingObjects(target.tree, this.shadowGit());
    if (targetMissing.length > 0) {
      return {
        restored: false,
        reason:
          `Checkpoint ${id} is missing ${targetMissing.length} object(s) from the shadow ` +
          'store (pruned externally?) — refusing to restore so the worktree is not partially mutated.',
      };
    }

    const { tree: currentTree, files: currentFiles } = await this.writeTreeFromWorktree();
    const includedSet = new Set(currentFiles);
    const baseline = index.currentBaselineId;
    const treeDirty = baseline !== null ? currentTree !== baseline : currentFiles.length > 0;

    const changes = await this.diffTrees(currentTree, target.tree);

    // Dirty-guard, hardened against the include/exclude boundary (review
    // CRITICAL #1). The tree-hash comparison above only sees files that
    // survived the ignore + size filter, so a file that crossed the ~2 MiB
    // cutoff (or an ignore change) is INVISIBLE to it — yet a restore that
    // writes over that path would silently destroy live bytes NO checkpoint
    // ever captured. So we additionally refuse if any WRITE (added/modified)
    // targets a path where a live file exists that is NOT part of the
    // captured current tree (i.e. it was excluded). Deleted entries only ever
    // target paths present in the captured current tree, so they cannot
    // remove never-captured bytes and are safe by construction.
    let uncapturedClobber: string | null = null;
    for (const change of changes) {
      if (change.status === 'deleted') continue;
      if (includedSet.has(change.path)) continue; // captured in the baseline tree
      const absPath = path.join(this.workspaceRoot, ...change.path.split('/'));
      if (await pathExists(absPath)) {
        uncapturedClobber = change.path;
        break;
      }
    }

    if ((treeDirty || uncapturedClobber !== null) && !opts.force) {
      const detail =
        uncapturedClobber !== null
          ? `restoring would overwrite live, never-captured content at '${uncapturedClobber}' ` +
            '(excluded by ignore rules or the file-size cutoff)'
          : 'the worktree has changes since the last checkpoint that no checkpoint captured';
      return {
        restored: false,
        reason: `Refusing to restore: ${detail}. Pass { force: true } to override.`,
      };
    }

    // ---- P1 (Task 6): eager anchor pre-capture (BEFORE any file mutation) ---
    // The pre-restore live tree (`currentTree`) must exist as a restorable row
    // so nothing this restore overwrites is ever lost. NOT via snapshot(): its
    // tree-hash dedup returns null with NO row exactly in the common
    // settled-turn undo case (currentTree === newest row's tree — the P1 trap).
    // Reuse the newest row already holding this tree; append a fresh anchor
    // row otherwise. Runs even when a redo pointer already exists (rule 3): a
    // dirty-while-reverted forced restore still appends a row so nothing is lost.
    let workingIndex = index;
    let anchorRowId_ = '';
    for (let i = workingIndex.checkpoints.length - 1; i >= 0; i--) {
      const cp = workingIndex.checkpoints[i];
      if (cp === undefined) {
        // Unreachable: i ranges over [0, checkpoints.length - 1] here.
        continue;
      }
      if (cp.tree === currentTree) {
        anchorRowId_ = cp.id;
        break;
      }
    }
    if (anchorRowId_ === '') {
      const seq = (workingIndex.anchorSeq ?? 0) + 1;
      const newest = workingIndex.checkpoints[workingIndex.checkpoints.length - 1];
      const anchorRecord: PersistedCheckpoint = {
        id: anchorRowId(currentTree, seq),
        tree: currentTree,
        label: 'Before restore',
        timestamp: new Date().toISOString(),
        filesChanged: newest ? (await this.diffTrees(newest.tree, currentTree)).length : currentFiles.length,
        phase: 'anchor',
      };
      // Pin the anchor tree so gc can never reap it (same ref-per-tree scheme as
      // snapshot(); create-only — see the retention invariant at refName()).
      await runGit(['update-ref', refName(currentTree), currentTree], this.shadowOpts());
      const withAnchor: CheckpointIndexFile = {
        ...workingIndex,
        anchorSeq: seq,
        checkpoints: [...workingIndex.checkpoints, anchorRecord],
      };
      await this.persistIndex(withAnchor); // disk-first: a crash mid-apply leaves the anchor recoverable
      this.cachedIndex = withAnchor;
      workingIndex = withAnchor;
      anchorRowId_ = anchorRecord.id;
      this.markLocalizeNeeded(); // the fresh tree may borrow alternate objects
    }

    const changedPaths: string[] = [];
    const skippedPaths: string[] = [];
    for (const change of changes) {
      const absPath = path.join(this.workspaceRoot, ...change.path.split('/'));

      // S-M1 realpath/traversal guard. `change.path` is a git tree path (git
      // normalizes away `..`), so the lexical join is in-tree — but the LIVE
      // worktree may since have turned an ancestor dir or the leaf itself into
      // a symlink pointing OUTSIDE. `fs.writeFile`/`fs.rm` would then follow it
      // and read/write/delete beyond the worktree (worse under `force`). We
      // therefore resolve the REAL path of both the target and the root and
      // re-assert containment — the same safe-realpath predicate the ACP
      // `readTextFile` confinement uses (`resolveWithinWorkspaceReal`), which
      // realpaths the ROOT too so pnpm/Nix/monorepo symlinked-root layouts
      // still pass. Escapes are refused (skipped + recorded), never applied.
      const safe = await resolveWithinWorkspaceReal(absPath, [this.workspaceRoot]);
      if (safe === null) {
        skippedPaths.push(change.path);
        continue;
      }

      // T-C3 (closes V-3): a per-path I/O failure here (Fedora-realistic
      // ENOSPC/EACCES/EROFS, or `git show` dying on a since-pruned blob) must
      // NOT abort the whole restore after files 1..N-1 were already mutated —
      // that would both throw away the changedPaths/skippedPaths disclosure
      // built so far AND skip the persistIndex(next) below, leaving the
      // baseline pointed at the pre-restore tree while the worktree is
      // already half-mutated (surfaced upstream as a clean "refused" that a
      // destructive "Restore anyway" re-arm would then apply OVER a tree the
      // user was told was untouched). Disclose instead, exactly like the
      // S-M1 escape-refusal above: record the path as skipped and continue —
      // one disclosure channel ("this path was not applied") for both
      // reasons. The log line carries our own relative path + the errno CODE
      // only — never `String(err)` (which for an fs error embeds the ABSOLUTE
      // path, leaking the home-dir/username) and never file content (the
      // `content` read below may not even have completed).
      try {
        if (change.status === 'deleted') {
          await fs.rm(absPath, { force: true });
        } else {
          // Never write THROUGH an in-worktree symlink at the leaf: drop the link
          // first so we write a fresh regular file at the intended in-tree path.
          await removeIfSymlink(absPath);
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          const content = await runGitBinary(
            ['show', `${target.tree}:${change.path}`],
            this.shadowOpts(),
          );
          await fs.writeFile(absPath, content);
        }
        changedPaths.push(change.path);
      } catch (err: unknown) {
        const code =
          (err as NodeJS.ErrnoException).code ??
          (err instanceof Error ? err.name : 'unknown');
        console.error(`restore: failed to apply ${change.path}: ${code}`);
        skippedPaths.push(change.path);
        continue;
      }
    }

    // ---- redo pointer + baseline (single durable write; corr-M3 disk-first,
    // P4/C5) --------------------------------------------------------------
    // Establish (rule 1) on the first undo; Move (rule 3) keeps the ORIGINAL
    // anchor and only moves the cursor while a redo is already outstanding;
    // Consume (rule 4) clears the pointer when the restore target IS the
    // anchor row itself (a manual restore of it, or redoAll()).
    const anchorId = workingIndex.redo?.anchorId ?? anchorRowId_;
    const next: CheckpointIndexFile = { ...workingIndex, currentBaselineId: target.tree };
    if (target.id === anchorId) {
      delete next.redo; // restored the forward tip — pointer consumed
    } else {
      next.redo = { anchorId, cursorId: target.id }; // establish on first undo / move the cursor after
    }
    await this.persistIndex(next);
    this.cachedIndex = next;

    return skippedPaths.length > 0
      ? { restored: true, filesChanged: changedPaths.length, changedPaths, skippedPaths }
      : { restored: true, filesChanged: changedPaths.length, changedPaths };
  }

  /**
   * Files changed for checkpoint `id` — against `otherId` when given,
   * otherwise against the live worktree.
   */
  async diff(id: string, otherId?: string): Promise<CheckpointDiffEntry[]> {
    await this.init();
    return this.enqueue(() => this.withLock(async () => {
      const from = await this.findCheckpoint(id);
      if (otherId !== undefined) {
        const to = await this.findCheckpoint(otherId);
        return this.diffTrees(from.tree, to.tree);
      }
      const { tree: currentTree } = await this.writeTreeFromWorktree();
      return this.diffTrees(from.tree, currentTree);
    }));
  }

  /** `git gc --prune=<pruneDays>.days.ago` — checkpoint refs keep live trees reachable. */
  async cleanup(pruneDays?: number): Promise<void> {
    await this.init();
    return this.enqueue(() => this.withLock(async () => {
      // Durability backstop (S-M6g): localize any checkpoint objects still
      // borrowed from the real repo BEFORE gc. snapshot() now defers this off
      // the barrier and a crash could skip a debounced run, so cleanup() —
      // invoked opportunistically on every activation (extension.ts) —
      // guarantees any pre-existing checkpoint is made self-contained here, well
      // before a real gc could orphan it. No-op when there is no real repo.
      await this.localizeAlternateObjects();
      this.localizePending = false;
      const days = pruneDays ?? this.defaultPruneDays;
      // `gc` can legitimately run long on a large repo; it is off the turn's
      // critical path (activation-time), so it is exempt from the wall-clock
      // timeout that bounds barrier ops.
      await runGit(['gc', `--prune=${days}.days.ago`], { ...this.shadowOpts(), timeoutMs: 0 });
    }));
  }

  /**
   * Run any pending alternate-object localization (`repack`) NOW, serialized
   * through the queue + cross-process lock so it never races a snapshot.
   * Idempotent: a no-op when nothing is pending or the workspace has no real
   * repo. Callers use it to guarantee durability before an external `git gc`
   * (tests; a future shutdown hook). Also cancels the debounce timer.
   */
  async flushLocalization(): Promise<void> {
    if (this.localizeTimer !== undefined) {
      clearTimeout(this.localizeTimer);
      this.localizeTimer = undefined;
    }
    if (!this._hasRealGitAlternates || !this.localizePending) return;
    await this.init();
    return this.enqueue(() =>
      this.withLock(async () => {
        if (!this.localizePending) return;
        await this.localizeAlternateObjects();
        this.localizePending = false;
      }),
    );
  }

  /** Cancel the background localization timer (idempotent). Safe to call on shutdown. */
  dispose(): void {
    if (this.localizeTimer !== undefined) {
      clearTimeout(this.localizeTimer);
      this.localizeTimer = undefined;
    }
  }

  // --- internals ----------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Run `fn` while holding the cross-process advisory lock; always releases. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const handle = await acquireLock(this.shadowDir, {
      staleMs: this.lockStaleMs,
      maxWaitMs: this.lockMaxWaitMs,
    });
    try {
      // P5 (arch A4): another window/process may have persisted a newer index
      // while we were unlocked. Drop the cache so the FIRST loadIndex() inside
      // this critical section re-reads disk — the lock serializes writers, and
      // this makes it serialize metadata READS too (without it, a stale cache
      // is re-persisted wholesale and silently erases the other window's rows —
      // and, Phase 1, its anchor row / redo pointer). persistIndex's atomic
      // rename guarantees we never see a torn file.
      this.cachedIndex = null;
      return await fn();
    } finally {
      await handle.release();
    }
  }

  private shadowOpts(input?: string): RunGitOptions {
    return {
      cwd: this.workspaceRoot,
      env: sanitizeGitEnv(process.env, { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workspaceRoot }),
      input,
      // Wall-clock bound so a stalled git can never hang the awaited barrier
      // (arch A#1). Maintenance ops (repack/gc) override this with `timeoutMs: 0`.
      timeoutMs: this.gitTimeoutMs,
    };
  }

  /**
   * A {@link ./objectClosure.RunGit} bound to this tracker's shadow repo — the
   * seam the F1 closure check ({@link ./objectClosure.missingObjects}) runs on.
   * Merges the caller's per-call `input`/`allowFailure` over the shadow cwd/env.
   */
  private shadowGit(): RunGit {
    return (args, opts) =>
      runGit(args, { ...this.shadowOpts(opts?.input), allowFailure: opts?.allowFailure });
  }

  /**
   * Flag that a snapshot borrowed objects from the real repo and (re)schedule a
   * DEBOUNCED background localization repack (corr-I1). Coalesces a burst of
   * turns into one repack instead of paying O(worktree) per snapshot on the
   * barrier. No-op when there is no real repo to borrow from. The debounce fires
   * ~`localizeDebounceMs` after the FIRST pending snapshot (it does not reset on
   * each mark), so localization latency stays bounded even under continuous
   * turns; the timer re-arms on the next snapshot after it fires.
   *
   * I-2: the timer is now `ref`'d (was `unref`'d). The window between anchoring a
   * borrowing checkpoint's ref and localizing its blobs is where a real-repo
   * `gc --prune` can orphan them, so we do NOT want that timer skipped on a
   * process that is draining its event loop to exit — a `ref`'d timer fires
   * before such an exit. Combined with the shortened debounce (500 ms) this
   * shrinks the exposure to a hard crash/force-kill (which no timer, `ref`'d or
   * not, survives). It never actually delays a real host shutdown: `dispose()`
   * and `flushLocalization()` clear it, and the extension's `deactivate()` flushes
   * synchronously (extension.ts) — so the `ref` only matters on an otherwise-idle
   * drain, and only for at most `localizeDebounceMs`.
   */
  private markLocalizeNeeded(): void {
    if (!this._hasRealGitAlternates) return;
    this.localizePending = true;
    if (this.localizeTimer !== undefined) return; // a flush is already scheduled
    this.localizeTimer = setTimeout(() => {
      this.localizeTimer = undefined;
      void this.flushLocalization().catch(() => undefined);
    }, this.localizeDebounceMs);
  }

  private async initInternal(): Promise<void> {
    await fs.mkdir(this.shadowDir, { recursive: true });
    await this.preflightGitAvailable();

    if (!(await pathExists(this.gitDir))) {
      await runGit(['init', '--quiet'], this.shadowOpts());
      await runGit(['config', 'user.name', 'Hermes Checkpoints'], this.shadowOpts());
      await runGit(['config', 'user.email', 'checkpoints@hermes.local'], this.shadowOpts());
      await runGit(['config', 'commit.gpgsign', 'false'], this.shadowOpts());
      await runGit(['config', 'gc.auto', '0'], this.shadowOpts()); // we gc explicitly via cleanup()
    }

    await this.syncAlternates();
    await this.loadIndex();
  }

  private async preflightGitAvailable(): Promise<void> {
    try {
      await runGit(['--version'], { cwd: this.storageDir, env: sanitizeGitEnv(process.env) });
    } catch (err) {
      throw new GitUnavailableError(
        `git executable not found on PATH; checkpoints are disabled (${String(err)})`,
      );
    }
  }

  /**
   * Detects whether {@link workspaceRoot} sits inside a real git repo
   * (including as a subdirectory of an ancestor repo) and, if so, points the
   * shadow store's `objects/info/alternates` at that repo's shared object
   * database. Nested `.git` dirs *inside* the workspace (submodule-like) are
   * irrelevant here — this only ever looks at ancestors of `workspaceRoot`.
   */
  private async syncAlternates(): Promise<void> {
    const discoveryEnv = sanitizeGitEnv(process.env);
    let realGitDir: string | null = null;
    try {
      const isInside = await runGit(['rev-parse', '--is-inside-work-tree'], {
        cwd: this.workspaceRoot,
        env: discoveryEnv,
        allowFailure: true,
      });
      if (isInside.code === 0 && isInside.stdout.trim() === 'true') {
        const commonDir = await runGit(['rev-parse', '--git-common-dir'], {
          cwd: this.workspaceRoot,
          env: discoveryEnv,
        });
        realGitDir = path.resolve(this.workspaceRoot, commonDir.stdout.trim());
      }
    } catch {
      realGitDir = null;
    }

    if (!realGitDir) {
      this._hasRealGitAlternates = false;
      return;
    }

    const realObjectsDir = path.join(realGitDir, 'objects');
    const alternatesPath = path.join(this.gitDir, 'objects', 'info', 'alternates');
    await fs.mkdir(path.dirname(alternatesPath), { recursive: true });
    await fs.writeFile(alternatesPath, toPosixAbsolute(realObjectsDir) + '\n', 'utf8');
    this._hasRealGitAlternates = true;
  }

  /**
   * Durability fix for review S-M6(g).
   *
   * The shadow store shares the real repo's object database via
   * `objects/info/alternates`, so a `write-tree` for unchanged content does NOT
   * re-write those blobs/trees locally — it BORROWS them from the real repo (the
   * OpenCode perf win). That leaves a checkpoint's tree pointing at objects that
   * physically exist ONLY in the real repo. A user who then runs
   * `git gc --prune` (even `--prune=now`) on their real repo can delete those
   * now-unreachable objects, and every checkpoint that referenced them becomes
   * un-restorable (`git show <tree>:<path>` / `diff-tree` fail on the missing
   * object).
   *
   * The fix runs `git repack -a -d` (WITHOUT `-l`/`--local`) in the SHADOW right
   * after a checkpoint's tree is anchored by its ref. Per git-pack-objects,
   * `--local` is precisely what would cause "an object that is borrowed from an
   * alternate object store to be ignored even if it would have otherwise been
   * packed" — so OMITTING it makes repack pull every object reachable from the
   * shadow's checkpoint refs, INCLUDING alternate-borrowed blobs/trees, into a
   * pack inside the shadow's OWN object dir. `-d` then drops the now-redundant
   * loose duplicates. From that point the shadow is self-contained for all
   * existing checkpoints, so a real-repo gc can no longer orphan any of them.
   *
   * Invariants preserved: repack only writes into the shadow `GIT_DIR` (never
   * the real `.git`), and the enumeration is bounded by objects reachable from
   * checkpoint refs (the captured file content), not the whole real repo. No-op
   * when the workspace has no real repo (nothing is borrowed).
   *
   * Durability guarantee (RESTATED for corr-I1's off-barrier relocation +
   * I-2's window shrink): the repack no longer runs synchronously inside
   * `snapshot()`. It is instead scheduled debounced right after a borrowing
   * snapshot ({@link markLocalizeNeeded}) and run unconditionally at the start of
   * {@link cleanup} (invoked on every activation). A checkpoint's tree is
   * anchored by its ref inside `snapshot()` BEFORE the barrier resolves, so the
   * borrowed objects stay reachable-from-shadow until this repack copies them in.
   * The guarantee holds provided localization runs before a REAL-repo gc — which
   * the debounce, the every-activation cleanup(), and the `deactivate()` flush
   * (extension.ts) ensure — rather than before every prompt (the point of Fix-A).
   *
   * Why the window matters (git-grounded): a checkpoint's borrowed blobs live
   * ONLY in the real repo until this repack. If the user rewrites history so
   * those blobs become unreachable and runs `git gc --prune=now`, git "prunes
   * loose objects regardless of their age" (git-gc docs) — deleting them
   * immediately — and every checkpoint that referenced them turns un-restorable.
   * `repack -a -d` WITHOUT `--local` copies those alternate-borrowed objects into
   * the shadow's own pack (git-pack-objects: `--local` is exactly what would make
   * "an object that is borrowed from an alternate object store ... be ignored";
   * omitting it packs them in), and `-d` drops the redundant loose duplicates —
   * from then on the shadow is self-contained for all existing checkpoints.
   *
   * I-2 window shrink: the debounce is 500 ms (down from 2 s) and its timer is
   * `ref`'d, so on any normal exit — the `deactivate()` flush, or even a bare
   * event-loop drain — the pending localization runs before the process leaves.
   * Residual (irreducible, DOCUMENTED): a HARD crash / `SIGKILL` in the ~500 ms
   * between a borrowing snapshot and its localization, followed by a real-repo
   * `gc --prune` before the next activation's cleanup(), could still orphan that
   * one just-made checkpoint. No in-process scheme closes this fully — a
   * force-killed host runs neither a timer nor `deactivate()`; only capturing the
   * blobs on the barrier (the seconds-of-stall Fix-A removed) or an OS-level
   * crash-consistent snapshot could, and both are worse trades than this residual.
   */
  private async localizeAlternateObjects(): Promise<void> {
    if (!this._hasRealGitAlternates) return;
    // `repack -a -d` is O(all shadow objects) and can legitimately run long on a
    // large real repo; it is OFF the turn's critical path and holds only the
    // shadow lock, so a stall can at worst delay the NEXT snapshot by the lock
    // wait (then fail-open) — never the awaited barrier directly. Killing it
    // mid-repack could also leave durability half-done, so it is exempt from the
    // wall-clock timeout (timeoutMs: 0).
    await runGit(['repack', '-a', '-d'], { ...this.shadowOpts(), timeoutMs: 0 });
  }

  private async loadIndex(): Promise<CheckpointIndexFile> {
    if (this.cachedIndex) return this.cachedIndex;

    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // First run — no index yet. Create an empty one.
        this.cachedIndex = {
          workspaceRoot: this.workspaceRoot,
          currentBaselineId: null,
          checkpoints: [],
        };
        await this.saveIndex();
        return this.cachedIndex;
      }
      throw err; // a real read error is NOT a reason to discard history
    }

    let parsed: CheckpointIndexFile;
    try {
      parsed = JSON.parse(raw) as CheckpointIndexFile;
    } catch (err) {
      // Corrupt index. Refuse to silently reset it — that would DELETE the
      // user's checkpoint history. Surface the failure instead so the caller can
      // report/recover. (Because {@link saveIndex} writes atomically, a
      // concurrent writer can never expose a half-written file here, so this
      // signals genuine corruption rather than a benign read/write race.)
      throw new Error(`Checkpoint index at ${this.indexPath} is unreadable/corrupt: ${String(err)}`);
    }

    // Migration: pre-existing records stored only the bare `write-tree` hash as
    // `id` and had no separate `tree`. Backfill `tree` from `id` so tree-ish git
    // operations keep resolving for older checkpoints.
    for (const c of parsed.checkpoints) {
      if (typeof (c as Partial<PersistedCheckpoint>).tree !== 'string') {
        c.tree = c.id;
      }
    }

    this.cachedIndex = parsed;
    return this.cachedIndex;
  }

  private async saveIndex(): Promise<void> {
    if (!this.cachedIndex) return;
    await this.persistIndex(this.cachedIndex);
  }

  /**
   * Atomically write a checkpoint index to disk WITHOUT mutating {@link
   * cachedIndex}. Serialize to a unique temp file in the same dir, then rename
   * over the target. rename(2) is atomic on a single filesystem, so a lock-free
   * reader (e.g. {@link list}, or another window) ever sees only the old OR the
   * new complete file — never a truncated/partial index. This is what lets
   * `list()` stay off the cross-process lock without risking a partial-read that
   * the old code would "recover" from by wiping history.
   *
   * corr-M3: because this does NOT touch the cache, `snapshot()` can persist the
   * would-be-next index FIRST and commit to the cache only after this resolves —
   * so a failed write leaves memory exactly consistent with disk.
   */
  private async persistIndex(data: CheckpointIndexFile): Promise<void> {
    const serialized = JSON.stringify(data, null, 2);
    const tmpPath = `${this.indexPath}.tmp-${randomUUID()}`;
    await fs.writeFile(tmpPath, serialized, 'utf8');
    try {
      await fs.rename(tmpPath, this.indexPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async findCheckpoint(id: string): Promise<PersistedCheckpoint> {
    const index = await this.loadIndex();
    for (let i = index.checkpoints.length - 1; i >= 0; i--) {
      const c = index.checkpoints[i];
      if (c === undefined) {
        // Unreachable: i ranges over [0, checkpoints.length - 1] here.
        continue;
      }
      if (c.id === id) return c;
    }
    throw new Error(`Checkpoint not found: ${id}`);
  }

  /**
   * Stage the live worktree (ignore-filtered + size-cutoff) into the PERSISTENT
   * (warm) shadow index and `write-tree` it. Correctness + perf (corr-I1 /
   * research §5.5):
   *
   * The index is NO LONGER emptied (`read-tree --empty`) each snapshot — doing
   * so discarded git's stat-cache and forced a full COLD `git add` (re-lstat +
   * re-hash of every file, ~2–2.8 s per 6 K files) on the awaited barrier every
   * turn. Instead the index is kept warm across snapshots AND across process
   * restarts (it lives at `<shadow>/.git/index`, guarded by the cross-process
   * lock), so `git add` re-hashes only files whose stat data actually changed.
   * This is safe: git's own racy-clean handling re-examines any entry whose
   * mtime is not strictly older than the index's, comparing CONTENT, so a
   * same-second edit can never leave a stale blob in the tree — the captured
   * tree is EXACT.
   *
   * M-2 (documented caveat, NOT a concern on the Fedora/Linux target): the warm
   * index trusts git's stat-cache, and git's racy-clean re-check keys on mtime +
   * SIZE. On filesystems where git's racy-clean handling is known to be defeated
   * — the "still broken" set: CEPH/CIFS/NTFS/UDF and other coarse-/unstable-mtime
   * stores — a same-SECOND, same-SIZE, in-place edit could slip past the re-check
   * and leave a stale blob in the captured tree. Hermes targets local
   * ext4/btrfs/xfs (nanosecond mtime, stable stat), where this cannot happen; the
   * caveat is recorded only for a future networked-worktree deployment.
   *
   * To keep the tree EXACTLY the current included set (no stale entries) we
   * compute the delta against the warm index each time:
   *  - ADD/MODIFY: `git add -f` over the current included set (unchanged files
   *    skipped cheaply via the warm stat-cache).
   *  - REMOVE: any path in the index NOT in the current set — because it was
   *    deleted, OR it crossed the ignore/size boundary OUT of the tracked set
   *    (e.g. grew past the cutoff) — is dropped from the index with
   *    `git rm --cached` (index only; the live file, if any, is untouched).
   *    Plain `git add <list>` MISSES both (a deleted file is absent from the
   *    list; a now-excluded file still exists on disk so `add` would re-stage
   *    it), so the explicit removal is what keeps the warm index honest.
   *
   * The two ops are disjoint (add touches the current set, remove touches
   * index∖current), so the resulting index is exactly the current set with
   * current content. The delta is recomputed from the live index each call, so
   * it is self-correcting and never accumulates drift (no periodic cold rebuild
   * needed).
   */
  private async writeTreeFromWorktree(): Promise<{ tree: string; files: string[] }> {
    const files = await this.scanWorktree();
    const currentSet = new Set(files);
    const indexed = await this.listIndexedFiles();
    const toRemove = indexed.filter((p) => !currentSet.has(p));

    if (files.length > 0) {
      // S-M6(b): stage via a NUL-delimited pathspec list on stdin. Per git-add,
      // `--pathspec-file-nul` separates elements with NUL and takes "all other
      // characters ... literally (including newlines and quotes)" — so a path
      // containing a newline/control char stages as one entry instead of being
      // split by the default LF delimiter into corrupt pathspecs. `--literal-
      // pathspecs` additionally disables pathspec magic/globbing, so a name
      // beginning with `:` or containing `*`/`?`/`[` is taken verbatim too. Each
      // scanned name is non-empty (guarded above) so there is no empty element,
      // which would otherwise be an "everything" pathspec. `-f` forces staging
      // regardless of the workspace's own .gitignore (Hermes' scanWorktree
      // filter is the authoritative include decision).
      await runGit(
        ['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { ...this.shadowOpts(), input: files.join('\0') },
      );
    }
    if (toRemove.length > 0) {
      // Drop index-only entries for paths that left the tracked set. `--cached`
      // = index only (the live file is NEVER touched — critical for the
      // grew-past-cutoff case, where the file still exists but must leave the
      // captured set); `--force` overrides the up-to-date safety check (the
      // shadow has no HEAD to diff against); `--ignore-unmatch` keeps a benign
      // no-op from failing the snapshot. Same NUL-safe / literal-pathspec
      // staging as the add so a newline/`:`/glob-bearing name is taken literally.
      await runGit(
        [
          '--literal-pathspecs',
          'rm',
          '--cached',
          '--force',
          '--ignore-unmatch',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        { ...this.shadowOpts(), input: toRemove.join('\0') },
      );
    }
    const result = await runGit(['write-tree'], this.shadowOpts());
    return { tree: result.stdout.trim(), files };
  }

  /**
   * The warm shadow index's current entries as relative POSIX paths, via
   * `git ls-files -z`. `-z` = NUL-delimited raw (unquoted) names, so a non-ASCII
   * or newline-bearing path round-trips intact (mirrors the staging + diff
   * paths). Used by {@link writeTreeFromWorktree} to compute index removals.
   */
  private async listIndexedFiles(): Promise<string[]> {
    const result = await runGit(['ls-files', '-z'], this.shadowOpts());
    return result.stdout.split('\0').filter((p) => p.length > 0);
  }

  private async diffTrees(from: string, to: string): Promise<CheckpointDiffEntry[]> {
    if (from === to) return [];
    // `-z` = NUL-delimited, raw (unquoted) paths — the ONLY safe way to read
    // back names with non-ASCII bytes, tabs, or control chars (review
    // IMPORTANT #2). Without it, git's default `core.quotepath=true` C-quotes
    // e.g. `café.txt` -> `"caf\303\251.txt"`, which a \t/\n split would take
    // literally, corrupting restore.
    const result = await runGit(
      ['diff-tree', '--no-commit-id', '-r', '-z', '--name-status', from, to],
      this.shadowOpts(),
    );
    return parseNameStatusZ(result.stdout);
  }

  /**
   * Recursively enumerates workspace files, applying the shared ignore filter +
   * size cutoff, under a WALL-CLOCK DEADLINE (I-1 / arch A#1).
   *
   * This walk is the FIRST step of the pre-turn snapshot barrier and runs BEFORE
   * any git subprocess, so the git-child timeout that bounds every other barrier
   * op (`gitProcess`) does NOT cover it. A stalled workspace FS — the exact
   * NFS/sshfs / filesystem stall that timeout comment cites — would wedge an
   * `fs.readdir`/`fs.stat` in the libuv threadpool, the awaited barrier would
   * never settle, and the user's prompt would be silently never sent (the git
   * timeout could never fire because execution never reaches a git subprocess).
   *
   * We bound the walk with the SAME budget as the git ops ({@link gitTimeoutMs})
   * two ways, closing both the slow-but-progressing and the fully-wedged subsets:
   *  - a per-entry deadline check throws once `Date.now()` passes the deadline
   *    (bounds a walk that keeps resolving fs calls but too slowly / too many);
   *  - the whole walk is raced against a timer that rejects when a single fs call
   *    never resolves at all (the wedged-FS case a per-entry check can't catch).
   * Either path rejects with a typed {@link WorktreeScanTimeoutError}, which
   * flows to `snapshot()`'s caller EXACTLY like {@link GitTimeoutError} → the
   * barrier's existing fail-open path (turn proceeds UNPROTECTED, never blocked).
   *
   * C1-SAFE: this bounds-and-REJECTS the snapshot before `write-tree`, so a
   * timed-out/wedged scan can NEVER set `currentBaselineId` — the baseline still
   * only ever moves after a completed `write-tree` (a late-resolving walk is
   * abandoned, not finished late). A hard uninterruptible D-state `lstat` cannot
   * be bounded in userspace (the raced timer settles our awaiting promise, but
   * the underlying syscall still leaks in the threadpool) — that is the accepted
   * irreducible limit for the walk, just as it is for git; we close the
   * slow/progressing-and-wedged-but-cancelable-await subset, which is the point.
   */
  private async scanWorktree(): Promise<string[]> {
    const budgetMs = this.gitTimeoutMs;
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;
    const checkDeadline = (): void => {
      if (Date.now() > deadline) {
        throw new WorktreeScanTimeoutError(
          `worktree scan exceeded the ${budgetMs}ms wall-clock deadline (a stalled workspace ` +
            'filesystem — e.g. an NFS/sshfs worktree or an FS stall); the snapshot is abandoned ' +
            'and the turn proceeds unprotected.',
        );
      }
    };

    const gitignoreContents: string[] = [];
    for (const name of ['.gitignore', '.hermesignore']) {
      try {
        gitignoreContents.push(await fs.readFile(path.join(this.workspaceRoot, name), 'utf8'));
      } catch {
        // absent — defaults still apply.
      }
    }
    const isIgnored = createIgnoreFilter(gitignoreContents, this.extraIgnoreGlobs);

    const included: string[] = [];
    const walk = async (absDir: string, relDir: string): Promise<void> => {
      checkDeadline();
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        checkDeadline();
        if (entry.isSymbolicLink()) continue; // never follow symlinks (footgun avoidance)
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (isIgnored(`${relPath}/`)) continue;
          await walk(path.join(absDir, entry.name), relPath);
        } else if (entry.isFile()) {
          if (isIgnored(relPath)) continue;
          let size = 0;
          try {
            size = (await fs.stat(path.join(absDir, entry.name))).size;
          } catch {
            continue; // vanished mid-walk
          }
          if (size > this.maxFileBytes) continue;
          included.push(relPath);
        }
      }
    };

    await this.raceScanDeadline(walk(this.workspaceRoot, ''), budgetMs);
    included.sort();
    return included;
  }

  /**
   * Settle `walk` OR a wall-clock timer, whichever comes first (I-1). If the
   * timer wins we reject with {@link WorktreeScanTimeoutError} even though the
   * walk's wedged fs call is still pending in the threadpool (it cannot be
   * cancelled — the accepted irreducible limit). `walk` already carries a
   * rejection handler from `Promise.race`, so its later settlement (if any) is a
   * no-op rather than an unhandled rejection. `budgetMs <= 0` disables the timer
   * (parity with the git ops' `timeoutMs: 0`), leaving only the per-entry check.
   */
  private async raceScanDeadline(walk: Promise<void>, budgetMs: number): Promise<void> {
    if (budgetMs <= 0) {
      await walk;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new WorktreeScanTimeoutError(
            `worktree scan exceeded the ${budgetMs}ms wall-clock deadline and was abandoned ` +
              '(a wedged workspace filesystem — e.g. an NFS/sshfs worktree or an FS stall — whose ' +
              'fs.readdir/fs.stat never returned); the turn proceeds unprotected.',
          ),
        );
      }, budgetMs);
      // Never keep the extension host alive just to time out a walk.
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([walk, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// --- module-level helpers --------------------------------------------------

/**
 * Per-TREE pin ref. NOTE the cardinality: rows→refs is MANY-TO-ONE — an
 * A→B→A worktree stores tree A under two rows (and Phase 1's anchor may be a
 * third) all pinned by ONE ref. Retention invariant (Phase 1, load-bearing
 * for redo):
 *   - `index.checkpoints` is APPEND-ONLY (nothing anywhere truncates it), and
 *   - refs are CREATE-ONLY (`update-ref` on snapshot/anchor-capture; no
 *     deletion code exists — keep it that way).
 * A future prune (Phase 3, pair-aware) MUST be a refcount sweep: root-mark
 * every tree referenced by ANY row in `index.checkpoints` AND by
 * `index.redo.anchorId`'s row, and only then may it delete unreferenced refs
 * — deleting by age or by "the row I just removed" would unpin a tree a
 * surviving row still references (the exact Kilo 7-day-GC / Roo-truncate
 * failure family; see docs/reviews/plans/bucket-2-phase1-plan.md Task 11).
 */
function refName(treeHash: string): string {
  return `refs/hermes/checkpoints/${treeHash}`;
}

/**
 * Public checkpoint id: the tree hash plus the turn ordinal. The tree hash alone
 * can recur across NON-consecutive turns (identical worktree ⇒ identical
 * `write-tree`; W2-F2 dedup rules out two CONSECUTIVE stored duplicates but not
 * an A→B→A recurrence at a later ordinal); folding in the turn ordinal makes the
 * id unique per checkpoint without losing restore-by-id (the tree-ish is stored
 * separately in `PersistedCheckpoint.tree`).
 */
function checkpointId(tree: string, turnOrdinal: number): string {
  return `${tree}-${turnOrdinal}`;
}

/**
 * Anchor-row id: `<tree>-a<seq>`. `seq` (CheckpointIndexFile.anchorSeq) is
 * persisted and monotonic, so the id is unique by construction — it can never
 * collide with a `<tree>-<turnOrdinal>` turn id (the `a` separates the
 * namespaces) nor with another anchor (P2: no reused ordinals → no duplicate
 * React keys downstream).
 */
function anchorRowId(tree: string, seq: number): string {
  return `${tree}-a${seq}`;
}

/**
 * Remove `p` iff it is currently a symlink, so a subsequent write lands on a
 * fresh regular file at that path instead of following the link. `fs.rm` on a
 * symlink removes the LINK, never its target. Missing/un-stattable paths are a
 * no-op (the write will create the file).
 */
async function removeIfSymlink(p: string): Promise<void> {
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) await fs.rm(p, { force: true });
  } catch {
    // doesn't exist / cannot stat — nothing to unlink
  }
}

function toPublicCheckpoint(record: PersistedCheckpoint): Checkpoint {
  return {
    id: record.id,
    label: record.label,
    age: formatAge(record.timestamp),
    timestamp: record.timestamp,
    filesChanged: record.filesChanged,
    turnOrdinal: record.turnOrdinal,
    // W2-F2: surface `phase` ONLY when the record carries it — legacy (pre-W2)
    // rows have no phase and must stay shapeless-compatible (never `phase: undefined`).
    ...(record.phase ? { phase: record.phase } : {}),
    // W4-T5b: same posture for `sessionLabel` (DISPLAY-ONLY — R8) — legacy/
    // unlabeled rows stay shapeless-compatible (never `sessionLabel: undefined`).
    ...(record.sessionLabel ? { sessionLabel: record.sessionLabel } : {}),
  };
}

function formatAge(timestampIso: string): string {
  const deltaMs = Date.now() - new Date(timestampIso).getTime();
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Parse `git diff-tree --name-status -z` output. The `-z` stream is a flat run
 * of NUL-terminated tokens: `STATUS\0PATH\0` per change, except renames/copies
 * (`R###`/`C###`) which carry `STATUS\0OLDPATH\0NEWPATH\0`. Rename detection is
 * NOT enabled here, but we parse it defensively so a future `-M` can't corrupt
 * the walk.
 */
function parseNameStatusZ(output: string): CheckpointDiffEntry[] {
  const tokens = output.split('\0');
  const entries: CheckpointDiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusCode = tokens[i];
    if (!statusCode) {
      i++;
      continue;
    }
    if (statusCode[0] === 'R' || statusCode[0] === 'C') {
      const newPath = tokens[i + 2];
      if (newPath) entries.push({ path: newPath, status: 'modified' });
      i += 3;
      continue;
    }
    const filePath = tokens[i + 1];
    if (filePath === undefined) break;
    const status: DiffStatus =
      statusCode[0] === 'A' ? 'added' : statusCode[0] === 'D' ? 'deleted' : 'modified';
    entries.push({ path: filePath, status });
    i += 2;
  }
  return entries;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Normalizes an OS path separator to the forward-slash form git's `alternates` file expects. */
function toPosixAbsolute(p: string): string {
  return p.replace(/\\/g, '/');
}
