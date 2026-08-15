import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';

/**
 * Linux-first resolution of the Hermes runtime.
 *
 * **Target platform is Fedora / Linux** (memory: target-platform-fedora). Both
 * children — `hermes acp` and `python -m tui_gateway.entry` — must run against
 * the *same* Python/venv that has Hermes installed. This module owns that
 * resolution and the login-shell spawn wiring (spec §2.1).
 *
 * Two hard problems on Linux this solves:
 * 1. **Same interpreter.** `hermes` is a console script; the tui_gateway must be
 *    launched with that install's interpreter, not an arbitrary `python`. We
 *    resolve `hermes`'s location, then derive its sibling venv `bin/python`.
 * 2. **GUI-launched PATH.** A VS Code started from a desktop launcher inherits a
 *    stripped `$PATH` missing venv / pyenv / conda / Homebrew dirs. So we spawn
 *    through the user's **login shell** (`$SHELL -l -c …`), which sources the
 *    profile and restores PATH. `vscode-acp-main`'s AgentManager does exactly
 *    this on unix.
 *
 * The OS-touching piece — running `command -v hermes` inside a login shell —
 * is REAL: it uses Node `execFile` with a 10s timeout, takes the last
 * non-empty stdout line (login shells echo profile/motd noise first), and
 * caches a successful result for the extension-host lifetime (failures are
 * never cached, so a user can install `hermes` and retry without reloading).
 * `talaria.hermesPath` remains the escape hatch when PATH discovery cannot
 * work (Flatpak VS Code, Remote-SSH with a non-login PATH, custom installs).
 */

/** User-overridable configuration (from `talaria.*` settings, spec §2.1). */
export interface HermesRuntimeConfig {
  /** Explicit path to the `hermes` executable. Overrides PATH lookup. */
  hermesPath?: string;
  /** Explicit interpreter path (`talaria.pythonPath`). Overrides derivation. */
  pythonPath?: string;
  /** Working directory for spawned children (usually the workspace root). */
  cwd?: string;
  /** Login shell to route through; defaults to `$SHELL` then `/bin/bash`. */
  shell?: string;
}

/** Fully-resolved launch info for both channels. */
export interface ResolvedHermes {
  /** Absolute path to the `hermes` executable. */
  hermesBin: string;
  /** Absolute path to the interpreter that has Hermes installed. */
  python: string;
  /** Working directory to spawn in. */
  cwd: string;
  /** How to launch the ACP channel. */
  acp: SpawnSpec;
  /** How to launch the control channel. */
  control: SpawnSpec;
}

/** A concrete spawn descriptor consumable by {@link ../transport/JsonRpcStdio}. */
export interface SpawnSpec {
  command: string;
  args: string[];
}

/**
 * Derive the venv interpreter that is a sibling of the `hermes` console script.
 *
 * Console scripts live in the venv `bin/` next to `python`:
 *   `/home/u/.venvs/hermes/bin/hermes` → `/home/u/.venvs/hermes/bin/python`
 *
 * This is pure string logic (no FS access) so it is safe to run anywhere,
 * including the Windows dev box. Returns the POSIX sibling path.
 *
 * **AU-7 / INV-9 / ADR-3: callers must hand this a REAL path.** Console
 * scripts installed by pipx (the extension's documented install mechanism —
 * V5) — and many other installers — are SYMLINKS into a versioned venv dir
 * (`~/.local/bin/hermes` → `~/.local/share/pipx/venvs/hermes-agent/bin/
 * hermes`), and pipx puts no `python` next to the symlink itself. Deriving
 * the sibling off the symlink's own directory yields a path that does not
 * exist. Callers realpath-resolve the discovered binary FIRST (see
 * {@link resolveHermes}) and pass the resolved target here — never the
 * as-discovered path.
 */
export function deriveVenvPython(hermesBin: string): string {
  const binDir = path.posix.dirname(toPosix(hermesBin));
  return path.posix.join(binDir, 'python');
}

/**
 * Pick the login shell to route spawns through. Prefers an explicit override,
 * then `$SHELL`, then `/bin/bash`. (On a non-target OS this still returns a
 * sensible value; nothing is executed in mock mode.)
 */
export function resolveLoginShell(config?: HermesRuntimeConfig): string {
  return config?.shell ?? process.env.SHELL ?? '/bin/bash';
}

/** Options for {@link loginShellSpawn}. */
export interface LoginShellSpawnOptions {
  /**
   * Wrap the command in `exec` so it replaces the login shell process,
   * letting signals (SIGTERM/SIGKILL from `JsonRpcStdio.dispose`) reach the
   * real child. Required for long-lived children. Default `true`.
   *
   * Set `false` only for one-shot lookups that invoke a shell BUILTIN (e.g.
   * `command -v hermes`): `exec` requires an external executable and does a
   * PATH search only, so `exec command -v hermes` fails with exit 127
   * ("exec: command: not found") — there is no `/usr/bin/command` binary.
   */
  exec?: boolean;
}

