/*
 * Typed bridge over the VS Code webview API.
 * ------------------------------------------------------------------
 * - In the extension host, `acquireVsCodeApi()` exists: post() -> postMessage,
 *   onMessage() listens to window 'message', get/setState() persist view state
 *   so the panel can rebuild after being disposed (see best-practices.md).
 * - Standalone (Vite dev / plain browser), the API is absent: we spin up the
 *   MockBackend, which plays the same host->webview messages so the whole UI
 *   renders and behaves from canned data with no extension present.
 */
import type { ControlRequestMethod, HostToWebview, WebviewToHost } from './protocol';
import { RpcClient } from './rpc';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type Listener = (msg: HostToWebview) => void;

class Bridge {
  private vscode: VsCodeApi | undefined;
  private listeners = new Set<Listener>();
  private mockHandler: ((msg: WebviewToHost) => void) | undefined;
  /**
   * The id-correlated request/response client (Part A2). Its `send` posts
   * `control.request` messages through this same bridge; inbound
   * `control.response` messages are routed to it in {@link emit} and NOT
   * broadcast to app listeners (they're RPC plumbing, not renderable state).
   */
  private readonly rpc = new RpcClient((req) => this.post(req));

  constructor() {
    try {
      this.vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    } catch {
      this.vscode = undefined;
    }

    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as HostToWebview | undefined;
      if (data && typeof data.type === 'string') {
        this.emit(data);
      }
    });

    // A#10 / corr-M5: when the view is being torn down (VS Code disposes the
    // webview, or the page unloads), reject every pending correlated request
    // PROMPTLY instead of leaving callers hanging until the 30s RPC timeout.
    // `pagehide` fires on webview disposal / navigation; it is the reliable
    // teardown signal here.
    window.addEventListener('pagehide', () => this.dispose());
  }

  /** Reject all in-flight correlated requests (view teardown). Idempotent. */
  dispose(): void {
    this.rpc.rejectAll('Hermes webview was disposed.');
  }

  /** True when running inside the real VS Code webview host. */
  get isHosted(): boolean {
    return this.vscode !== undefined;
  }

  /** Send a message to the host (or the mock in standalone mode). */
  post(msg: WebviewToHost): void {
    if (this.vscode) {
      this.vscode.postMessage(msg);
    } else if (this.mockHandler) {
      // defer so callers can finish their render pass first
      queueMicrotask(() => this.mockHandler?.(msg));
    }
  }

  /**
   * Issue a CORRELATED control invocation (Part A2) and await its result. Use
   * this when the webview needs the return value — a panel data fetch (so it
   * can render Loading/Error+Retry) or `checkpoint.restore`. Result-less
   * actions should keep using fire-and-forget {@link post}(`control.invoke`).
   * `tag` (W4-T3b §2e Deliverable 5), when given, is the chat-session tab
   * this request was issued from — see {@link rejectTab}.
   */
  request(method: ControlRequestMethod, params?: Record<string, unknown>, tag?: string): Promise<unknown> {
    return this.rpc.request(method, params, tag);
  }

  /**
   * W4-T3b (§2e Deliverable 5): reject every in-flight request tagged with
   * `tabId` — called on tab close, a per-tab sibling of {@link dispose}'s
   * whole-webview `rejectAll` (`pagehide`).
   */
  rejectTab(tabId: string, reason: string): void {
    this.rpc.rejectByTag(tabId, reason);
  }

  /** Subscribe to host->webview messages. Returns an unsubscribe fn. */
  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Deliver a host->webview message. `control.response` messages are consumed
   * by the RPC client (resolving the matching pending request) and NOT
   * broadcast to app listeners; everything else fans out to subscribers.
   */
  emit(msg: HostToWebview): void {
    if (this.rpc.handleResponse(msg)) return;
    for (const fn of this.listeners) fn(msg);
  }

  /** Register the standalone mock's inbound handler + delivery channel. */
  attachMock(handler: (msg: WebviewToHost) => void): (msg: HostToWebview) => void {
    this.mockHandler = handler;
    return (msg) => this.emit(msg);
  }

  getState<T = unknown>(): T | undefined {
    return this.vscode?.getState<T>();
  }

  setState<T = unknown>(state: T): void {
    this.vscode?.setState<T>(state);
  }
}

export const bridge = new Bridge();
