/**
 * WV3-MIN-FUNC (WS-SU) + FI-10 (WS-F8 F8-1): the shared core of the two
 * login-shell binary locators (`pipxLocator.ts` / `llamaCppLocator.ts` — the
 * latter was a documented verbatim clone of the former). Pure, vscode-free —
 * all subprocess I/O is routed through the caller-injected `ExecLookup` seam
 * (`exec`), never spawned directly here. Each locator re-exports
 * {@link isExecTimeout} so its public API and its REAL execFile-timeout pin
 * test are unchanged.
 */

import { loginShellSpawn, type ExecLookup } from '../runtime/resolveHermes';

/**
 * Classify a rejected `ExecLookup` error as a TIMEOUT kill specifically —
 * Node's `execFile` sets `err.killed = true` (usually `err.signal =
 * 'SIGTERM'`) both when the `timeout` option fires AND when the child is
 * killed for exceeding `maxBuffer`; the latter must NOT be treated as a
 * login-shell slowness signal (excluded via Node's own `err.code`).
 */
export function isExecTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { killed?: unknown; signal?: unknown; code?: unknown };
  const killedOrSigterm = e.killed === true || e.signal === 'SIGTERM';
  return killedOrSigterm && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/** Abort check between pipeline steps — the locators' shared idiom. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

/** Login shells may echo profile/motd noise before the answer — take the
 *  last non-empty line. */
export function lastNonEmptyLine(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/** §6 copy — the honest "probe never got an answer" framing surfaced when
 *  BOTH the login-shell lookup AND every absolute-candidate fallback have
 *  failed to answer in time (FI-10, WS-F8 F8-1: previously duplicated
 *  verbatim in both `pipxLocator.ts` and `llamaCppLocator.ts`; single-sourced
 *  here so both locators import the one copy). Drift-locked against
 *  `internal-notes/setup-architecture-notes.md` §6's "probe-timeout
 *  detail (C1)" row. */
export const PROBE_TIMEOUT_DETAIL =
  "Your login shell didn't answer in time — a slow shell profile (nvm, conda, a network home directory) can cause this. It's usually transient: press Re-check.";

/**
 * Per-locator specifics {@link locateOnLoginPath} needs to run the shared
 * step-0-login-shell-lookup + absolute-candidate-probe recipe both
 * `pipxLocator.ts` and `llamaCppLocator.ts` run (FI-10, WS-F8 F8-1): the
 * binary name for `command -v <binary>`, the absolute-candidate probe list
 * (PATH-precedence order — the caller's own), the three timeouts, and
 * whether a candidate hit's own `--version` output doubles as the resolved
 * version (llama.cpp) or is discarded (pipx — presence-only).
 */
export interface LocateOnLoginPathSpec {
  binary: string;
  candidates: readonly string[];
  timeouts: { step0: number; retry: number; candidate: number };
  captureVersion: boolean;
}

/**
 * The three outcomes step 0 (+ its absolute-candidate fallback) can resolve
 * to. `probe-timeout` is reached ONLY after both the login-shell lookup
 * (`spec.timeouts.step0`, then a `spec.timeouts.retry`) AND every absolute
 * candidate have failed to answer in time. A fallback candidate's own
 * successful `--version` call doubles as its version source when
 * `spec.captureVersion` is set (`version` present here means the caller can
 * skip a redundant post-resolution probe).
 */
export type LoginPathLookup =
  | { kind: 'found'; path: string; version?: string }
  | { kind: 'missing' }
  | { kind: 'probe-timeout' };

/**
 * Shared step-0 login-shell lookup (FI-10, WS-F8 F8-1) — extracted verbatim
 * from `pipxLocator.ts`'s `findPipxPath` / `llamaCppLocator.ts`'s
 * `findLlamaServerPath` (the two were a documented clone of each other). The
 * login shell remains the semantic authority for WHICH binary is used:
 * absolute candidates are consulted ONLY when the login shell itself could
 * not answer twice in a row, never as a faster substitute for it — a fast
 * path there would silently pick a DIFFERENT binary (different PATH
 * precedence) than the one the user's own terminal would find.
 *
 * - First attempt: `spec.timeouts.step0` budget.
 * - A TIMEOUT (never any other error) retries once at `spec.timeouts.retry`.
 * - A clean miss (non-timeout error — e.g. `command -v <binary>` exiting
 *   non-zero because the binary genuinely isn't installed) on EITHER attempt
 *   ends the lookup immediately as `missing` — no retry, no fallback.
 * - If BOTH timed out, probe `spec.candidates` directly (no shell, no
 *   profile to wait on) in the caller's own PATH-precedence order. Each
 *   candidate's own `--version` call is its presence check (and, when
 *   `spec.captureVersion` is set, its version source too — no redundant
 *   second call). Every candidate failing to answer is the only path to
 *   `probe-timeout`.
 */
export async function locateOnLoginPath(
  exec: ExecLookup,
  spec: LocateOnLoginPathSpec,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<LoginPathLookup> {
  const shellSpec = loginShellSpawn('command', ['-v', spec.binary], undefined, { exec: false });

  let stdout: string;
  try {
    stdout = await exec(shellSpec.command, shellSpec.args, {
      timeoutMs: spec.timeouts.step0,
      cwd,
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (firstErr) {
    // TC-5/AU-28: an abort takes priority over the timeout classifier — Node
    // sets `killed`/`signal` on an abort-driven kill too (the same shape a
    // genuine timeout produces), so without this check a scoped recheck
    // cancel could be misread as "the login shell was merely slow" and
    // silently retried instead of propagating the cancellation.
    if (signal?.aborted) throw firstErr;
    if (!isExecTimeout(firstErr)) return { kind: 'missing' };
    try {
      stdout = await exec(shellSpec.command, shellSpec.args, {
        timeoutMs: spec.timeouts.retry,
        cwd,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (secondErr) {
      if (signal?.aborted) throw secondErr;
      if (!isExecTimeout(secondErr)) return { kind: 'missing' };
      return probeAbsoluteCandidates(exec, spec, cwd, signal);
    }
  }

  const line = lastNonEmptyLine(stdout);
  return line.startsWith('/') ? { kind: 'found', path: line } : { kind: 'missing' };
}

async function probeAbsoluteCandidates(
  exec: ExecLookup,
  spec: LocateOnLoginPathSpec,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<LoginPathLookup> {
  for (const candidate of spec.candidates) {
    try {
      const raw = await exec(candidate, ['--version'], {
        timeoutMs: spec.timeouts.candidate,
        cwd,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!spec.captureVersion) return { kind: 'found', path: candidate };
      const version = lastNonEmptyLine(raw);
      return { kind: 'found', path: candidate, ...(version ? { version } : {}) };
    } catch (err) {
      // TC-5/AU-28: an abort must propagate, not be swallowed as "try the
      // next candidate" — the whole point of a cancel is to stop probing.
      if (signal?.aborted) throw err;
      // Try the next candidate; every candidate failing falls through to
      // 'probe-timeout' below.
    }
  }
  return { kind: 'probe-timeout' };
}