/**
 * Build a login-shell spawn spec that runs `command args…` with a full PATH.
 *
 * Produces e.g. `/bin/zsh -l -c 'exec "hermes" "acp"'`. `exec` replaces the
 * shell so signals (SIGTERM/SIGKILL from `JsonRpcStdio.dispose`) reach the real
 * child rather than the wrapper. Arguments are single-quote escaped.
 */
export function loginShellSpawn(
  command: string,
  args: string[],
  config?: HermesRuntimeConfig,
  options?: LoginShellSpawnOptions,
): SpawnSpec {
  const shell = resolveLoginShell(config);
  const quoted = [command, ...args].map(shellQuote).join(' ');
  const useExec = options?.exec ?? true;
  return { command: shell, args: ['-l', '-c', useExec ? `exec ${quoted}` : quoted] };
}

/** R-A5: login-shell lookup timeout — long enough for a slow NFS-homed
 * profile, short enough not to hang activation (L2 A5 recommendation). */
const HERMES_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Test seam: run a command and resolve its stdout. Default = Node `execFile`
 * (its `timeout` option SIGTERMs the child on expiry — Node child_process
 * docs). Injectable so unit tests never spawn a real shell.
 *
 * `cwd` (AUDIT-5 SEC M-2, defensive hardening): pinned by the caller to
 * `os.homedir()` for the login-shell `hermes` discovery spawn. This is NOT a
 * fix for a working exploit — the filed direnv-PATH-steering chain does not
 * reproduce (two independent dead links: the extension host's cwd is not the
 * workspace, and direnv's auto-env hook only fires for interactive shells,
 * never for a non-interactive `$SHELL -l -c` lookup). It closes the general
 * cwd-sensitivity class instead: before this, the lookup child silently
 * inherited whatever cwd the extension host happened to have, so any
 * cwd-dependent logic in the user's own profile scripts (not just direnv)
 * could influence PATH discovery. Pinning a non-workspace cwd converts that
 * happenstance guarantee into a pinned one.
 *
 * `signal` (TC-5/AU-28): OPTIONAL — when a caller passes one (e.g.
 * `pipxLocator.ts`/`llamaCppLocator.ts` threading `locatePipx`/
 * `locateLlamaServer`'s own `AbortSignal` parameter down into every exec()
 * call, not just checking it BETWEEN steps), the default implementation
 * below hands it straight to Node `execFile`'s own `signal` option, which
 * kills the in-flight child and rejects with an `AbortError` (Node
 * child_process docs: "the signal option allows aborting the child process
 * using an AbortController... results in an AbortError"). Before this field
 * existed, Cancel could only ever be observed BETWEEN steps — an in-flight
 * 5-10s login-shell probe kept running to its own timeout regardless.
 */
export type ExecLookup = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; cwd: string; signal?: AbortSignal },
) => Promise<string>;

/** Exported (TC-5/AU-28): the real, `execFile`-backed default — tested
 *  directly against a REAL `execFile` abort (Global Constraint 4: the
 *  `ExecLookup` seam carries no error shape of its own, so the actual signal
 *  wiring is pinned against Node's real behavior, not a hand-rolled fixture —
 *  same discipline `pipxLocator.test.ts`'s real-timeout `isExecTimeout` test
 *  already uses). */
export const defaultExecLookup: ExecLookup = (command, args, opts) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: opts.timeoutMs, cwd: opts.cwd, signal: opts.signal }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/**
 * R-A5: successful discovery is cached for the extension-host lifetime —
 * `hermes` does not move mid-session, and every `resolveHermes` call (two
 * channels + dashboard) would otherwise pay a login-shell spawn. Failures are
 * NEVER cached (the user may install hermes and retry).
 */
let cachedHermesBin: string | undefined;

/** Test-only: clear the module-level lookup cache. */
export function resetHermesBinCache(): void {
  cachedHermesBin = undefined;
}

/**
 * Locate the `hermes` executable.
 *
 * - If `config.hermesPath` is set, trust it (the lookup never runs).
 * - Otherwise run `command -v hermes` *inside a login shell* so PATH matches
 *   what the user's terminal would see, with a 10s timeout. The result is
 *   cached on success; a failure throws an actionable error pointing at the
 *   `talaria.hermesPath` escape hatch and is retried on the next call.
 *
 * `command` is a POSIX shell builtin, not an external executable, so the
 * lookup runs WITHOUT the `exec` wrapper (`exec` only PATH-searches for a
 * real binary; `exec command -v hermes` fails with exit 127 on Fedora since
 * there is no `/usr/bin/command`). The long-lived children still use `exec`
 * via {@link resolveHermes} for signal propagation.
 */
