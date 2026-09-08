import * as os from 'node:os';
import * as path from 'node:path';
import { loginShellSpawn, type ExecLookup, type LoginShellSpawnOptions } from '../runtime/resolveHermes';
import {
  PROBE_TIMEOUT_DETAIL,
  isExecTimeout,
  lastNonEmptyLine,
  locateOnLoginPath,
  throwIfAborted,
  type LocateOnLoginPathSpec,
} from './locatorShared';

export { isExecTimeout } from './locatorShared';

/**
 * pipx + Python locator (onboarding-backend-setup-architecture.md §2.2,
 * steps 0–1 + 3; Task 4 of the onboarding/backend-setup plan).
 *
 * PURE LOGIC — no `vscode` import (the only type-level dependency on
 * `resolveHermes.ts`, `ExecLookup`, is erased at compile; the VALUE import,
 * `loginShellSpawn`, is safe too — that module itself is vscode-free, see
 * its own header comment). All subprocess I/O is routed through the caller-
 * injected `ExecLookup` seam, so unit tests never touch a real shell.
 *
 * Covers ONLY steps 0, 1, and 3 of the managed-install recipe:
 *   0. Preflight — is `pipx` on the login-shell PATH at all?
 *   1. Python gate — is the interpreter pipx would use in range
 *      [3.11, 3.14)? (Hermes's `requires-python = ">=3.11,<3.14"` — the
 *      upper bound is load-bearing: Rust transitives like pydantic-core
 *      have no cp314 wheels yet.) If not, probe python3.13/3.12/3.11.
 *   3. Resolve `PIPX_LOCAL_VENVS` (the venvs root `pipx install` will use).
 * Steps 2 (the actual `pipx install`) and 4 (the post-install `--check`)
 * are a LATER task's pipeline, consuming this module's `PipxEnv.venvsRoot`
 * — deliberately NOT reimplemented here (this module never mutates
 * anything; it only observes).
 *
 * Login-shell routing, universally (matching `resolveHermes.ts`'s own
 * practice of routing EVERY OS-touching command through the user's login
 * shell, not just the one-shot builtin lookup): a VS Code process launched
 * from a desktop icon inherits a stripped `$PATH` missing venv/pyenv/conda/
 * Homebrew dirs (and, on some distros, even a user-local `~/.local/bin`
 * pipx install). Every command below — including ones that already look
 * "safe" because they follow an absolute path resolved by a prior step —
 * goes through `loginShellSpawn` so the user's real profile-sourced PATH
 * and environment apply consistently. Exactly one command is a POSIX shell
 * BUILTIN (`command -v pipx`), so it alone passes `{ exec: false }` — see
 * `LoginShellSpawnOptions`'s doc comment in `resolveHermes.ts` for why
 * `exec command -v pipx` would fail with exit 127 otherwise.
 *
 * pipx CLI mechanics (grounded 2026-08-04, Context7 has no pipx docs
 * indexed — only `uv`, which replaces it — so grounded directly against
 * https://pipx.pypa.io/latest/reference/cli/ + the Debian bookworm manpage
 * for the older-pipx comparison):
 *   `pipx environment [--value VARIABLE]` (short `-V`) prints the resolved
 *   value of one named variable, one line, when `--value` is given — stable
 *   across pipx versions (unlike `pipx list --json`'s two incompatible
 *   envelope shapes across pipx releases, deliberately avoided per §2.2).
 *   `PIPX_LOCAL_VENVS` is an INTERNAL derived variable pipx has always
 *   exposed via `pipx environment` (confirmed present in both the current
 *   docs' "Available variables" list and the Debian bookworm pipx manpage's
 *   older list: `PIPX_HOME, PIPX_BIN_DIR, PIPX_SHARED_LIBS, PIPX_LOCAL_VENVS,
 *   PIPX_LOG_DIR, PIPX_TRASH_DIR, PIPX_VENV_CACHEDIR`). `PIPX_DEFAULT_PYTHON`
 *   is NOT in that older Debian bookworm list — confirming the brief's
 *   fallback caveat: older distro pipx can 4xx/error on
 *   `--value PIPX_DEFAULT_PYTHON`, so this module falls back to a plain
 *   `python3 --version` probe on any failure of that lookup (whether the
 *   `--value` call itself errors, or the resolved interpreter's `--version`
 *   call fails).
 *
 * `isExecTimeout`/`throwIfAborted`/`lastNonEmptyLine` (WS-SU) and the step-0
 * lookup itself, `locateOnLoginPath` (FI-10, WS-F8 F8-1), are the shared core
 * extracted to `locatorShared.ts`; this module is now a CALLER building its
 * own `spec` (see {@link pipxSpec}) and mapping the generic
 * `found`/`missing`/`probe-timeout` result to its own `PipxLocateResult`.
 * `llamaCppLocator.ts` follows the same shape.
 */

