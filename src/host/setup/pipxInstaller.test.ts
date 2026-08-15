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
  match: (cmd, args) => cmd === ENV.pipxPath && args[0] === 'install',
  ...opts,
});

const verifyRule = (opts: { stdout?: string[]; stderr?: string[]; exitCode: number }): SpawnRule => ({
  match: (cmd, args) => cmd === EXPECTED_PATHS.hermesAcp && args[0] === '--check',
  ...opts,
});

const allPathsExist = (): { fileExists: FileExists; calls: string[] } =>
  scriptedFileExists(new Set([EXPECTED_PATHS.hermes, EXPECTED_PATHS.hermesAcp, EXPECTED_PATHS.python]));

/** V10 settled `pipx list --json` shape:
 *  `{pipx_spec_version, venvs:{<name>:{metadata:{main_package:{package_version}}}}}`.
 *  The venv name is `hermes-agent` (matches `EXPECTED_PATHS.venvRoot`'s basename). */
const listJson = (version: string | undefined): string =>
  JSON.stringify({
    pipx_spec_version: '0.1',
    venvs: version === undefined ? {} : { 'hermes-agent': { metadata: { main_package: { package_version: version } } } },
  });

/** Every `installHermes` success path (fresh install OR a no-op skip) now
 *  reads back `pipx list --json` (TC-2/AU-50, INV-10) — this rule reports the
 *  pin so pre-existing exit-0 happy-path fixtures don't need to know about
 *  the mismatch/`--force` branch at all. */
const listRule = (version: string | undefined = RECIPE.pinnedVersion): SpawnRule => ({
  match: (cmd, args) => cmd === ENV.pipxPath && args[0] === 'list' && args[1] === '--json',
  stdout: [listJson(version)],
  exitCode: 0,
});

