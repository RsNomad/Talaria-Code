import { spawn } from 'node:child_process';

/**
 * The child-process spawner every runner uses. A module-level indirection so a
 * test can inject a fake `git` child (see {@link __setSpawnForTests}) — in
 * production this is always Node's real `spawn`.
 */
let spawnImpl: typeof spawn = spawn;

/**
 * TEST SEAM — not for production use. Overrides the spawner so a test can inject
 * a fake `git` child (e.g. one that never emits `close`, to exercise the
 * wall-clock timeout + SIGKILL path deterministically without a real hung
 * subprocess). Pass `null` to restore the real `spawn`.
 */
export function __setSpawnForTests(fn: typeof spawn | null): void {
  spawnImpl = fn ?? spawn;
}

/**
 * Thin `git` subprocess runner used by {@link ./CheckpointTracker}.
 *
 * No shell is involved (argv is passed directly to `spawn`, so there is no
 * quoting/injection surface), and every call site is required to pass an
 * explicit `env` — always the result of {@link ./gitEnv.sanitizeGitEnv} — so
 * a shadow-git command can never silently inherit `process.env` verbatim.
 *
 * ## Bounded capture (review S-M6c)
 * stdout/stderr are captured into memory with a hard per-stream byte cap
 * ({@link RunGitOptions.maxBufferBytes}, default {@link DEFAULT_MAX_BUFFER_BYTES}).
 * A pathological repo (e.g. a `git show`/`diff-tree` that emits gigabytes) can
 * no longer drive the extension host to OOM: once a stream crosses the cap the
 * child is killed and the call REJECTS with a typed {@link GitOutputLimitError}.
 * We deliberately fail rather than truncate — the callers here consume
 * tree/hash/name-status output where a silently-cut buffer would corrupt a
 * checkpoint or a restore.
 */
export interface RunGitOptions {
  /** Working directory for the `git` invocation. */
  cwd: string;
  /** Always a {@link ./gitEnv.sanitizeGitEnv} result — never raw `process.env`. */
  env: NodeJS.ProcessEnv;
  /** Piped to the child's stdin (e.g. NUL/newline-delimited pathspecs), then closed. */
  input?: string;
  /** When true, a non-zero exit code resolves instead of rejecting. */
  allowFailure?: boolean;
  /**
   * Max bytes captured from EACH of stdout/stderr before the call aborts with a
   * {@link GitOutputLimitError}. Defaults to {@link DEFAULT_MAX_BUFFER_BYTES}.
   */
  maxBufferBytes?: number;
  /**
   * Wall-clock timeout (ms) for the whole git invocation. On expiry the child is
   * SIGKILLed and the call REJECTS with a typed {@link GitTimeoutError}.
   *
   * This is what bounds the C1 pre-turn snapshot BARRIER (arch A#1): `withLock`
   * bounds only lock *acquisition* and {@link maxBufferBytes} bounds only *output
   * size*, so without this a stalled `git` — an NFS/sshfs worktree, a filesystem
   * stall, a wedged hook/credential prompt — would make the awaited snapshot
   * never settle and the user's prompt would silently never be sent.
   *
   * Defaults to {@link DEFAULT_GIT_TIMEOUT_MS}. Pass `0` (or a negative value) to
   * DISABLE the timeout for a legitimately long-running maintenance op
   * (`gc`/`repack`) that runs OFF the turn's critical path.
   */
  timeoutMs?: number;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * ~128 MiB. Generous enough for the largest legitimate outputs the checkpoint
 * engine reads (a captured file via `git show`, capped at ~2 MiB; a whole-tree
 * `diff-tree --name-status`), while still bounding a single git call's memory
 * so an adversarial/pathological repo cannot exhaust the host. Overridable
 * per-call via {@link RunGitOptions.maxBufferBytes}.
 */
const DEFAULT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

/**
 * Default wall-clock bound (15 s) for a single `git` invocation. Comfortably
 * above a warm-index snapshot's steady-state cost (tens of ms to sub-second even
 * on a ~6 K-file tree — research §3) yet low enough that a genuinely stalled git
 * frees the turn quickly (fail-open, unprotected). Overridable per call via
 * {@link RunGitOptions.timeoutMs}; background maintenance disables it with `0`.
 */
const DEFAULT_GIT_TIMEOUT_MS = 15_000;

/** Thrown when a git invocation's captured stdout/stderr exceeds the byte cap. */
export class GitOutputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOutputLimitError';
  }
}

