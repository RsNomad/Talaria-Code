import * as os from 'node:os';
import * as path from 'node:path';
import type { InstallRecipe } from './registry';
import type { PipxEnv } from './pipxLocator';

/**
 * pipx install pipeline for hermes-agent[acp] (onboarding-backend-setup-
 * architecture.md §2.2 steps 2–4, §7; Task 5 of the onboarding/backend-setup
 * plan).
 *
 * PURE PIPELINE — no `vscode` import, no direct `fs`/`child_process` access.
 * Every OS-touching operation (spawning `pipx install` and `<hermesAcp>
 * --check`, checking file existence) is routed through the caller-injected
 * `SpawnFn`/`FileExists` seams, so unit tests never touch a real shell or
 * disk — matching `pipxLocator.ts`'s own discipline one module over. This
 * module writes NOTHING to VS Code settings: Task 9's SetupController owns
 * that, consuming this module's resolved `HermesPaths` only after a
 * successful `installHermes()` resolution. Single-flight guarding (refusing
 * a second concurrent `setup.install`) is also the controller's job (§7) —
 * this module is a single run of the pipeline, cancellable via the caller's
 * `AbortSignal`.
 *
 * Pipeline (§2.2 steps 2–4):
 *   1. `pipx install "<packageSpec>" [--python <override>]` — stdout/stderr
 *      streamed to `onEvent({kind:'log', line})` as they arrive; non-zero
 *      exit WITHOUT the "already seems to be installed" marker ⇒
 *      `failed@pipx-install` with a ≤40-line stderr tail (§7 FM-3).
 *   1a. TC-2/AU-50 (INV-10): modern pipx silently exits 0 as a no-op when ANY
 *      version of the package is already installed — a pinned UPGRADE would
 *      never apply. So on BOTH the exit-0 path AND the nonzero-exit path that
 *      carries the "already seems to be installed" marker (Rev-1 A7: the
 *      skip's exit code has historically flipped 0→1→0 across pipx versions,
 *      V10 — the marker only gates whether this step runs, never the
 *      decision itself), read back the actually-installed version via
 *      `pipx list --json` through the SAME spawn seam. A match proceeds
 *      (covers the fresh-install case for free). A mismatch logs an honest
 *      "existing hermes-agent <v> found; reinstalling pinned <pin>" line,
 *      runs ONE `pipx install --force <spec>` (same seam/streaming), and
 *      re-verifies; still mismatched ⇒ `failed@pipx-install` — the caller
 *      (`SetupController`) only ever records `pinnedVersion` after this
 *      resolves, so this is the whole of INV-10's enforcement.
 *   2. Derive `<venvsRoot>/hermes-agent/bin/{hermes,hermes-acp,python}` and
 *      existence-check each via `fileExists` (no JSON parsing — §2.2 step 3
 *      v2 correction). The `hermes`/`hermes-acp` console-script basenames
 *      come from `recipe.apps.main`/`recipe.apps.acpCheck` (falling back to
 *      `recipe.postCheck.app`, which names the same script) rather than
 *      being hardcoded here — for the shipped Hermes recipe these resolve
 *      to the identical `bin/hermes` / `bin/hermes-acp` paths §2.2 spells
 *      out, but the derivation stays recipe-driven, the same "never
 *      hardcode what the registry already states" discipline the postCheck
 *      marker below follows. `python` has no analogous recipe field (pipx
 *      venvs always name it `python`), so that basename IS a constant.
 *      `env.venvsRoot` MAY be an empty string (Task 4's `pipxLocator` can
 *      return one on an unmodeled failure) — that is not special-cased
 *      here; an empty root simply fails every `fileExists` check like any
 *      other missing path (§7 FM-5).
 *   3. `<hermesAcp> --check` (`recipe.postCheck.args`) — require exit 0 AND
 *      stdout containing `recipe.postCheck.expectStdoutIncludes` (the
 *      marker is load-bearing and comes from the registry, never hardcoded
 *      here — §7 FM-6).
 *   4. `onEvent({kind:'done', paths})` and return `paths`. On ANY failure
 *      above, the returned promise REJECTS after emitting the `'failed'`
 *      event — the event stream is the primary UI signal; the rejection is
 *      a control-flow convenience for callers awaiting the pipeline.
 *
 * Spawn hygiene (§7/§8, AUDIT-5 SEC M-2 precedent): absolute-path commands +
 * args arrays, no shell, `cwd: os.homedir()` for both spawns — matching
 * `pipxLocator.ts`'s own `cwd` choice for the same reason (installing/
 * verifying hermes-agent has nothing to do with any particular workspace,
 * and a workspace folder is not guaranteed to exist or be writable).
 *
 * Cancellation: every phase boundary — and every line received from either
 * stream — checks `signal.aborted` BEFORE emitting anything for it. An
 * abort therefore never produces a trailing event: the caller sees exactly
 * the events already-committed at the moment of cancellation, and the
 * returned promise rejects with the same `DOMException('…','AbortError')`
 * shape this codebase already uses elsewhere (`rag/embedder.ts`,
 * `autocomplete/nextedit/*.test.ts`).
 */

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal },
) => { stdout: AsyncIterable<string>; stderr: AsyncIterable<string>; exitCode: Promise<number> };

