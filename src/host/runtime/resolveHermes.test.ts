import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveHermes,
  resolveHermesBin,
  resetHermesBinCache,
  defaultExecLookup,
  type ExecLookup,
  type RealpathLookup,
  type AccessCheck,
} from './resolveHermes';
import { must } from '../../testing/must';

function fakeExec(stdout: string): {
  exec: ExecLookup;
  calls: Array<{ command: string; args: string[]; timeoutMs: number }>;
} {
  const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
  const exec: ExecLookup = async (command, args, opts) => {
    calls.push({ command, args, timeoutMs: opts.timeoutMs });
    return stdout;
  };
  return { exec, calls };
}

/**
 * Fake seams for the AU-7 realpath-then-derive path (INV-9/ADR-3). Every
 * pre-existing `resolveHermes(...)` call below that expects a SUCCESSFUL
 * resolution (not testing AU-7 itself) must inject these — the new default
 * behavior is real `fs.promises.realpath`/`fs.promises.access` against a
 * fake `/home/u/.venvs/...` path that does not exist on the test runner's
 * real disk, which would otherwise throw the new AU-7 not-found error.
 * `identityRealpath` models a plain (non-symlinked) venv `bin/hermes` —
 * realpath is a no-op — and `alwaysAccessible` models the sibling `python`
 * actually existing next to it.
 */
const identityRealpath: RealpathLookup = async (p) => p;
const alwaysAccessible: AccessCheck = async () => {};

describe('resolveHermesBin — R-A5: real cached login-shell lookup', () => {
  beforeEach(() => resetHermesBinCache());

  it('an explicit hermesPath wins; the lookup is never executed', async () => {
    const { exec, calls } = fakeExec('/never/used');
    await expect(
      resolveHermesBin({ hermesPath: '/opt/hermes/bin/hermes' }, exec),
    ).resolves.toBe('/opt/hermes/bin/hermes');
    expect(calls).toEqual([]);
  });

  it('runs `command -v hermes` through the login shell with a 10s timeout and trims stdout', async () => {
    const { exec, calls } = fakeExec('/home/u/.venvs/hermes/bin/hermes\n');
    await expect(resolveHermesBin({ shell: '/bin/zsh' }, exec)).resolves.toBe(
      '/home/u/.venvs/hermes/bin/hermes',
    );
    // NOTE: no `exec` wrapper here. `command` is a POSIX shell builtin, not an
    // external executable — `exec command -v hermes` fails with exit 127
    // ("exec: command: not found") because `exec` only PATH-searches for real
    // binaries. The one-shot lookup must run the builtin directly.
    expect(calls).toEqual([
      { command: '/bin/zsh', args: ['-l', '-c', 'command -v hermes'], timeoutMs: 10_000 },
    ]);
  });

  it('takes the LAST stdout line (login-shell profile noise precedes the answer)', async () => {
    const { exec } = fakeExec('Welcome back!\nmotd line\n/usr/local/bin/hermes\n');
    await expect(resolveHermesBin({}, exec)).resolves.toBe('/usr/local/bin/hermes');
  });

  it('caches a successful lookup for the process lifetime (one exec total)', async () => {
    const { exec, calls } = fakeExec('/usr/local/bin/hermes\n');
    await resolveHermesBin({}, exec);
    await resolveHermesBin({}, exec);
    expect(calls).toHaveLength(1);
  });

  it('a failed exec surfaces an actionable error naming talaria.hermesPath — and is NOT cached', async () => {
    let attempts = 0;
    const failing: ExecLookup = async () => {
      attempts += 1;
      throw new Error('ETIMEDOUT');
    };
    await expect(resolveHermesBin({}, failing)).rejects.toThrow(/talaria\.hermesPath/);
    await expect(resolveHermesBin({}, failing)).rejects.toThrow();
    expect(attempts).toBe(2); // failure retried, never cached
  });

  it('empty or non-absolute output is rejected with the actionable error', async () => {
    const { exec } = fakeExec('\n');
    await expect(resolveHermesBin({}, exec)).rejects.toThrow(/talaria\.hermesPath/);
    resetHermesBinCache();
    const relative = fakeExec('hermes: aliased to hx\n');
    await expect(resolveHermesBin({}, relative.exec)).rejects.toThrow(/talaria\.hermesPath/);
  });

  it('AUDIT-5 SEC M-2: the login-shell discovery pins a NON-workspace cwd (os.homedir) so workspace auto-env hooks (direnv) can never steer PATH', async () => {
    const seen: Array<{ timeoutMs: number; cwd: string }> = [];
    const exec: ExecLookup = async (_cmd, _args, opts) => {
      seen.push(opts);
      return '/usr/local/bin/hermes\n';
    };
    resetHermesBinCache();
    await resolveHermesBin({ hermesPath: undefined, pythonPath: undefined, cwd: undefined }, exec);
    expect(seen[0]?.cwd).toBe(os.homedir());
  });

  it('resolveHermes derives the sibling venv python and both spawn specs from the discovered bin', async () => {
    const { exec } = fakeExec('/home/u/.venvs/hermes/bin/hermes\n');
    const resolved = await resolveHermes(
      { cwd: '/ws', shell: '/bin/bash' },
      exec,
      identityRealpath,
      alwaysAccessible,
    );
    expect(resolved.hermesBin).toBe('/home/u/.venvs/hermes/bin/hermes');
    expect(resolved.python).toBe('/home/u/.venvs/hermes/bin/python');
    expect(resolved.acp.command).toBe('/bin/bash');
    expect(resolved.acp.args[2]).toContain('exec /home/u/.venvs/hermes/bin/hermes acp');
  });

  it('the long-lived children (hermes acp, python -m tui_gateway) still spawn via `exec` — signal propagation must not regress', async () => {
    const { exec } = fakeExec('/home/u/.venvs/hermes/bin/hermes\n');
    const resolved = await resolveHermes(
      { cwd: '/ws', shell: '/bin/bash' },
      exec,
      identityRealpath,
      alwaysAccessible,
    );
    // `exec` replaces the login shell so SIGTERM/SIGKILL from disposal reaches
    // the real child. Only the one-shot `command -v hermes` lookup should skip it.
    expect(resolved.acp.args[2]).toBe('exec /home/u/.venvs/hermes/bin/hermes acp');
    expect(resolved.control.args[2]).toBe(
      'exec /home/u/.venvs/hermes/bin/python -m tui_gateway.entry',
    );
  });

  it('AUDIT-5 SEC M-3: with no workspace open (cwd undefined), resolveHermes falls back to os.homedir() — never process.cwd() (the EH install dir)', async () => {
    const { exec } = fakeExec('/home/u/.venvs/hermes/bin/hermes\n');
    const resolved = await resolveHermes(
      { cwd: undefined, shell: '/bin/bash' },
      exec,
      identityRealpath,
      alwaysAccessible,
    );
    expect(resolved.cwd).toBe(os.homedir());
  });
});

