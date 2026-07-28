import type { Logger, JsonRpcStdioOptions } from '../transport/JsonRpcStdio';
import { JsonRpcStdio } from '../transport/JsonRpcStdio';
import type { HermesRuntimeConfig } from '../runtime/resolveHermes';
import { resolveHermes } from '../runtime/resolveHermes';
import { parseGatewayEvent, isGatewayReady } from './eventDemux';
import { respawnBackoffMs } from './respawnBackoff';

/**
 * The Hermes **control plane** (spec §4).
 *
 * Spawns `python -m tui_gateway.entry` via {@link JsonRpcStdio} and exposes
 * the §4.3 method map that turns "manage Hermes natively" into concrete RPCs:
 * `tools.list` / `tools.configure`, `skills.manage`, `rollback.list|restore|diff`,
 * `model.options`, `config.*`, `delegation.status`, etc. — see
 * `research/harness/hermes-tui-gateway-methods.md` for the full 128-method
 * catalog; this class doesn't hardcode any of them, it's a generic
 * method-name-in/result-out pipe (`dispatch`) plus an event fan-out
 * (`onEvent`).
 *
 * ### Wiring (ported from `ui-tui/src/gatewayClient.ts`)
 * 1. `resolveHermes(config)` → the `control` spawn spec (login-shell
 *    wrapped `python -m tui_gateway.entry`).
 * 2. `new JsonRpcStdio(controlSpec + logger)`.
 * 3. **Ready handshake:** the gateway emits an `event` frame
 *    `{jsonrpc:'2.0', method:'event', params:{type:'gateway.ready', payload}}`
 *    (`tui_gateway/entry.py:349`, confirmed against source) before reading any
 *    stdin — {@link start} awaits it (timeout {@link READY_TIMEOUT_MS} ≈ 15s,
 *    mirroring `gatewayClient.ts:17-18`).
 * 4. `dispatch(method, params)` → `JsonRpcStdio.request(method, params)`.
 * 5. Server `event` notifications (`{method:'event', params:{type, session_id,
 *    payload}}`) are parsed by {@link parseGatewayEvent} and fanned out to
 *    {@link onEvent} subscribers as `(type, payload)`; `*.delta` events are the
 *    streaming set.
 * 6. **Crash-respawn:** an unexpected child exit after a successful handshake
 *    schedules a respawn with {@link respawnBackoffMs} backoff and re-runs the
 *    same handshake. Subscribers registered via {@link onEvent} are
 *    channel-scoped (not transport-scoped) so they survive a respawn
 *    transparently. WS-attach mode (`HERMES_TUI_GATEWAY_URL=ws://…`) is a
 *    later transport swap — `dispatch()`/`onEvent()` stay wire-identical.
 *
 * Session-scoped control calls (usage, context breakdown, rollback) take the
 * id that ACP `session/new` returned — see spec §4.4 / risk #1. The caller
 * (real `AcpBackend.invokeControl`) is a thin passthrough to
 * {@link ControlChannel.dispatch} and is responsible for including
 * `session_id` in `params`.
 */

/** Startup handshake timeout — mirrors `gatewayClient.ts:17-18` (≈15s). */
const READY_TIMEOUT_MS = 15_000;

/** Minimal event-subscription handle (mirrors `JsonRpcStdio`'s `Disposable`). */
export interface EventSubscription {
  dispose(): void;
}

/**
 * The subset of {@link JsonRpcStdio} that `ControlChannel` depends on, kept
 * as a thin interface per the wave-1 quality bar ("keep dep-touching code
 * behind a thin interface... so logic is testable"). The real `JsonRpcStdio`
 * satisfies this structurally with no changes needed there; tests inject a
 * fake so the respawn/ready state machine can be exercised without spawning
 * a real `python` process.
 */
export interface ControlTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  onEvent(handler: (method: string, params: unknown) => void): EventSubscription;
  onExit(handler: (code: number | null) => void): EventSubscription;
  dispose(): void;
}

/** Builds the transport for a resolved control spawn spec. */
export type ControlTransportFactory = (
  options: JsonRpcStdioOptions,
) => ControlTransport;

type ControlChannelState = 'idle' | 'starting' | 'ready' | 'respawning' | 'disposed';

export class ControlChannel {
  private transport: ControlTransport | undefined;
  private transportEventSub: EventSubscription | undefined;
  private transportExitSub: EventSubscription | undefined;

  private readonly eventHandlers = new Set<(type: string, payload: unknown) => void>();

