import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { installHermes, type SpawnFn, type FileExists, type InstallEvent, type HermesPaths } from './pipxInstaller';
import type { InstallRecipe } from './registry';
import type { PipxEnv } from './pipxLocator';

/**
 * pipxInstaller.test.ts — Task 5 (onboarding-backend-setup-architecture.md
 * §2.2 steps 2–4, §7). Every OS-touching call `installHermes` makes routes
 * through the caller-injected `SpawnFn`/`FileExists` seams, so this suite
 * never touches a real shell or disk — same discipline `pipxLocator.test.ts`
 * established one module over. Deliberately decoupled from the real
 * `registry.ts`/`pipxLocator.ts` VALUES (only their TYPES are imported):
 * `RECIPE`/`ENV` below mirror the real hermes registry entry's shape without
 * importing it, keeping this suite self-contained per the test-antipatterns
 * discipline (registry drift is already locked by `registry.test.ts`).
 */

const RECIPE: Extract<InstallRecipe, { kind: 'pipx' }> = {
  kind: 'pipx',
  packageSpec: 'hermes-agent[acp]==0.18.2',
  pinnedVersion: '0.18.2',
  pythonRange: { minInclusive: '3.11', maxExclusive: '3.14' },
  apps: { main: 'hermes', acpCheck: 'hermes-acp' },
  postCheck: { app: 'hermes-acp', args: ['--check'], expectStdoutIncludes: 'Hermes ACP check OK' },
};

const ENV: PipxEnv = {
  pipxPath: '/usr/bin/pipx',
  venvsRoot: '/home/u/.local/share/pipx/venvs',
  defaultPythonVersion: '3.13.1',
};

const EXPECTED_PATHS: HermesPaths = {
  venvRoot: '/home/u/.local/share/pipx/venvs/hermes-agent',
  hermes: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes',
  hermesAcp: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes-acp',
  python: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/python',
};

// --- scripted seams ----------------------------------------------------

function linesOf(...lines: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const line of lines) yield line;
  })();
}

interface ScriptedSpawnCall {
  cmd: string;
  args: string[];
  opts: { cwd: string; signal: AbortSignal };
}

interface SpawnRule {
  match: (cmd: string, args: string[]) => boolean;
  stdout?: string[];
  stderr?: string[];
  exitCode: number;
}

/** First matching rule wins; an unmatched call throws loudly (a silent
 *  wrong-branch call would otherwise pass silently) — same convention
 *  `pipxLocator.test.ts`'s `scriptedExec` established. */
function scriptedSpawn(rules: SpawnRule[]): { spawn: SpawnFn; calls: ScriptedSpawnCall[] } {
  const calls: ScriptedSpawnCall[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const rule = rules.find((r) => r.match(cmd, args));
    if (!rule) throw new Error(`unscripted spawn call: ${cmd} ${args.join(' ')}`);
    return {
      stdout: linesOf(...(rule.stdout ?? [])),
      stderr: linesOf(...(rule.stderr ?? [])),
      exitCode: Promise.resolve(rule.exitCode),
    };
  };
  return { spawn, calls };
}

function scriptedFileExists(existingPaths: ReadonlySet<string>): { fileExists: FileExists; calls: string[] } {
  const calls: string[] = [];
  const fileExists: FileExists = async (path) => {
    calls.push(path);
    return existingPaths.has(path);
  };
  return { fileExists, calls };
}

const installRule = (opts: { stdout?: string[]; stderr?: string[]; exitCode: number }): SpawnRule => ({
  match: (cmd, args) => cmd === 'pipx' && args[0] === 'install',
  ...opts,
});

const verifyRule = (opts: { stdout?: string[]; stderr?: string[]; exitCode: number }): SpawnRule => ({
  match: (cmd, args) => cmd === EXPECTED_PATHS.hermesAcp && args[0] === '--check',
  ...opts,
});

