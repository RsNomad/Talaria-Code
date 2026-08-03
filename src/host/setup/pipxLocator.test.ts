import { describe, it, expect } from 'vitest';
import { locatePipx, isVersionInRange } from './pipxLocator';
import type { ExecLookup } from '../runtime/resolveHermes';

/** Test-local bookkeeping shape for the scripted exec's observed calls. */
interface ExecLookupCallLine {
  command: string;
  cmdline: string;
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
 *  throw loudly (a silent wrong-branch call would otherwise pass silently). */
function scriptedExec(
  rules: ReadonlyArray<{ match: RegExp; respond: () => string }>,
): { exec: ExecLookup; calls: ExecLookupCallLine[] } {
  const calls: ExecLookupCallLine[] = [];
  const exec: ExecLookup = async (command, args, _opts) => {
    const cmdline = args[2] ?? '';
    calls.push({ command, cmdline });
    for (const rule of rules) {
      if (rule.match.test(cmdline)) return rule.respond();
    }
    throw new Error(`unscripted exec call: ${command} ${args.join(' ')}`);
  };
  return { exec, calls };
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