/**
 * Thrown when a git invocation exceeds its {@link RunGitOptions.timeoutMs}
 * wall-clock bound. The child is SIGKILLed before the call rejects. Distinct
 * from {@link GitOutputLimitError} (too much output) and a plain non-zero exit:
 * this specifically means "the git child stalled and was force-killed" — the
 * signal the C1 barrier's fail-open path treats as "snapshot unavailable, run
 * the turn unprotected".
 */
export class GitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitTimeoutError';
  }
}

interface RawGitResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Spawn `git <args>` and collect stdout/stderr into bounded buffers. Rejects on
 * spawn error or when either stream exceeds the cap (killing the child first).
 * The exit-code → reject/resolve decision is left to the typed wrappers below.
 */
function spawnGitCollect(args: string[], options: RunGitOptions): Promise<RawGitResult> {
  return new Promise((resolve, reject) => {
    const cap = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const child = spawnImpl('git', args, { cwd: options.cwd, env: options.env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      // No shell wraps the child (argv is passed straight to spawn), so SIGKILL
      // reaches the git process directly rather than only a shell parent
      // (Node child_process docs: a shelled kill signals only the shell). Kill
      // is idempotent/harmless if the child is already gone.
      child.kill('SIGKILL');
      reject(err);
    };
    const succeed = (result: RawGitResult): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve(result);
    };

    // Wall-clock bound (arch A#1): SIGKILL a stalled git and reject with a typed
    // GitTimeoutError, so an awaited snapshot barrier can never hang the turn
    // forever. Node's `spawn` has a native `timeout`/`killSignal` option, but it
    // resolves `close` with `signal` set (code null) rather than surfacing a
    // typed reason — we drive the timeout ourselves so callers can distinguish a
    // force-killed stall from any other failure. `0`/negative disables it.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(
          new GitTimeoutError(
            `git ${args.join(' ')} exceeded the ${timeoutMs}ms wall-clock timeout and was ` +
              'SIGKILLed (a stalled git — e.g. an NFS/sshfs worktree, a filesystem stall, or a ' +
              'wedged hook/credential prompt).',
          ),
        );
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > cap) {
        fail(
          new GitOutputLimitError(
            `git ${args.join(' ')} exceeded the ${cap}-byte stdout capture cap; ` +
              'aborted to avoid unbounded memory use',
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > cap) {
        fail(
          new GitOutputLimitError(
            `git ${args.join(' ')} exceeded the ${cap}-byte stderr capture cap; ` +
              'aborted to avoid unbounded memory use',
          ),
        );
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    child.on('close', (code) =>
      succeed({ code, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) }),
    );

    // Attach the EPIPE guard UNCONDITIONALLY, before writing/closing stdin (M-1).
    // Even a NO-INPUT git call (`write-tree`/`ls-files`/`update-ref`/`show`) still
    // opens+ends stdin, and a kill/timeout (SIGKILL above) or a broken pipe can
    // surface an async `'error'` on `child.stdin`. Without a listener Node throws
    // on the EventEmitter and can CRASH the extension host — defeating the very
    // timeout path this module adds. Previously this listener lived only inside
    // the `input !== undefined` branch, so no-input calls were unguarded.
    child.stdin.on('error', () => undefined);
    if (options.input !== undefined) {
      // The pipe may already be closed if the child died (cap/timeout tripped);
      // the guard above swallows the resulting EPIPE rather than crash the host.
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

/** Run `git <args>`, capturing stdout/stderr as UTF-8 text (bounded — see module doc). */
export async function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
  const raw = await spawnGitCollect(args, options);
  const stdout = raw.stdout.toString('utf8');
  const stderr = raw.stderr.toString('utf8');
  if (raw.code !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (exit ${raw.code}): ${stderr.trim()}`);
  }
  return { code: raw.code, stdout, stderr };
}

/**
 * Same as {@link runGit} but resolves stdout as a raw `Buffer` — required for
 * `git show <tree>:<path>` so binary file content survives round-trip intact.
 * Still bounded by the same per-stream cap (see module doc).
 */
export async function runGitBinary(args: string[], options: RunGitOptions): Promise<Buffer> {
  const raw = await spawnGitCollect(args, options);
  if (raw.code !== 0 && !options.allowFailure) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${raw.code}): ${raw.stderr.toString('utf8').trim()}`,
    );
  }
  return raw.stdout;
}
