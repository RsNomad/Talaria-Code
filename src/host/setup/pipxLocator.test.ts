import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { locatePipx, isVersionInRange, isExecTimeout } from './pipxLocator';
import type { ExecLookup } from '../runtime/resolveHermes';

/** Test-local bookkeeping shape for the scripted exec's observed calls. */
interface ExecLookupCallLine {
  command: string;
  cmdline: string;
  timeoutMs: number;
  /** TC-5 (AU-28): the `AbortSignal` (if any) `locatePipx` threaded into
   *  THIS specific exec() call's opts — not just checked between steps. */
  signal: AbortSignal | undefined;
}

/**
 * pipxLocator.test.ts — Task 4 (onboarding-backend-setup-architecture.md §2.2
 * steps 0–1+3). Every OS-touching call `locatePipx` makes routes through
 * `loginShellSpawn` (matching `resolveHermes.ts`'s own login-shell modeling:
 * ONE mechanism for every subprocess, not just the builtin lookup) — so the
 * scripted `ExecLookup` below inspects the assembled shell command line
 * (`args[2]`, e.g. `'exec /usr/bin/pipx environment --value PIPX_LOCAL_VENVS'`
 * or the un-wrapped builtin form `'command -v pipx'`) rather than a bare
 * `(command, args)` pair. `resolveHermesBin`'s own test
 * (`resolveHermes.test.ts`) asserts that exact string shape for the
 * `command -v hermes` builtin case — this fixture generalizes the same
 * pattern to every step of the pipx/python recipe.
 */

/** Build a scripted `ExecLookup`: first matching rule wins; unmatched calls
 *  throw loudly (a silent wrong-branch call would otherwise pass silently).
 *
 * T11: `cmdline` is a HYBRID — for login-shell-wrapped calls (the vast
 * majority) it's the assembled shell command line (`args[2]`, e.g. `'exec
 * /usr/bin/pipx environment --value PIPX_LOCAL_VENVS'` or the un-wrapped
 * builtin form `'command -v pipx'`); for the T11 absolute-candidate probe
 * (called DIRECTLY, no shell — `exec(candidate, ['--version'], opts)`,
 * `args[2]` is `undefined`) it falls back to `'<command> <args…>'` (e.g.
 * `'/usr/bin/pipx --version'`), so both call shapes stay matchable by the
 * same rule mechanism. */
function scriptedExec(
  rules: ReadonlyArray<{ match: RegExp; respond: () => string }>,
): { exec: ExecLookup; calls: ExecLookupCallLine[] } {
  const calls: ExecLookupCallLine[] = [];
  const exec: ExecLookup = async (command, args, opts) => {
    const cmdline = args[2] ?? `${command} ${args.join(' ')}`;
    calls.push({ command, cmdline, timeoutMs: opts.timeoutMs, signal: opts.signal });
    for (const rule of rules) {
      if (rule.match.test(cmdline)) return rule.respond();
    }
    throw new Error(`unscripted exec call: ${command} ${args.join(' ')}`);
  };
  return { exec, calls };
}

// --- T11: timeout/maxBuffer/exit-127 error fixtures -------------------------
// Node `execFile` sets `err.killed`/`err.signal` on a timeout kill, and ALSO
// on a maxBuffer kill (§3, critic C-9) — the classifier must tell them apart
// via `err.code`. A clean "not found" (`command -v` exits non-zero) carries
// neither `killed` nor a maxBuffer code.

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
  // A clean `command -v pipx` miss: non-zero exit, no signal, no `killed`.
  return new Error('command failed with exit code 1');
}

const PIPX_FOUND = { match: /^command -v pipx$/, respond: () => '/usr/bin/pipx\n' };
const PIPX_MISSING = {
  match: /^command -v pipx$/,
  respond: (): string => {
    throw new Error('ENOENT: no pipx');
  },
};

function venvsRoot(root: string) {
  return {
    match: /^exec \/usr\/bin\/pipx environment --value PIPX_LOCAL_VENVS$/,
    respond: () => `${root}\n`,
  };
}

