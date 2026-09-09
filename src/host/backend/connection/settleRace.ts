// src/host/backend/connection/settleRace.ts

/**
 * WS-R1 (FUNC-RACE-ROOT, DESIGN-NOTES.md §3.1): the ONE
 * settle-once / exit-race / deadline primitive the ~8-member hand-rolled
 * race family (`raceAgainstChildExit`, the deadline-only session-load race
 * deleted at WS-R1 step 3b once `loadSessionIntoTabInternal` migrated to
 * call this primitive directly, `raceRecoveryAgainstChildExit`,
 * `raceConnectPhase`, `AcpClient.raceTermination`, `ControlChannel.
 * awaitReady`, …) each re-implemented a subset of. Semantics are inherited
 * from the proven `ConnectionSupervisor.raceAgainstChildExit` body
 * (`:867-898` pre-swap):
 *
 *  - settle-once flag: the FIRST of {p settles, exit fires, deadline fires}
 *    wins; every later signal is discarded.
 *  - the exit subscription is disposed and the deadline timer cleared on
 *    EVERY settle path (value, exit, deadline, rejection) — no stray
 *    listeners, no stray timers (proven by the fast-path timer test).
 *  - the deadline timer is `unref()`d — it never keeps the process alive.
 *  - a genuine rejection of `p` PASSES THROUGH as a rejection (it is not an
 *    outcome kind) — preserving `AcpBackend.openSession`'s belated-rejection
 *    contract: after this race has already settled (exit/deadline), a late
 *    settlement of `p` (resolve OR reject) is silently discarded by the
 *    settle-once guard, so a belated stale-attempt throw never surfaces as
 *    an unhandled rejection.
 *  - belated-resolution CLEANUP is deliberately NOT owned here — callers
 *    own it (the `isStaleAttempt` pattern in `AcpBackend.openSession`),
 *    exactly as today.
 *
 * `deadline` is REQUIRED (`number | 'none'`), not optional — the class-kill
 * mechanism (ADR-R1): "no deadline" must be a visible, greppable, written-out
 * token (`deadline: 'none'`) at every call site, never a silent omission.
 * F3-1 existed precisely because omission was silent.
 */
export type RaceOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'exit' } // the raced child died first
  | { kind: 'deadline' }; // the wall clock won

/** The exit seam — structurally satisfied by `AcpClientLike` and `ControlTransport`. */
export interface ExitSource {
  onExit(cb: (code: number | null) => void): { dispose(): void };
}

export interface SettleRaceOpts {
  /** Optional: also race `p` against this child's own exit. */
  exit?: ExitSource;
  /** REQUIRED, not optional: 'none' must be written out (ADR-R1). */
  deadline: number | 'none';
}

export function settleRace<T>(p: Promise<T>, opts: SettleRaceOpts): Promise<RaceOutcome<T>> {
  return new Promise<RaceOutcome<T>>((resolve, reject) => {
    let settled = false;
    let exitSub: { dispose(): void } | undefined;
    // Set when `cleanup()` runs BEFORE the exit handle below has been
    // assigned — i.e. the `ExitSource` fired its callback SYNCHRONOUSLY,
    // from inside the `onExit()` call, before that call has returned. No
    // documented seam (`AcpClient.onExit` / `JsonRpcStdio.onExit`) does
    // this — both are async-only — but this is a generic primitive: it
    // must not leak the subscription (or arm a now-orphaned deadline
    // timer, below) even under that adversarial ordering.
    let exitDisposePending = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const disposeExit = (): void => {
      if (exitSub !== undefined) {
        exitSub.dispose();
        exitSub = undefined;
      } else {
        exitDisposePending = true;
      }
    };
    const cleanup = (): void => {
      disposeExit();
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };
    const settleResolve = (outcome: RaceOutcome<T>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const exitHandle = opts.exit?.onExit(() => settleResolve({ kind: 'exit' }));
    if (exitHandle !== undefined) {
      if (exitDisposePending) {
        // The callback above already fired synchronously and cleanup() ran
        // before this handle existed — dispose it now instead of leaking it.
        exitHandle.dispose();
      } else {
        exitSub = exitHandle;
      }
    }
    // Guard against arming a deadline timer AFTER a synchronous exit fire
    // has already settled the race (see exitDisposePending above) — such a
    // timer would never be cleared, since cleanup() already ran.
    if (opts.deadline !== 'none' && !settled) {
      deadlineTimer = setTimeout(() => settleResolve({ kind: 'deadline' }), opts.deadline);
      // Never keep the event loop alive on a deadline — matches every other
      // deadline timer in this subsystem (raceConnectPhase / scheduleAcpRespawn).
      deadlineTimer.unref?.();
    }
    p.then((value) => settleResolve({ kind: 'value', value }), settleReject);
  });
}
