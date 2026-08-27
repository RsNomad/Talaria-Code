/**
 * WS-CK-A6 Task 13: `CheckpointTrackerRegistry` — the multi-root sibling of
 * `rootRegistry.ts`'s `RootRegistry`, keyed the SAME way (canonical
 * (realpath'd) workspace root -> per-root state), but for the shadow-git
 * tracker layer instead of the turn-lease/ordinal layer. This class OWNS
 * realpath canonicalization for the tracker layer (T13-FN-d / FN-1): it
 * feeds `makeTracker`/`shadowDirForImpl` the canonical string, never a
 * lexical/symlinked one — `key === hash-input` by construction (spec req 1).
 *
 * `shadowDirFor` (moved to `CheckpointTracker.ts` as a pure function) is the
 * ONE hash-derivation rule this class and the real tracker both use — this
 * file never re-derives a shadow directory a second way.
 *
 * NO vscode imports (headless-testable), mirroring `rootRegistry.ts`'s own
 * posture.
 *
 * Task 13 shipped construction, `get`/`allTrackers`/`size`/`disposeAll`, and
 * the private `addRoot`/`removeRoot` lifecycle primitives (with `reconcile()`
 * as a minimal, unconditional-re-add-only stub). Task 14 replaced that stub
 * with the full serialized reconcile pass: a resolver-derived desired set
 * (ONE containment rule, spec req 5), single-flight serialization via
 * `reconcileChain` (spec req 4), construct-before-dispose within each pass
 * (spec req 4), and one-shot promotion notice (spec req 6b, option b). See
 * the doc comments on `reconcile()`/`reconcilePass()` below.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { CheckpointTracker, shadowDirFor } from './CheckpointTracker';
import { DEFAULT_DISPOSE_FLUSH_DEADLINE_MS } from './constants';
import { canonicalizeWorkspaceRoot, findContainingWorkspaceRoot } from './rootResolution';
import type { CheckpointTrackerLike, CheckpointTrackerRegistryLike } from './trackerContract';

/** The structural tracker surface the registry manages (the real `CheckpointTracker` satisfies it; tests inject fakes). */
export interface RegistryTrackerLike extends CheckpointTrackerLike {
  init(): Promise<void>;
  cleanup(pruneDays?: number): Promise<void>;
  dispose(): void;
  /**
   * WS-CK-A6 durability fix (Task 12): a THIRD outcome discloses a repack
   * failure rather than folding it into `'flushed'` — see `removeRoot`'s own
   * doc for how each outcome is surfaced to the user.
   */
  disposeAndFlush(deadlineMs?: number): Promise<'flushed' | 'deadline' | 'failed'>;
  readonly shadowGitDir: string;
}

export interface TrackerRegistryDeps {
  storageDir: string;
  /** Raw workspace-folder fsPaths in LISTED ORDER (the resolver is first-listed-wins). */
  listFolders: () => readonly string[];
  /** User-visible log line (extension.ts wires the OutputChannel). */
  log: (line: string) => void;
  /**
   * Seam (repo idiom: LanceDBStore.connectImpl). Default mints a real CheckpointTracker on the CANONICAL root.
   * Override BOTH this and `shadowDirForImpl` together, or NEITHER — overriding only one diverges the
   * registry's own bookkeeping shadowDir (`shadowDirOwner`) from the real tracker's `shadowGitDir`.
   */
  makeTracker?: (canonicalRoot: string) => RegistryTrackerLike;
  /**
   * Seam for the hash-collision test (sha256-16 cannot be collided for real).
   * Override BOTH this and `makeTracker` together, or NEITHER — see `makeTracker`'s doc above.
   */
  shadowDirForImpl?: (storageDir: string, workspaceRoot: string) => string;
  /** Fired ONCE per promoted child (spec req 6b, option b) by `reconcilePass()`. */
  onPromotion?: (childRoot: string, formerParentRoot: string) => void;
  disposeDeadlineMs?: number;
}

/** `deps` with every optional seam resolved to its concrete default (only `onPromotion` stays genuinely optional — no default makes sense for it). */
interface ResolvedDeps {
  storageDir: string;
  listFolders: () => readonly string[];
  log: (line: string) => void;
  makeTracker: (canonicalRoot: string) => RegistryTrackerLike;
  shadowDirForImpl: (storageDir: string, workspaceRoot: string) => string;
  disposeDeadlineMs: number;
  onPromotion?: (childRoot: string, formerParentRoot: string) => void;
}

