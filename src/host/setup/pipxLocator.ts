import * as os from 'node:os';
import { loginShellSpawn, type ExecLookup, type LoginShellSpawnOptions } from '../runtime/resolveHermes';

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
  | { ok: false; reason: 'pipx-missing' | 'python-unsuitable'; detail: string };

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
 *  panel on a wedged shell. */
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Locate `pipx` and gate its default Python interpreter into Hermes's
 * supported range, resolving the venvs root along the way. Never throws for
 * any of the SCRIPTED failure modes the brief covers (`pipx-missing`,
 * `python-unsuitable`) — those are returned as typed results. An exec
 * failure DURING the final `PIPX_LOCAL_VENVS` read (pipx vanishing between
 * step 0 and step 3 — an unmodeled race) is allowed to propagate as a
 * rejected promise; there is no third reason code for it in this task's
 * interface (that belongs to the later install pipeline's own
 * `resolve-paths` failure mode, §2.2 step 3's file-existence checks).
 */
export async function locatePipx(exec: ExecLookup): Promise<PipxLocateResult> {
  const cwd = os.homedir();

  const pipxPath = await findPipxPath(exec, cwd);
  if (!pipxPath) {
    return {
      ok: false,
      reason: 'pipx-missing',
      detail:
        "'command -v pipx' found no pipx on the login-shell PATH. " +
        "Install it with your distro's package manager, then `pipx ensurepath`.",
    };
  }

  const pythonGate = await gatePython(exec, pipxPath, cwd);
  if (!pythonGate) {
    return {
      ok: false,
      reason: 'python-unsuitable',
      detail:
        `No suitable Python (>=${PYTHON_MIN_INCLUSIVE}, <${PYTHON_MAX_EXCLUSIVE}) was found ` +
        `on the login-shell PATH (probed ${PYTHON_PROBE_CANDIDATES.join(', ')}).`,
    };
  }

  const venvsRootRaw = await runLoginShell(
    exec,
    pipxPath,
    ['environment', '--value', 'PIPX_LOCAL_VENVS'],
    cwd,
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

async function findPipxPath(exec: ExecLookup, cwd: string): Promise<string | undefined> {
  let stdout: string;
  try {
    stdout = await runLoginShell(exec, 'command', ['-v', 'pipx'], cwd, { exec: false });
  } catch {
    return undefined;
  }
  const line = lastNonEmptyLine(stdout);
  return line.startsWith('/') ? line : undefined;
}

/** Steps 1: gate the default interpreter, probing overrides if needed. */
async function gatePython(exec: ExecLookup, pipxPath: string, cwd: string): Promise<PythonGate | undefined> {
  const defaultPythonVersion = await getDefaultPythonVersion(exec, pipxPath, cwd);
  if (defaultPythonVersion && isVersionInRange(defaultPythonVersion, PYTHON_MIN_INCLUSIVE, PYTHON_MAX_EXCLUSIVE)) {
    return { defaultPythonVersion };
  }

  for (const candidate of PYTHON_PROBE_CANDIDATES) {
    const version = await tryGetVersion(exec, candidate, cwd);
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
): Promise<string | undefined> {
  try {
    const raw = await runLoginShell(
      exec,
      pipxPath,
      ['environment', '--value', 'PIPX_DEFAULT_PYTHON'],
      cwd,
    );
    const pythonBin = lastNonEmptyLine(raw);
    if (!pythonBin) throw new Error('empty PIPX_DEFAULT_PYTHON value');
    const version = await tryGetVersion(exec, pythonBin, cwd);
    if (!version) throw new Error(`'${pythonBin} --version' did not resolve`);
    return version;
  } catch {
    return tryGetVersion(exec, 'python3', cwd);
  }
}

async function tryGetVersion(exec: ExecLookup, command: string, cwd: string): Promise<string | undefined> {
  try {
    const raw = await runLoginShell(exec, command, ['--version'], cwd);
    const line = lastNonEmptyLine(raw);
    return line ? stripPythonPrefix(line) : undefined;
  } catch {
    return undefined;
  }
}

/** Every OS-touching call in this module funnels through here — one
 *  `loginShellSpawn` + `exec`, matching `resolveHermes.ts`'s own pattern. */
async function runLoginShell(
  exec: ExecLookup,
  command: string,
  args: string[],
  cwd: string,
  options?: LoginShellSpawnOptions,
): Promise<string> {
  const spec = loginShellSpawn(command, args, undefined, options);
  return exec(spec.command, spec.args, { timeoutMs: LOOKUP_TIMEOUT_MS, cwd });
}

/** Login shells may echo profile/motd noise before the answer — same
 *  tolerance `resolveHermes.ts`'s `resolveHermesBin` needs. */
function lastNonEmptyLine(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
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
