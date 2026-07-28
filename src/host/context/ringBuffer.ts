/**
 * `RingBuffer` — the PURE core of `terminalCapture.ts` (§2a, T2d brief: "Extract
 * a PURE RingBuffer helper (push line(s), tail(maxLines), cap)"). Zero
 * `vscode` import so it is headlessly testable (`ringBuffer.test.ts`); the
 * vscode-touching shell (`terminalCapture.ts`) is the only impure caller.
 *
 * A fixed-size ring of COMPLETED lines: `push` accepts an arbitrary raw
 * chunk — `TerminalShellExecution.read()` yields data at arbitrary boundaries,
 * not line-aligned — so a line split across two `push` calls is stitched via
 * a one-line `pending` buffer rather than counted as two separate lines.
 * Once more than `capLines` COMPLETED lines have been pushed, the oldest are
 * evicted (the ring behavior) so a long-lived, chatty terminal can never grow
 * this without bound. The not-yet-newline-terminated `pending` tail is never
 * itself subject to the completed-line cap — it always surfaces in `tail()`
 * so the very latest (still-streaming) output is never silently dropped —
 * but it IS subject to a character cap (`PENDING_MAX_CHARS`, below), since a
 * single execution emitting `\r`-only progress-spinner output with no `\n`
 * would otherwise grow `pending` unbounded for the life of that execution.
 */

/**
 * Max characters retained in the un-terminated `pending` fragment. Only the
 * TRAILING `PENDING_MAX_CHARS` chars are kept once exceeded — the tail is
 * what matters for a progress line (e.g. a `\r`-only spinner with no `\n`).
 * This is independent of `capLines`, which only bounds COMPLETED lines.
 */
const PENDING_MAX_CHARS = 8_192;

export class RingBuffer {
  private readonly lines: string[] = [];
  private pending = '';

  constructor(private readonly capLines: number) {}

  /**
   * Append a raw chunk. May contain zero, one, or many newlines, and may
   * itself be a mid-line fragment (e.g. `execution.read()`'s `for await`
   * yields writer-determined chunk boundaries) — only text up to and
   * including the LAST `\n` in the accumulated `pending + chunk` becomes
   * completed lines; anything after the last `\n` remains `pending` for the
   * next `push` (or the next `tail()` read, if none follows).
   */
  push(chunk: string): void {
    const combined = this.pending + chunk;
    const parts = combined.split('\n');
    const pending = parts.pop() ?? '';
    this.pending =
      pending.length > PENDING_MAX_CHARS ? pending.slice(pending.length - PENDING_MAX_CHARS) : pending;
    for (const line of parts) this.pushLine(line);
  }

  private pushLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.capLines) this.lines.shift();
  }

  /**
   * The last `maxLines` lines captured so far (oldest first among those
   * returned), including any not-yet-terminated `pending` fragment as the
   * final entry. Fewer than `maxLines` lines if less has been captured;
   * `''` for `maxLines <= 0` or an empty buffer.
   */
  tail(maxLines: number): string {
    if (maxLines <= 0) return '';
    const all = this.pending ? [...this.lines, this.pending] : this.lines;
    return all.slice(Math.max(0, all.length - maxLines)).join('\n');
  }
}
