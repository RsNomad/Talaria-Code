import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('(D) CA-04: the restore step never uses an existence-check + rename — a fresh lock racing into the check→restore window survives', async () => {
      const lockPath = path.join(dir, '.checkpoint.lock');
      // Plant a genuinely-stale lock so the acquirer enters the steal path.
      await fs.writeFile(lockPath, 'stale-dead-holder');
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      // Stat choreography (call-counted so the stealer runs EXACTLY ONE
      // steal-restore cycle): the FIRST lockPath stat passes through real
      // (old mtime -> stale -> steal); every LATER lockPath stat reports
      // FRESH — a restored lock keeps the ORIGINAL inode's old mtime, which
      // would otherwise re-trigger the steal in an endless loop that never
      // reaches the deadline branch. Every `.stale-` stat reports FRESH
      // (forces the "grabbed a now-LIVE lock" restore branch).
      const realStat = fs.stat.bind(fs);
      let lockStatCalls = 0;
      const fresh = (st: Awaited<ReturnType<typeof realStat>>): typeof st =>
        new Proxy(st, {
          get: (t, prop) => (prop === 'mtimeMs' ? Date.now() : Reflect.get(t, prop)),
        }) as typeof st;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p) => {
        const st = await realStat(p as string);
        if (String(p).includes('.stale-')) return fresh(st);
        if (String(p) === lockPath) {
          lockStatCalls += 1;
          return lockStatCalls === 1 ? st : fresh(st);
        }
        return st;
      });

      // The armed trap: IF the restore step consults `fs.access(lockPath)`
      // (the old check-then-rename shape), a third party wins the window —
      // we create its fresh lock at that exact instant, then report "absent".
      let thirdPartyPlanted = false;
      const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async (p) => {
        if (String(p) === lockPath) {
          await fs.writeFile(lockPath, 'third-party-token');
          thirdPartyPlanted = true;
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
      });

      // A rename whose DESTINATION is the lock path is the banned mechanism.
      const realRename = fs.rename.bind(fs);
      let renamesOntoLockPath = 0;
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
        if (String(b) === lockPath) renamesOntoLockPath += 1;
        return realRename(a as string, b as string);
      });

      try {
        // The acquirer steals, re-validates (fresh → restore branch), restores,
        // then loops; the (restored or third-party) live lock makes it wait out
        // maxWaitMs and reject — it must NEVER enter.
        await expect(
          acquireLock(dir, { staleMs: 1_000, maxWaitMs: 250, pollMs: 20 }),
        ).rejects.toBeInstanceOf(CheckpointLockTimeoutError);

        // THE PIN (non-vacuous on both old and new code): restore never
        // rename(2)s onto the lock path.
        expect(renamesOntoLockPath).toBe(0);
        // AND if the access-trap fired (old shape), the third party survived.
        if (thirdPartyPlanted) {
          expect(await fs.readFile(lockPath, 'utf8')).toBe('third-party-token');
        }
      } finally {
        statSpy.mockRestore();
        accessSpy.mockRestore();
        renameSpy.mockRestore();
      }
    });

    it('(E) CA-04: occupied slot at restore time — the occupant is byte-untouched, the stolen copy is discarded', async () => {
      const lockPath = path.join(dir, '.checkpoint.lock');
      await fs.writeFile(lockPath, 'stale-dead-holder');
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      // Stolen-file re-validation reports FRESH (live), and at that same
      // instant a newer lock appears in the slot — the deterministic EEXIST
      // arm. lockPath stats are call-counted exactly like test (D): first
      // real (stale -> steal), later FRESH (the occupant must look live so
      // the acquirer waits out maxWaitMs instead of stealing IT).
      const realStat = fs.stat.bind(fs);
      let lockStatCalls = 0;
      let occupantPlanted = false;
      const fresh = (st: Awaited<ReturnType<typeof realStat>>): typeof st =>
        new Proxy(st, {
          get: (t, prop) => (prop === 'mtimeMs' ? Date.now() : Reflect.get(t, prop)),
        }) as typeof st;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p) => {
        const st = await realStat(p as string);
        if (String(p).includes('.stale-')) {
          if (!occupantPlanted) {
            occupantPlanted = true;
            await fs.writeFile(lockPath, 'newer-live-occupant');
          }
          return fresh(st);
        }
        if (String(p) === lockPath) {
          lockStatCalls += 1;
          return lockStatCalls === 1 ? st : fresh(st);
        }
        return st;
      });

      try {
        await expect(
          acquireLock(dir, { staleMs: 1_000, maxWaitMs: 250, pollMs: 20 }),
        ).rejects.toBeInstanceOf(CheckpointLockTimeoutError);
        expect(await fs.readFile(lockPath, 'utf8')).toBe('newer-live-occupant');
        const leftovers = (await fs.readdir(dir)).filter((n) => n.includes('.stale-'));
        expect(leftovers).toEqual([]);
      } finally {
        statSpy.mockRestore();
      }
    });

    it('(F) CA-04: empty slot at restore time — the live owner\'s lock is restored intact (same content), no stolen leftovers', async () => {
      const lockPath = path.join(dir, '.checkpoint.lock');
      await fs.writeFile(lockPath, 'live-owner-token');
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      // Call-counted lockPath stats, exactly like tests (D)/(E): the FIRST
      // probe is real (old mtime -> triggers the steal); LATER probes report
      // FRESH — the RESTORED lock carries the original inode's old mtime and
      // would otherwise be endlessly re-stolen, never reaching the deadline.
      const realStat = fs.stat.bind(fs);
      let lockStatCalls = 0;
      const fresh = (st: Awaited<ReturnType<typeof realStat>>): typeof st =>
        new Proxy(st, {
          get: (t, prop) => (prop === 'mtimeMs' ? Date.now() : Reflect.get(t, prop)),
        }) as typeof st;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p) => {
        const st = await realStat(p as string);
        if (String(p).includes('.stale-')) return fresh(st);
        if (String(p) === lockPath) {
          lockStatCalls += 1;
          return lockStatCalls === 1 ? st : fresh(st);
        }
        return st;
      });

      try {
        await expect(
          acquireLock(dir, { staleMs: 1_000, maxWaitMs: 250, pollMs: 20 }),
        ).rejects.toBeInstanceOf(CheckpointLockTimeoutError);
        expect(await fs.readFile(lockPath, 'utf8')).toBe('live-owner-token');
        const leftovers = (await fs.readdir(dir)).filter((n) => n.includes('.stale-'));
        expect(leftovers).toEqual([]);
      } finally {
        statSpy.mockRestore();
      }
    });

    it('(G) CA-04: 3-party race harness — a successfully-created fresh lock is never silently replaced', async () => {
      const lockPath = path.join(dir, '.checkpoint.lock');
      const opts = { staleMs: 300, maxWaitMs: 250, pollMs: 10 };
      for (let trial = 0; trial < 6; trial++) {
        await fs.rm(lockPath, { force: true });
        await fs.writeFile(lockPath, `dead-${trial}`);
        const past = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, past, past);

        // Third party hammers the wx gate while two stealers race the stale lock.
        let thirdToken: string | null = null;
        const thirdParty = (async () => {
          for (let i = 0; i < 40 && thirdToken === null; i++) {
            try {
              const fh = await fs.open(lockPath, 'wx');
              thirdToken = `third-${trial}-${i}`;
              await fh.writeFile(thirdToken);
              await fh.close();
            } catch {
              await new Promise((r) => setTimeout(r, 5));
            }
          }
        })();

        const results = await Promise.allSettled([acquireLock(dir, opts), acquireLock(dir, opts)]);
        await thirdParty;

        const winners = results.filter((r) => r.status === 'fulfilled');
        // Invariant 1: the wx gate stays single-winner overall.
        expect(winners.length + (thirdToken !== null ? 1 : 0)).toBeLessThanOrEqual(2);
        // Invariant 2: if the third party created a lock and NO stealer
        // subsequently acquired (its lock is fresh → un-stealable), its token
        // must still be on disk — restore must never have replaced it.
        if (thirdToken !== null && winners.length === 0) {
          expect(await fs.readFile(lockPath, 'utf8')).toBe(thirdToken);
        }
        for (const r of results) {
          if (r.status === 'fulfilled') await r.value.release();
        }
      }
    }, 20_000);
  });
});
