import { describe, it, expect } from 'vitest';
import {
  RESPAWN_DEGRADED_AFTER_ATTEMPTS,
  RESPAWN_DOWN_AFTER_ATTEMPTS,
  respawnHealthForAttempt,
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
