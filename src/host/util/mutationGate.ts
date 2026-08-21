import { settleRace } from '../backend/connection/settleRace';

/**
 * WS-R2 §3.2 (standalone position-9.5 commit): the structural disposed-guard
 * primitive. Closes NO finding by itself — it is the shared enabler Phase 2
 * wires into the RAG indexer's four sink families (store.upsert /
 * store.deleteByPath / writeManifest / writeMeta — WS-R2-proper) and into
 * SetupController's F2-16 abort re-arm guard (WS-SU).
 *
 * Contract:
 *  - `sink(op)`: while open, invokes `op` and passes its settlement through
 *    (values AND rejections — the gate never swallows a live failure).
 *    After `close()` has flipped the gate: `op` is NEVER invoked; resolves
 *    `undefined`; the refusal is counted (`refusedCount`) — the post-dispose
 *    mutation CLASS dies at the choke point regardless of body-level
 *    vigilance (the AU-23 shape).
 *  - `close(drain)`: flips the gate CLOSED SYNCHRONOUSLY (a sink issued in
 *    the same tick, after the call, is already refused — this ordering is
 *    what puts a mid-sequence dispose on the safe side of the Phase-2
 *    manifest-invalidate-first invariant), then awaits the CALLER-supplied
 *    in-flight drain (e.g. the indexer's buildChain tail), bounded by the
 *    drain deadline (WS-R1's settleRace). A rejected or never-settling
 *    drain never rejects nor wedges close(). Idempotent: the first close
 *    wins; later calls return the same completion.
 *
 * Deliberately NOT owned here (YAGNI, §3.2): in-flight op tracking (the
 * caller supplies the drain), sink ordering (a caller-side discipline),
 * re-open (a gate closes once, like the dispose it models).
 */
export const MUTATION_GATE_DRAIN_DEADLINE_MS = 10_000; // proposed default; tunable on live-QA

export interface MutationGate {
  /** Wraps a store/manifest-mutating call; after close() → no-op + counted. */
  sink<T>(op: () => Promise<T>): Promise<T | undefined>;
  /** Flips the gate, then awaits the in-flight drain (bounded). */
  close(drain: Promise<unknown>): Promise<void>;
  /** Observability: sink() calls refused after the gate flipped. */
  readonly refusedCount: number;
  /** True from the synchronous start of the first close() call onward. */
  readonly closed: boolean;
}

export function createMutationGate(opts?: { drainDeadlineMs?: number }): MutationGate {
  const drainDeadlineMs = opts?.drainDeadlineMs ?? MUTATION_GATE_DRAIN_DEADLINE_MS;
  let closed = false;
  let refusedCount = 0;
  let closing: Promise<void> | undefined;
  return {
    get refusedCount() {
      return refusedCount;
    },
    get closed() {
      return closed;
    },
    sink<T>(op: () => Promise<T>): Promise<T | undefined> {
      if (closed) {
        refusedCount += 1;
        return Promise.resolve(undefined);
      }
      // LOAD-BEARING: `op()` must be invoked SYNCHRONOUSLY here, right after the
      // `closed` check, with no `await`/`.then`/`Promise.resolve().then` between
      // them — that adjacency is what makes the check-then-invoke atomic under
      // JS run-to-completion. Deferring this call (e.g. an `async sink` or a
      // `.then(op)` hop) reopens the exact post-close mutation race this gate
      // exists to close: a `close()` could then flip `closed` in the gap.
      return op();
    },
    close(drain: Promise<unknown>): Promise<void> {
      if (closing === undefined) {
        closed = true; // flip FIRST, synchronously — before any await
        closing = settleRace(
          drain.then(
            () => undefined,
            () => undefined, // a rejected drain must not reject close()
          ),
          { deadline: drainDeadlineMs },
        ).then(() => undefined);
      }
      return closing;
    },
  };
}
