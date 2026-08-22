/**
 * WS-R3 F2-19: shared health-threshold vocabulary for BOTH respawn loops
 * (ControlChannel + ConnectionSupervisor — same file family as the shared
 * respawnBackoffMs). Self-heal never stops; these thresholds only decide
 * when the silence becomes a visible signal. Phase 3 (WS-UX) turns the
 * onHealth callbacks into the `gateway.health` webview push + banner.
 * Proposed defaults; tunable on Fedora live-QA.
 */
export const RESPAWN_DEGRADED_AFTER_ATTEMPTS = 5;
export const RESPAWN_DOWN_AFTER_ATTEMPTS = 10;

export type RespawnHealthState = 'ok' | 'degraded' | 'down';

export interface RespawnHealth {
  state: RespawnHealthState;
  attempts: number;
}

export function respawnHealthForAttempt(attempt: number): RespawnHealthState {
  if (attempt >= RESPAWN_DOWN_AFTER_ATTEMPTS) return 'down';
  if (attempt >= RESPAWN_DEGRADED_AFTER_ATTEMPTS) return 'degraded';
  return 'ok';
}

const HEALTH_SEVERITY: Record<RespawnHealthState, number> = { ok: 0, degraded: 1, down: 2 };

/**
 * WS-UX UX-02: combine the two management links' health into the ONE banner
 * signal. Worst-state-wins; `attempts` is the max among the port(s) at that
 * worst state (a healthier port's counter must not dilute the honest "retried
 * N times" of the link that is actually failing).
 */
export function combineGatewayHealth(a: RespawnHealth, b: RespawnHealth): RespawnHealth {
  const state = HEALTH_SEVERITY[a.state] >= HEALTH_SEVERITY[b.state] ? a.state : b.state;
  const attempts = Math.max(a.state === state ? a.attempts : 0, b.state === state ? b.attempts : 0);
  return { state, attempts };
}

/**
 * WS-UX consolidation of the healthHandlers/lastHealthState/emitHealth trio
 * that ControlChannel and ConnectionSupervisor previously duplicated
 * field-for-field (rule-of-three: the gateway.health combined tracker is the
 * third user). Edge-triggered on `health.state`; the fan-out preserves BOTH
 * defensive layers the loops' reviews mandated (F2-19a concurrency Minor-1):
 *  - per-handler try/catch: one throwing subscriber never starves the rest;
 *  - whole-body try/catch: a pathological failure INSIDE the guard (the
 *    injected log throwing, `String(err)` throwing on an exotic error) can
 *    never escape `emit` — both loops call it on their respawn-critical path
 *    (backoff armed immediately before), so an escaping throw here would be
 *    the exact F2-19 silent fail-stop this family of code exists to prevent.
 * The `log` callback is the OWNING loop's already-guarded logger (`log`/
 * `safeLog`) — this class never touches a Logger directly.
 */
export class RespawnHealthTracker {
  private readonly handlers = new Set<(health: RespawnHealth) => void>();
  private lastState: RespawnHealthState = 'ok';

  constructor(private readonly log: (message: string) => void) {}

  onHealth(handler: (health: RespawnHealth) => void): { dispose(): void } {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  emit(health: RespawnHealth): void {
    try {
      if (health.state === this.lastState) return;
      this.lastState = health.state;
      for (const handler of [...this.handlers]) {
        try {
          handler(health);
        } catch (err) {
          this.log(`health handler threw: ${String(err)}`);
        }
      }
    } catch {
      // Deliberately empty — see the class doc: nothing may escape.
    }
  }
}