export type FileExists = (path: string) => Promise<boolean>;

export type InstallPhase = 'pipx-install' | 'resolve-paths' | 'verify';

export type InstallEvent =
  | { kind: 'phase'; phase: InstallPhase }
  | { kind: 'log'; line: string }
  | { kind: 'done'; paths: HermesPaths }
  | { kind: 'failed'; phase: InstallPhase; detail: string }; // stderr tail ≤ 40 lines

export interface HermesPaths {
  venvRoot: string;
  hermes: string;
  hermesAcp: string;
  python: string;
}

/** §7: "stderr tail ≤ 40 lines" — applies to any failed-phase detail built
 *  from a spawned process's collected output. */
const TAIL_MAX_LINES = 40;

/** TC-2/AU-50 + INV-10 (V10): pipx's verbatim skip message is "'X' already
 *  seems to be installed. Not modifying existing installation …" — matched
 *  as a plain substring against every collected stdout AND stderr line
 *  (case-sensitive; the exit code carrying it has flipped across pipx
 *  versions, so the marker — not the exit code — decides whether the
 *  version read-back below runs on a nonzero exit). */
const ALREADY_INSTALLED_MARKER = 'already seems to be installed';

export async function installHermes(
  recipe: Extract<InstallRecipe, { kind: 'pipx' }>,
  env: PipxEnv,
  spawn: SpawnFn,
  fileExists: FileExists,
  onEvent: (e: InstallEvent) => void,
  signal: AbortSignal,
): Promise<HermesPaths> {
  throwIfAborted(signal);
  const cwd = os.homedir();
  const paths = derivePaths(recipe, env);

  // --- Step 2 (§2.2): pipx install -----------------------------------------
  onEvent({ kind: 'phase', phase: 'pipx-install' });
  const installArgs = [
    'install',
    recipe.packageSpec,
    ...(env.pythonOverride ? ['--python', env.pythonOverride] : []),
  ];
  const installRun = await runAndStream(spawn(env.pipxPath, installArgs, { cwd, signal }), onEvent, signal);
  const alreadyInstalled = hasAlreadyInstalledMarker(installRun.stdoutLines, installRun.stderrLines);
  if (installRun.exitCode !== 0 && !alreadyInstalled) {
    // TC-4/AU-29 belt: `SpawnFn` normally guarantees a non-empty stderr tail
    // for any nonzero exit (a spawn-level 'error' now synthesizes one — see
    // `createNodeSpawnFn`), but this module never assumes its own seam —
    // an empty tail still falls back to the exit code so no future
    // zero-output failure ever renders the blank
    // `hermes install failed at phase "pipx-install": ` AU-29 reported.
    const stderrTail = tail(installRun.stderrLines);
    const detail = stderrTail.length > 0 ? stderrTail : `exit code ${installRun.exitCode}`;
    onEvent({ kind: 'failed', phase: 'pipx-install', detail });
    throw new InstallFailedError('pipx-install', detail);
  }

  // --- Step 1a (TC-2/AU-50, INV-10, Rev-1 A7): pinned-version read-back ----
  await verifyPinnedVersion(recipe, env, paths, spawn, cwd, onEvent, signal);

  // --- Step 3 (§2.2 v2): resolve + existence-check paths -------------------
  throwIfAborted(signal);
  onEvent({ kind: 'phase', phase: 'resolve-paths' });
  for (const candidate of [paths.hermes, paths.hermesAcp, paths.python]) {
    throwIfAborted(signal);
    if (!(await fileExists(candidate))) {
      const detail = `Expected pipx-installed file not found: ${candidate}`;
      onEvent({ kind: 'failed', phase: 'resolve-paths', detail });
      throw new InstallFailedError('resolve-paths', detail);
    }
  }

  // --- Step 4 (§2.2): verify -------------------------------------------------
  throwIfAborted(signal);
  onEvent({ kind: 'phase', phase: 'verify' });
  const verifyRun = await runAndStream(
    spawn(paths.hermesAcp, recipe.postCheck.args, { cwd, signal }),
    onEvent,
    signal,
  );
  const marker = recipe.postCheck.expectStdoutIncludes;
  const stdoutText = verifyRun.stdoutLines.join('\n');
  if (verifyRun.exitCode !== 0 || !stdoutText.includes(marker)) {
    const detail =
      verifyRun.stderrLines.length > 0
        ? tail(verifyRun.stderrLines)
        : `Expected stdout to include "${marker}" (exit ${verifyRun.exitCode}).`;
    onEvent({ kind: 'failed', phase: 'verify', detail });
    throw new InstallFailedError('verify', detail);
  }

  onEvent({ kind: 'done', paths });
  return paths;
}