const allPathsExist = (): { fileExists: FileExists; calls: string[] } =>
  scriptedFileExists(new Set([EXPECTED_PATHS.hermes, EXPECTED_PATHS.hermesAcp, EXPECTED_PATHS.python]));

describe('installHermes — Task 5: pipx install pipeline (§2.2 steps 2–4)', () => {
  it('happy path: emits phases in order + done, and returns the derived paths', async () => {
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ stdout: ['installed package hermes-agent 0.18.2, installed using Python 3.13.1'], exitCode: 0 }),
      verifyRule({ stdout: ['Hermes ACP check OK'], exitCode: 0 }),
    ]);
    const { fileExists, calls: fileExistsCalls } = allPathsExist();
    const events: InstallEvent[] = [];
    const controller = new AbortController();

    const result = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), controller.signal);

    expect(result).toEqual(EXPECTED_PATHS);
    expect(events).toEqual([
      { kind: 'phase', phase: 'pipx-install' },
      { kind: 'log', line: 'installed package hermes-agent 0.18.2, installed using Python 3.13.1' },
      { kind: 'phase', phase: 'resolve-paths' },
      { kind: 'phase', phase: 'verify' },
      { kind: 'log', line: 'Hermes ACP check OK' },
      { kind: 'done', paths: EXPECTED_PATHS },
    ]);

    // spawn hygiene: absolute-ish command + args array, cwd = os.homedir(), same signal threaded through.
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toMatchObject({ cmd: 'pipx', args: ['install', RECIPE.packageSpec] });
    expect(spawnCalls[0]?.opts.cwd).toBe(os.homedir());
    expect(spawnCalls[0]?.opts.signal).toBe(controller.signal);
    expect(spawnCalls[1]).toMatchObject({ cmd: EXPECTED_PATHS.hermesAcp, args: ['--check'] });
    expect(spawnCalls[1]?.opts.cwd).toBe(os.homedir());

    // resolve-paths existence-checks all three, in derivation order.
    expect(fileExistsCalls).toEqual([EXPECTED_PATHS.hermes, EXPECTED_PATHS.hermesAcp, EXPECTED_PATHS.python]);
  });

  it('passes --python <override> to pipx install when env.pythonOverride is set', async () => {
    const envWithOverride: PipxEnv = { ...ENV, pythonOverride: 'python3.12' };
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      verifyRule({ stdout: ['Hermes ACP check OK'], exitCode: 0 }),
    ]);
    const { fileExists } = allPathsExist();

    await installHermes(RECIPE, envWithOverride, spawn, fileExists, () => {}, new AbortController().signal);

    expect(spawnCalls[0]?.args).toEqual(['install', RECIPE.packageSpec, '--python', 'python3.12']);
  });

  it('omits --python when env.pythonOverride is absent', async () => {
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      verifyRule({ stdout: ['Hermes ACP check OK'], exitCode: 0 }),
    ]);
    const { fileExists } = allPathsExist();

    await installHermes(RECIPE, ENV, spawn, fileExists, () => {}, new AbortController().signal);

    expect(spawnCalls[0]?.args).toEqual(['install', RECIPE.packageSpec]);
  });

  it('pipx install exit 1 → failed@pipx-install with stderr as detail; pipeline stops', async () => {
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ stderr: ['ERROR: could not find a version that satisfies hermes-agent[acp]==0.18.2'], exitCode: 1 }),
    ]);
    const { fileExists, calls: fileExistsCalls } = allPathsExist();
    const events: InstallEvent[] = [];

    const err = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('pipx-install');
    expect(events).toEqual([
      { kind: 'phase', phase: 'pipx-install' },
      { kind: 'log', line: 'ERROR: could not find a version that satisfies hermes-agent[acp]==0.18.2' },
      {
        kind: 'failed',
        phase: 'pipx-install',
        detail: 'ERROR: could not find a version that satisfies hermes-agent[acp]==0.18.2',
      },
    ]);
    // resolve-paths / verify never started.
    expect(fileExistsCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });

  it('stderr tail is capped at the last 40 lines when the failing spawn produced more', async () => {
    const stderrLines = Array.from({ length: 45 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`);
    const { spawn } = scriptedSpawn([installRule({ stderr: stderrLines, exitCode: 1 })]);
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal).catch(() => {});

    const failedEvent = events.find((e) => e.kind === 'failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.kind).toBe('failed');
    const detail = failedEvent && failedEvent.kind === 'failed' ? failedEvent.detail : '';
    expect(detail).toBe(stderrLines.slice(-40).join('\n'));
    expect(detail.split('\n')).toHaveLength(40);
    expect(detail).not.toContain('line-01');
    expect(detail).not.toContain('line-05');
    expect(detail).toContain('line-45');
  });

  it('resolve-paths: missing bin/hermes-acp → failed@resolve-paths; verify never runs', async () => {
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      verifyRule({ stdout: ['Hermes ACP check OK'], exitCode: 0 }),
    ]);
    // hermes and python exist; hermes-acp is missing (pipx state inconsistent — §7 FM-5).
    const { fileExists } = scriptedFileExists(new Set([EXPECTED_PATHS.hermes, EXPECTED_PATHS.python]));
    const events: InstallEvent[] = [];

    const err = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('resolve-paths');
    expect(events).toEqual([
      { kind: 'phase', phase: 'pipx-install' },
      { kind: 'phase', phase: 'resolve-paths' },
      { kind: 'failed', phase: 'resolve-paths', detail: expect.stringContaining(EXPECTED_PATHS.hermesAcp) },
    ]);
    // verify's spawn (hermesAcp --check) must never have been invoked.
    expect(spawnCalls).toHaveLength(1);
  });

  it('verify: exit 0 but stdout lacks the marker → failed@verify (marker is load-bearing)', async () => {
    const { spawn } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      verifyRule({ stdout: ['some unrelated output'], exitCode: 0 }),
    ]);
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    const err = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('verify');
    const failedEvent = events.find((e) => e.kind === 'failed');
    expect(failedEvent).toEqual({
      kind: 'failed',
      phase: 'verify',
      detail: 'Expected stdout to include "Hermes ACP check OK" (exit 0).',
    });
    expect(events.some((e) => e.kind === 'done')).toBe(false);
  });

  it('verify: non-zero exit with stderr → failed@verify uses the stderr tail as detail', async () => {
    const { spawn } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      verifyRule({ stderr: ['Traceback: ImportError: acp'], exitCode: 1 }),
    ]);
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal).catch(() => {});

    const failedEvent = events.find((e) => e.kind === 'failed');
    expect(failedEvent).toEqual({ kind: 'failed', phase: 'verify', detail: 'Traceback: ImportError: acp' });
  });

  it('an already-aborted signal rejects immediately with zero events and zero I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: InstallEvent[] = [];
    const spawn: SpawnFn = () => {
      throw new Error('spawn must not be called once already aborted');
    };
    const fileExists: FileExists = async () => {
      throw new Error('fileExists must not be called once already aborted');
    };

    const err = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), controller.signal).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(events).toEqual([]);
  });

  it('aborting mid pipx-install stream rejects and emits no events after the abort point', async () => {
    const controller = new AbortController();
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ stdout: ['installed package hermes-agent 0.18.2', 'should never be observed'], exitCode: 0 }),
    ]);
    const { fileExists, calls: fileExistsCalls } = allPathsExist();
    const events: InstallEvent[] = [];
    const onEvent = (e: InstallEvent): void => {
      events.push(e);
      if (e.kind === 'log') controller.abort();
    };

    const err = await installHermes(RECIPE, ENV, spawn, fileExists, onEvent, controller.signal).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(events).toEqual([
      { kind: 'phase', phase: 'pipx-install' },
      { kind: 'log', line: 'installed package hermes-agent 0.18.2' },
    ]);
    // resolve-paths never started; the install spawn was the only one issued.
    expect(fileExistsCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });
});
