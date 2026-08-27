/**
 * WS-CK (WV3-MIN-FUNC dedup): the ONE home for the checkpoint subsystem's
 * timeout/lock tunables. Previously `15_000` lived independently in
 * gitProcess.ts AND CheckpointTracker.ts, and the 30_000/10_000 lock defaults
 * lived independently in shadowLock.ts AND CheckpointTracker's constructor
 * fallbacks — a drift trap where tuning one site silently missed the other.
 */

/** Wall-clock bound per barrier/foreground shadow-git op (arch A#1). */
export const DEFAULT_GIT_TIMEOUT_MS = 15_000;
/** Cross-process lock: reclaim a lockfile whose mtime is older than this. */
export const DEFAULT_LOCK_STALE_MS = 30_000;
/** Cross-process lock: max wait for a live lock before failing. */
export const DEFAULT_LOCK_MAX_WAIT_MS = 10_000;