/** `pipx environment --value PIPX_DEFAULT_PYTHON` resolves to a python bin path. */
const DEFAULT_PYTHON_BIN = {
  match: /^exec \/usr\/bin\/pipx environment --value PIPX_DEFAULT_PYTHON$/,
  respond: () => '/usr/bin/python-default\n',
};

/** Older pipx: `--value PIPX_DEFAULT_PYTHON` is not a recognized key → errors. */
const DEFAULT_PYTHON_ERRORS = {
  match: /^exec \/usr\/bin\/pipx environment --value PIPX_DEFAULT_PYTHON$/,
  respond: (): string => {
    throw new Error('unrecognized --value key: PIPX_DEFAULT_PYTHON');
  },
};

/**
 * Escape EVERY RegExp metacharacter (backslash included) so a bin path is
 * matched literally when interpolated into a `new RegExp(...)`. The earlier
 * `.replace(/[.]/g, '\\.')` escaped only dots, leaving `\`/`+`/`(`/… unescaped
 * (CodeQL js/incomplete-sanitization). Inputs here are controlled test
 * fixtures, but the pattern is fixed at the source so it can't drift.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pythonVersion(bin: string, version: string) {
  return {
    match: new RegExp(`^exec ${escapeRegExp(bin)} --version$`),
    respond: () => `Python ${version}\n`,
  };
}

function pythonMissing(bin: string) {
  return {
    match: new RegExp(`^exec ${escapeRegExp(bin)} --version$`),
    respond: (): string => {
      throw new Error(`ENOENT: ${bin} not found`);
    },
  };
}

describe('locatePipx — Task 4: pipx presence + python 3.11–3.13 gate + venvsRoot', () => {
  it('pipx found + default python 3.13 in range → ok, venvsRoot captured, no override', async () => {
    const { exec } = scriptedExec([
      PIPX_FOUND,
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.13.1'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    const result = await locatePipx(exec);

    expect(result).toEqual({
      ok: true,
      env: {
        pipxPath: '/usr/bin/pipx',
        venvsRoot: '/home/u/.local/share/pipx/venvs',
        defaultPythonVersion: '3.13.1',
      },
    });
  });

  it('default python 3.14 (out of range) + python3.12 present → ok via override "python3.12"', async () => {
    const { exec } = scriptedExec([
      PIPX_FOUND,
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.14.0'),
      pythonMissing('python3.13'),
      pythonVersion('python3.12', '3.12.4'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    const result = await locatePipx(exec);

    expect(result).toEqual({
      ok: true,
      env: {
        pipxPath: '/usr/bin/pipx',
        venvsRoot: '/home/u/.local/share/pipx/venvs',
        defaultPythonVersion: '3.14.0',
        pythonOverride: 'python3.12',
      },
    });
  });

  it('pipx missing on the login-shell PATH → { ok: false, reason: "pipx-missing" }', async () => {
    const { exec, calls } = scriptedExec([PIPX_MISSING]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pipx-missing');
      expect(result.detail.length).toBeGreaterThan(0);
    }
    // No python/venvsRoot calls should ever be attempted once pipx itself is missing.
    expect(calls).toHaveLength(1);
  });

  it('T6: the pipx-missing detail is distro-neutral — no hardcoded Fedora install hint', async () => {
    const { exec } = scriptedExec([PIPX_MISSING]);
    const result = await locatePipx(exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).not.toContain('Fedora');
      expect(result.detail).not.toContain('dnf');
    }
  });

  it('default python 3.14 AND every probe candidate also 3.14 → { ok: false, reason: "python-unsuitable" }', async () => {
    const { exec, calls } = scriptedExec([
      PIPX_FOUND,
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.14.0'),
      pythonVersion('python3.13', '3.14.0'),
      pythonVersion('python3.12', '3.14.0'),
      pythonVersion('python3.11', '3.14.0'),
    ]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('python-unsuitable');
      expect(result.detail.length).toBeGreaterThan(0);
    }
    // venvsRoot must NEVER be fetched once no suitable python was found.
    expect(calls.some((c) => c.cmdline.includes('PIPX_LOCAL_VENVS'))).toBe(false);
  });

  it('older pipx where PIPX_DEFAULT_PYTHON errors → falls back to `python3 --version` (3.12) → ok', async () => {
    const { exec } = scriptedExec([
      PIPX_FOUND,
      DEFAULT_PYTHON_ERRORS,
      pythonVersion('python3', '3.12.9'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    const result = await locatePipx(exec);

    expect(result).toEqual({
      ok: true,
      env: {
        pipxPath: '/usr/bin/pipx',
        venvsRoot: '/home/u/.local/share/pipx/venvs',
        defaultPythonVersion: '3.12.9',
      },
    });
  });
});

// --- T11 (§3, C1): login-shell probe robustness -----------------------------

describe('isExecTimeout — classifies a timeout kill, excludes a maxBuffer kill (critic C-9)', () => {
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

  // Global Constraint 4 (no mock-theater): the `ExecLookup` seam carries no
  // error shape of its own, so this classifier is additionally pinned
  // against a REAL `execFile` timeout — the actual Node error Windows/Linux
  // produce, not a hand-rolled fixture.
  it('REAL execFile timeout (node -e long sleep, timeout:100) -> true', async () => {
    const err: unknown = await new Promise((resolve) => {
      execFile('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 100 }, (e) => resolve(e));
    });
    expect(err).not.toBeNull();
    expect(isExecTimeout(err)).toBe(true);
  }, 10_000);
});

const PROBE_TIMEOUT_DETAIL =
  "Your login shell didn't answer in time — a slow shell profile (nvm, conda, a network home directory) can cause this. It's usually transient: press Re-check.";

/** Step-0 `command -v pipx` rule whose FIRST call times out and whose SECOND
 *  call (the 10s retry) succeeds — proves "timeout -> retry -> success". */