describe('resolveHermes — AU-7: symlink-blind interpreter derivation (INV-9 / ADR-3)', () => {
  beforeEach(() => resetHermesBinCache());

  it('a pipx-shim symlink derives python from the REALPATH TARGET, not the symlink\'s own sibling (fails at HEAD: string-sibling math never realpaths)', async () => {
    // pipx layout (V5): `~/.local/bin/hermes` is a SYMLINK into
    // `~/.local/share/pipx/venvs/hermes-agent/bin/`; pipx puts no `python` in
    // `~/.local/bin` — the symlink's own sibling does not exist. Only the
    // REALPATH TARGET's sibling (`…/venvs/hermes-agent/bin/python`) exists.
    const { exec } = fakeExec('/home/u/.local/bin/hermes\n');
    const realTarget = '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes';
    const seenRealpathArgs: string[] = [];
    const realpathImpl: RealpathLookup = async (p) => {
      seenRealpathArgs.push(p);
      return p === '/home/u/.local/bin/hermes' ? realTarget : p;
    };
    const seenAccessArgs: string[] = [];
    const accessImpl: AccessCheck = async (p) => {
      seenAccessArgs.push(p);
      // Only the realpath-target's sibling exists — mirrors the real pipx
      // filesystem (no `python` next to the shim in `~/.local/bin`).
      if (p !== '/home/u/.local/share/pipx/venvs/hermes-agent/bin/python') {
        throw new Error('ENOENT');
      }
    };

    const resolved = await resolveHermes({}, exec, realpathImpl, accessImpl);

    expect(resolved.python).toBe('/home/u/.local/share/pipx/venvs/hermes-agent/bin/python');
    expect(resolved.python).not.toBe('/home/u/.local/bin/python'); // the symlink's own (nonexistent) sibling
    expect(seenRealpathArgs).toEqual(['/home/u/.local/bin/hermes']); // realpath ran on the DISCOVERED bin
    expect(seenAccessArgs).toEqual([
      '/home/u/.local/share/pipx/venvs/hermes-agent/bin/python',
    ]); // existence-checked the REALPATH-derived sibling
  });

  it('a derived interpreter that does not exist throws an actionable error naming talaria.pythonPath (broken-link realpath falls back to the lexical sibling, which also misses)', async () => {
    const { exec } = fakeExec('/home/u/.local/bin/hermes\n');
    const realpathImpl: RealpathLookup = async () => {
      throw new Error('ENOENT: broken symlink');
    };
    const seenAccessArgs: string[] = [];
    const accessImpl: AccessCheck = async (p) => {
      seenAccessArgs.push(p);
      throw new Error('ENOENT');
    };

    await expect(resolveHermes({}, exec, realpathImpl, accessImpl)).rejects.toThrow(
      /talaria\.pythonPath/,
    );
    // realpath failure fell back to the LEXICAL sibling (still attempted a
    // derivation, never silently gave up before the existence check).
    expect(seenAccessArgs).toEqual(['/home/u/.local/bin/python']);
  });

  it('an explicit talaria.pythonPath short-circuits BOTH the realpath and existence checks (unchanged behavior)', async () => {
    const { exec } = fakeExec('/home/u/.local/bin/hermes\n');
    let realpathCalls = 0;
    let accessCalls = 0;
    const realpathImpl: RealpathLookup = async (p) => {
      realpathCalls += 1;
      return p;
    };
    const accessImpl: AccessCheck = async () => {
      accessCalls += 1;
    };

    const resolved = await resolveHermes(
      { pythonPath: '/opt/custom/bin/python' },
      exec,
      realpathImpl,
      accessImpl,
    );

    expect(resolved.python).toBe('/opt/custom/bin/python');
    expect(realpathCalls).toBe(0);
    expect(accessCalls).toBe(0);
  });
});

