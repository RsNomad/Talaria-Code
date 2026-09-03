/**
 * WS-GD.2b B6: the single-flight latch registry extracted from
 * `SetupController` — install/pull/provision `arm`/`release`, the cancel-path
 * `abort`, and the dispose-path `abortAll`. Reads the lifecycle-closed gate
 * through an injected `isClosed` thunk; the {@link MutationGate} itself stays
 * owned by `SetupController` (this class never sees it directly, only its
 * `closed` flag).
 */
export class LatchRegistry {
  private readonly latches = new Map<string, AbortController>();

  constructor(private readonly isClosed: () => boolean) {}

  has(key: string): boolean {
    return this.latches.has(key);
  }

  /** F2-16: the ONE place an install/pull latch is armed. Refuses after
   *  dispose (gate closed) — the caller maps `undefined` to
   *  {@link SETUP_DISPOSED_REFUSAL}. Synchronous by construction: the
   *  closed-check and the Map.set run in one tick (run-to-completion), so a
   *  concurrent dispose() cannot interleave between them. */
  arm(key: string): AbortController | undefined {
    if (this.isClosed()) return undefined;
    const abort = new AbortController();
    this.latches.set(key, abort);
    return abort;
  }

  release(key: string): void {
    this.latches.delete(key);
  }

  /** Cancel path: abort a live latch. Returns true iff an abort was DELIVERED (the F2-20 honesty bit). */
  abort(key: string): boolean {
    const latch = this.latches.get(key);
    if (latch === undefined) return false;
    latch.abort();
    return true;
  }

  /** Dispose path (TC-6 doc moves verbatim): abort every live latch, then clear. */
  abortAll(): void {
    for (const abort of this.latches.values()) abort.abort();
    this.latches.clear();
  }
}
