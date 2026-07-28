import { describe, it, expect, vi, afterEach } from 'vitest';
import { getNonce } from './nonce';

describe('getNonce (CSP nonce, S-M3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT use Math.random (must be a CSPRNG)', () => {
    const spy = vi.spyOn(Math, 'random');
    getNonce();
    expect(spy).not.toHaveBeenCalled();
  });

  it('produces a token within the base64url charset', () => {
    // base64url alphabet per RFC 4648 §5: A-Z a-z 0-9 - _ (no padding, no +/).
    for (let i = 0; i < 100; i++) {
      expect(getNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('carries at least 128 bits of entropy (>= 22 base64url chars)', () => {
    // 16 random bytes -> 22 base64url chars (unpadded). 128 bits is the CSP floor.
    expect(getNonce().length).toBeGreaterThanOrEqual(22);
  });

  it('is unique across many calls (no collisions)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(getNonce());
    expect(seen.size).toBe(10_000);
  });
});
