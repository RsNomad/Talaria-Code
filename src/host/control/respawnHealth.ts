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
