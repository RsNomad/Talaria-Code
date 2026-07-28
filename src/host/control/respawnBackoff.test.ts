import { describe, it, expect } from 'vitest';
import { respawnBackoffMs } from './respawnBackoff';

describe('respawnBackoffMs', () => {
  it('starts at 500ms for the first attempt', () => {
    expect(respawnBackoffMs(1)).toBe(500);
  });

  it('doubles each subsequent attempt', () => {
    expect(respawnBackoffMs(2)).toBe(1000);
    expect(respawnBackoffMs(3)).toBe(2000);
    expect(respawnBackoffMs(4)).toBe(4000);
    expect(respawnBackoffMs(5)).toBe(8000);
  });

  it('caps at 15s and stays capped for further attempts', () => {
    expect(respawnBackoffMs(6)).toBe(15_000);
    expect(respawnBackoffMs(7)).toBe(15_000);
    expect(respawnBackoffMs(20)).toBe(15_000);
  });

  it('treats attempt 0, negative, or fractional as attempt 1', () => {
    expect(respawnBackoffMs(0)).toBe(500);
    expect(respawnBackoffMs(-3)).toBe(500);
    expect(respawnBackoffMs(1.9)).toBe(500);
  });
});