  private state: ControlChannelState = 'idle';
  /** The in-flight promise for "next time we reach `ready`", shared by an
   * explicit {@link start} call and internal respawn attempts so concurrent
   * callers don't race two spawns. */
  private pendingReady: Promise<void> | undefined;
  private respawnAttempts = 0;
  private respawnTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly config: HermesRuntimeConfig,
    private readonly logger?: Logger,
    /** Test seam — defaults to the real stdio transport. */
    private readonly createTransport: ControlTransportFactory = (options) =>
      new JsonRpcStdio(options),
  ) {}

  /** Spawn `python -m tui_gateway.entry` and await the `gateway.ready` event. */
  async start(): Promise<void> {
    if (this.state === 'disposed') {
      throw new Error('ControlChannel: disposed');
    }
    if (this.state === 'ready') return; // already connected
    if (this.pendingReady) return this.pendingReady;

    this.state = 'starting';
    this.pendingReady = this.spawnAndAwaitReady()
      .catch((err) => {
        if (this.state !== 'disposed') this.state = 'idle';
        throw err;
      })
      .finally(() => {
        this.pendingReady = undefined;
      });
    return this.pendingReady;
  }

  /**
   * Issue a control-plane RPC and return its result. This is the single entry
   * the real `AcpBackend.invokeControl` delegates to.
   */
  async dispatch<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state === 'disposed') {
      throw new Error(`ControlChannel: disposed; cannot dispatch '${method}'`);
    }
    if (!this.transport) {
      throw new Error(
        `ControlChannel: not connected (state='${this.state}'); ` +
          `cannot dispatch '${method}' — call and await start() first`,
      );
    }
    return this.transport.request<T>(method, params);
  }

  /** Subscribe to gateway `event` notifications (control-plane streaming set). */
  onEvent(handler: (type: string, payload: unknown) => void): { dispose(): void } {
    this.eventHandlers.add(handler);
    return {
      dispose: () => {
        this.eventHandlers.delete(handler);
      },
    };
  }

  dispose(): void {
    this.state = 'disposed';
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = undefined;
    }
    this.transportEventSub?.dispose();
    this.transportExitSub?.dispose();
    this.transportEventSub = undefined;
    this.transportExitSub = undefined;
    this.transport?.dispose();
    this.transport = undefined;
    this.eventHandlers.clear();
  }

  // --- internals --------------------------------------------------------

  /** Resolve the runtime, spawn the transport, and await the ready handshake. */
  private async spawnAndAwaitReady(): Promise<void> {
    const resolved = await resolveHermes(this.config);
    const transport = this.createTransport({
      command: resolved.control.command,
      args: resolved.control.args,
      cwd: resolved.cwd,
      logger: this.logger,
    });

    // Attach the permanent fan-out BEFORE waiting for readiness so a
    // `gateway.ready` (or anything else) that arrives during the handshake
    // window still reaches subscribers exactly once.
    const eventSub = transport.onEvent((method, params) =>
      this.handleEvent(method, params),
    );

    try {
      await this.awaitReady(transport);
    } catch (err) {
      eventSub.dispose();
      transport.dispose();
      throw err;
    }

    this.transport = transport;
    this.transportEventSub = eventSub;
    this.transportExitSub = transport.onExit((code) => this.handleCrash(code));
    this.respawnAttempts = 0;
    this.state = 'ready';
  }

  /** Race the `gateway.ready` event against a timeout and an early child exit. */
  private awaitReady(
    transport: ControlTransport,
    timeoutMs: number = READY_TIMEOUT_MS,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        readySub.dispose();
        exitSub.dispose();
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `ControlChannel: timed out waiting for 'gateway.ready' after ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      const readySub = transport.onEvent((method, params) => {
        if (isGatewayReady(parseGatewayEvent(method, params))) {
          settle(resolve);
        }
      });

      const exitSub = transport.onExit((code) => {
        settle(() =>
          reject(
            new Error(
              `ControlChannel: control process exited (code ${code}) before 'gateway.ready'`,
            ),
          ),
        );
      });
    });
  }

  /** Parse an inbound notification and fan it out to `onEvent` subscribers. */
  private handleEvent(method: string, params: unknown): void {
    const frame = parseGatewayEvent(method, params);
    if (!frame) {
      this.log(`dropped non-event notification: method=${method}`);
      return;
    }
    // `gateway.ready` is the internal handshake signal — `awaitReady()` has
    // its own listener for it. It must not leak to channel-scoped `onEvent`
    // subscribers, who would otherwise see it spuriously on every respawn
    // (subscribers registered before a crash outlive the transport that
    // emits the new bootstrap `gateway.ready`).
    if (isGatewayReady(frame)) return;
    for (const handler of this.eventHandlers) {
      try {
        handler(frame.type, frame.payload);
      } catch (err) {
        this.log(`event handler threw: ${String(err)}`);
      }
    }
  }

  /** The control process died after a successful handshake — respawn it. */
  private handleCrash(code: number | null): void {
    this.transportEventSub?.dispose();
    this.transportExitSub?.dispose();
    this.transportEventSub = undefined;
    this.transportExitSub = undefined;
    this.transport = undefined;

    if (this.state === 'disposed') return;
    this.log(`control process exited unexpectedly (code ${code}); scheduling respawn`);
    this.state = 'respawning';
    this.scheduleRespawn();
  }

  private scheduleRespawn(): void {
    if (this.state === 'disposed') return;
    const attempt = ++this.respawnAttempts;
    const delayMs = respawnBackoffMs(attempt);
    this.log(`respawn attempt ${attempt} in ${delayMs}ms`);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      this.attemptRespawn();
    }, delayMs);
    this.respawnTimer.unref?.();
  }

  private attemptRespawn(): void {
    if (this.state === 'disposed') return;
    this.state = 'respawning';
    this.pendingReady = this.spawnAndAwaitReady()
      .catch((err) => {
        this.log(`respawn attempt ${this.respawnAttempts} failed: ${String(err)}`);
        if (this.state !== 'disposed') this.scheduleRespawn();
        throw err;
      })
      .finally(() => {
        this.pendingReady = undefined;
      });
    // Nothing awaits this internally-triggered attempt directly; mark it
    // handled so a rejection doesn't surface as an unhandled-rejection
    // warning (any external `start()` caller that captured this same
    // promise before it was replaced still observes the rejection).
    this.pendingReady.catch(() => {});
  }

  private log(message: string): void {
    this.logger?.append(`[ControlChannel] ${message}`);
  }
}
