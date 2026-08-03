import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveHermes,
  resolveHermesBin,
  resetHermesBinCache,
  type ExecLookup,
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
    const resolved = await resolveHermes({ cwd: '/ws', shell: '/bin/bash' }, exec);
    expect(resolved.hermesBin).toBe('/home/u/.venvs/hermes/bin/hermes');
    expect(resolved.python).toBe('/home/u/.venvs/hermes/bin/python');
    expect(resolved.acp.command).toBe('/bin/bash');
    expect(resolved.acp.args[2]).toContain('exec /home/u/.venvs/hermes/bin/hermes acp');
  });

  it('the long-lived children (hermes acp, python -m tui_gateway) still spawn via `exec` — signal propagation must not regress', async () => {
    const { exec } = fakeExec('/home/u/.venvs/hermes/bin/hermes\n');
    const resolved = await resolveHermes({ cwd: '/ws', shell: '/bin/bash' }, exec);
    // `exec` replaces the login shell so SIGTERM/SIGKILL from disposal reaches
    // the real child. Only the one-shot `command -v hermes` lookup should skip it.
    expect(resolved.acp.args[2]).toBe('exec /home/u/.venvs/hermes/bin/hermes acp');
    expect(resolved.control.args[2]).toBe(
      'exec /home/u/.venvs/hermes/bin/python -m tui_gateway.entry',
    );
  });

  it('AUDIT-5 SEC M-3: with no workspace open (cwd undefined), resolveHermes falls back to os.homedir() — never process.cwd() (the EH install dir)', async () => {
    const { exec } = fakeExec('/home/u/.venvs/hermes/bin/hermes\n');
    const resolved = await resolveHermes({ cwd: undefined, shell: '/bin/bash' }, exec);
    expect(resolved.cwd).toBe(os.homedir());
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
