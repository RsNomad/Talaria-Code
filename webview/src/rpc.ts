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
  /**
   * AU-9/INV-13 (TE-2): this client's page-instance id — stamped on every
   * outgoing `control.request` and checked against every inbound
   * `control.response` (see {@link RpcClient.handleResponse}). Injectable for
   * tests; the production caller (`bridge.ts`) mints one fresh id per page
   * (re)construction. Defaults to a fresh {@link generateInstanceId} id here
   * so direct `new RpcClient(...)` callers (most of this file's own tests)
   * keep working unmodified.
   */
  instanceId?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * AU-9/INV-13: fallback per-instance id generator — mirrors the
 * `crypto.randomUUID?.() ?? Math.random()…` shape `Composer.tsx` already uses
 * for its per-attachment ids (this codebase's established "mint a fresh id,
 * prefer the CSPRNG when present" pattern), reused here rather than invented
 * fresh.
 */
function generateInstanceId(): string {
  return crypto.randomUUID?.() ?? `rpc-${Math.random().toString(36).slice(2)}`;
}

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
  // beta.5 T2 (§0.1 ⑦ / §2.1): `setup.install`/`setup.pullModel` are the
  // long-running Setup mutations (pipx/hermes install, model pull) that used
  // to hit `control.request 'setup.install' timed out after 30000ms` while
  // the host was still legitimately working. `0` disables the timer
  // entirely (see `if (effectiveTimeoutMs > 0)` below) rather than arming a
  // longer one — these ops have no fixed upper bound, and `pagehide ->
  // rejectAll` (bridge.ts) plus the rendered Cancel affordance during
  // `installing` already bound the pending-forever risk. `setup.testRemote`
  // is a bounded network probe, not a long-running install/pull, and stays
  // on the ordinary 30s default (deliberately absent from this table).
  'setup.install': 0,
  'setup.pullModel': 0,
  // beta.6 T9 (§1.3/§2.5 RPC rows: `'setup.provisionModel': 0`): the
  // catalog-provisioning gate (T7) is the same unbounded-download shape as
  // `setup.install`/`setup.pullModel` above — a multi-GB Devstral download
  // or a slow llama.cpp GGUF pull must not be killed by the 30s connection
  // default. `0` disables the timer entirely, same discipline as the two
  // overrides above (Cancel + `pagehide -> rejectAll` bound the risk).
  'setup.provisionModel': 0,
};

export class RpcClient {
  private seq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** AU-9/INV-13: this client's page-instance id — see {@link RpcOptions.instanceId}. */
  private readonly instanceId: string;

  constructor(
    private readonly send: (req: ControlRequest) => void,
    opts: RpcOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.instanceId = opts.instanceId ?? generateInstanceId();
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
      this.send({ type: 'control.request', requestId, method, params, instanceId: this.instanceId });
    });
  }

  /**
   * Route an inbound host message. Returns `true` iff it was a
   * `control.response` (i.e. RPC plumbing this client consumed) — the bridge
   * uses that to withhold responses from ordinary app listeners. A response
   * with no matching pending id (stale/duplicate) is still "consumed" (returns
   * `true`) but silently dropped.
   *
   * AU-9/INV-13 (TE-2): a response stamped with a PRIOR page instance's id is
   * a late settle from a webview that was reloaded/re-created out from under
   * it — its numeric `requestId` may collide with an unrelated pending
   * request THIS (new) instance's own `seq` (which restarts at 0 per
   * instance) happens to have reused. That response is dropped here, BEFORE
   * ever touching `pending`, so it can never resolve/reject the wrong
   * caller. An ABSENT `instanceId` (e.g. the standalone `MockBackend`, which
   * never echoes one) is NOT treated as a mismatch — it is trusted and
   * resolved normally, so that additive, defensive rollout path needs no
   * change.
   */
  handleResponse(msg: HostToWebview): boolean {
    if (msg.type !== 'control.response') return false;
    if (msg.instanceId !== undefined && msg.instanceId !== this.instanceId) return true;
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
