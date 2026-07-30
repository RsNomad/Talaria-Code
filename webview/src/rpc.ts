/*
 * RpcClient — id-correlated request/response over the webview->host bridge
 * (Part A2).
 *
 * The webview posts `control.request` messages carrying a monotonic
 * `requestId`; the host echoes that id back on a `control.response`. This class
 * keeps the pending-promise map and resolves/rejects the exact caller when the
 * matching reply arrives. It is the minimal in-house form of TypeFox
 * `vscode-messenger`'s `RequestType<P,R>` (`sendRequest` returns a Promise;
 * `onRequest` returns a result; correlation is by an internal msgId) — chosen
 * over the dependency because we need exactly ONE narrow RPC surface layered on
 * the bridge we already own.
 *
 * Pure and transport-agnostic: it takes a `send` sink and is fed inbound
 * messages via {@link handleResponse}. `bridge.ts` wires both ends.
 */
import type { ControlRequestMethod, HostToWebview, WebviewToHost } from './protocol';

type ControlRequest = Extract<WebviewToHost, { type: 'control.request' }>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  clearTimer: () => void;
  /** W4-T3b (§2e Deliverable 5): the chat-session tab that issued this
   * request, if any — lets {@link rejectByTag} reject exactly one tab's
   * in-flight requests on close (a per-tab sibling of {@link rejectAll}'s
   * whole-webview teardown reject). `undefined` for connection-global
   * requests no single tab owns. */
  tag?: string;
}

export interface RpcOptions {
  /**
   * ms before an unanswered request rejects with a timeout — a safety net for
   * a response that never arrives (e.g. the view was disposed mid-request).
   * `0`/omitted disables the timer. Longer than the ~15s gateway handshake so a
   * slow first control call isn't killed prematurely.
   */
  timeoutMs?: number;
  /** Injectable timers (default: globals) — tests drive the timeout deterministically. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * T-12 (Tier-2 remediation, RPC deadline): `DEFAULT_TIMEOUT_MS` is shorter
 * than the host's real checkpoint-restore time (the host side runs up to
 * ~120s for a real worktree restore) — a slow-but-successful restore used to
 * time out HERE first, which reads as a false "failed" AND re-arms the
 * destructive "Restore anyway" confirmation for a restore that actually
 * succeeded. `checkpoint.restore`/`checkpoint.redo` get a per-method
 * timeout independent of the connection default (see {@link request}).
 *
 * `checkpoint.redoAll` (audit-3 Code M-2) is included here BY SYMMETRY with
 * `checkpoint.redo` — a redo-all runs the same worktree-restore machinery on
 * the host side and is at least as slow as a single redo, so leaving it on
 * the 30s default was an oversight (it inherited the same false-timeout
 * failure mode T-12 fixed for restore/redo), not a deliberate scoping
 * decision. Every other method keeps the ordinary default.
 */
const METHOD_TIMEOUT_OVERRIDES_MS: Partial<Record<ControlRequestMethod, number>> = {
  'checkpoint.restore': 150_000,
  'checkpoint.redo': 150_000,
  'checkpoint.redoAll': 150_000,
};

export class RpcClient {
  private seq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly send: (req: ControlRequest) => void,
    opts: RpcOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Issue a correlated control invocation. Resolves with the host's
   * `result` (or rejects with its error / a timeout). `tag` (W4-T3b), when
   * given, is the chat-session tab this request belongs to — see
   * {@link rejectByTag}.
   */
  request(method: ControlRequestMethod, params?: Record<string, unknown>, tag?: string): Promise<unknown> {
    const requestId = ++this.seq;
    // T-12: a per-method override (e.g. `checkpoint.restore`) wins over the
    // connection default outright — it is not itself configurable via
    // `opts.timeoutMs`, which only ever tunes the DEFAULT.
    const effectiveTimeoutMs = METHOD_TIMEOUT_OVERRIDES_MS[method] ?? this.timeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      let handle: unknown;
      const clearTimerFn = () => {
        if (handle !== undefined) this.clearTimer(handle);
      };
      if (effectiveTimeoutMs > 0) {
        handle = this.setTimer(() => {
          if (this.pending.delete(requestId)) {
            reject(new Error(`control.request '${method}' timed out after ${effectiveTimeoutMs}ms`));
          }
        }, effectiveTimeoutMs);
      }
      this.pending.set(requestId, { resolve, reject, clearTimer: clearTimerFn, tag });
      this.send({ type: 'control.request', requestId, method, params });
    });
  }

  /**
   * Route an inbound host message. Returns `true` iff it was a
   * `control.response` (i.e. RPC plumbing this client consumed) — the bridge
   * uses that to withhold responses from ordinary app listeners. A response
   * with no matching pending id (stale/duplicate) is still "consumed" (returns
   * `true`) but silently dropped.
   */
  handleResponse(msg: HostToWebview): boolean {
    if (msg.type !== 'control.response') return false;
    const entry = this.pending.get(msg.requestId);
    if (!entry) return true;
    this.pending.delete(msg.requestId);
    entry.clearTimer();
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error.message));
    return true;
  }

  /** Reject every in-flight request (e.g. on view teardown). */
  rejectAll(reason: string): void {
    for (const entry of this.pending.values()) {
      entry.clearTimer();
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * W4-T3b (§2e Deliverable 5): reject every in-flight request tagged with
   * `tag` (a closed tab's id) — a per-tab sibling of {@link rejectAll} that
   * leaves every OTHER tab's (and every untagged, connection-global) request
   * untouched.
   */
  rejectByTag(tag: string, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.tag !== tag) continue;
      entry.clearTimer();
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