function pipxFoundOnRetry() {
  let calls = 0;
  return {
    match: /^command -v pipx$/,
    respond: (): string => {
      calls++;
      if (calls === 1) throw execTimeoutError();
      return '/usr/bin/pipx\n';
    },
  };
}

/** Step-0 rule where BOTH attempts (5s then 10s) time out. */
const PIPX_DOUBLE_TIMEOUT = {
  match: /^command -v pipx$/,
  respond: (): string => {
    throw execTimeoutError();
  },
};

const PIPX_STEP0_TIMEOUT_ONCE_THEN_MISSING_ON_RETRY = (() => {
  let calls = 0;
  return {
    match: /^command -v pipx$/,
    respond: (): string => {
      calls++;
      if (calls === 1) throw execTimeoutError();
      throw execNotFoundError();
    },
  };
})();

const HOME_CANDIDATE_HIT = { match: /\.local[\\/]bin[\\/]pipx --version$/, respond: () => 'pipx 1.7.1\n' };
const HOME_CANDIDATE_MISS = {
  match: /\.local[\\/]bin[\\/]pipx --version$/,
  respond: (): string => {
    throw execTimeoutError();
  },
};
const USR_BIN_CANDIDATE_HIT = { match: /^\/usr\/bin\/pipx --version$/, respond: () => 'pipx 1.4.2\n' };
const USR_BIN_CANDIDATE_MISS = {
  match: /^\/usr\/bin\/pipx --version$/,
  respond: (): string => {
    throw execTimeoutError();
  },
};