/** Resolved pipx + Python facts needed by the (later) install pipeline. */
export interface PipxEnv {
  /** Absolute path to the `pipx` executable (`command -v pipx`). */
  pipxPath: string;
  /** `pipx environment --value PIPX_LOCAL_VENVS` — the venvs root `pipx
   *  install` will place `hermes-agent`'s venv under. */
  venvsRoot: string;
  /** The version actually reported for pipx's DEFAULT interpreter (the one
   *  `pipx install` would use with no `--python` flag) — even when it was
   *  out of range and a `pythonOverride` had to be found instead. */
  defaultPythonVersion: string;
  /** Set only when the default interpreter was out of range and a suitable
   *  probe candidate (`python3.13`/`python3.12`/`python3.11`) was found on
   *  the login-shell PATH. The later install step passes this as
   *  `pipx install --python <pythonOverride> …`. */
  pythonOverride?: string;
}

export type PipxLocateResult =
  | { ok: true; env: PipxEnv }
  | { ok: false; reason: 'pipx-missing' | 'python-unsuitable' | 'probe-timeout'; detail: string };

/** Hermes's `requires-python = ">=3.11,<3.14"` (pyproject.toml, §2.1) — the
 *  upper bound excludes 3.14 because Rust transitives (pydantic-core et al.)
 *  ship no cp314 wheels yet. */
const PYTHON_MIN_INCLUSIVE = '3.11';
const PYTHON_MAX_EXCLUSIVE = '3.14';

/** Probe order when the default interpreter is out of range (§2.2 step 1):
 *  newest-first, so a Fedora box that has both 3.13 and 3.12 installed
 *  prefers 3.13. */
const PYTHON_PROBE_CANDIDATES = ['python3.13', 'python3.12', 'python3.11'];

/** Same 10s budget `resolveHermes.ts` uses for its login-shell lookup — long
 *  enough for a slow NFS-homed profile, short enough not to hang the Setup
 *  panel on a wedged shell. Used for every `runLoginShell` call EXCEPT the
 *  step-0 pipx lookup, which has its own asymmetric two-tier budget below
 *  (§3 / T11). */
const LOOKUP_TIMEOUT_MS = 10_000;

/** T11 (§3): step-0 `command -v pipx` first-attempt budget — shorter than
 *  {@link LOOKUP_TIMEOUT_MS} so a merely-slow-but-working shell still
 *  answers well within the panel's patience, while a genuinely wedged shell
 *  fails fast enough to retry once at the full 10s below. */
const PIPX_STEP0_TIMEOUT_MS = 5_000;

/** T11 (§3): step-0 retry budget after the first attempt times out — the
 *  same 10s budget every other login-shell call uses. */
const PIPX_STEP0_RETRY_TIMEOUT_MS = LOOKUP_TIMEOUT_MS;

/** T11 (§3): absolute-candidate fallback budget — short, because by the time
 *  we reach this fallback the login shell has ALREADY failed twice (15s
 *  spent); these are direct `execFile` calls with no shell/profile to wait
 *  on, so a real pipx binary answers near-instantly. */
const ABSOLUTE_CANDIDATE_TIMEOUT_MS = 2_000;

/**
 * Locate `pipx` and gate its default Python interpreter into Hermes's
 * supported range, resolving the venvs root along the way. Never throws for
 * any of the SCRIPTED failure modes the brief covers (`pipx-missing`,
 * `python-unsuitable`, `probe-timeout`) — those are returned as typed
 * results. An exec failure DURING the final `PIPX_LOCAL_VENVS` read (pipx
 * vanishing between step 0 and step 3 — an unmodeled race) is allowed to
 * propagate as a rejected promise; there is no reason code for it in this
 * task's interface (that belongs to the later install pipeline's own
 * `resolve-paths` failure mode, §2.2 step 3's file-existence checks). An
 * aborted `signal` also propagates as a rejected `AbortError` — both checked
 * between steps (see {@link throwIfAborted}) AND, since TC-5/AU-28, threaded
 * into EVERY exec() call's own opts, so an in-flight 5-10s login-shell probe
 * is actually killed instead of running to its own timeout regardless of
 * Cancel.
 *
 * @param signal T11 (§3, critic C-11): optional — `handleInstall` passes its
 *   `AbortController.signal` so Cancel can reach a wedged probe; callers that
 *   never cancel (e.g. `setup.recheck`) simply omit it.
 */
