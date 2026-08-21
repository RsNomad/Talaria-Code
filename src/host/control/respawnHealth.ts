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
