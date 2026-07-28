/**
 * W4-T2 (§3.2 Deliverable 2) — `Map<canonicalRoot, RootCoordinator>`. The
 * ONE `RootCoordinator` instance per workspace root; every session's
 * controller sharing a root shares its lease/ordinals/tracker through this
 * registry. `AcpBackend` owns the registry and is the ONLY caller that ever
 * touches `vscode`/`fs` to compute a `canonicalRoot` — this class receives
 * an already-canonical (realpath'd) key.
 *
 * NO vscode IMPORTS (headless-testable).
 */
import { RootCoordinator } from './RootCoordinator';
import type { CheckpointTrackerLike } from './trackerContract';

export class RootRegistry {
  private readonly roots = new Map<string, RootCoordinator>();

  /**
   * Return the existing coordinator for `canonicalRoot`, or construct one
   * via `trackerFactory()` (called AT MOST ONCE per new key — never
   * re-invoked on a cache hit, so a caller can pass a factory that itself
   * has side effects, e.g. minting a fresh `CheckpointTracker`).
   *
   * W6-FI-c Part 2 (W4-F5 placement fix): `notifyCheckpointsChanged` is
   * threaded through to the newly-minted `RootCoordinator`'s constructor —
   * same "at most once, mint-time only" posture as `trackerFactory`, and
   * likewise OPTIONAL (defaults to a no-op) so every existing 2-arg call
   * site keeps compiling unchanged.
   */
  getOrCreate(
    canonicalRoot: string,
    trackerFactory: () => CheckpointTrackerLike | undefined,
    notifyCheckpointsChanged: () => void = () => {},
  ): RootCoordinator {
    const existing = this.roots.get(canonicalRoot);
    if (existing) return existing;
    const coordinator = new RootCoordinator(canonicalRoot, trackerFactory(), notifyCheckpointsChanged);
    this.roots.set(canonicalRoot, coordinator);
    return coordinator;
  }

  /** Look up an already-registered coordinator by its canonical root id — used to route `checkpoint.restore`/`redo`/`redoAll` by `rootId`. */
  get(rootId: string): RootCoordinator | undefined {
    return this.roots.get(rootId);
  }

  /** Every registered coordinator (used to fall back to "the single implicit root" when no explicit `rootId` was supplied). */
  values(): IterableIterator<RootCoordinator> {
    return this.roots.values();
  }

  get size(): number {
    return this.roots.size;
  }

  /**
   * Extension-deactivate-scope teardown ONLY (§2a: a `RootCoordinator`'s
   * lifetime is "first controller on that root → extension deactivate" — NOT
   * tab close, NOT a respawn). No refcount-dispose (YAGNI) — trackers are
   * cheap idle.
   */
  disposeAll(): void {
    this.roots.clear();
  }
}
