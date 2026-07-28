import type { Checkpoint, CheckpointPhase, CheckpointsData } from '../../shared/protocol';
import type { RestoreResult } from './CheckpointTracker';

/**
 * Zone CKPT: the narrow structural slice of `CheckpointTracker`'s public API
 * (`src/host/checkpoints/CheckpointTracker.ts` — frozen; used, never
 * modified) that `AcpBackend` actually depends on. Kept as an interface
 * (rather than importing the concrete class as the constructor param type)
 * so tests can inject a lightweight fake with no real `git` subprocess
 * machinery — the real `CheckpointTracker` satisfies this structurally.
 * `extension.ts` owns constructing the real tracker (storage dir + workspace
 * root) and calling its `init()`/`cleanup()`; `AcpBackend` only ever calls
 * `snapshot`/`list`/`restore` and treats ANY rejection (in particular
 * `GitUnavailableError`) as "checkpoints unavailable right now" rather than
 * letting it propagate.
 *
 * AH1: relocated here (out of `AcpBackend.ts`) so the `panels/` →
 * `checkpoints/` dependency doesn't have to route through `backend/` — its
 * siblings (`RestoreResult`, `CheckpointLockTimeoutError`) already live under
 * `checkpoints/`. `AcpBackend.ts` re-exports this type for back-compat.
 */
export interface CheckpointTrackerLike {
  // W2-F2 Phase 0 (pinned cross-zone contract): `opts.phase` defaults to
  // 'before'; the resolved value is `null` iff the snapshot was DEDUPED (the
  // computed tree matched the last stored checkpoint) — no caller here consumes
  // the value, so `Checkpoint | null` is source-compatible at every call site.
  // W4-T5b: `opts.sessionLabel`, when supplied, is stored verbatim on the
  // written row (DISPLAY-ONLY — R8, see `Checkpoint.sessionLabel`'s doc);
  // never read back or used in the dedup/id computation.
  snapshot(
    turnOrdinal: number,
    label?: string,
    opts?: { phase?: CheckpointPhase; sessionLabel?: string },
  ): Promise<Checkpoint | null>;
  list(): Promise<CheckpointsData>;
  restore(id: string, opts?: { force?: boolean }): Promise<RestoreResult>;
  // W2-F2 Phase 1 (pinned cross-zone contract): anchored redo. Both return the
  // same RestoreResult family restore() does; "no redo available" and "anchor
  // missing" (R1) come back as {restored:false, reason} rather than throwing.
  redo(opts?: { force?: boolean }): Promise<RestoreResult>;
  redoAll(opts?: { force?: boolean }): Promise<RestoreResult>;
}
