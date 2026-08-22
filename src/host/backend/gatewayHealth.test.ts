import { describe, it, expect } from 'vitest';
import type { RespawnHealth } from '../control/respawnHealth';
import type { HostToWebviewMessage } from '../../shared/protocol';
import { wireGatewayHealth, gatewayHealthMessage } from './gatewayHealth';

function makePort(initial: RespawnHealth = { state: 'ok', attempts: 0 }) {
  const handlers: Array<(h: RespawnHealth) => void> = [];
  let current = initial;
  return {
    port: {
      onHealth(handler: (h: RespawnHealth) => void) {
        handlers.push(handler);
        return { dispose: () => handlers.splice(handlers.indexOf(handler), 1) };
      },
      currentHealth: () => current,
    },
    fire(h: RespawnHealth) {
      current = h;
      for (const fn of [...handlers]) fn(h);
    },
  };
}

describe('gatewayHealthMessage — wire shape', () => {
  it('omits attempts at ok; carries it otherwise (exactOptional discipline)', () => {
    expect(gatewayHealthMessage({ state: 'ok', attempts: 0 })).toEqual({ type: 'gateway.health', state: 'ok' });
    expect(gatewayHealthMessage({ state: 'down', attempts: 10 }))
      .toEqual({ type: 'gateway.health', state: 'down', attempts: 10 });
  });
});

describe('wireGatewayHealth — UX-02: two ports, ONE edge-deduped combined push', () => {
  it('combines worst-state-wins and pushes only on COMBINED transitions', () => {
    const control = makePort();
    const acp = makePort();
    const pushed: HostToWebviewMessage[] = [];
    wireGatewayHealth(control.port, acp.port, (m) => pushed.push(m), () => {});
    control.fire({ state: 'degraded', attempts: 5 }); // combined: degraded
    acp.fire({ state: 'down', attempts: 10 });        // combined: down
    control.fire({ state: 'ok', attempts: 0 });       // combined STILL down — deduped
    acp.fire({ state: 'ok', attempts: 0 });           // combined: ok (recovery)
    expect(pushed).toEqual([
      { type: 'gateway.health', state: 'degraded', attempts: 5 },
      { type: 'gateway.health', state: 'down', attempts: 10 },
      { type: 'gateway.health', state: 'ok' },
    ]);
  });

  it('a throwing emit sink cannot escape into the port fan-out (the respawn loops sit above this)', () => {
    const control = makePort();
    const acp = makePort();
    wireGatewayHealth(control.port, acp.port, () => { throw new Error('sink boom'); }, () => {});
    expect(() => control.fire({ state: 'degraded', attempts: 5 })).not.toThrow();
  });

  it('dispose() detaches from BOTH ports', () => {
    const control = makePort();
    const acp = makePort();
    const pushed: HostToWebviewMessage[] = [];
    const sub = wireGatewayHealth(control.port, acp.port, (m) => pushed.push(m), () => {});
    sub.dispose();
    control.fire({ state: 'down', attempts: 10 });
    acp.fire({ state: 'down', attempts: 10 });
    expect(pushed).toEqual([]);
  });
});
