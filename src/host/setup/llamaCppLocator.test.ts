import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { locateLlamaServer, isExecTimeout } from './llamaCppLocator';
import type { ExecLookup } from '../runtime/resolveHermes';

/**
 * llamaCppLocator.test.ts — beta.6 Task T5
 * (docs_claude/beta6-unified-local-model-onboarding-architecture.md §2.4).
 *
 * Clones `pipxLocator.test.ts`'s scripted-`ExecLookup` fixture pattern: every
 * OS-touching call `locateLlamaServer` makes routes through `loginShellSpawn`
 * EXCEPT the absolute-candidate fallback (called directly, no shell — matching
 * `pipxLocator.ts`'s own `probeAbsoluteCandidates`), so the scripted exec below
 * inspects the assembled shell command line (`args[2]`) for login-shell calls
 * and falls back to `'<command> <args…>'` for the direct-exec fallback calls.
 */

interface ExecLookupCallLine {
  command: string;
  cmdline: string;
  timeoutMs: number;
}

function scriptedExec(
  rules: ReadonlyArray<{ match: RegExp; respond: () => string }>,
): { exec: ExecLookup; calls: ExecLookupCallLine[] } {
  const calls: ExecLookupCallLine[] = [];
  const exec: ExecLookup = async (command, args, opts) => {
    const cmdline = args[2] ?? `${command} ${args.join(' ')}`;
    calls.push({ command, cmdline, timeoutMs: opts.timeoutMs });
    for (const rule of rules) {
      if (rule.match.test(cmdline)) return rule.respond();
    }
    throw new Error(`unscripted exec call: ${command} ${args.join(' ')}`);
  };
  return { exec, calls };
}

// --- timeout/maxBuffer/exit-127 error fixtures (identical shapes to pipxLocator.test.ts) ---

function execTimeoutError(): Error {
  const err = new Error('command timed out') as Error & { killed?: boolean; signal?: string };
  err.killed = true;
  err.signal = 'SIGTERM';
  return err;
}

function execMaxBufferError(): Error {
  const err = new Error('stdout maxBuffer exceeded') as Error & { killed?: boolean; code?: string };
  err.killed = true;
  err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  return err;
}

function execNotFoundError(): Error {
  // A clean `command -v llama-server` miss: exit 127, no signal, no `killed`.
  return new Error('command failed with exit code 127');
}

const FOUND = { match: /^command -v llama-server$/, respond: () => '/usr/local/bin/llama-server\n' };
const MISSING = {
  match: /^command -v llama-server$/,
  respond: (): string => {
    throw execNotFoundError();
  },
};

function foundOnRetry() {
  let calls = 0;
  return {
    match: /^command -v llama-server$/,
    respond: (): string => {
      calls++;
      if (calls === 1) throw execTimeoutError();
      return '/usr/local/bin/llama-server\n';
    },
  };
}

const DOUBLE_TIMEOUT = {
  match: /^command -v llama-server$/,
  respond: (): string => {
    throw execTimeoutError();
  },
};

const TIMEOUT_ONCE_THEN_MISSING_ON_RETRY = (() => {
  let calls = 0;
  return {
    match: /^command -v llama-server$/,
    respond: (): string => {
      calls++;
      if (calls === 1) throw execTimeoutError();
      throw execNotFoundError();
    },
  };
})();

const VERSION_HIT = {
  match: /^exec \/usr\/local\/bin\/llama-server --version$/,
  respond: () => 'version: b4570 (a1b2c3d)\n',
};

const VERSION_FAILS = {
  match: /^exec \/usr\/local\/bin\/llama-server --version$/,
  respond: (): string => {
    throw new Error('binary does not support --version');
  },
};

const HOME_CANDIDATE_HIT = {
  match: /\.local[\\/]bin[\\/]llama-server --version$/,
  respond: () => 'version: b4570 (home-candidate)\n',
};
const HOME_CANDIDATE_MISS = {
  match: /\.local[\\/]bin[\\/]llama-server --version$/,
  respond: (): string => {
    throw execTimeoutError();
  },
};
const USR_LOCAL_BIN_CANDIDATE_HIT = {
  match: /^\/usr\/local\/bin\/llama-server --version$/,
  respond: () => 'version: b4570 (usr-local)\n',
};
const USR_LOCAL_BIN_CANDIDATE_MISS = {
  match: /^\/usr\/local\/bin\/llama-server --version$/,
  respond: (): string => {
    throw execTimeoutError();
  },
};
const USR_BIN_CANDIDATE_HIT = {
  match: /^\/usr\/bin\/llama-server --version$/,
  respond: () => 'version: b4570 (usr-bin)\n',
};
const USR_BIN_CANDIDATE_MISS = {
  match: /^\/usr\/bin\/llama-server --version$/,
  respond: (): string => {
    throw execTimeoutError();
  },
};

