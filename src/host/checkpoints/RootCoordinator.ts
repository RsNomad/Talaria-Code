/**
 * W4-T2 (§3.2) — the REAL per-workspace-root coordinator: a single-holder
 * turn lease (one live turn per root — refuse, never queue), a root-scoped
 * positive turn-ordinal counter (§2c decoupling), and a root-scoped negative
 * baseline/non-turn ordinal counter (F3 — shared by session baselines AND
 * the ephemeral one-shot's before-snapshot, replacing T1a's per-`AcpBackend`
 * `sessionBaselineCount`).
 *
 * NO vscode IMPORTS (headless-testable) — `CheckpointTrackerLike` is itself
 * vscode-free. Realpath resolution (needed to canonicalize the registry key
 * this coordinator is stored under) stays in `AcpBackend`/`rootRegistry`'s
 * caller — this class only ever receives an ALREADY-canonical `rootId`.
 */
import type { CheckpointTrackerLike } from './trackerContract';

/**
 * The per-workspace-root coordinator: serializes turn execution across every
 * session sharing one root (§3.2's "root turn lease" decision — G-4 option
 * (a)), so the shadow-git tracker's before/after pairing and `<tree>-
 * <ordinal>` id-uniqueness proof (`CheckpointTracker.ts`) never has to
 * reason about two sessions' turns interleaving over the same repo.
 */
export interface RootCoordinatorLike {
  /** The canonical (realpath'd) root key this coordinator was registered under (`rootRegistry`'s map key). */
  readonly rootId: string;
  /** The ONE per-root shadow-git tracker instance, or `undefined` when checkpoints aren't wired for this root. */
  readonly tracker: CheckpointTrackerLike | undefined;
  /**
   * Synchronously claim the root's turn lease for `sessionId`. `false` ⇒
   * refuse the prompt (a DIFFERENT session on this root already holds it) —
   * refuse, never queue (§3.2: queuing invents ordering semantics and cancel
   * complexity for zero v1 value). The SAME `sessionId` re-acquiring is
   * idempotent-true (never refuses itself).
   *
   * F1 (critic pin): the ephemeral one-shot acquires this SAME lease under
   * its own synthetic holder id, for its cwd's root — so a live one-shot and
   * a live main turn are mutually exclusive by construction (single holder),
   * with no separate flag needed.
   */
  tryAcquireTurnLease(sessionId: string): boolean;
  /** Release the lease, idempotent and holder-checked (a non-holder's release is a no-op). */
  releaseTurnLease(sessionId: string): void;
  /** The restore/redo interlock predicate: refuse `checkpoint.restore`/`redo`/`redoAll` while true (a holder exists — a turn OR a one-shot). */
  anyLiveTurn(): boolean;
  /** The next root-scoped turn ordinal — a POSITIVE monotonic counter shared by every session on this root (§2c decoupling; replaces `turnOrdinalFromTurnId`). */
  nextTurnOrdinal(): number;
  /** The next root-scoped baseline/non-turn ordinal — a NEGATIVE monotonic counter (`-1, -2, …`) shared by session baselines AND the one-shot before-snapshot (F3). */
  nextBaselineOrdinal(): number;
  /**
   * W6-FI-c Part 2 (3-way ARCH I-4c, folding in the W4-F5 critic-pin
   * placement fix): trigger a checkpoints-panel refresh for THIS root.
   * Fire-and-forget, fail-open — mirrors every other checkpoint-refresh call
   * site's posture. Sourced ONCE per root (wired at mint time via the
   * constructor's `notifyCheckpointsChanged` callback — see that param's own
   * doc) rather than re-implemented per `SessionController` port: every
   * session sharing this root reaches the SAME wired implementation through
   * this ONE method, instead of each session's `buildSessionPort` call
   * independently closing over its own `fetchPanelData` invocation (the F5
   * hazard — "N× controller ports").
   */
  refreshCheckpointsPanel(): void;
}

/**
 * W4-T2: the real per-root class. `rootRegistry.getOrCreate` constructs
 * exactly one of these per canonical workspace root; every `SessionController`
 * sharing that root is handed the SAME instance as `port.root`.
 */
export class RootCoordinator implements RootCoordinatorLike {
  readonly rootId: string;
  readonly tracker: CheckpointTrackerLike | undefined;

  /**
   * The single current lease holder (a real `sessionId`, or a one-shot's
   * synthetic per-invocation id) — `undefined` when the root is idle. A
   * SINGLE field (not a `Set`) is deliberate: it is what makes "one live
   * turn per root" a structural invariant rather than a counted one, and it
   * is what makes F1 (one-shot ⊇ turn mutual exclusion) fall out for free —
   * a one-shot's holder id and a turn's `sessionId` can never both occupy
   * this one slot.
   */
  private leaseHolder: string | undefined;
  private turnOrdinal = 0;
  private baselineOrdinal = 0;

  /**
   * W6-FI-c Part 2 (3-way ARCH I-4c / W4-F5 placement fix): the checkpoints-
   * panel refresh trigger for THIS root, injected ONCE at mint time by
   * `rootRegistry.getOrCreate`'s caller (`AcpBackend.resolveRootCoordinator`)
   * — mirrors `trackerFactory`'s own "constructed once, at mint time" posture.
   * Defaults to a no-op so every EXISTING 2-arg `new RootCoordinator(rootId,
   * tracker)` call site (this class's own unit tests, `rootRegistry.test.ts`'s
   * 2-arg `getOrCreate` calls) keeps compiling and behaving identically —
   * this class stays vscode-free either way (the real implementation, on
   * `ControlDispatcher`, is injected from the vscode-touching host).
   */
  constructor(
    rootId: string,
    tracker: CheckpointTrackerLike | undefined,
    private readonly notifyCheckpointsChanged: () => void = () => {},
  ) {
    this.rootId = rootId;
    this.tracker = tracker;
  }

  tryAcquireTurnLease(sessionId: string): boolean {
    if (this.leaseHolder === undefined || this.leaseHolder === sessionId) {
      this.leaseHolder = sessionId;
      return true;
    }
    return false;
  }

  /** Holder-checked: releasing a lease you don't hold (already released, or never acquired) is a safe no-op. */
  releaseTurnLease(sessionId: string): void {
    if (this.leaseHolder === sessionId) this.leaseHolder = undefined;
  }

  anyLiveTurn(): boolean {
    return this.leaseHolder !== undefined;
  }

  nextTurnOrdinal(): number {
    this.turnOrdinal += 1;
    return this.turnOrdinal;
  }

  nextBaselineOrdinal(): number {
    this.baselineOrdinal += 1;
    return -this.baselineOrdinal;
  }

  refreshCheckpointsPanel(): void {
    this.notifyCheckpointsChanged();
  }
}
