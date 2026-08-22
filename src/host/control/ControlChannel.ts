import type { Logger, JsonRpcStdioOptions } from '../transport/JsonRpcStdio';
import { JsonRpcStdio } from '../transport/JsonRpcStdio';
import type { HermesRuntimeConfig } from '../runtime/resolveHermes';
import { resolveHermes } from '../runtime/resolveHermes';
import { parseGatewayEvent, isGatewayReady } from './eventDemux';
import { respawnBackoffMs } from './respawnBackoff';
import { respawnHealthForAttempt, RespawnHealthTracker } from './respawnHealth';
import type { RespawnHealth } from './respawnHealth';

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

  /** WS-R3 F2-19: health-transition machinery (the gateway.health source) —
   * consolidated into the shared RespawnHealthTracker (see its class doc for
   * the double defensive guard that used to live inline here). The `log`
   * callback is this class's own guarded `log()` (:461-477), so a throwing
   * OutputChannel still cannot reach the respawn-critical path. */
  private readonly healthTracker = new RespawnHealthTracker((m) => this.log(m));

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
    // CF-01/I-4: an explicit (re)start replaces any pending respawn retry —
    // mirrors `ConnectionSupervisor.startInternal`'s `clearAcpRespawnTimer()`
    // call (`ConnectionSupervisor.ts:314-316`: the disposed-check runs
    // first there, `clearAcpRespawnTimer()` second — order doesn't matter
    // for this invariant, only that it runs on every (re)start). Without
    // this, a `start()` issued while a crash-respawn backoff is armed
    // leaves the stale timer live; it later fires `attemptRespawn()` on top
    // of the spawn `start()` just kicked off, double-spawning the control
    // child.
    this.clearRespawnTimer();
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

  /**
   * WS-R3 F2-19: subscribe to respawn-health TRANSITIONS ('ok' → 'degraded'
   * at 5 failed attempts → 'down' at 10 → back to 'ok' on a successful
   * handshake). Transition-only — never one event per attempt. The loop
   * itself keeps its backoff schedule forever (fail-visible, never
   * fail-stopped). Channel-scoped like onEvent — survives respawns.
   */
  onHealth(handler: (health: RespawnHealth) => void): { dispose(): void } {
    return this.healthTracker.onHealth(handler);
  }

  /**
   * WS-R3 F2-19a (arch review Important-1): the CURRENT health, computed
   * fresh from the live `respawnAttempts` through the same classifier
   * `emitHealth` uses — NOT the frozen payload of the last-fired
   * transition. `onHealth` is purely edge-triggered and holds no replay, so
   * a subscriber that registers AFTER the channel has already crash-looped
   * past a threshold (e.g. a webview panel VS Code creates lazily, only
   * revealed post-outage) would otherwise hear nothing and default to
   * assuming `'ok'`. Also doubles as the live "retried N times" counter
   * (arch review Minor-1) — unlike a transition payload, `attempts` here
   * keeps climbing past the threshold crossing instead of freezing at 5/10.
   */
  currentHealth(): RespawnHealth {
    return {
      state: respawnHealthForAttempt(this.respawnAttempts),
      attempts: this.respawnAttempts,
    };
  }

  // F2-19a (concurrency review Minor-1): both call sites of `emitHealth`
  // sit on the respawn loop's critical path — `scheduleRespawn` arms the
  // next backoff around this call (see the ordering note there) and
  // `spawnAndAwaitReady` calls it as its very last step on the success
  // path — so the double defensive guard (per-handler + whole-body) now
  // lives in `RespawnHealthTracker.emit` instead of here; see its class doc.
  private emitHealth(attempts: number): void {
    this.healthTracker.emit({ state: respawnHealthForAttempt(attempts), attempts });
  }

  dispose(): void {
    this.state = 'disposed';
    this.clearRespawnTimer();
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
    // CF-01/I-5: `dispose()` can fire while `resolveHermes()` is in flight
    // (before any transport exists) — don't spawn a process for a channel
    // that's already gone.
    if (this.state === 'disposed') {
      throw new Error('ControlChannel: disposed');
    }

    const transport = this.createTransport({
      command: resolved.control.command,
      args: resolved.control.args,
      cwd: resolved.cwd,
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
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

    // CF-01/I-5: `dispose()` racing THIS exact await — it fires after the
    // transport is spawned and subscribed but before the handshake settles —
    // must not be resurrected by a late `gateway.ready`. Mirrors
    // `HermesDashboardManager.bringUp()`'s post-await disposed re-checks:
    // abort and dispose the just-spawned transport instead of publishing it
    // as `'ready'`, so a disposed channel stays disposed and no child is
    // orphaned. Cast breaks tsc's (incorrect, for real async re-entrancy)
    // control-flow narrowing carried over from the `!== 'disposed'` check
    // above the `await` — same idiom as `ConnectionSupervisor.ts`'s
    // `(this.acpState as string) !== 'disposed'`.
    if ((this.state as ControlChannelState) === 'disposed') {
      eventSub.dispose();
      transport.dispose();
      throw new Error('ControlChannel: disposed');
    }

    // Defensive: don't orphan a still-assigned prior transport. Normal
    // crash/dispose paths already clear `this.transport` before a new
    // `spawnAndAwaitReady()` attempt begins, but this keeps that invariant
    // even if a future caller of this method doesn't.
    this.transport?.dispose();
    this.transport = transport;
    this.transportEventSub = eventSub;
    this.transportExitSub = transport.onExit((code) => this.handleCrash(code));
    this.respawnAttempts = 0;
    this.state = 'ready';
    this.emitHealth(0);
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
    // WS-R3 F2-19 close-out: each dispose is guarded in its OWN try/catch —
    // best-effort, so a throwing event-sub dispose can never prevent the
    // exit-sub from STILL being disposed, and neither can prevent the
    // unconditional nulling below (idempotency: a late child `onExit` must
    // never re-enter a live sub — the existing invariant). These are
    // injected-factory transport disposables (transport-swap-ready); the
    // self-heal loop's "always another respawn attempt" guarantee must not
    // depend on one behaving — mirrors `log()`'s own hardening on this path.
    try {
      this.transportEventSub?.dispose();
    } catch (err) {
      this.log(`transport event-sub dispose failed during crash teardown: ${String(err)}`);
    }
    try {
      this.transportExitSub?.dispose();
    } catch (err) {
      this.log(`transport exit-sub dispose failed during crash teardown: ${String(err)}`);
    }
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
    // F2-19a (concurrency review Minor-1/Minor-2): the next backoff is
    // armed BEFORE `emitHealth` runs — not after. `emitHealth` fans out to
    // arbitrary subscriber callbacks synchronously; arming first means the
    // loop's own scheduling work is already committed before any of that
    // untrusted code runs, so nothing in the emit path (a throw that
    // somehow escapes `emitHealth`'s own defensive wrapper, or a subscriber
    // that reentrantly calls `dispose()`/`start()` from inside its
    // callback) can prevent — or race — this attempt's timer. A reentrant
    // `dispose()` now correctly clears this very timer via
    // `clearRespawnTimer()` instead of leaving one armed post-dispose; a
    // reentrant `start()` now correctly clears it too before arming its own
    // spawn, instead of this call re-arming a stale one afterward.
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      this.attemptRespawn();
    }, delayMs);
    this.respawnTimer.unref?.();
    this.emitHealth(attempt);
  }

  private attemptRespawn(): void {
    if (this.state === 'disposed') return;
    // CF-01/I-4: guard against firing on top of an already-pending spawn
    // (an explicit `start()` may have raced this timer into the same
    // `respawning` window) or a channel that already reconnected — only
    // `disposed` was checked before, which let a stale/duplicate timer fire
    // `spawnAndAwaitReady()` a second time.
    if (this.pendingReady || this.state === 'ready') return;
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

  /** Mirrors `ConnectionSupervisor.clearAcpRespawnTimer()`. */
  private clearRespawnTimer(): void {
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = undefined;
    }
  }

  private log(message: string): void {
    // F2-19a (concurrency re-review IMPORTANT-1): three call sites on the
    // crash/respawn critical path — `handleCrash`, `scheduleRespawn`, and
    // `attemptRespawn`'s failure handler — all call `log()` BEFORE the next
    // backoff timer is armed or the next attempt is scheduled. An unguarded
    // `logger?.append` (e.g. a bad/disposed `vscode.OutputChannel` on
    // Fedora) would otherwise escape `log()` and propagate out of whichever
    // caller invoked it, aborting that method before it reaches
    // `scheduleRespawn()`/`this.state = 'respawning'` — leaving the channel
    // a zombie (`state` stuck, `transport` undefined) that never respawns:
    // exactly the F2-19 silent fail-stop this class exists to prevent.
    // Guarding here, once, hardens every call site at once — same rationale
    // as `emitHealth`'s own defensive wrap.
    try {
      this.logger?.append(`[ControlChannel] ${message}`);
    } catch {
      // Swallow: a logging failure must never affect control flow.
    }
  }
}
