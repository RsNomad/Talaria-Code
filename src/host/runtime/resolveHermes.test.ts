import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
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

  it('a failed exec surfaces an actionable error naming hermes.hermesPath — and is NOT cached', async () => {
    let attempts = 0;
    const failing: ExecLookup = async () => {
      attempts += 1;
      throw new Error('ETIMEDOUT');
    };
    await expect(resolveHermesBin({}, failing)).rejects.toThrow(/hermes\.hermesPath/);
    await expect(resolveHermesBin({}, failing)).rejects.toThrow();
    expect(attempts).toBe(2); // failure retried, never cached
  });

  it('empty or non-absolute output is rejected with the actionable error', async () => {
    const { exec } = fakeExec('\n');
    await expect(resolveHermesBin({}, exec)).rejects.toThrow(/hermes\.hermesPath/);
    resetHermesBinCache();
    const relative = fakeExec('hermes: aliased to hx\n');
    await expect(resolveHermesBin({}, relative.exec)).rejects.toThrow(/hermes\.hermesPath/);
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
});

describe('package.json — R-A5: hermes.hermesPath is contributed machine-scoped and trust-restricted', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
  ) as {
    contributes: {
      configuration: {
        properties: Record<string, { type: string; scope?: string; default?: unknown }>;
      };
    };
    capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
  };

  it('contributes hermes.hermesPath (string, machine scope, empty default)', () => {
    const prop = must(manifest.contributes.configuration.properties['hermes.hermesPath']);
    expect(prop.type).toBe('string');
    expect(prop.scope).toBe('machine');
    expect(prop.default).toBe('');
  });

  it('lists hermes.hermesPath in untrustedWorkspaces.restrictedConfigurations', () => {
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(
      'hermes.hermesPath',
    );
  });
});
