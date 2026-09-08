import * as os from 'node:os';
import * as path from 'node:path';
import { loginShellSpawn, type ExecLookup } from '../runtime/resolveHermes';
import {
  PROBE_TIMEOUT_DETAIL,
  lastNonEmptyLine,
  locateOnLoginPath,
  throwIfAborted,
  type LocateOnLoginPathSpec,
} from './locatorShared';

export { isExecTimeout } from './locatorShared';

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
 *
 * `isExecTimeout`/`throwIfAborted`/`lastNonEmptyLine` (WS-SU) and the step-0
 * lookup itself, `locateOnLoginPath` (FI-10, WS-F8 F8-1) — this module's
 * clone of `pipxLocator.ts`'s recipe — are the shared core extracted to
 * `locatorShared.ts`; this module is now a CALLER building its own `spec`
 * (see {@link llamaServerSpec}) and mapping the generic
 * `found`/`missing`/`probe-timeout` result to its own `LlamaCppLocateResult`.
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

/**
 * Locate `llama-server` and (best-effort) its version. Never throws for the
 * two SCRIPTED failure modes (`not-found`, `probe-timeout`) — those are
 * returned as typed results. An aborted `signal` propagates as a rejected
 * `AbortError` — both checked between steps (see {@link throwIfAborted}) AND,
 * since TC-5/AU-28, threaded into EVERY exec() call's own opts, so an
 * in-flight 5-10s login-shell probe is actually killed instead of running to
 * its own timeout regardless of a scoped `setup.recheck` cancel.
 */
export async function locateLlamaServer(exec: ExecLookup, signal?: AbortSignal): Promise<LlamaCppLocateResult> {
  const cwd = os.homedir();

  throwIfAborted(signal);
  const lookup = await locateOnLoginPath(exec, llamaServerSpec(), cwd, signal);
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

  throwIfAborted(signal);
  const version = lookup.version ?? (await tryGetVersion(exec, lookup.path, cwd, signal));
  return { ok: true, path: lookup.path, ...(version ? { version } : {}) };
}

// --- internals ---------------------------------------------------------

/**
 * This locator's `spec` for the shared `locateOnLoginPath` core
 * (`locatorShared.ts`, FI-10, WS-F8 F8-1): the step-0 binary name, the
 * absolute-candidate probe list in PATH-precedence order (a user-local build
 * — `~/.local/bin`, a common from-source llama.cpp install location — then
 * `/usr/local/bin`, the typical `make install`/manual-build target, then the
 * distro package path `/usr/bin`), this module's own timeouts, and
 * `captureVersion: true` — a fallback candidate's own successful `--version`
 * call doubles as its version source (`locateLlamaServer` then skips the
 * redundant post-resolution probe).
 */
function llamaServerSpec(): LocateOnLoginPathSpec {
  return {
    binary: 'llama-server',
    candidates: [
      path.join(os.homedir(), '.local', 'bin', 'llama-server'),
      '/usr/local/bin/llama-server',
      '/usr/bin/llama-server',
    ],
    timeouts: { step0: STEP0_TIMEOUT_MS, retry: STEP0_RETRY_TIMEOUT_MS, candidate: ABSOLUTE_CANDIDATE_TIMEOUT_MS },
    captureVersion: true,
  };
}

/** Best-effort `<path> --version` for a path already confirmed present via
 *  step 0 — routed through the login shell (matching every other non-
 *  builtin call in this module), single-shot (no retry: a slow/failing
 *  version call must never turn an already-confirmed `found` into anything
 *  else). TC-5/AU-28: "best-effort" covers an ordinary probe failure (the
 *  binary not supporting `--version`, etc.) — an explicit Cancel is not that;
 *  it still propagates rather than being silently swallowed into "found, no
 *  version". */
async function tryGetVersion(
  exec: ExecLookup,
  binPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const spec = loginShellSpawn(binPath, ['--version']);
    const raw = await exec(spec.command, spec.args, {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      cwd,
      ...(signal !== undefined ? { signal } : {}),
    });
    const line = lastNonEmptyLine(raw);
    return line || undefined;
  } catch (err) {
    if (signal?.aborted) throw err;
    return undefined;
  }
}