describe('locatePipx — T11 (§3): step-0 login-shell probe robustness', () => {
  it('timeout on first attempt -> retries once at 10s -> success (login shell stays authoritative)', async () => {
    const { exec, calls } = scriptedExec([
      pipxFoundOnRetry(),
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.13.1'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    const result = await locatePipx(exec);

    expect(result).toEqual({
      ok: true,
      env: {
        pipxPath: '/usr/bin/pipx',
        venvsRoot: '/home/u/.local/share/pipx/venvs',
        defaultPythonVersion: '3.13.1',
      },
    });
    const pipxCalls = calls.filter((c) => c.cmdline === 'command -v pipx');
    expect(pipxCalls).toHaveLength(2);
    expect(pipxCalls[0]?.timeoutMs).toBe(5_000);
    expect(pipxCalls[1]?.timeoutMs).toBe(10_000);
  });

  it('clean exit-127 miss on the FIRST attempt -> pipx-missing, NO retry, NO absolute-candidate fallback', async () => {
    const { exec, calls } = scriptedExec([
      { match: /^command -v pipx$/, respond: (): string => { throw execNotFoundError(); } },
    ]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pipx-missing');
    expect(calls).toHaveLength(1);
  });

  it('a timeout THEN a clean miss on retry -> pipx-missing (single-timeout path never triggers the double-timeout fallback)', async () => {
    const { exec, calls } = scriptedExec([PIPX_STEP0_TIMEOUT_ONCE_THEN_MISSING_ON_RETRY]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pipx-missing');
    expect(calls.filter((c) => c.cmdline === 'command -v pipx')).toHaveLength(2);
    expect(calls.some((c) => c.cmdline.includes('--version'))).toBe(false);
  });

  it('maxBuffer kill on BOTH attempts is NOT classified as a timeout -> pipx-missing, no absolute-candidate fallback', async () => {
    const { exec, calls } = scriptedExec([
      { match: /^command -v pipx$/, respond: (): string => { throw execMaxBufferError(); } },
    ]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pipx-missing');
    // A maxBuffer kill on the FIRST attempt must not even retry (only a real
    // timeout retries) — exactly one call.
    expect(calls).toHaveLength(1);
  });

  it('double-timeout -> absolute-candidate fallback probed in PATH-precedence ORDER: ~/.local/bin/pipx THEN /usr/bin/pipx', async () => {
    const { exec, calls } = scriptedExec([PIPX_DOUBLE_TIMEOUT, HOME_CANDIDATE_MISS, USR_BIN_CANDIDATE_MISS]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('probe-timeout');
      expect(result.detail).toBe(PROBE_TIMEOUT_DETAIL);
    }
    const candidateCalls = calls.filter((c) => c.cmdline.includes('--version') && !c.cmdline.includes('python'));
    expect(candidateCalls.map((c) => c.command)).toEqual([expect.stringMatching(/\.local[\\/]bin[\\/]pipx$/), '/usr/bin/pipx']);
    expect(candidateCalls.every((c) => c.timeoutMs === 2_000)).toBe(true);
  });

  it('double-timeout -> home candidate HIT (first in order) -> proceeds as pipxPath, /usr/bin never probed', async () => {
    // The subsequent login-shell steps (python gate + venvsRoot) run AS the
    // home-candidate path, which is platform-dependent (Windows dev box vs.
    // Linux) and gets shell-quoted accordingly — matched here by SUFFIX
    // rather than replicating that quoting, since what's under test is the
    // fallback→hit handoff, not the shell-quoting of an arbitrary prefix.
    const { exec, calls } = scriptedExec([
      PIPX_DOUBLE_TIMEOUT,
      HOME_CANDIDATE_HIT,
      { match: /environment --value PIPX_DEFAULT_PYTHON$/, respond: () => '/usr/bin/python-default\n' },
      { match: /python-default --version$/, respond: () => 'Python 3.12.0\n' },
      { match: /environment --value PIPX_LOCAL_VENVS$/, respond: () => '/home/u/.local/share/pipx/venvs\n' },
    ]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.pipxPath).toMatch(/\.local[\\/]bin[\\/]pipx$/);
      expect(result.env.venvsRoot).toBe('/home/u/.local/share/pipx/venvs');
    }
    expect(calls.some((c) => c.command === '/usr/bin/pipx')).toBe(false);
  });

  it('double-timeout -> home candidate MISS, /usr/bin/pipx HIT -> proceeds with /usr/bin/pipx', async () => {
    const { exec } = scriptedExec([
      PIPX_DOUBLE_TIMEOUT,
      HOME_CANDIDATE_MISS,
      USR_BIN_CANDIDATE_HIT,
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.12.0'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.pipxPath).toBe('/usr/bin/pipx');
  });

  it('a timeout deep in step 1 (python gate) also retries once and can still succeed (generic runLoginShell retry)', async () => {
    let versionCalls = 0;
    const { exec } = scriptedExec([
      PIPX_FOUND,
      DEFAULT_PYTHON_BIN,
      {
        match: /^exec \/usr\/bin\/python-default --version$/,
        respond: (): string => {
          versionCalls++;
          if (versionCalls === 1) throw execTimeoutError();
          return 'Python 3.13.1\n';
        },
      },
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    const result = await locatePipx(exec);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.defaultPythonVersion).toBe('3.13.1');
    expect(versionCalls).toBe(2);
  });
});

describe('locatePipx — T11 (§3, critic C-11): optional AbortSignal checked between steps', () => {
  it('an already-aborted signal rejects with AbortError BEFORE any exec call', async () => {
    const { exec, calls } = scriptedExec([PIPX_FOUND]);
    const controller = new AbortController();
    controller.abort();

    await expect(locatePipx(exec, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });

  it('aborting BETWEEN steps (after step 0 resolves, before step 1) rejects with AbortError, step 1 never called', async () => {
    const controller = new AbortController();
    const { exec, calls } = scriptedExec([
      {
        match: /^command -v pipx$/,
        respond: (): string => {
          controller.abort(); // fires as a side effect of step 0 completing
          return '/usr/bin/pipx\n';
        },
      },
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.13.1'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    await expect(locatePipx(exec, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    // Only the step-0 call happened; nothing from python-gate/venvsRoot.
    expect(calls).toHaveLength(1);
  });
});

describe('locatePipx — TC-5 (AU-28): AbortSignal threaded into every exec() call, not just checked between steps', () => {
  it('an aborted signal rejects an in-flight probe promptly, not by waiting for the exec to resolve (fails at HEAD: hangs — exec never sees the signal)', async () => {
    const controller = new AbortController();
    // A never-resolving exec that ONLY settles if it was handed the signal —
    // exactly the AU-28 mechanism: at HEAD, `opts.signal` is never populated,
    // so this promise would hang forever (bounded by the test's own timeout
    // below) instead of rejecting shortly after abort() fires.
    const exec: ExecLookup = (_command, _args, opts) =>
      new Promise<string>((_resolve, reject) => {
        opts.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });

    const promise = locatePipx(exec, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  }, 1_500);

  it('passes the caller signal into every exec() call across the main pipeline (step 0, python gate, venvsRoot)', async () => {
    const controller = new AbortController();
    const { exec, calls } = scriptedExec([
      PIPX_FOUND,
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.13.1'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    await locatePipx(exec, controller.signal);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.signal).toBe(controller.signal);
  });

  it('passes the caller signal into the absolute-candidate fallback probes too (double-timeout path)', async () => {
    const controller = new AbortController();
    const { exec, calls } = scriptedExec([
      PIPX_DOUBLE_TIMEOUT,
      HOME_CANDIDATE_MISS,
      USR_BIN_CANDIDATE_HIT,
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.12.0'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    await locatePipx(exec, controller.signal);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.signal).toBe(controller.signal);
  });

  it('a signal-less call still omits opts.signal everywhere (back-compat: unchanged for non-cancelling callers)', async () => {
    const { exec, calls } = scriptedExec([
      PIPX_FOUND,
      DEFAULT_PYTHON_BIN,
      pythonVersion('/usr/bin/python-default', '3.13.1'),
      venvsRoot('/home/u/.local/share/pipx/venvs'),
    ]);

    await locatePipx(exec);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.signal).toBeUndefined();
  });
});

describe('isVersionInRange — numeric major.minor(.patch) compare, "Python " prefix tolerant', () => {
  it('3.14.0 is NOT in [3.11, 3.14) — upper bound is exclusive', () => {
    expect(isVersionInRange('3.14.0', '3.11', '3.14')).toBe(false);
  });

  it('3.11.0 IS in [3.11, 3.14) — lower bound is inclusive', () => {
    expect(isVersionInRange('3.11.0', '3.11', '3.14')).toBe(true);
  });

  it('tolerates a "Python " prefix (as printed by `python --version`)', () => {
    expect(isVersionInRange('Python 3.13.1', '3.11', '3.14')).toBe(true);
    expect(isVersionInRange('Python 3.14.2', '3.11', '3.14')).toBe(false);
  });
});
