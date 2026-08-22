import { describe, it, expect } from 'vitest';
import {
  RESPAWN_DEGRADED_AFTER_ATTEMPTS,
  RESPAWN_DOWN_AFTER_ATTEMPTS,
  respawnHealthForAttempt,
  combineGatewayHealth,
} from './respawnHealth';
import { RespawnHealthTracker } from './respawnHealth';
import type { RespawnHealth } from './respawnHealth';

describe('respawnHealthForAttempt — WS-R3 F2-19 thresholds', () => {
  it('boundary table', () => {
    expect(respawnHealthForAttempt(0)).toBe('ok');
    expect(respawnHealthForAttempt(RESPAWN_DEGRADED_AFTER_ATTEMPTS - 1)).toBe('ok');
    expect(respawnHealthForAttempt(RESPAWN_DEGRADED_AFTER_ATTEMPTS)).toBe('degraded');
    expect(respawnHealthForAttempt(RESPAWN_DOWN_AFTER_ATTEMPTS - 1)).toBe('degraded');
    expect(respawnHealthForAttempt(RESPAWN_DOWN_AFTER_ATTEMPTS)).toBe('down');
    expect(respawnHealthForAttempt(RESPAWN_DOWN_AFTER_ATTEMPTS + 25)).toBe('down');
  });
});

describe('combineGatewayHealth — UX-02 worst-state-wins', () => {
  it('worst state wins, carrying the worst port\'s attempts', () => {
    expect(combineGatewayHealth({ state: 'ok', attempts: 2 }, { state: 'down', attempts: 10 }))
      .toEqual({ state: 'down', attempts: 10 });
    expect(combineGatewayHealth({ state: 'degraded', attempts: 6 }, { state: 'ok', attempts: 0 }))
      .toEqual({ state: 'degraded', attempts: 6 });
    expect(combineGatewayHealth({ state: 'down', attempts: 11 }, { state: 'degraded', attempts: 7 }))
      .toEqual({ state: 'down', attempts: 11 });
  });

  it('same state on both ports → max attempts (the longer-suffering loop is the honest counter)', () => {
    expect(combineGatewayHealth({ state: 'degraded', attempts: 5 }, { state: 'degraded', attempts: 8 }))
      .toEqual({ state: 'degraded', attempts: 8 });
  });

  it('both ok → ok with the higher live counter (attempts climb 1-4 while still classified ok)', () => {
    expect(combineGatewayHealth({ state: 'ok', attempts: 3 }, { state: 'ok', attempts: 1 }))
      .toEqual({ state: 'ok', attempts: 3 });
  });
});

describe('RespawnHealthTracker — the shared edge-dedup fan-out both respawn loops use', () => {
  it('transition-only: same-state emits are swallowed; each state change fans out once', () => {
    const seen: RespawnHealth[] = [];
    const tracker = new RespawnHealthTracker(() => {});
    tracker.onHealth((h) => seen.push(h));
    tracker.emit({ state: 'ok', attempts: 1 });        // still ok — no edge
    tracker.emit({ state: 'ok', attempts: 4 });        // still ok — no edge
    tracker.emit({ state: 'degraded', attempts: 5 });  // edge
    tracker.emit({ state: 'degraded', attempts: 7 });  // no edge
    tracker.emit({ state: 'down', attempts: 10 });     // edge
    tracker.emit({ state: 'ok', attempts: 0 });        // edge (recovery)
    expect(seen).toEqual([
      { state: 'degraded', attempts: 5 },
      { state: 'down', attempts: 10 },
      { state: 'ok', attempts: 0 },
    ]);
  });

  it('a throwing handler is logged and does not stop later handlers (per-handler guard)', () => {
    const logs: string[] = [];
    const seen: RespawnHealth[] = [];
    const tracker = new RespawnHealthTracker((m) => logs.push(m));
    tracker.onHealth(() => { throw new Error('subscriber boom'); });
    tracker.onHealth((h) => seen.push(h));
    tracker.emit({ state: 'degraded', attempts: 5 });
    expect(seen).toEqual([{ state: 'degraded', attempts: 5 }]);
    expect(logs.some((l) => l.includes('health handler threw'))).toBe(true);
  });

  it('a throwing LOG cannot escape emit (whole-body guard — the respawn loops\' critical path sits above this call)', () => {
    const tracker = new RespawnHealthTracker(() => { throw new Error('logger boom'); });
    tracker.onHealth(() => { throw new Error('subscriber boom'); });
    expect(() => tracker.emit({ state: 'degraded', attempts: 5 })).not.toThrow();
  });

  it('dispose() detaches exactly that handler', () => {
    const a: RespawnHealth[] = [];
    const b: RespawnHealth[] = [];
    const tracker = new RespawnHealthTracker(() => {});
    const subA = tracker.onHealth((h) => a.push(h));
    tracker.onHealth((h) => b.push(h));
    subA.dispose();
    tracker.emit({ state: 'down', attempts: 10 });
    expect(a).toEqual([]);
    expect(b).toEqual([{ state: 'down', attempts: 10 }]);
  });
});
