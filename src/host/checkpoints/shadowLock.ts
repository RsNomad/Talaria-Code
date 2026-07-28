import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Cross-process advisory lock for the shadow-git dir (review IMPORTANT #3, and
 * its re-review hardening).
 *
 * A {@link ./CheckpointTracker.CheckpointTracker}'s in-process promise queue
 * only serializes operations *within one instance*. Two VS Code windows (or an
 * extension-host restart racing its predecessor) on the same `workspaceRoot`
 * share one on-disk shadow `GIT_DIR` + `index.json`; without a cross-process
 * lock they interleave the multi-command `read-tree; add; write-tree` sequence
 * on the shared index and can capture a half-built tree — a checkpoint that
 * misrepresents the worktree, which a later restore then mis-restores. (git's
 * per-command `index.lock` does NOT span that multi-command sequence.)
 *
 * Correctness rests on three properties — the first two fix the re-review
 * defects, the third makes staleness a real liveness signal:
 *
 *  1. **Ownership token.** Each acquire writes a unique token (uuid:pid:time)
 *     into the lockfile. `release()` deletes the file ONLY if the on-disk token
 *     still matches this holder's — so a holder can never delete a *successor's*
 *     lock (which previously created a third acquirer).
 *
 *  2. **Atomic-rename steal.** A stale lock is broken by
 *     `rename(lockPath -> unique tmp)`, NOT `rm(lockPath)`. Only ONE racer wins
 *     the atomic rename of a given file; losers get `ENOENT` and loop. This
 *     kills the rm-by-path TOCTOU where two waiters each removed the file (one
 *     of them the other's *fresh* lock) and both entered. The stolen file is
 *     re-validated as actually-stale before being discarded; if we raced and
 *     grabbed a now-*live* lock, we put it back rather than enter.
 *
 *  3. **Heartbeat liveness.** While held, a timer refreshes the lockfile's
 *     mtime every ~`staleMs/3`, guarded by the ownership token. This is the
 *     chosen liveness approach (over a blindly-large static `staleMs`): a
 *     genuinely-live but long operation (e.g. `git gc` / `write-tree` over a
 *     huge worktree) keeps its lock fresh and is never wrongly stolen, while a
 *     crashed holder stops heart-beating and is reclaimed after `staleMs`.
 */

const LOCK_FILENAME = '.checkpoint.lock';

/**
 * Thrown when a *live* lock cannot be acquired within `maxWaitMs`. This is a
 * TRANSIENT/retryable condition (another window/process is mid-operation), as
 * distinct from a permanent failure (e.g. `GitUnavailableError`). Callers that
 * surface checkpoint availability should treat it as "try again", not
 * "checkpoints are unavailable".
 */
export class CheckpointLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointLockTimeoutError';
  }
}

export interface AcquireLockOptions {
  /** Reclaim a lockfile whose mtime is older than this many ms. Default 30 s. */
  staleMs?: number;
  /** Max time to wait for a live lock to free up before throwing. Default 10 s. */
  maxWaitMs?: number;
  /** Poll interval while waiting on a live lock. Default 100 ms. */
  pollMs?: number;
  /** Heartbeat interval while held. Defaults to `staleMs / 3`. */
  heartbeatMs?: number;
}

export interface LockHandle {
  /** Idempotent: stops the heartbeat and removes the lockfile IFF we still own it. */
  release(): Promise<void>;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

/**
 * Acquire the advisory lock for `dir`. Resolves with a {@link LockHandle} whose
 * `release()` frees it; rejects if a *live* lock cannot be obtained within
 * `maxWaitMs`. A genuinely-stale lock (mtime older than `staleMs`, and not kept
 * fresh by a heartbeat) is reclaimed via an atomic rename.
 */
export async function acquireLock(
  dir: string,
  options: AcquireLockOptions = {},
): Promise<LockHandle> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(staleMs / 3));
  const lockPath = path.join(dir, LOCK_FILENAME);
  const token = `${randomUUID()}:${process.pid}:${Date.now()}`;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    try {
      // `wx` = atomic create-or-fail. The SOLE gate through which a holder is
      // established: if two racers both reach here, only one create succeeds.
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      return makeHandle(lockPath, token, heartbeatMs);
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;

      // Held by someone. Reclaim only if genuinely stale; else wait.
      let stat;
      try {
        stat = await fs.stat(lockPath);
      } catch {
        continue; // vanished between open() and stat() — retry the acquire
      }

      if (Date.now() - stat.mtimeMs > staleMs) {
        await tryStealStaleLock(lockPath, staleMs);
        continue; // whatever the outcome, re-attempt the atomic create
      }

      if (Date.now() >= deadline) {
        throw new CheckpointLockTimeoutError(
          `Could not acquire checkpoint lock at ${lockPath} within ${maxWaitMs}ms ` +
            '(held by another live process). Retry once the other operation finishes.',
        );
      }
      await delay(pollMs);
    }
  }
}

/**
 * Break a presumed-stale lock atomically. Exactly one racer wins the rename of
 * a given file; the winner re-validates that what it grabbed is actually stale
 * before discarding it (if it turns out to be a freshly-created *live* lock, it
 * is restored so its owner stays protected). Callers loop and re-`open(wx)`
 * afterwards, so this never itself grants the lock.
 */
async function tryStealStaleLock(lockPath: string, staleMs: number): Promise<void> {
  const stolenPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, stolenPath);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return; // another racer already broke it
    throw err;
  }

  // We won the rename. Confirm the grabbed file is really stale — a fresh lock
  // could have been created in the window between our stat() and rename().
  try {
    const stolenStat = await fs.stat(stolenPath);
    if (Date.now() - stolenStat.mtimeMs > staleMs) {
      await fs.rm(stolenPath, { force: true }).catch(() => undefined);
      return;
    }
    // Grabbed a now-live lock; put it back so its owner is not silently evicted.
    try {
      await fs.access(lockPath);
      // A newer lock already occupies the slot — ours is obsolete, drop it.
      await fs.rm(stolenPath, { force: true }).catch(() => undefined);
    } catch {
      await fs.rename(stolenPath, lockPath).catch(async () => {
        await fs.rm(stolenPath, { force: true }).catch(() => undefined);
      });
    }
  } catch {
    await fs.rm(stolenPath, { force: true }).catch(() => undefined);
  }
}

function makeHandle(lockPath: string, token: string, heartbeatMs: number): LockHandle {
  let released = false;

  // Heartbeat: keep our lock's mtime fresh so a long-but-live operation is not
  // seen as stale. Ownership-guarded so we never refresh someone else's lock.
  const timer = setInterval(() => {
    void (async () => {
      if (released) return;
      try {
        const onDisk = await fs.readFile(lockPath, 'utf8');
        if (onDisk !== token) {
          clearInterval(timer);
          return; // we've been stolen/replaced — stop touching it
        }
        const now = new Date();
        await fs.utimes(lockPath, now, now);
      } catch {
        clearInterval(timer); // file gone — nothing to refresh
      }
    })();
  }, heartbeatMs);
  // Don't keep the extension host alive just for the heartbeat.
  (timer as { unref?: () => void }).unref?.();

  return {
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        const onDisk = await fs.readFile(lockPath, 'utf8');
        if (onDisk === token) {
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
        }
        // else: a successor owns it now — deleting it would strand that holder.
      } catch {
        // Already gone — nothing to release.
      }
    },
  };
}
