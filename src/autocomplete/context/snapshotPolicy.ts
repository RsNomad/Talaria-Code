/**
 * W5-T3 · `snapshotPolicy.ts` — the KV-stable snapshot regeneration predicate
 * (`docs/research/wave-5/00-architecture-and-paths.md` §2.4, critic-A finding 1).
 *
 * This is a PAUSE DETECTOR, not a rate limiter. Pinned formula:
 *
 *   regenerate = epochChanged ∧ (boundaryEvent ∨ idle)
 *   epochChanged = currentEpoch !== prevEpoch
 *   boundaryEvent = active-editor-change or document-save (caller-computed)
 *   idle = (now - lastKeystrokeAt) >= SNAPSHOT_IDLE_MS
 *
 * Deliberately absent: any "≥Nms since last regeneration" clause. Such a
 * clause would rotate the snippet set mid-typing-burst on a fixed cadence —
 * exactly the KV-cache cliff this predicate exists to prevent (llama.cpp's
 * `input_extra` sits at the front of the prompt with `cache_prompt:true`; a
 * changed snippet set invalidates KV for the ENTIRE prompt). There is no
 * "time since last regeneration" input anywhere in this module — structurally,
 * not just by omission — so no rate-limiter clause can be added by accident.
 * "Completion accept" is also NOT a trigger (§2.4) — it is not represented in
 * this predicate's inputs at all.
 *
 * Pure: no `vscode`, no `Date.now()`, no `Math.random()`. `now` and
 * `lastKeystrokeAt` are caller-supplied wall-clock inputs (the shell, T5,
 * owns the clock); `prevEpoch`/`currentEpoch` are monotonic counters from
 * `ringBuffer.ts`. No hidden state — every call is independent, which is
 * itself part of the "no rate limiter" proof: a predicate that could rotate
 * the set on a timer would need to remember when it last regenerated, and
 * this function has no such memory (see `snapshotPolicy.test.ts`, "never
 * regenerates mid-burst on a timer").
 *
 * Immutable copy-on-write (concurrency): this module does not build or swap
 * snapshots — it only says 'reuse' | 'regenerate'. The shell (T5) is
 * responsible for, on 'regenerate', building a NEW frozen snapshot
 * (`snippetBudgeter.buildSnapshot`, which calls `Object.freeze`) and swapping
 * its cached reference — never mutating the previous frozen snapshot. JS is
 * single-threaded, so a completion in flight that already captured the OLD
 * frozen reference is immune to torn reads: no lock is needed, because the
 * old array object is never written to, only replaced.
 */

/** Default idle threshold (ms) — "no keystroke for longer than the 350ms
 *  debounce" per §2.4; conservative default of 1200ms. */
export const SNAPSHOT_IDLE_MS = 1200;

export interface ShouldRegenerateInput {
  /** The buffer epoch this snapshot was last built from. */
  prevEpoch: number;
  /** The buffer's current (monotonic) epoch. */
  currentEpoch: number;
  /** True on active-editor-change or document-save (caller-computed). */
  boundaryEvent: boolean;
  /** Wall-clock ms of the most recent keystroke. */
  lastKeystrokeAt: number;
  /** Wall-clock ms "now" (caller-supplied — this module never reads the clock). */
  now: number;
  /** Idle threshold override (ms). Defaults to `SNAPSHOT_IDLE_MS`. */
  idleMs?: number;
}

export function shouldRegenerate(input: ShouldRegenerateInput): 'reuse' | 'regenerate' {
  const epochChanged = input.currentEpoch !== input.prevEpoch;
  if (!epochChanged) {
    return 'reuse';
  }

  const idleThreshold = input.idleMs ?? SNAPSHOT_IDLE_MS;
  const idle = input.now - input.lastKeystrokeAt >= idleThreshold;

  return input.boundaryEvent || idle ? 'regenerate' : 'reuse';
}