/** `fs.access` existence probe — no permission/content inspection, just "is something there". */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** CKP-05 discipline (mirrors `CheckpointTracker.ts`'s own local helper): errno-code-or-name only — never `String(err)` (fs errors embed absolute paths). */
function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.name : 'unknown';
}

export class CheckpointTrackerRegistry implements CheckpointTrackerRegistryLike {
  private readonly deps: ResolvedDeps;

  private readonly trackers = new Map<string, RegistryTrackerLike>();
  /** shadowDir -> the canonical root that currently owns it (hash-collision detection). */
  private readonly shadowDirOwner = new Map<string, string>();
  /** Single-flight mutex (Task 14): a second `reconcile()` arriving mid-pass chains behind it rather than running concurrently. */
  private reconcileChain: Promise<void> = Promise.resolve();
  /** raw listed folder -> its containing root's canonical form, as of the LAST completed pass (promotion detection needs the prior mapping). */
  private prevAssignment = new Map<string, string>();
  /** Canonical roots already surfaced via `onPromotion` — fires ONCE per promoted root, never again even if it churns further. */
  private readonly promotionNotified = new Set<string>();

  constructor(deps: TrackerRegistryDeps) {
    const { storageDir, listFolders, log, makeTracker, shadowDirForImpl, onPromotion, disposeDeadlineMs } = deps;
    this.deps = {
      storageDir,
      listFolders,
      log,
      makeTracker:
        makeTracker ??
        ((canonicalRoot: string): RegistryTrackerLike => new CheckpointTracker(storageDir, canonicalRoot)),
      shadowDirForImpl: shadowDirForImpl ?? shadowDirFor,
      disposeDeadlineMs: disposeDeadlineMs ?? DEFAULT_DISPOSE_FLUSH_DEADLINE_MS,
      // exactOptionalPropertyTypes: omit the key entirely when absent, never set it to `undefined`.
      ...(onPromotion !== undefined ? { onPromotion } : {}),
    };
  }

  get(canonicalRoot: string): CheckpointTrackerLike | undefined {
    return this.trackers.get(canonicalRoot);
  }

  allTrackers(): RegistryTrackerLike[] {
    return [...this.trackers.values()];
  }

  get size(): number {
    return this.trackers.size;
  }