export async function resolveHermesBin(
  config: HermesRuntimeConfig,
  exec: ExecLookup = defaultExecLookup,
): Promise<string> {
  if (config.hermesPath) return config.hermesPath;
  if (cachedHermesBin) return cachedHermesBin;

  const lookup = loginShellSpawn('command', ['-v', 'hermes'], config, { exec: false });
  let stdout: string;
  try {
    // AUDIT-5 SEC M-2 (defensive): pin a non-workspace cwd — see the ExecLookup
    // doc-comment above for the full rationale (exploit chain dead, hardening kept).
    stdout = await exec(lookup.command, lookup.args, {
      timeoutMs: HERMES_LOOKUP_TIMEOUT_MS,
      cwd: os.homedir(),
    });
  } catch (err) {
    throw new Error(
      `Could not locate 'hermes' on the login-shell PATH ` +
        `(ran: ${lookup.command} ${lookup.args.join(' ')}): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Set the 'talaria.hermesPath' setting to the absolute path of the hermes executable ` +
        `(Flatpak VS Code and Remote-SSH sessions usually need this).`,
    );
  }

  // Login shells may echo profile/motd noise before the answer — the path is
  // the LAST non-empty line (same tolerance vscode-acp-main's AgentManager needs).
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const bin = lines[lines.length - 1] ?? '';
  if (!bin.startsWith('/')) {
    throw new Error(
      `'command -v hermes' returned no usable path (output: ${JSON.stringify(stdout.trim())}). ` +
        `Set the 'talaria.hermesPath' setting to the absolute path of the hermes executable.`,
    );
  }
  cachedHermesBin = bin;
  return bin;
}

/**
 * Test seam: resolve the real (symlink-free) path a discovered binary points
 * to. Default = `fs.promises.realpath`. Injectable alongside {@link ExecLookup}
 * so unit tests never touch the real FS (same seam idiom).
 */
export type RealpathLookup = (p: string) => Promise<string>;

const defaultRealpathLookup: RealpathLookup = (p) => fs.realpath(p);

/**
 * Test seam: verify a path exists. Default = `fs.promises.access`.
 * Injectable alongside {@link RealpathLookup} — same rationale.
 */
export type AccessCheck = (p: string) => Promise<void>;

const defaultAccessCheck: AccessCheck = (p) => fs.access(p);

/**
 * AU-7 / INV-9 / ADR-3: derive + verify the sibling venv interpreter for a
 * discovered `hermes` binary.
 *
 * 1. Realpath the binary FIRST — pipx (and most installers) expose console
 *    scripts as SYMLINKS into a versioned venv dir, so deriving off the
 *    symlink's own directory instead of its real target yields a path that
 *    does not exist (the AU-7 mechanism). A realpath failure (dangling
 *    link, permission denied) falls back to the lexical path rather than
 *    giving up — the existence check below still catches a bad result.
 * 2. Existence-check the derived interpreter before it is ever spawned. A
 *    miss throws an actionable error naming the `talaria.pythonPath`
 *    escape hatch instead of failing later as a cryptic exit-127.
 */
async function deriveAndVerifyPython(
  hermesBin: string,
  realpathImpl: RealpathLookup,
  accessImpl: AccessCheck,
): Promise<string> {
  let realBin: string;
  try {
    realBin = await realpathImpl(hermesBin);
  } catch {
    realBin = hermesBin;
  }
  const python = deriveVenvPython(realBin);
  try {
    await accessImpl(python);
  } catch {
    throw new Error(
      `Derived Python interpreter '${python}' (the venv sibling of 'hermes' at its real ` +
        `location '${realBin}') was not found. Set the 'talaria.pythonPath' setting to the ` +
        `absolute path of the interpreter that has Hermes installed (its venv 'bin/python').`,
    );
  }
  return python;
}

/**
 * Full resolution: binary → sibling python → both channel spawn specs, each
 * wrapped in the login shell. `MockBackend` never calls this.
 */
export async function resolveHermes(
  config: HermesRuntimeConfig,
  exec?: ExecLookup,
  realpathImpl: RealpathLookup = defaultRealpathLookup,
  accessImpl: AccessCheck = defaultAccessCheck,
): Promise<ResolvedHermes> {
  const hermesBin = await resolveHermesBin(config, exec);
  const python =
    config.pythonPath ?? (await deriveAndVerifyPython(hermesBin, realpathImpl, accessImpl));
  // AUDIT-5 SEC M-3 (F-2): no workspace open -> the agent runs from $HOME,
  // matching the manifest copy — never from process.cwd() (the EH inherits
  // the VS Code install dir).
  const cwd = config.cwd ?? os.homedir();

  return {
    hermesBin,
    python,
    cwd,
    // ACP channel: `hermes acp` (spec §3.1). Spawned via the ORIGINAL
    // discovered path (not the realpath target) — the user-visible path
    // works either way, and this stays what the user configured/PATH found.
    acp: loginShellSpawn(hermesBin, ['acp'], config),
    // Control channel: `python -m tui_gateway.entry` (spec §4.1).
    control: loginShellSpawn(python, ['-m', 'tui_gateway.entry'], config),
  };
}

// --- helpers ----------------------------------------------------------------

/** Normalize Windows separators so path math is stable on the dev box. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** POSIX single-quote escaping: wrap in '…', and encode embedded quotes. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