// --- internals ---------------------------------------------------------

function derivePaths(recipe: Extract<InstallRecipe, { kind: 'pipx' }>, env: PipxEnv): HermesPaths {
  const venvRoot = path.posix.join(toPosix(env.venvsRoot), 'hermes-agent');
  const hermesBin = recipe.apps.main;
  const hermesAcpBin = recipe.apps.acpCheck ?? recipe.postCheck.app;
  return {
    venvRoot,
    hermes: path.posix.join(venvRoot, 'bin', hermesBin),
    hermesAcp: path.posix.join(venvRoot, 'bin', hermesAcpBin),
    python: path.posix.join(venvRoot, 'bin', 'python'),
  };
}

function hasAlreadyInstalledMarker(stdoutLines: readonly string[], stderrLines: readonly string[]): boolean {
  return (
    stdoutLines.some((line) => line.includes(ALREADY_INSTALLED_MARKER)) ||
    stderrLines.some((line) => line.includes(ALREADY_INSTALLED_MARKER))
  );
}

/** TC-2/AU-50 (INV-10): read back the actually-installed hermes-agent
 *  version via `pipx list --json` and reconcile it against
 *  `recipe.pinnedVersion`. A match returns (covers the fresh-install case
 *  for free — no `--force` run). A mismatch logs the old→new version
 *  honestly, runs ONE `pipx install --force <spec>` through the same
 *  streaming seam as the original install, and re-verifies; a
 *  still-mismatched re-verify throws so the caller (`SetupController`)
 *  never records `pinnedVersion` for a version that isn't actually
 *  installed. `--force` is scoped to this single explicit-Install-action
 *  call path — it never runs on a passive status check. */
