import { spawn, ChildProcess } from 'node:child_process';

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 *
 * This is the ONE transport primitive the spec (§2) calls for: both the ACP
 * channel (`hermes acp`) and the control channel (`python -m tui_gateway.entry`)
 * frame JSON on `\n`, correlate requests by `id`, and fan out `event` /
 * notification frames. So we build it once and use it twice.
 *
 * Design rules baked in from the spec / reference extensions:
 * - **stdout is protocol-only.** Every child stdout line is a JSON frame. All
 *   human logs go to stderr, which we forward to {@link Logger} untouched.
 * - **Traffic tap.** Every framed send/recv is logged (`→`/`←`) when a logger is
 *   provided — cheap and invaluable when debugging the wire (ported idea from
 *   `vscode-acp-main`).
 * - **Timeouts.** Per-request default 120s (long agent turns); overridable.
 * - **Kill discipline.** `dispose()` → SIGTERM, then SIGKILL after 5s.
 *
 * It intentionally does NOT depend on `vscode` so it is unit-testable and reused
 * by both channels. Logging + disposal use the tiny local shapes below.
 */

/** Minimal disposable so this module needn't import `vscode`. */
export interface Disposable {
  dispose(): void;
}

/** Where child stderr + the traffic tap are written (usually an OutputChannel). */
export interface Logger {
  append(line: string): void;
}

/** Handler for inbound notifications / `event` frames (no `id`). */
export type EventHandler = (method: string, params: unknown) => void;

/** How to launch the child. Spawn options mirror `child_process.spawn`. */
export interface JsonRpcStdioOptions {
  /** Executable to run (already resolved — see {@link ../runtime/resolveHermes}). */
  command: string;
  /** Argument vector, e.g. `['acp']` or `['-m', 'tui_gateway.entry']`. */
  args: string[];
  /** Working directory for the child. */
  cwd?: string;
  /** Environment for the child (defaults to the host's `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Optional output sink for stderr + the traffic tap. */
  logger?: Logger;
  /** Per-request timeout in ms (default 120_000). */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface JsonRpcResponseFrame {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotificationFrame {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;

export class JsonRpcStdio implements Disposable {
  private readonly child: ChildProcess;
  private readonly logger?: Logger;
  private readonly requestTimeoutMs: number;

  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();

  /** Partial-line buffer for stdout (frames may straddle chunk boundaries). */
  private stdoutBuffer = '';
  private disposed = false;

  constructor(options: JsonRpcStdioOptions) {
    this.logger = options.logger;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.log(`spawn: ${options.command} ${options.args.join(' ')}`);
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) =>
      this.log(`[stderr] ${chunk.replace(/\n$/, '')}`),
    );

    this.child.on('error', (err) =>
      this.rejectAll(new Error(`child process error: ${String(err)}`)),
    );
    this.child.on('exit', (code) => {
      this.log(`child exited with code ${code}`);
      this.rejectAll(new Error(`child exited (code ${code}) before reply`));
      for (const h of this.exitHandlers) h(code);
    });
  }

  // --- public API -----------------------------------------------------------

  /**
   * Send an id-correlated request and await its result. Rejects on JSON-RPC
   * error frames, on child exit, and after {@link requestTimeoutMs}.
   */
  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('JsonRpcStdio disposed'));
    }
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0' as const, id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request '${method}' (id ${id}) timed out ` +
          `after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });
      this.send(frame);
    });
  }

  /** Fire-and-forget notification (no `id`, no reply expected). */
  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Subscribe to inbound notifications / `event` frames. */
  onEvent(handler: EventHandler): Disposable {
    this.eventHandlers.add(handler);
    return { dispose: () => this.eventHandlers.delete(handler) };
  }

  /** Subscribe to child exit (e.g. to trigger crash-respawn upstream). */
  onExit(handler: (code: number | null) => void): Disposable {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  /** SIGTERM the child, escalate to SIGKILL after a grace period, drop state. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error('JsonRpcStdio disposed'));
    this.eventHandlers.clear();

    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      // Don't hold the event loop open just for the escalation timer.
      killTimer.unref?.();
    }
  }

  // --- internals ------------------------------------------------------------

  private send(frame: object): void {
    const line = JSON.stringify(frame) + '\n';
    this.log(`→ ${line.trimEnd()}`);
    this.child.stdin?.write(line);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) this.handleFrame(line);
    }
  }

  private handleFrame(line: string): void {
    this.log(`← ${line}`);
    let frame: JsonRpcResponseFrame | JsonRpcNotificationFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.log(`[warn] non-JSON stdout line dropped: ${line}`);
      return;
    }

    // Response frame (has an id we're waiting on).
    if ('id' in frame && frame.id !== undefined && this.pending.has(frame.id)) {
      const response = frame as JsonRpcResponseFrame;
      const pending = this.pending.get(response.id)!;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) {
        pending.reject(
          new Error(`${pending.method} failed [${response.error.code}]: ` +
            response.error.message),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    // Notification / event frame (dispatch to listeners).
    const note = frame as JsonRpcNotificationFrame;
    if (note.method) {
      for (const handler of this.eventHandlers) {
        try {
          handler(note.method, note.params);
        } catch (err) {
          this.log(`[warn] event handler threw: ${String(err)}`);
        }
      }
    }
  }

  private rejectAll(reason: unknown): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private log(message: string): void {
    this.logger?.append(`[JsonRpcStdio] ${message}`);
  }
}
