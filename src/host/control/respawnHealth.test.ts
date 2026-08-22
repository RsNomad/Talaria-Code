import { describe, it, expect } from 'vitest';
import {
  RESPAWN_DEGRADED_AFTER_ATTEMPTS,
  RESPAWN_DOWN_AFTER_ATTEMPTS,
  respawnHealthForAttempt,
  combineGatewayHealth,
} from './respawnHealth';

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
