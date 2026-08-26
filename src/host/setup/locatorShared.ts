/**
 * WV3-MIN-FUNC (WS-SU): the shared core of the two login-shell binary
 * locators (`pipxLocator.ts` / `llamaCppLocator.ts` — the latter was a
 * documented verbatim clone of the former). Pure, vscode-free, subprocess-
 * free. Each locator re-exports {@link isExecTimeout} so its public API and
 * its REAL execFile-timeout pin test are unchanged.
 */

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
