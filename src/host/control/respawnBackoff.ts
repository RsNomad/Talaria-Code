/**
 * Pure exponential backoff schedule for control-channel crash-respawn.
 *
 * Attempt 1 fires almost immediately (500ms) so a one-off blip recovers
 * fast; later attempts back off exponentially so a genuinely dead
 * interpreter/venv doesn't spin-loop the extension host. Capped at 15s —
 * long enough to stop hammering the OS, short enough that a human watching
 * the output channel isn't left wondering whether the extension gave up.
 */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

/**
 * Delay (ms) before respawn attempt number `attempt` (1-based). Non-finite,
 * fractional, or non-positive input is treated as attempt 1.
 */
export function respawnBackoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const delay = BASE_DELAY_MS * 2 ** (n - 1);
  return Math.min(delay, MAX_DELAY_MS);
}