async function verifyPinnedVersion(
  recipe: Extract<InstallRecipe, { kind: 'pipx' }>,
  env: PipxEnv,
  paths: HermesPaths,
  spawn: SpawnFn,
  cwd: string,
  onEvent: (e: InstallEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const venvName = path.posix.basename(paths.venvRoot);

  const first = await readInstalledVersion(spawn, env, cwd, signal, venvName);
  if (first.version === recipe.pinnedVersion) return;

  onEvent({
    kind: 'log',
    line: `existing hermes-agent ${first.version ?? 'unknown'} found; reinstalling pinned ${recipe.pinnedVersion}`,
  });

  throwIfAborted(signal);
  const forceArgs = [
    'install',
    '--force',
    recipe.packageSpec,
    ...(env.pythonOverride ? ['--python', env.pythonOverride] : []),
  ];
  await runAndStream(spawn(env.pipxPath, forceArgs, { cwd, signal }), onEvent, signal);

  const second = await readInstalledVersion(spawn, env, cwd, signal, venvName);
  if (second.version !== recipe.pinnedVersion) {
    const detail =
      second.version !== undefined
        ? `installed ${second.version}, expected ${recipe.pinnedVersion}`
        : `could not verify installed version from pipx list --json output: ${second.rawTail}`;
    onEvent({ kind: 'failed', phase: 'pipx-install', detail });
    throw new InstallFailedError('pipx-install', detail);
  }
}

interface InstalledVersionRead {
  version: string | undefined;
  rawTail: string;
}

async function readInstalledVersion(
  spawn: SpawnFn,
  env: PipxEnv,
  cwd: string,
  signal: AbortSignal,
  venvName: string,
): Promise<InstalledVersionRead> {
  throwIfAborted(signal);
  const proc = spawn(env.pipxPath, ['list', '--json'], { cwd, signal });
  const { stdout, stderr } = await collectQuiet(proc, signal);
  return { version: parsePipxListVersion(stdout, venvName), rawTail: tail((stdout || stderr).split('\n')) };
}

/**
 * V10 settled shape: `{pipx_spec_version:"0.1",
 * venvs:{<name>:{metadata:{main_package:{package_version}}}}}`. Parsed
 * defensively — any missing/malformed key (including a future
 * `pipx_spec_version` bump) resolves to `undefined` (unverifiable), which
 * the caller treats exactly like a version mismatch, never a crash.
 */
function parsePipxListVersion(stdoutText: string, venvName: string): string | undefined {
  try {
    const parsed = JSON.parse(stdoutText) as {
      venvs?: Record<string, { metadata?: { main_package?: { package_version?: unknown } } }>;
    };
    const version = parsed.venvs?.[venvName]?.metadata?.main_package?.package_version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Like `runAndStream` but does not forward lines as `'log'` events — `pipx
 *  list --json`'s raw JSON is plumbing for the version reconciliation, not
 *  user-facing install progress (the one user-facing line this flow adds is
 *  the synthetic "existing … reinstalling …" message in
 *  `verifyPinnedVersion`). Exit code is drained, not inspected: V10 pins the
 *  read-back version as the decision signal, never `pipx list`'s own exit
 *  code. */
async function collectQuiet(proc: ReturnType<SpawnFn>, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const consume = async (iter: AsyncIterable<string>, sink: string[]): Promise<void> => {
    for await (const line of iter) {
      throwIfAborted(signal);
      sink.push(line);
    }
  };

  await Promise.all([consume(proc.stdout, stdoutLines), consume(proc.stderr, stderrLines)]);
  throwIfAborted(signal);
  await proc.exitCode;
  return { stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
}

interface StreamRun {
  exitCode: number;
  stdoutLines: string[];
  stderrLines: string[];
}

/** Consumes both streams of a spawned process concurrently, forwarding each
 *  received line as a `'log'` event — checking `signal.aborted` before every
 *  single emission so an abort mid-stream never lets a trailing line escape. */
async function runAndStream(
  proc: ReturnType<SpawnFn>,
  onEvent: (e: InstallEvent) => void,
  signal: AbortSignal,
): Promise<StreamRun> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const consume = async (iter: AsyncIterable<string>, sink: string[]): Promise<void> => {
    for await (const line of iter) {
      throwIfAborted(signal);
      sink.push(line);
      onEvent({ kind: 'log', line });
    }
  };

  await Promise.all([consume(proc.stdout, stdoutLines), consume(proc.stderr, stderrLines)]);
  throwIfAborted(signal);
  const exitCode = await proc.exitCode;
  return { exitCode, stdoutLines, stderrLines };
}

function tail(lines: readonly string[]): string {
  return lines.slice(-TAIL_MAX_LINES).join('\n');
}

/** Normalize Windows separators so path math is stable on the dev box (same
 *  helper `resolveHermes.ts` uses for the identical reason). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

class InstallFailedError extends Error {
  constructor(
    public readonly phase: InstallPhase,
    public readonly detail: string,
  ) {
    super(`hermes install failed at phase "${phase}": ${detail}`);
    this.name = 'InstallFailedError';
  }
}
