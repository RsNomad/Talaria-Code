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
 *      exit ⇒ `failed@pipx-install` with a ≤40-line stderr tail (§7 FM-3).
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

  // --- Step 2 (§2.2): pipx install -----------------------------------------
  onEvent({ kind: 'phase', phase: 'pipx-install' });
  const installArgs = [
    'install',
    recipe.packageSpec,
    ...(env.pythonOverride ? ['--python', env.pythonOverride] : []),
  ];
  const installRun = await runAndStream(spawn(env.pipxPath, installArgs, { cwd, signal }), onEvent, signal);
  if (installRun.exitCode !== 0) {
    const detail = tail(installRun.stderrLines);
    onEvent({ kind: 'failed', phase: 'pipx-install', detail });
    throw new InstallFailedError('pipx-install', detail);
  }

  // --- Step 3 (§2.2 v2): resolve + existence-check paths -------------------
  throwIfAborted(signal);
  onEvent({ kind: 'phase', phase: 'resolve-paths' });
  const paths = derivePaths(recipe, env);
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
