import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

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
 */
export type ExecLookup = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; cwd: string },
) => Promise<string>;

const defaultExecLookup: ExecLookup = (command, args, opts) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: opts.timeoutMs, cwd: opts.cwd }, (err, stdout) => {
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
 * Full resolution: binary → sibling python → both channel spawn specs, each
 * wrapped in the login shell. `MockBackend` never calls this.
 */
export async function resolveHermes(
  config: HermesRuntimeConfig,
  exec?: ExecLookup,
): Promise<ResolvedHermes> {
  const hermesBin = await resolveHermesBin(config, exec);
  const python = config.pythonPath ?? deriveVenvPython(hermesBin);
  // AUDIT-5 SEC M-3 (F-2): no workspace open -> the agent runs from $HOME,
  // matching the manifest copy — never from process.cwd() (the EH inherits
  // the VS Code install dir).
  const cwd = config.cwd ?? os.homedir();

  return {
    hermesBin,
    python,
    cwd,
    // ACP channel: `hermes acp` (spec §3.1).
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
