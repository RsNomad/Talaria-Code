import * as os from 'node:os';
import * as path from 'node:path';
import { loginShellSpawn, type ExecLookup } from '../runtime/resolveHermes';

/**
 * llama.cpp `llama-server` binary locator
 * (docs_claude/beta6-unified-local-model-onboarding-architecture.md §2.4;
 * Task T5 of the beta.6 build). Close clone of `pipxLocator.ts`'s probe
 * pattern — see that file's header for the full login-shell-routing
 * rationale, reproduced only where it differs below.
 *
 * PURE LOGIC — no `vscode` import (matching `pipxLocator.ts`'s own
 * discipline; the only type-level dependency on `resolveHermes.ts`,
 * `ExecLookup`, is erased at compile — the VALUE import, `loginShellSpawn`,
 * is safe too, that module itself is vscode-free). All subprocess I/O is
 * routed through the caller-injected `ExecLookup` seam, so unit tests never
 * touch a real shell (except the one REAL execFile-timeout test that pins
 * {@link isExecTimeout} against Node's actual timeout error shape — Global
 * Constraint 4, cloned verbatim from `pipxLocator.test.ts`).
 *
 * Three DISTINCT outcomes (the honesty rule carried over from beta.5 ④,
 * §2.4 CC-5): `found` (binary on PATH, best-effort version), `not-found`
 * (the login shell gave a clean "no such command" answer), and
 * `probe-timeout` (the probe itself never got an answer — this is NEVER
 * collapsed into `not-found`; the controller/wire layer maps it to the
 * `'unknown'` state, never `'missing'`, so the UI can say "couldn't check"
 * instead of falsely claiming "not installed").
 *
 * Recipe (§2.4, line 308):
 *   0. `command -v llama-server` inside the login shell (5s budget; a
 *      TIMEOUT — never any other error — retries once at 10s; a clean miss
 *      on EITHER attempt ends the lookup immediately as `not-found`, no
 *      retry, no fallback — exit 127 is exactly this case).
 *   1. If BOTH attempts timed out, probe absolute candidates directly (no
 *      shell, no profile to wait on) in PATH-precedence order:
 *      `~/.local/bin/llama-server`, `/usr/local/bin/llama-server`,
 *      `/usr/bin/llama-server`. Each candidate's own `--version` call is
 *      BOTH its presence check and (on success) its version source — no
 *      redundant second call. Every candidate failing to answer is the
 *      only path to `probe-timeout`.
 *   2. Once a path is resolved via step 0 (which has no version yet), run
 *      `<path> --version` once more (2s budget, through the login shell —
 *      matches every other non-builtin call in this module) purely to
 *      populate the optional `version` field. This call is BEST-EFFORT: a
 *      failure here does not downgrade an already-confirmed `found` result
 *      — the path is real (the login shell just told us so), only the
 *      cosmetic version string is missing.
 */

/** Typed probe result — the exact shape the controller (T6) consumes. */
export type LlamaCppLocateResult =
  | { ok: true; path: string; version?: string }
  | { ok: false; reason: 'not-found' | 'probe-timeout'; detail: string };

/** Step-0 `command -v llama-server` first-attempt budget — matches
 *  `pipxLocator.ts`'s `PIPX_STEP0_TIMEOUT_MS`. */
const STEP0_TIMEOUT_MS = 5_000;

/** Step-0 retry budget after the first attempt times out. */
const STEP0_RETRY_TIMEOUT_MS = 10_000;

/** Absolute-candidate fallback budget — short, because by the time this
 *  fallback runs the login shell has ALREADY failed twice (15s spent);
 *  these are direct `execFile` calls with no shell/profile to wait on. */
const ABSOLUTE_CANDIDATE_TIMEOUT_MS = 2_000;

/** Best-effort post-resolution `<path> --version` budget — short because a
 *  failure here never changes the `found` verdict, only whether `version`
 *  is populated. */
const VERSION_PROBE_TIMEOUT_MS = 2_000;

/** §6 copy — same wording `pipxLocator.ts` uses for its own `probe-timeout`
 *  detail (the identical honesty framing applies: a probe that never got an
 *  answer, not a probe that got a clean "not installed" answer). */
const PROBE_TIMEOUT_DETAIL =
  "Your login shell didn't answer in time — a slow shell profile (nvm, conda, a network home directory) can cause this. It's usually transient: press Re-check.";

/**
 * Classify a rejected `ExecLookup` error as a TIMEOUT kill specifically —
 * cloned verbatim from `pipxLocator.ts`'s `isExecTimeout` (Node's
 * `execFile` sets `err.killed = true` — and usually `err.signal =
 * 'SIGTERM'` — both when the `timeout` option fires AND when the child is
 * killed for exceeding `maxBuffer`; the latter must NOT be treated as a
 * login-shell slowness signal, excluded via Node's own `err.code`).
 */