describe('locateLlamaServer — §2.4 truth table: found / not-found / probe-timeout', () => {
  it('found on login-shell PATH + version parsed → ok:true with path+version', async () => {
    const { exec } = scriptedExec([FOUND, VERSION_HIT]);

    const result = await locateLlamaServer(exec);

    expect(result).toEqual({
      ok: true,
      path: '/usr/local/bin/llama-server',
      version: 'version: b4570 (a1b2c3d)',
    });
  });

  it('found on login-shell PATH but --version probe fails → ok:true, path only, NO version (best-effort)', async () => {
    const { exec } = scriptedExec([FOUND, VERSION_FAILS]);

    const result = await locateLlamaServer(exec);

    expect(result).toEqual({ ok: true, path: '/usr/local/bin/llama-server' });
  });

  it('clean exit-127 miss on the FIRST attempt → { ok:false, reason:"not-found" }, no retry, no fallback', async () => {
    const { exec, calls } = scriptedExec([MISSING]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-found');
      expect(result.detail.length).toBeGreaterThan(0);
    }
    expect(calls).toHaveLength(1);
  });

  it('a timeout THEN a clean miss on retry → not-found (single-timeout path never triggers the fallback)', async () => {
    const { exec, calls } = scriptedExec([TIMEOUT_ONCE_THEN_MISSING_ON_RETRY]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
    expect(calls.filter((c) => c.cmdline === 'command -v llama-server')).toHaveLength(2);
    expect(calls.some((c) => c.cmdline.includes('--version'))).toBe(false);
  });

  it('timeout on first attempt → retries once at 10s → success (login shell stays authoritative)', async () => {
    const { exec, calls } = scriptedExec([foundOnRetry(), VERSION_HIT]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe('/usr/local/bin/llama-server');
    const step0Calls = calls.filter((c) => c.cmdline === 'command -v llama-server');
    expect(step0Calls).toHaveLength(2);
    expect(step0Calls[0]?.timeoutMs).toBe(5_000);
    expect(step0Calls[1]?.timeoutMs).toBe(10_000);
  });

  it('maxBuffer kill on the first attempt is NOT classified as a timeout → not-found, no retry, no fallback', async () => {
    const { exec, calls } = scriptedExec([
      { match: /^command -v llama-server$/, respond: (): string => { throw execMaxBufferError(); } },
    ]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
    expect(calls).toHaveLength(1);
  });

  it('double-timeout (5s + 10s retry both time out) + every absolute candidate also times out → probe-timeout, DISTINCT from not-found', async () => {
    const { exec, calls } = scriptedExec([
      DOUBLE_TIMEOUT,
      HOME_CANDIDATE_MISS,
      USR_LOCAL_BIN_CANDIDATE_MISS,
      USR_BIN_CANDIDATE_MISS,
    ]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The load-bearing distinction (CC-5): a probe that never got an answer
      // is NOT the same typed state as a probe that got a clean "no such command".
      expect(result.reason).toBe('probe-timeout');
      expect(result.reason).not.toBe('not-found');
      expect(result.detail.length).toBeGreaterThan(0);
    }
    const candidateCalls = calls.filter((c) => c.cmdline.includes('--version'));
    expect(candidateCalls.map((c) => c.command)).toEqual([
      expect.stringMatching(/\.local[\\/]bin[\\/]llama-server$/),
      '/usr/local/bin/llama-server',
      '/usr/bin/llama-server',
    ]);
    expect(candidateCalls.every((c) => c.timeoutMs === 2_000)).toBe(true);
  });

  it('double-timeout → home candidate HIT (first in PATH-precedence order) → ok:true, later candidates never probed', async () => {
    const { exec, calls } = scriptedExec([DOUBLE_TIMEOUT, HOME_CANDIDATE_HIT]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toMatch(/\.local[\\/]bin[\\/]llama-server$/);
      expect(result.version).toBe('version: b4570 (home-candidate)');
    }
    expect(calls.some((c) => c.command === '/usr/local/bin/llama-server')).toBe(false);
    expect(calls.some((c) => c.command === '/usr/bin/llama-server')).toBe(false);
  });

  it('double-timeout → home MISS, /usr/local/bin HIT → ok:true with /usr/local/bin, /usr/bin never probed', async () => {
    const { exec, calls } = scriptedExec([DOUBLE_TIMEOUT, HOME_CANDIDATE_MISS, USR_LOCAL_BIN_CANDIDATE_HIT]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe('/usr/local/bin/llama-server');
    expect(calls.some((c) => c.command === '/usr/bin/llama-server')).toBe(false);
  });

  it('double-timeout → home MISS, /usr/local/bin MISS, /usr/bin HIT → ok:true with /usr/bin (last in precedence)', async () => {
    const { exec } = scriptedExec([
      DOUBLE_TIMEOUT,
      HOME_CANDIDATE_MISS,
      USR_LOCAL_BIN_CANDIDATE_MISS,
      USR_BIN_CANDIDATE_HIT,
    ]);

    const result = await locateLlamaServer(exec);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe('/usr/bin/llama-server');
  });
});

describe('isExecTimeout — classifies a timeout kill, excludes a maxBuffer kill (cloned from pipxLocator)', () => {
  it('killed:true + signal:SIGTERM (a genuine timeout kill) -> true', () => {
    expect(isExecTimeout(execTimeoutError())).toBe(true);
  });

  it('killed:true + code:ERR_CHILD_PROCESS_STDIO_MAXBUFFER (Node also sets killed on maxBuffer) -> false', () => {
    expect(isExecTimeout(execMaxBufferError())).toBe(false);
  });

  it('a clean non-zero exit (no killed, no signal) -> false', () => {
    expect(isExecTimeout(execNotFoundError())).toBe(false);
  });

  it('non-object / nullish input -> false (never throws)', () => {
    expect(isExecTimeout(undefined)).toBe(false);
    expect(isExecTimeout('plain string')).toBe(false);
    expect(isExecTimeout(null)).toBe(false);
  });

  // Global Constraint 4 (no mock-theater): pinned against a REAL `execFile`
  // timeout — the actual Node error Windows/Linux produce, not a hand-rolled
  // fixture. Cloned verbatim from pipxLocator.test.ts (GC4 is non-negotiable).
  it('REAL execFile timeout (node -e long sleep, timeout:100) -> true', async () => {
    const err: unknown = await new Promise((resolve) => {
      execFile('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 100 }, (e) => resolve(e));
    });
    expect(err).not.toBeNull();
    expect(isExecTimeout(err)).toBe(true);
  }, 10_000);
});
