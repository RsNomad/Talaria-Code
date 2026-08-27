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
 * Scope: this task ships construction, `get`/`allTrackers`/`size`/
 * `disposeAll`, and the private `addRoot`/`removeRoot` lifecycle primitives.
 * `reconcile()` is a MINIMAL STUB here — Task 14 replaces its body with the
 * full serialized pass (removal of vanished roots, first-listed-wins
 * promotion, `reconcileChain` serialization). See the doc comment on
 * `reconcile()` below.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { CheckpointTracker, shadowDirFor } from './CheckpointTracker';
import { DEFAULT_DISPOSE_FLUSH_DEADLINE_MS } from './constants';
import { canonicalizeWorkspaceRoot, findContainingWorkspaceRoot } from './rootResolution';
import type { CheckpointTrackerLike } from './trackerContract';

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
  /** Seam (repo idiom: LanceDBStore.connectImpl). Default mints a real CheckpointTracker on the CANONICAL root. */
  makeTracker?: (canonicalRoot: string) => RegistryTrackerLike;
  /** Seam for the hash-collision test (sha256-16 cannot be collided for real). */
  shadowDirForImpl?: (storageDir: string, workspaceRoot: string) => string;
  /** Fired ONCE per promoted child (spec req 6b, option b). Unused until Task 14's full reconcile pass. */
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

export class CheckpointTrackerRegistry {
  private readonly deps: ResolvedDeps;

  private readonly trackers = new Map<string, RegistryTrackerLike>();
  /** shadowDir -> the canonical root that currently owns it (hash-collision detection). */
  private readonly shadowDirOwner = new Map<string, string>();

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

  /**
   * Task 13 STUB — Task 14 replaces this body with the full serialized
   * reconcile pass (removal of vanished roots, first-listed-wins promotion,
   * `reconcileChain` re-entrancy serialization). For now: unconditionally
   * (re-)add every CURRENTLY listed folder, every call, with NO removal —
   * callers/tests drive `addRoot`'s behaviors through this stub.
   */
  async reconcile(): Promise<void> {
    const folders = this.deps.listFolders();
    for (const rawFolderPath of folders) {
      const canonicalRoot = canonicalizeWorkspaceRoot(findContainingWorkspaceRoot(rawFolderPath, folders));
      await this.addRoot(canonicalRoot, rawFolderPath);
    }
  }

  /** deactivate-scope: disposeAndFlush EVERY tracker (sequential, best-effort), then clear. */
  async disposeAll(): Promise<void> {
    for (const [canonicalRoot] of [...this.trackers.entries()]) {
      await this.removeRoot(canonicalRoot).catch(() => undefined);
    }
    this.trackers.clear();
    this.shadowDirOwner.clear();
  }

  /**
   * Register `canonicalRoot` (already realpath'd by the caller — this method
   * never canonicalizes on its own, T13-FN-d). Three phases, in order:
   *
   * 1. **Hash-collision guard.** Two DIFFERENT canonical roots can only ever
   *    compute the same `shadowDir` via the injected test seam (sha256-16 is
   *    not collidable for real) — refuse honestly rather than let two roots
   *    silently share one shadow history.
   * 2. **Symlinked-root adopt-by-rename (spec req 1).** When the raw listed
   *    path is a symlink into `canonicalRoot`, its shadow history lives under
   *    the OLD lexical hash — move it to the canonical hash so history
   *    survives the realpath switch. Deliberately NOT gated on whether the
   *    canonical shadow dir already exists: a two-window race (two callers
   *    both see the lexical dir present) lets one winner actually move it,
   *    and the loser's `fs.rename` then fails naturally (source vanished, or
   *    target now occupied) — caught below and disclosed, never silent.
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

    const lexical = path.resolve(rawFolderPath);
    if (lexical !== canonicalRoot) {
      const lexDir = shadowDirForImpl(storageDir, lexical);
      if (lexDir !== shadowDir && (await pathExists(lexDir))) {
        try {
          await fs.rename(lexDir, shadowDir);
        } catch (err) {
          log(
            `checkpoints: could not adopt existing shadow history for symlinked root ${canonicalRoot} (${errCode(err)}); starting a fresh shadow — prior history remains at ${lexDir}`,
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
