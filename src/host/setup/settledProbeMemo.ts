/**
 * WS-GD.2b B2: the ONE settled-value probe memo — kick-once/lazily, epoch
 * supersession, optional cancellation. Unifies the llama.cpp runtime memo and
 * the Hermes PATH-discovery memo that used to be hand-rolled, field-quartet
 * IIFEs directly on `SetupController` (their doc comments moved here
 * verbatim in spirit): `status()` kicks the probe once, lazily, and returns
 * immediately with the memo unsettled; the probe's eventual settle writes
 * {@link SettledProbeMemo.value} and fires {@link
 * SettledProbeMemoOpts.onSettled} exactly ONCE — a settle whose epoch was
 * superseded (a scoped recheck, `rekick()`, or `supersede()` on dispose) is
 * DROPPED entirely: it writes nothing and never fires.
 *
 * NOT the CA-M18 Ollama TTL memo — that one is TIME-based (a short-lived
 * memoized promise), not epoch-based, and is deliberately left untouched.
 */
export interface SettledProbeMemoOpts<T> {
  /** The probe, already mapping its result to the settled value. A rejection settles `onRejected()`. */
  probe: (signal: AbortSignal) => Promise<T>;
  onRejected: () => T;
  /** Fired exactly once per fresh settle (the bumpStatus hook). A superseded settle never fires it. */
  onSettled: () => void;
  /** true = a superseding invalidate/rekick/supersede aborts the in-flight attempt's signal
   *  (llama.cpp); false = no cancellation seam — the stale attempt runs on, its settle made inert
   *  by the epoch (Hermes discovery). */
  cancellable: boolean;
}

export class SettledProbeMemo<T> {
  private settled: T | undefined;
  /** True while a probe attempt is in flight — with {@link settled}
   *  `undefined` and this false, the next `kick()` starts a fresh attempt. */
  private inFlight = false;
  /** Monotonic supersession guard: bumped by `invalidate`/`rekick`/`supersede`
   *  so a superseded attempt's late settle can neither overwrite fresher
   *  state nor fire a stray `onSettled`. */
  private epoch = 0;
  /** The in-flight attempt's AbortController — always created (a `probe`
   *  always receives a real signal), but only ABORTED by a superseding call
   *  when {@link SettledProbeMemoOpts.cancellable} is true. */
  private abortCtl: AbortController | undefined;

  constructor(private readonly opts: SettledProbeMemoOpts<T>) {}

  get value(): T | undefined {
    return this.settled;
  }

  /** Lazily start ONE attempt — no-op while settled or in flight. */
  kick(): void {
    if (this.settled !== undefined || this.inFlight) return;
    this.inFlight = true;
    const epoch = this.epoch;
    const abortCtl = new AbortController();
    this.abortCtl = abortCtl;
    void (async () => {
      let result: T;
      try {
        result = await this.opts.probe(abortCtl.signal);
      } catch {
        // Rejection (incl. an abort racing the settle) settles via
        // onRejected(); a superseded epoch is dropped below either way.
        result = this.opts.onRejected();
      }
      if (epoch !== this.epoch) return; // superseded — the fresh attempt (or a clear) owns the state
      this.settled = result;
      this.inFlight = false;
      this.abortCtl = undefined;
      this.opts.onSettled();
    })();
  }

  /** Clear value + in-flight flag, bump epoch, abort if cancellable. NO re-kick (the recheck-agent posture). */
  invalidate(): void {
    this.epoch += 1;
    if (this.opts.cancellable) this.abortCtl?.abort();
    this.abortCtl = undefined;
    this.settled = undefined;
    this.inFlight = false;
  }

  /** invalidate() + kick() (the scoped llama.cpp recheck posture). */
  rekick(): void {
    this.invalidate();
    this.kick();
  }

  /** Bump epoch (+abort if cancellable) WITHOUT clearing the settled value (the dispose posture). */
  supersede(): void {
    this.epoch += 1;
    if (this.opts.cancellable) this.abortCtl?.abort();
    this.abortCtl = undefined;
  }
}