describe('installHermes — Task 5: pipx install pipeline (§2.2 steps 2–4)', () => {
  it('happy path: emits phases in order + done, and returns the derived paths', async () => {
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ stdout: ['installed package hermes-agent 0.18.2, installed using Python 3.13.1'], exitCode: 0 }),
      listRule(),
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

    // spawn hygiene: absolute command + args array, cwd = os.homedir(), same signal threaded through.
    // TC-2/AU-50: a `pipx list --json` read-back now runs between install and
    // resolve-paths on every successful install — 3 calls, not 2.
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[0]).toMatchObject({ cmd: ENV.pipxPath, args: ['install', RECIPE.packageSpec] });
    expect(spawnCalls[0]?.opts.cwd).toBe(os.homedir());
    expect(spawnCalls[0]?.opts.signal).toBe(controller.signal);
    expect(spawnCalls[1]).toMatchObject({ cmd: ENV.pipxPath, args: ['list', '--json'] });
    expect(spawnCalls[2]).toMatchObject({ cmd: EXPECTED_PATHS.hermesAcp, args: ['--check'] });
    expect(spawnCalls[2]?.opts.cwd).toBe(os.homedir());

    // resolve-paths existence-checks all three, in derivation order.
    expect(fileExistsCalls).toEqual([EXPECTED_PATHS.hermes, EXPECTED_PATHS.hermesAcp, EXPECTED_PATHS.python]);
  });

  it('passes --python <override> to pipx install when env.pythonOverride is set', async () => {
    const envWithOverride: PipxEnv = { ...ENV, pythonOverride: 'python3.12' };
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      listRule(),
      verifyRule({ stdout: ['Hermes ACP check OK'], exitCode: 0 }),
    ]);
    const { fileExists } = allPathsExist();

    await installHermes(RECIPE, envWithOverride, spawn, fileExists, () => {}, new AbortController().signal);

    expect(spawnCalls[0]?.args).toEqual(['install', RECIPE.packageSpec, '--python', 'python3.12']);
  });

  it('omits --python when env.pythonOverride is absent', async () => {
    const { spawn, calls: spawnCalls } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      listRule(),
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
      listRule(),
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
    // verify's spawn (hermesAcp --check) must never have been invoked — but
    // the version read-back (TC-2) DID run (install + list), so 2 not 1.
    expect(spawnCalls).toHaveLength(2);
  });

  it('verify: exit 0 but stdout lacks the marker → failed@verify (marker is load-bearing)', async () => {
    const { spawn } = scriptedSpawn([
      installRule({ exitCode: 0 }),
      listRule(),
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
      listRule(),
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

/**
 * TC-2 · AU-50 (Med) — pinned-version read-back verify (INV-10).
 *
 * `pipx install pkg==PIN` silently exits 0 as a no-op when ANY version of the
 * package is already installed ("'X' already seems to be installed. Not
 * modifying existing installation") — a pinned UPGRADE never applies, but the
 * pre-fix pipeline treated exit 0 as success unconditionally. These tests use
 * a hand-rolled `SpawnFn` (rather than `scriptedSpawn`'s static first-match
 * rules) because `pipx list --json` is called TWICE with DIFFERENT scripted
 * responses across a single `installHermes` run (before vs. after the
 * `--force` reinstall) — `scriptedSpawn`'s rule list has no notion of call
 * order, only "first rule that matches wins".
 */
describe('installHermes — TC-2/AU-50: pinned-version read-back verify (INV-10)', () => {
  const ALREADY_INSTALLED_STDOUT = "'hermes-agent' already seems to be installed. Not modifying existing installation.";

  function makeSpawn(script: {
    install: { stdout?: string[]; stderr?: string[]; exitCode: number };
    /** Successive `pipx list --json` responses, consumed in call order; the
     *  last entry repeats for any call beyond the scripted count. */
    listVersions: (string | undefined)[];
    force?: { stdout?: string[]; stderr?: string[]; exitCode: number };
    verify?: { stdout?: string[]; stderr?: string[]; exitCode: number };
  }): { spawn: SpawnFn; calls: ScriptedSpawnCall[] } {
    const calls: ScriptedSpawnCall[] = [];
    let listCallIndex = 0;
    const spawn: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === ENV.pipxPath && args[0] === 'install' && !args.includes('--force')) {
        return {
          stdout: linesOf(...(script.install.stdout ?? [])),
          stderr: linesOf(...(script.install.stderr ?? [])),
          exitCode: Promise.resolve(script.install.exitCode),
        };
      }
      if (cmd === ENV.pipxPath && args[0] === 'install' && args.includes('--force')) {
        const f = script.force ?? { exitCode: 0 };
        return {
          stdout: linesOf(...(f.stdout ?? [])),
          stderr: linesOf(...(f.stderr ?? [])),
          exitCode: Promise.resolve(f.exitCode),
        };
      }
      if (cmd === ENV.pipxPath && args[0] === 'list' && args[1] === '--json') {
        const version = script.listVersions[Math.min(listCallIndex, script.listVersions.length - 1)];
        listCallIndex++;
        return { stdout: linesOf(listJson(version)), stderr: linesOf(), exitCode: Promise.resolve(0) };
      }
      if (cmd === EXPECTED_PATHS.hermesAcp && args[0] === '--check') {
        const v = script.verify ?? { stdout: ['Hermes ACP check OK'], exitCode: 0 };
        return {
          stdout: linesOf(...(v.stdout ?? [])),
          stderr: linesOf(...(v.stderr ?? [])),
          exitCode: Promise.resolve(v.exitCode),
        };
      }
      throw new Error(`unscripted spawn call: ${cmd} ${args.join(' ')}`);
    };
    return { spawn, calls };
  }

  it('(a) exit-0 no-op with a DIFFERENT version installed → detects the mismatch via list --json and re-installs with --force, ending with the pin actually installed', async () => {
    const { spawn, calls: spawnCalls } = makeSpawn({
      install: { stdout: [ALREADY_INSTALLED_STDOUT], exitCode: 0 },
      listVersions: ['0.17.9', '0.18.2'],
      force: { stdout: ['installed package hermes-agent 0.18.2, installed using Python 3.13.1'], exitCode: 0 },
    });
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    const result = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal);

    expect(result).toEqual(EXPECTED_PATHS);
    // Honest log line naming old→new (design: "existing hermes-agent <v>
    // found; reinstalling pinned <pin>") — not a second consent modal.
    expect(events).toContainEqual({
      kind: 'log',
      line: 'existing hermes-agent 0.17.9 found; reinstalling pinned 0.18.2',
    });
    const installCalls = spawnCalls.filter((c) => c.args[0] === 'install');
    expect(installCalls).toHaveLength(2);
    expect(installCalls[1]?.args).toEqual(['install', '--force', RECIPE.packageSpec]);
    const listCalls = spawnCalls.filter((c) => c.args[0] === 'list');
    expect(listCalls).toHaveLength(2);
    expect(events.some((e) => e.kind === 'done')).toBe(true);
  });

  it('(b) INV-10: still mismatched after the --force retry → rejects honestly; pinnedVersion is never resolved as success', async () => {
    const { spawn, calls: spawnCalls } = makeSpawn({
      install: { stdout: [ALREADY_INSTALLED_STDOUT], exitCode: 0 },
      // Force reinstall doesn't fix it (simulates e.g. a broken index/pin) —
      // list --json reports the same stale version both times.
      listVersions: ['0.17.9', '0.17.9'],
    });
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    const err = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('pipx-install');
    expect((err as Error).message).toContain('0.17.9');
    expect((err as Error).message).toContain('0.18.2');
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    const failedEvent = events.find((e) => e.kind === 'failed');
    expect(failedEvent).toMatchObject({ kind: 'failed', phase: 'pipx-install' });
    // Exactly ONE --force retry — not an infinite/repeated reinstall loop.
    expect(spawnCalls.filter((c) => c.args.includes('--force'))).toHaveLength(1);
    // verify (`hermes-acp --check`) must never run — the pipeline stops honestly.
    expect(spawnCalls.some((c) => c.cmd === EXPECTED_PATHS.hermesAcp)).toBe(false);
  });

  it('(c) Rev-1/A7: nonzero exit WITH the "already seems to be installed" marker still runs the read-back verify (and resolves when it already matches the pin)', async () => {
    const { spawn, calls: spawnCalls } = makeSpawn({
      // Exit code flipped to 1 for the skip on this simulated pipx version
      // (V10: the skip exit code has historically been 0→1→0) — the marker
      // text, not the exit code, gates whether verify runs.
      install: { stderr: [ALREADY_INSTALLED_STDOUT], exitCode: 1 },
      listVersions: ['0.18.2'], // already the pin — no --force needed.
    });
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    const result = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal);

    expect(result).toEqual(EXPECTED_PATHS);
    expect(spawnCalls.some((c) => c.args.includes('--force'))).toBe(false);
    expect(events.some((e) => e.kind === 'failed')).toBe(false);
  });

  it('nonzero exit WITHOUT the marker is unaffected (existing failure path, unchanged) — no list --json call', async () => {
    const { spawn, calls: spawnCalls } = makeSpawn({
      install: { stderr: ['ERROR: could not find a version that satisfies hermes-agent[acp]==0.18.2'], exitCode: 1 },
      listVersions: [], // must never be consulted.
    });
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    const err = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('pipx-install');
    expect(spawnCalls.some((c) => c.args[0] === 'list')).toBe(false);
    expect(spawnCalls).toHaveLength(1);
  });

  it('defends against an unexpected/garbled pipx list --json shape (V10: treat as unverifiable, never crash)', async () => {
    const calls: ScriptedSpawnCall[] = [];
    let listCallIndex = 0;
    const garbledThenPin = ['not json at all', listJson(RECIPE.pinnedVersion)];
    const spawn: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === ENV.pipxPath && args[0] === 'install' && !args.includes('--force')) {
        return { stdout: linesOf(ALREADY_INSTALLED_STDOUT), stderr: linesOf(), exitCode: Promise.resolve(0) };
      }
      if (cmd === ENV.pipxPath && args[0] === 'install' && args.includes('--force')) {
        return { stdout: linesOf('installed package hermes-agent 0.18.2'), stderr: linesOf(), exitCode: Promise.resolve(0) };
      }
      if (cmd === ENV.pipxPath && args[0] === 'list' && args[1] === '--json') {
        const body = garbledThenPin[Math.min(listCallIndex, garbledThenPin.length - 1)] ?? '';
        listCallIndex++;
        return { stdout: linesOf(body), stderr: linesOf(), exitCode: Promise.resolve(0) };
      }
      if (cmd === EXPECTED_PATHS.hermesAcp && args[0] === '--check') {
        return { stdout: linesOf('Hermes ACP check OK'), stderr: linesOf(), exitCode: Promise.resolve(0) };
      }
      throw new Error(`unscripted spawn call: ${cmd} ${args.join(' ')}`);
    };
    const { fileExists } = allPathsExist();
    const events: InstallEvent[] = [];

    const result = await installHermes(RECIPE, ENV, spawn, fileExists, (e) => events.push(e), new AbortController().signal);

    // Garbled JSON on the first read is treated as unverifiable (≠ pin) —
    // triggers the SAME --force + re-verify path as a real mismatch, not a
    // thrown TypeError/SyntaxError.
    expect(result).toEqual(EXPECTED_PATHS);
    expect(calls.filter((c) => c.args.includes('--force'))).toHaveLength(1);
  });
});