export function isExecTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { killed?: unknown; signal?: unknown; code?: unknown };
  const killedOrSigterm = e.killed === true || e.signal === 'SIGTERM';
  return killedOrSigterm && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/**
 * Locate `llama-server` and (best-effort) its version. Never throws for the
 * two SCRIPTED failure modes (`not-found`, `probe-timeout`) — those are
 * returned as typed results.
 */
export async function locateLlamaServer(exec: ExecLookup): Promise<LlamaCppLocateResult> {
  const cwd = os.homedir();

  const lookup = await findLlamaServerPath(exec, cwd);
  if (lookup.kind === 'probe-timeout') {
    return { ok: false, reason: 'probe-timeout', detail: PROBE_TIMEOUT_DETAIL };
  }
  if (lookup.kind === 'missing') {
    return {
      ok: false,
      reason: 'not-found',
      detail:
        "'command -v llama-server' found no llama-server on the login-shell PATH. " +
        'Install or build llama.cpp, then press Re-check.',
    };
  }

  const version = lookup.version ?? (await tryGetVersion(exec, lookup.path, cwd));
  return { ok: true, path: lookup.path, ...(version ? { version } : {}) };
}

// --- internals ---------------------------------------------------------

/** The three outcomes step 0 (+ its absolute-candidate fallback) can
 *  resolve to. `probe-timeout` is reached ONLY after both the login-shell
 *  lookup (5s, then a 10s retry) AND every absolute-candidate fallback have
 *  failed to answer in time. A fallback candidate's own successful
 *  `--version` call doubles as its version source (`version` present here
 *  means `locateLlamaServer` skips the redundant post-resolution probe). */
type LlamaServerLookup =
  | { kind: 'found'; path: string; version?: string }
  | { kind: 'missing' }
  | { kind: 'probe-timeout' };

/**
 * Step 0 — locate `llama-server` on the login-shell PATH. The login shell
 * remains the semantic authority for WHICH binary is used (matching
 * `pipxLocator.ts`'s `findPipxPath` rationale verbatim): absolute
 * candidates are consulted ONLY when the login shell itself could not
 * answer twice in a row, never as a faster substitute for it.
 */
async function findLlamaServerPath(exec: ExecLookup, cwd: string): Promise<LlamaServerLookup> {
  const spec = loginShellSpawn('command', ['-v', 'llama-server'], undefined, { exec: false });

  let stdout: string;
  try {
    stdout = await exec(spec.command, spec.args, { timeoutMs: STEP0_TIMEOUT_MS, cwd });
  } catch (firstErr) {
    if (!isExecTimeout(firstErr)) return { kind: 'missing' };
    try {
      stdout = await exec(spec.command, spec.args, { timeoutMs: STEP0_RETRY_TIMEOUT_MS, cwd });
    } catch (secondErr) {
      if (!isExecTimeout(secondErr)) return { kind: 'missing' };
      return probeAbsoluteCandidates(exec, cwd);
    }
  }

  const line = lastNonEmptyLine(stdout);
  return line.startsWith('/') ? { kind: 'found', path: line } : { kind: 'missing' };
}

/** PATH-precedence order: a user-local build (`~/.local/bin`, a common
 *  from-source llama.cpp install location), then `/usr/local/bin` (the
 *  typical `make install`/manual-build target), then the distro package
 *  path `/usr/bin`. Called with NO shell — direct `execFile` probes. */
function absoluteCandidatePaths(): string[] {
  return [
    path.join(os.homedir(), '.local', 'bin', 'llama-server'),
    '/usr/local/bin/llama-server',
    '/usr/bin/llama-server',
  ];
}

async function probeAbsoluteCandidates(exec: ExecLookup, cwd: string): Promise<LlamaServerLookup> {
  for (const candidate of absoluteCandidatePaths()) {
    try {
      const raw = await exec(candidate, ['--version'], { timeoutMs: ABSOLUTE_CANDIDATE_TIMEOUT_MS, cwd });
      const version = lastNonEmptyLine(raw);
      return { kind: 'found', path: candidate, ...(version ? { version } : {}) };
    } catch {
      // Try the next candidate; every candidate failing falls through to
      // 'probe-timeout' below.
    }
  }
  return { kind: 'probe-timeout' };
}

/** Best-effort `<path> --version` for a path already confirmed present via
 *  step 0 — routed through the login shell (matching every other non-
 *  builtin call in this module), single-shot (no retry: a slow/failing
 *  version call must never turn an already-confirmed `found` into anything
 *  else). */
async function tryGetVersion(exec: ExecLookup, binPath: string, cwd: string): Promise<string | undefined> {
  try {
    const spec = loginShellSpawn(binPath, ['--version']);
    const raw = await exec(spec.command, spec.args, { timeoutMs: VERSION_PROBE_TIMEOUT_MS, cwd });
    const line = lastNonEmptyLine(raw);
    return line || undefined;
  } catch {
    return undefined;
  }
}

/** Login shells may echo profile/motd noise before the answer — same
 *  tolerance `pipxLocator.ts`/`resolveHermes.ts` need. */
function lastNonEmptyLine(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}