  /** Serialized: a second reconcile() arriving mid-pass queues behind it; each pass re-reads the CURRENT folder list at its start. */
  reconcile(): Promise<void> {
    const run = this.reconcileChain.then(
      () => this.reconcilePass(),
      () => this.reconcilePass(),
    );
    this.reconcileChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcilePass(): Promise<void> {
    const folders = [...this.deps.listFolders()];

    // Pass-local canonicalization memo: canonicalizeWorkspaceRoot reads disk
    // (realpathSync) and fail-opens to a lexical fallback, so calling it
    // multiple times for the same path within ONE pass could see DIFFERENT
    // results if a transient failure lands between calls — mis-firing the
    // promotion notice. Memoize per pass so every canonicalization within
    // this pass is self-consistent. Recreated on EVERY reconcilePass() call
    // (never a registry field) — see the FN-2 doc comment below for why a
    // cross-pass cache would be actively harmful, not just unnecessary.
    const canonMemo = new Map<string, string>();
    const canon = (p: string): string => {
      const hit = canonMemo.get(p);
      if (hit !== undefined) return hit;
      const v = canonicalizeWorkspaceRoot(p);
      canonMemo.set(p, v);
      return v;
    };

    // ONE containment rule: the runtime's own resolver decides the desired set
    // (spec req 5 — first-listed-wins; a parent-wins re-derivation here would
    // build a set the runtime later disagrees with -> spurious NO_TRACKER).
    //
    // FN-2 (WS-CK-A6): the canonical key is re-derived per pass (never
    // persistently cached) so the registry and the runtime resolver co-derive
    // it identically — a persistent registry-side cache would, during a
    // transient realpath failure, hold the resolved key while the runtime
    // falls back to lexical, producing a spurious NO_TRACKER. The accepted
    // residual: a transient realpathSync failure on a genuinely-symlinked
    // root yields a self-correcting ONE-PASS domain "flap" (a lexical-keyed
    // tracker minted + the resolved one disposed, history RETAINED on disk +
    // disclosed, re-converged next healthy pass). Near-nil on the local
    // POSIX target (realpath of an open local folder does not transiently
    // fail). REVISIT with a shared (registry+runtime) canonicalization cache
    // or a fail-closed canonicalize if the target ever expands to
    // network/removable mounts.
    const assignment = new Map<string, string>();
    for (const f of folders) {
      assignment.set(f, canon(findContainingWorkspaceRoot(f, folders)));
    }
    const desired = new Set(assignment.values());

    // Promotion detection (spec req 6b, option b): a folder that now maps to
    // ITSELF but previously mapped to a different (parent) root started a
    // fresh undo domain — surface it ONCE, visibly, never silently.
    for (const [f, cur] of assignment) {
      const prev = this.prevAssignment.get(f);
      if (prev !== undefined && prev !== cur && cur === canon(f) && !this.promotionNotified.has(cur)) {
        this.promotionNotified.add(cur);
        this.deps.onPromotion?.(cur, prev);
      }
    }

    // Construct-before-dispose within the pass (spec req 4).
    for (const root of desired) {
      if (!this.trackers.has(root)) {
        const raw = folders.find((g) => canon(g) === root) ?? root;
        await this.addRoot(root, raw);
      }
    }
    for (const [root] of [...this.trackers]) {
      if (!desired.has(root)) {
        await this.removeRoot(root);
      }
    }

    this.prevAssignment = assignment;
  }

  /**
   * deactivate-scope: disposeAndFlush EVERY tracker (sequential, best-effort).
   * No terminal `.clear()` here (review fix, Minor b) — each `removeRoot`
   * call already empties both maps of ITS OWN entry via `removeRegistration`
   * (synchronously, before the flush is even awaited), so a blanket clear at
   * the end would only mask a `removeRoot` that failed to deregister —
   * `size === 0` afterward is real proof the per-root removal path ran, not
   * a side effect of this method's own bookkeeping.
   */
  async disposeAll(): Promise<void> {
    for (const [canonicalRoot] of [...this.trackers.entries()]) {
      await this.removeRoot(canonicalRoot).catch(() => undefined);
    }
  }

  /**
   * Register `canonicalRoot` (already realpath'd by the caller — this method
   * never canonicalizes on its own, T13-FN-d). Three phases, in order:
   *
   * 1. **Hash-collision guard.** Two DIFFERENT canonical roots can only ever
   *    compute the same `shadowDir` via the injected test seam (sha256-16 is
   *    not collidable for real) — refuse honestly rather than let two roots
   *    silently share one shadow history.
   * 2. **Symlinked-root adopt-by-rename (spec req 1).** When `rawFolderPath`
   *    is itself a symlink resolving to `canonicalRoot` (never a merely
   *    NESTED descendant of it — see the `canonicalizeWorkspaceRoot`
   *    re-check below), its shadow history lives under the OLD lexical hash
   *    — move it to the canonical hash so history survives the realpath
   *    switch. Gated FIRST on `!shadowDir-exists`: on POSIX, `fs.rename`
   *    onto an existing EMPTY directory SUCCEEDS and would silently clobber
   *    a canonical shadow (including a concurrent init's freshly-`mkdir`'d
   *    dir, or a crash leftover) — never rename onto an existing target. The
   *    `catch` around the rename itself remains as belt-and-suspenders for
   *    the residual TOCTOU window (Node has no `renameat2(RENAME_NOREPLACE)`
   *    to close it atomically) — disclosed, never silent, either way.
   * 3. **Mint + per-root init isolation.** `makeTracker(canonicalRoot)` —
   *    constructor arg is the canonical string, so key === hash input by
   *    construction. Registers in BOTH maps BEFORE kicking off `init()`
   *    (mirrors `extension.ts`'s existing single-root posture). The `catch`
   *    handler is INSTANCE-CHECKED (`this.trackers.get(canonicalRoot) ===
   *    tracker`) so a late-rejecting, already-superseded instance can never
   *    evict a healthy successor registered in the meantime (spec req 2).
   */
  private async addRoot(canonicalRoot: string, rawFolderPath: string): Promise<void> {
    const { storageDir, shadowDirForImpl, makeTracker, log } = this.deps;
    const shadowDir = shadowDirForImpl(storageDir, canonicalRoot);

    const owner = this.shadowDirOwner.get(shadowDir);
    if (owner !== undefined && owner !== canonicalRoot) {
      log(
        `checkpoints: REFUSING root ${canonicalRoot} — its shadow directory collides with ${owner} (hash-prefix collision); checkpoints stay unavailable for it`,
      );
      return;
    }

    // FIX 2 (review, mis-adoption guard): `lexical !== canonicalRoot` alone
    // conflates "rawFolderPath is a symlink INTO canonicalRoot" with
    // "rawFolderPath is a NESTED DESCENDANT whose containing root happens to
    // be canonicalRoot" (`reconcile()` maps a nested child's rawFolderPath to
    // its containing root's canonical string via `findContainingWorkspaceRoot`
    // before calling this method). Only the former is a genuine symlink
    // alias eligible for adoption — require rawFolderPath to itself
    // realpath to canonicalRoot before ever computing a lexical hash to
    // adopt from. A nested/other root's own pre-A6 shadow (if any) is simply
    // not touched — nothing to adopt, so nothing is logged either.
    if (canonicalizeWorkspaceRoot(rawFolderPath) === canonicalRoot) {
      const lexical = path.resolve(rawFolderPath);
      if (lexical !== canonicalRoot) {
        const lexDir = shadowDirForImpl(storageDir, lexical);
        const lexicalExists = lexDir !== shadowDir && (await pathExists(lexDir));
        if (lexicalExists && !(await pathExists(shadowDir))) {
          // FIX 1 (review, POSIX-safety guard): !shadowDir-exists checked
          // FIRST — see the phase-2 doc comment above.
          try {
            await fs.rename(lexDir, shadowDir);
          } catch (err) {
            // Residual micro-TOCTOU: this catch covers a NON-EMPTY shadowDir
            // reappearing in the check->rename window (ENOTEMPTY). An EMPTY
            // dir materializing there instead is the irreducible residual —
            // Node has no renameat2(RENAME_NOREPLACE) to close that window
            // atomically — but exposure is near-nil (a cross-process
            // bare-init instant on the very same canonical root; an empty
            // dir carries zero history to lose). Disclosed, never silent,
            // either way.
            log(
              `checkpoints: could not adopt existing shadow history for symlinked root ${canonicalRoot} (${errCode(err)}); starting a fresh shadow — prior history remains at ${lexDir}`,
            );
          }
        } else if (lexicalExists) {
          // shadowDir already exists — do NOT clobber it; disclose and start fresh.
          log(
            `checkpoints: could not adopt existing shadow history for symlinked root ${canonicalRoot} (shadow already present); starting a fresh shadow — prior history remains at ${lexDir}`,
          );
        }
      }
    }

    const tracker = makeTracker(canonicalRoot);
    this.trackers.set(canonicalRoot, tracker);
    this.shadowDirOwner.set(shadowDir, canonicalRoot);

    tracker
      .init()
      .then(() => {
        log(`checkpoints: shadow tracker initialized for ${canonicalRoot}`);
        void tracker.cleanup().catch((err: unknown) => {
          log(`checkpoints: cleanup failed for ${canonicalRoot} — ${errCode(err)}`);
        });
      })
      .catch((err: unknown) => {
        log(`checkpoints: unavailable for ${canonicalRoot} — ${errCode(err)}`);
        // Instance-checked: only evict if the map STILL holds THIS instance —
        // a successor minted for the same root in the meantime is untouched.
        if (this.trackers.get(canonicalRoot) === tracker) {
          this.removeRegistration(canonicalRoot);
        }
      });
  }

  /** Removes `canonicalRoot` from both maps without touching disk or the tracker itself. */
  private removeRegistration(canonicalRoot: string): void {
    this.trackers.delete(canonicalRoot);
    for (const [shadowDir, owner] of this.shadowDirOwner) {
      if (owner === canonicalRoot) {
        this.shadowDirOwner.delete(shadowDir);
        break;
      }
    }
  }

  /**
   * Delete from BOTH maps FIRST (no new lookup can hand this tracker out
   * again — T13-FN-c), THEN flush. NEVER calls any other tracker method
   * after `disposeAndFlush` — its `work` reads a queue SNAPSHOT, so anything
   * enqueued afterward wouldn't be awaited anyway (T13-FN-c). NEVER touches
   * the on-disk shadow dir — the never-delete-shadow retention is the
   * durability safety net (T13-FN-a): `'flushed'` is best-effort-durable, not
   * a guarantee, so keeping history on disk regardless of outcome is load-
   * bearing.
   */
  private async removeRoot(canonicalRoot: string): Promise<void> {
    const tracker = this.trackers.get(canonicalRoot);
    if (!tracker) return;
    this.removeRegistration(canonicalRoot);

    const kind = await tracker.disposeAndFlush(this.deps.disposeDeadlineMs);
    if (kind === 'deadline') {
      this.deps.log(
        `checkpoints: dispose flush for ${canonicalRoot} hit its deadline — localization continues in the background (lock-serialized)`,
      );
    } else if (kind === 'failed') {
      // The tracker already console.error'd the errno; this is the
      // user-visible seam disclosure — never silent (CA-M07).
      this.deps.log(
        `checkpoints: dispose flush for ${canonicalRoot} reported a repack failure — its checkpoints may not be fully self-contained; history retained on disk`,
      );
    }
  }
}
