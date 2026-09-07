/**
 * FI-26 (WS-F10 task 2, FSU §5 Q4): a pure, vscode-free one-shot dedup
 * registry — a thin `Set<string>` wrapper. Replaces the three independent
 * module-level dedup Sets this zone used to keep (`provider.ts`'s
 * `surfacedAutocompleteFailures`, `nextedit/backend.ts`'s `warnedOnce`,
 * `backendFactory.ts`'s `warnedOnce`) with ONE reusable class, so a single
 * activation-scoped instance can be threaded to every dedup site instead of
 * each site rolling its own `Set` + `clear()` export.
 *
 * The four operations below are exactly the union of what the three sites
 * use on the live HEAD: `has`/`add` (every site's "warn/surface once" check),
 * `delete` (provider.ts's `surfaceIfFirst` — a failed toast's `onRejected`
 * handler removes its own key so the NEXT completion gets a fresh signal
 * instead of permanent silence), and `reset` (each site's own re-arm-all
 * primitive, replacing a raw `.clear()`).
 *
 * No timers, no other state — a key is either seen or it isn't.
 */
export class OnceRegistry {
  private readonly seen = new Set<string>();

  /** Has `key` already been recorded (i.e. already surfaced/warned)? */
  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** Record `key` as seen — the caller's own "first time" check (`has`)
   *  must run first; this alone does not gate anything. */
  add(key: string): void {
    this.seen.add(key);
  }

  /** Forget `key` — re-arms exactly this one key, leaving every other
   *  recorded key untouched (provider.ts: a failed remediation attempt must
   *  not leave the user stranded in permanent silence for THIS key). */
  delete(key: string): void {
    this.seen.delete(key);
  }

  /** Forget every recorded key — re-arms the whole registry at once. */
  reset(): void {
    this.seen.clear();
  }
}
