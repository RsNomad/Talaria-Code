import { describe, it, expect } from 'vitest';
import { shouldRegenerate, SNAPSHOT_IDLE_MS } from './snapshotPolicy';

/**
 * §2.4 pinned predicate: regenerate = epochChanged ∧ (boundaryEvent ∨ idle).
 * This is a PAUSE DETECTOR, not a rate limiter — there is deliberately no
 * "≥Nms since last regeneration" input or clause anywhere below.
 */
describe('shouldRegenerate', () => {
  it('reuses when the epoch is unchanged, even with a boundary event and long idle', () => {
    const result = shouldRegenerate({
      prevEpoch: 5,
      currentEpoch: 5,
      boundaryEvent: true,
      lastKeystrokeAt: 0,
      now: 100_000,
    });

    expect(result).toBe('reuse');
  });

  it('reuses when the epoch changed but it is mid-burst (no boundary, not idle)', () => {
    const result = shouldRegenerate({
      prevEpoch: 5,
      currentEpoch: 6,
      boundaryEvent: false,
      lastKeystrokeAt: 1_000,
      now: 1_500, // 500ms since last keystroke — under the 1200ms idle threshold
    });

    expect(result).toBe('reuse');
  });

  it('regenerates on epoch-change + boundary event (even mid-burst by idle)', () => {
    const result = shouldRegenerate({
      prevEpoch: 5,
      currentEpoch: 6,
      boundaryEvent: true,
      lastKeystrokeAt: 1_000,
      now: 1_050, // 50ms since last keystroke — not idle
    });

    expect(result).toBe('regenerate');
  });

  it('regenerates on epoch-change + idle >= 1200ms (no boundary)', () => {
    const result = shouldRegenerate({
      prevEpoch: 5,
      currentEpoch: 6,
      boundaryEvent: false,
      lastKeystrokeAt: 1_000,
      now: 1_000 + SNAPSHOT_IDLE_MS,
    });

    expect(result).toBe('regenerate');
  });

  it('does not regenerate at 1199ms idle (just under the threshold)', () => {
    const result = shouldRegenerate({
      prevEpoch: 5,
      currentEpoch: 6,
      boundaryEvent: false,
      lastKeystrokeAt: 1_000,
      now: 1_000 + SNAPSHOT_IDLE_MS - 1,
    });

    expect(result).toBe('reuse');
  });

  it('never regenerates mid-burst on a timer, no matter how much wall-clock time passes', () => {
    // Simulate a long typing burst: epoch changed once at the start, but the
    // user keeps typing (lastKeystrokeAt tracks `now` — never idle) and never
    // crosses a structural boundary. A rate-limiter ("regenerate every 3s
    // regardless") would eventually flip this to 'regenerate'; the pause
    // detector must not, because epochChanged/boundary/idle never change.
    const sampledNows = [1_000, 5_000, 30_000, 300_000, 3_000_000];

    for (const now of sampledNows) {
      const result = shouldRegenerate({
        prevEpoch: 5,
        currentEpoch: 6,
        boundaryEvent: false,
        lastKeystrokeAt: now - 100, // always 100ms since the last keystroke
        now,
      });
      expect(result).toBe('reuse');
    }
  });

  it('is a pure function: identical input always yields identical output', () => {
    const input = {
      prevEpoch: 1,
      currentEpoch: 2,
      boundaryEvent: true,
      lastKeystrokeAt: 10,
      now: 20,
    };

    expect(shouldRegenerate(input)).toBe(shouldRegenerate(input));
  });

  it('supports an injected idleMs threshold override instead of the 1200ms default', () => {
    const result = shouldRegenerate({
      prevEpoch: 1,
      currentEpoch: 2,
      boundaryEvent: false,
      lastKeystrokeAt: 0,
      now: 500,
      idleMs: 400, // custom, lower threshold — 500ms since keystroke crosses it
    });

    expect(result).toBe('regenerate');
  });
});
