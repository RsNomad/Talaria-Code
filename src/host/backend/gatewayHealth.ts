import type { RespawnHealth } from '../control/respawnHealth';
import { RespawnHealthTracker, combineGatewayHealth } from '../control/respawnHealth';
import type { HostToWebviewMessage } from '../../shared/protocol';

/** The structural face both respawn loops already expose (ControlChannel.ts:171/:192, ConnectionSupervisor.ts:213/:236). */
export interface HealthPort {
  onHealth(handler: (health: RespawnHealth) => void): { dispose(): void };
  currentHealth(): RespawnHealth;
}

/** UX-02 wire shape: `attempts` present iff not ok (protocol.ts contract). */
export function gatewayHealthMessage(health: RespawnHealth): HostToWebviewMessage {
  return {
    type: 'gateway.health',
    state: health.state,
    ...(health.state !== 'ok' ? { attempts: health.attempts } : {}),
  };
}

/**
 * WS-UX UX-02 (F2-19 UI face): subscribe to BOTH management links' health
 * edges, combine worst-state-wins, and emit ONE `gateway.health` push per
 * COMBINED transition. The per-port callbacks run synchronously inside the
 * loops' `emitHealth` fan-out (their per-handler guard already contains us);
 * the tracker's own whole-body guard additionally contains the `emit` sink,
 * so nothing here can ever reach the respawn-critical path. Per-port state
 * is seeded from `currentHealth()` at wire time (in production both loops
 * are freshly constructed — 'ok'/0 — but the seed keeps the first combine
 * honest for any caller wiring later).
 */
export function wireGatewayHealth(
  control: HealthPort,
  acp: HealthPort,
  emit: (msg: HostToWebviewMessage) => void,
  log: (message: string) => void,
): { dispose(): void } {
  let controlHealth = control.currentHealth();
  let acpHealth = acp.currentHealth();
  const tracker = new RespawnHealthTracker(log);
  tracker.onHealth((combined) => emit(gatewayHealthMessage(combined)));
  const push = () => tracker.emit(combineGatewayHealth(controlHealth, acpHealth));
  const subs = [
    control.onHealth((h) => {
      controlHealth = h;
      push();
    }),
    acp.onHealth((h) => {
      acpHealth = h;
      push();
    }),
  ];
  return {
    dispose: () => {
      for (const sub of subs) sub.dispose();
    },
  };
}