export async function locatePipx(exec: ExecLookup, signal?: AbortSignal): Promise<PipxLocateResult> {
  const cwd = os.homedir();

  throwIfAborted(signal);
  const lookup = await locateOnLoginPath(exec, pipxSpec(), cwd, signal);
  if (lookup.kind === 'probe-timeout') {
    return { ok: false, reason: 'probe-timeout', detail: PROBE_TIMEOUT_DETAIL };
  }
  if (lookup.kind === 'missing') {
    return {
      ok: false,
      reason: 'pipx-missing',
      detail:
        "'command -v pipx' found no pipx on the login-shell PATH. " +
        "Install it with your distro's package manager, then `pipx ensurepath`.",
    };
  }
  const pipxPath = lookup.path;

  throwIfAborted(signal);
  const pythonGate = await gatePython(exec, pipxPath, cwd, signal);
  if (!pythonGate) {
    return {
      ok: false,
      reason: 'python-unsuitable',
      detail:
        `No suitable Python (>=${PYTHON_MIN_INCLUSIVE}, <${PYTHON_MAX_EXCLUSIVE}) was found ` +
        `on the login-shell PATH (probed ${PYTHON_PROBE_CANDIDATES.join(', ')}).`,
    };
  }

  throwIfAborted(signal);
  const venvsRootRaw = await runLoginShell(
    exec,
    pipxPath,
    ['environment', '--value', 'PIPX_LOCAL_VENVS'],
    cwd,
    signal,
  );
  const venvsRoot = lastNonEmptyLine(venvsRootRaw);

  return {
    ok: true,
    env: {
      pipxPath,
      venvsRoot,
      defaultPythonVersion: pythonGate.defaultPythonVersion,
      ...(pythonGate.pythonOverride ? { pythonOverride: pythonGate.pythonOverride } : {}),
    },
  };
}

/**
 * Numeric `major.minor(.patch)` compare — `v` is tolerant of a leading
 * `"Python "` prefix (exactly what `python --version` prints, e.g.
 * `"Python 3.13.1"`), missing components default to `0`. Upper bound is
 * EXCLUSIVE (`3.14.0` is never in range for `maxExclusive: '3.14'`) —
 * matches Hermes's own `<3.14` pyproject bound precisely.
 */
export function isVersionInRange(v: string, minInclusive: string, maxExclusive: string): boolean {
  const value = parseVersion(v);
  const min = parseVersion(minInclusive);
  const max = parseVersion(maxExclusive);
  return compareVersions(value, min) >= 0 && compareVersions(value, max) < 0;
}

// --- internals ---------------------------------------------------------

interface PythonGate {
  defaultPythonVersion: string;
  pythonOverride?: string;
}

/**
 * This locator's `spec` for the shared `locateOnLoginPath` core
 * (`locatorShared.ts`, FI-10, WS-F8 F8-1): the step-0 binary name, the
 * absolute-candidate probe list in PATH-precedence order per critic C-4/T11
 * (a user-local pipx — `~/.local/bin`, the `pipx ensurepath` / pip
 * user-install default — wins over the distro package `/usr/bin`, exactly as
 * a real login shell's PATH would order them), this module's own timeouts,
 * and `captureVersion: false` — a candidate hit is presence-only (a hit that
 * reaches here proceeds using the login shell's PATH having been genuinely
 * too slow to answer, not silently overridden — a future task could thread a
 * log-tail note about this through `SetupControllerDeps.locatePipx`'s caller
 * if that visibility is wanted); the pipx version string itself is never
 * consumed downstream.
 */
function pipxSpec(): LocateOnLoginPathSpec {
  return {
    binary: 'pipx',
    candidates: [path.join(os.homedir(), '.local', 'bin', 'pipx'), '/usr/bin/pipx'],
    timeouts: {
      step0: PIPX_STEP0_TIMEOUT_MS,
      retry: PIPX_STEP0_RETRY_TIMEOUT_MS,
      candidate: ABSOLUTE_CANDIDATE_TIMEOUT_MS,
    },
    captureVersion: false,
  };
}

