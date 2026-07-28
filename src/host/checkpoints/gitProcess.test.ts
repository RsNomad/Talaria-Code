import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sanitizeGitEnv } from './gitEnv';
import {
  GitOutputLimitError,
  GitTimeoutError,
  __setSpawnForTests,
  runGit,
  runGitBinary,
} from './gitProcess';

/**
 * A fake `git` child that behaves like a `ChildProcess` for {@link
 * spawnGitCollect}'s purposes but NEVER emits `close` unless the test does so
 * explicitly — i.e. a stalled git. `kill` is a spy so we can assert SIGKILL.
 */
class FakeGitChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { on: (): void => undefined, write: (): void => undefined, end: (): void => undefined };
  kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true);
}

/** Cast a `() => FakeGitChild` into the shape {@link __setSpawnForTests} expects. */
function injectSpawn(child: FakeGitChild): void {
  __setSpawnForTests((() => child) as unknown as Parameters<typeof __setSpawnForTests>[0]);
}

/**
 * S-M6(c): git subprocess stdout must be captured with a BOUNDED buffer so a
 * pathological repo cannot OOM the extension host. Output past the cap fails
 * cleanly (a typed error) rather than truncating or growing without limit.
 */
describe('runGit output cap (S-M6c)', () => {
  const baseEnv = sanitizeGitEnv(process.env);

  it('rejects with GitOutputLimitError when stdout exceeds maxBufferBytes', async () => {
    // `git --version` prints well over 1 byte in a single chunk.
    await expect(
      runGit(['--version'], { cwd: process.cwd(), env: baseEnv, maxBufferBytes: 1 }),
    ).rejects.toBeInstanceOf(GitOutputLimitError);
  });

  it('rejects the binary variant too when stdout exceeds the cap', async () => {
    await expect(
      runGitBinary(['--version'], { cwd: process.cwd(), env: baseEnv, maxBufferBytes: 1 }),
    ).rejects.toBeInstanceOf(GitOutputLimitError);
  });

  it('resolves normally under a generous cap (no false positives)', async () => {
    const res = await runGit(['--version'], {
      cwd: process.cwd(),
      env: baseEnv,
      maxBufferBytes: 1024 * 1024,
    });
    expect(res.stdout).toMatch(/git version/i);
  });
});

/**
 * arch A#1: a git invocation must be WALL-CLOCK bounded. Without this a stalled
 * git (NFS/sshfs worktree, FS stall, wedged hook/credential prompt) makes the
 * awaited C1 snapshot barrier never settle → the user's prompt is silently never
 * sent. The runner SIGKILLs the child and rejects with a typed GitTimeoutError.
 */
describe('runGit wall-clock timeout + SIGKILL (arch A#1)', () => {
  const baseEnv = sanitizeGitEnv(process.env);

  afterEach(() => {
    __setSpawnForTests(null); // restore the real spawn
  });

  it('SIGKILLs a stalled git and rejects with GitTimeoutError after timeoutMs', async () => {
    const child = new FakeGitChild();
    injectSpawn(child);

    const start = Date.now();
    await expect(
      runGit(['write-tree'], { cwd: process.cwd(), env: baseEnv, timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(GitTimeoutError);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // Settled promptly on the timeout, not hung indefinitely.
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('binary variant is bounded too', async () => {
    const child = new FakeGitChild();
    injectSpawn(child);
    await expect(
      runGitBinary(['show', 'HEAD:big'], { cwd: process.cwd(), env: baseEnv, timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(GitTimeoutError);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does NOT time out when timeoutMs is 0 (disabled) — settles only on close', async () => {
    const child = new FakeGitChild();
    injectSpawn(child);

    let settled = false;
    const p = runGit(['gc'], { cwd: process.cwd(), env: baseEnv, timeoutMs: 0 }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false); // no timeout fired
    expect(child.kill).not.toHaveBeenCalled();

    // Let it finish cleanly so the promise settles and the test cleans up.
    child.stdout.emit('data', Buffer.from(''));
    child.emit('close', 0);
    await p;
    expect(settled).toBe(true);
  });

  it('does not fire on a fast real git under a generous timeout (no false positive)', async () => {
    const res = await runGit(['--version'], { cwd: process.cwd(), env: baseEnv, timeoutMs: 10_000 });
    expect(res.stdout).toMatch(/git version/i);
  });
});

/**
 * M-1: the EPIPE guard on `child.stdin` must be attached UNCONDITIONALLY, not
 * only for calls that pipe input. For a no-input git call
 * (`write-tree`/`ls-files`/`update-ref`/`show`) a kill/EPIPE can still surface an
 * async `'error'` on `child.stdin`; with no listener Node throws on the
 * EventEmitter and can crash the extension host — defeating the very timeout path
 * this module adds.
 */
describe('runGit stdin error guard is unconditional (M-1)', () => {
  const baseEnv = sanitizeGitEnv(process.env);

  afterEach(() => {
    __setSpawnForTests(null);
  });

  /** A fake child whose stdin is a REAL EventEmitter, so an unhandled `'error'`
   * throws exactly as Node's would (a plain stub can't reproduce M-1). */
  class FakeGitChildEmitterStdin extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = Object.assign(new EventEmitter(), {
      write: (): void => undefined,
      end: (): void => undefined,
    });
    kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true);
  }

  it('swallows a stdin EPIPE on a NO-INPUT git call instead of throwing', async () => {
    const child = new FakeGitChildEmitterStdin();
    __setSpawnForTests((() => child) as unknown as Parameters<typeof __setSpawnForTests>[0]);

    // No `input` — the pre-M-1 code attached the stdin 'error' listener only in
    // the `input !== undefined` branch, so this call had NO listener.
    const p = runGit(['write-tree'], { cwd: process.cwd(), env: baseEnv, timeoutMs: 0 }).catch(
      () => undefined,
    );

    // Emitting 'error' with no listener throws synchronously at the emit site
    // (Node EventEmitter semantics). With the unconditional guard it is swallowed.
    expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();

    child.emit('close', 0);
    await p;
  });
});