describe('package.json — R-A5: talaria.hermesPath is contributed machine-scoped and trust-restricted', () => {
  type ManifestProperty = { type: string; scope?: string; default?: unknown };
  type ManifestCategory = { properties?: Record<string, ManifestProperty> };
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
  ) as {
    contributes: { configuration: ManifestCategory | ManifestCategory[] };
    capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
  };
  // `contributes.configuration` is an array of titled categories
  // (configurationSections.test.ts locks the shape) — flatten to the union.
  const configSections = Array.isArray(manifest.contributes.configuration)
    ? manifest.contributes.configuration
    : [manifest.contributes.configuration];
  const configProperties: Record<string, ManifestProperty> = {};
  for (const section of configSections) {
    Object.assign(configProperties, section.properties ?? {});
  }

  it('contributes talaria.hermesPath (string, machine scope, empty default)', () => {
    const prop = must(configProperties['talaria.hermesPath']);
    expect(prop.type).toBe('string');
    expect(prop.scope).toBe('machine');
    expect(prop.default).toBe('');
  });

  it('lists talaria.hermesPath in untrustedWorkspaces.restrictedConfigurations', () => {
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(
      'talaria.hermesPath',
    );
  });
});

// --- TC-5 (AU-28): AbortSignal never wired into the ExecLookup execFile calls ---

describe('defaultExecLookup — TC-5 (AU-28): AbortSignal actually kills the in-flight execFile child', () => {
  // Global Constraint 4 (no mock-theater): the `ExecLookup` seam carries no
  // error shape of its own, so this is pinned against a REAL `execFile`
  // abort — the actual Node behavior (Node child_process docs: the `signal`
  // option lets an AbortController kill the child, rejecting with an
  // AbortError), not a hand-rolled fixture. Cloned discipline from
  // `pipxLocator.test.ts`'s real-timeout `isExecTimeout` test.
  it('aborting mid-probe rejects promptly instead of letting the child run to completion (fails at HEAD: resolves after the full sleep)', async () => {
    const abort = new AbortController();
    const promise = defaultExecLookup('node', ['-e', 'setTimeout(() => {}, 2000)'], {
      timeoutMs: 10_000,
      cwd: os.homedir(),
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);

    await expect(promise).rejects.toThrow();
  }, 3_000);
});