/** Steps 1: gate the default interpreter, probing overrides if needed. */
async function gatePython(
  exec: ExecLookup,
  pipxPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<PythonGate | undefined> {
  const defaultPythonVersion = await getDefaultPythonVersion(exec, pipxPath, cwd, signal);
  if (defaultPythonVersion && isVersionInRange(defaultPythonVersion, PYTHON_MIN_INCLUSIVE, PYTHON_MAX_EXCLUSIVE)) {
    return { defaultPythonVersion };
  }

  for (const candidate of PYTHON_PROBE_CANDIDATES) {
    const version = await tryGetVersion(exec, candidate, cwd, signal);
    if (version && isVersionInRange(version, PYTHON_MIN_INCLUSIVE, PYTHON_MAX_EXCLUSIVE)) {
      return {
        // Preserve whatever the ACTUAL default was (even out-of-range) —
        // `pythonOverride` is what makes it usable, not a replacement fact.
        defaultPythonVersion: defaultPythonVersion ?? version,
        pythonOverride: candidate,
      };
    }
  }
  return undefined;
}

/** `pipx environment --value PIPX_DEFAULT_PYTHON` → `<that> --version`.
 *  ANY failure along that path (the `--value` lookup erroring on older
 *  pipx, or the resolved interpreter's `--version` call failing) falls back
 *  to a plain `python3 --version` on the login-shell PATH. */
async function getDefaultPythonVersion(
  exec: ExecLookup,
  pipxPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const raw = await runLoginShell(
      exec,
      pipxPath,
      ['environment', '--value', 'PIPX_DEFAULT_PYTHON'],
      cwd,
      signal,
    );
    const pythonBin = lastNonEmptyLine(raw);
    if (!pythonBin) throw new Error('empty PIPX_DEFAULT_PYTHON value');
    const version = await tryGetVersion(exec, pythonBin, cwd, signal);
    if (!version) throw new Error(`'${pythonBin} --version' did not resolve`);
    return version;
  } catch (err) {
    // TC-5/AU-28: an abort must propagate out of this fallback try/catch too
    // — otherwise Cancel would be silently swallowed into "fall back to
    // plain python3", masking the cancellation as an ordinary probe result.
    if (signal?.aborted) throw err;
    return tryGetVersion(exec, 'python3', cwd, signal);
  }
}

async function tryGetVersion(
  exec: ExecLookup,
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const raw = await runLoginShell(exec, command, ['--version'], cwd, signal);
    const line = lastNonEmptyLine(raw);
    return line ? stripPythonPrefix(line) : undefined;
  } catch (err) {
    // TC-5/AU-28: an abort must propagate — this function's "best-effort,
    // undefined on any failure" contract is for a candidate genuinely not
    // being present, not for Cancel being silently reinterpreted as "keep
    // probing the next candidate".
    if (signal?.aborted) throw err;
    return undefined;
  }
}

/** Every OS-touching call in this module (besides step 0's own two-tier
 *  lookup, now the shared {@link locateOnLoginPath}) funnels through here —
 *  one `loginShellSpawn` + `exec`, matching `resolveHermes.ts`'s own pattern.
 *
 *  T11 (§3 point 2): "timeout-only retry everywhere" — a TIMEOUT (per
 *  {@link isExecTimeout}; a maxBuffer kill does NOT count) gets exactly one
 *  retry at the same budget; any other error propagates immediately without
 *  a retry, matching step 0's own no-retry-on-clean-miss rule. */
async function runLoginShell(
  exec: ExecLookup,
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  options?: LoginShellSpawnOptions,
): Promise<string> {
  const spec = loginShellSpawn(command, args, undefined, options);
  try {
    return await exec(spec.command, spec.args, {
      timeoutMs: LOOKUP_TIMEOUT_MS,
      cwd,
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    // TC-5/AU-28: an abort takes priority over the timeout classifier (see
    // {@link locateOnLoginPath}'s identical guard) — propagate immediately
    // instead of retrying into an already-aborted signal.
    if (signal?.aborted) throw err;
    if (!isExecTimeout(err)) throw err;
    return exec(spec.command, spec.args, {
      timeoutMs: LOOKUP_TIMEOUT_MS,
      cwd,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}

function stripPythonPrefix(s: string): string {
  return s.trim().replace(/^Python\s+/i, '');
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(v: string): Version {
  const cleaned = stripPythonPrefix(v);
  const [majorStr, minorStr, patchStr] = cleaned.split('.');
  return { major: toInt(majorStr), minor: toInt(minorStr), patch: toInt(patchStr) };
}

function toInt(s: string | undefined): number {
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
