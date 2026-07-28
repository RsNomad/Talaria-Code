import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireLock, CheckpointLockTimeoutError } from './shadowLock';

describe('acquireLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-lock-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('grants, then blocks a second acquisition until released', async () => {
    const a = await acquireLock(dir, { maxWaitMs: 150, pollMs: 20 });

    // A live-lock timeout is a TRANSIENT/retryable condition, surfaced as a
    // dedicated typed error so callers can distinguish it from permanent failure
    // (e.g. GitUnavailableError) instead of masking both as "unavailable".
    await expect(acquireLock(dir, { maxWaitMs: 150, pollMs: 20 })).rejects.toBeInstanceOf(
      CheckpointLockTimeoutError,
    );
    await expect(acquireLock(dir, { maxWaitMs: 150, pollMs: 20 })).rejects.toThrow(/lock/i);

    await a.release();

    // Once released, the lock is grantable again.
    const b = await acquireLock(dir, { maxWaitMs: 150, pollMs: 20 });
    await b.release();
  });

  it('steals a lock older than staleMs so it can never deadlock', async () => {
    const lockPath = path.join(dir, '.checkpoint.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, at: 0 }));
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, past, past);

    // Acquisition succeeds despite the existing lockfile because it is stale.
    const handle = await acquireLock(dir, { staleMs: 1_000, maxWaitMs: 150, pollMs: 20 });
    await handle.release();

    // Release removed the lockfile.
    await expect(fs.access(lockPath)).rejects.toBeDefined();
  });

  it('releases even if never re-acquired (idempotent release)', async () => {
    const a = await acquireLock(dir, { maxWaitMs: 150, pollMs: 20 });
    await a.release();
    await a.release(); // second release is a no-op, does not throw
  });

  describe('re-review: no two concurrent holders', () => {
    it('(A) two racing stealers on a stale lock: EXACTLY ONE acquires (never two holders)', async () => {
      const lockPath = path.join(dir, '.checkpoint.lock');
      const opts = { staleMs: 1_000, maxWaitMs: 120, pollMs: 20 };

      // Repeat the race a few times: only ONE racer may ever break a given
      // stale lock and enter. The atomic-rename steal guarantees this by
      // construction; the naive rm-by-path steal can let BOTH in on unlucky
      // interleavings. Asserting "exactly one" every trial is the invariant.
      for (let trial = 0; trial < 8; trial++) {
        await fs.rm(lockPath, { force: true });
        await fs.writeFile(lockPath, `pre-existing-dead-holder-${trial}`);
        const past = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, past, past);

        const results = await Promise.allSettled([
          acquireLock(dir, opts),
          acquireLock(dir, opts),
        ]);
        const winners = results.filter((r) => r.status === 'fulfilled');

        expect(winners.length).toBe(1);

        for (const r of results) {
          if (r.status === 'fulfilled') await r.value.release();
        }
      }
    }, 15_000);

    it('(B) a genuinely-held live lock is NOT stolen even past staleMs (heartbeat keeps it live)', async () => {
      // staleMs deliberately tiny; the heartbeat must refresh mtime so the held
      // lock never looks stale.
      const held = await acquireLock(dir, { staleMs: 150, heartbeatMs: 40, maxWaitMs: 100, pollMs: 20 });

      // Hold it well past staleMs.
      await new Promise((r) => setTimeout(r, 500));

      // A second acquirer must NOT be able to steal the still-live lock.
      await expect(
        acquireLock(dir, { staleMs: 150, heartbeatMs: 40, maxWaitMs: 120, pollMs: 20 }),
      ).rejects.toThrow(/lock/i);

      // The original holder still owns the file.
      const lockPath = path.join(dir, '.checkpoint.lock');
      await expect(fs.access(lockPath)).resolves.toBeUndefined();

      await held.release();
    });

    it('(C) release() removes only the caller\'s own lock (ownership token)', async () => {
      const lockPath = path.join(dir, '.checkpoint.lock');
      const a = await acquireLock(dir, { staleMs: 60_000, heartbeatMs: 30_000, maxWaitMs: 150, pollMs: 20 });

      // Simulate a successor having stolen the lock: overwrite the file with a
      // different owner's token.
      await fs.writeFile(lockPath, 'successor-owner-token');

      // The original holder's release must NOT delete the successor's lock.
      await a.release();

      const onDisk = await fs.readFile(lockPath, 'utf8');
      expect(onDisk).toBe('successor-owner-token'); // survived the wrong owner's release

      await fs.rm(lockPath, { force: true });
    });
  });
});
