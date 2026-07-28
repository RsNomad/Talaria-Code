/**
 * Per `core/autocomplete/util/AutocompleteDebouncer.ts`. Each call is tagged with a
 * monotonically increasing sequence number (Continue uses a `uuid`; a counter is
 * enough here and avoids a new dependency). After `delayMs`, a call resolves `true`
 * ("you were superseded, drop this request") unless it is still the most recent
 * call, in which case it resolves `false` ("proceed").
 *
 * Combined with a per-request `AbortController` in the engine, superseded keystrokes
 * are dropped before ever reaching the (effectively single-flight) backend.
 */
export class AutocompleteDebouncer {
  private sequence = 0;

  async delayAndShouldDebounce(delayMs: number): Promise<boolean> {
    const requestSequence = ++this.sequence;
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(requestSequence !== this.sequence);
      }, delayMs);
    });
  }
}
