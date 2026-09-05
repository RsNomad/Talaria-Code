import { describe, it, expect } from 'vitest';
import { LatchRegistry } from './latchRegistry';

/** Builds a registry whose `isClosed` thunk is controlled by the test via a
 *  mutable box, mirroring how `SetupController` wires `() => this.lifecycle.closed`. */
function makeRegistry(): { registry: LatchRegistry; close: () => void } {
  const box = { closed: false };
  const registry = new LatchRegistry(() => box.closed);
  return { registry, close: () => (box.closed = true) };
}

describe('LatchRegistry — WS-GD.2b B6 (single-flight latches + cancel + dispose-abort)', () => {
  it('F2-16: arm() after close (isClosed → true) returns undefined — no latch armed post-close', () => {
    const { registry, close } = makeRegistry();
    close();
    expect(registry.arm('install:hermes')).toBeUndefined();
    expect(registry.has('install:hermes')).toBe(false);
  });

  it('abort() on an absent key returns false and aborts nothing', () => {
    const { registry } = makeRegistry();
    expect(registry.abort('pull:missing')).toBe(false);
  });

  it('arm() returns a live AbortController whose .signal is what abort(key) fires', () => {
    const { registry } = makeRegistry();
    const abort = registry.arm('pull:qwen2.5-coder:1.5b-base');
    expect(abort).toBeDefined();
    expect(abort?.signal.aborted).toBe(false);
    expect(registry.abort('pull:qwen2.5-coder:1.5b-base')).toBe(true);
    expect(abort?.signal.aborted).toBe(true);
  });

  it('abortAll() aborts EVERY held controller (observed via signal.aborted) and empties the registry', () => {
    const { registry } = makeRegistry();
    const a = registry.arm('install:hermes');
    const b = registry.arm('pull:qwen2.5-coder:1.5b-base');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    registry.abortAll();
    expect(a?.signal.aborted).toBe(true);
    expect(b?.signal.aborted).toBe(true);
    expect(registry.has('install:hermes')).toBe(false);
    expect(registry.has('pull:qwen2.5-coder:1.5b-base')).toBe(false);
  });

  it('has() reflects arm()/release() transitions', () => {
    const { registry } = makeRegistry();
    expect(registry.has('install:hermes')).toBe(false);
    registry.arm('install:hermes');
    expect(registry.has('install:hermes')).toBe(true);
    registry.release('install:hermes');
    expect(registry.has('install:hermes')).toBe(false);
  });

  it('mirrors the current armLatch behavior on a re-arm of the same key: OVERWRITES — a second arm() returns a NEW, distinct AbortController and does not abort the first (the documented "second inFlight.set clobbers the first" clobber, not a refuse/abort-old)', () => {
    const { registry } = makeRegistry();
    const first = registry.arm('pull:model');
    const second = registry.arm('pull:model');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // The first controller's signal is never touched by the re-arm — it is
    // simply orphaned (clobbered), exactly like the current `Map.set` overwrite.
    expect(first?.signal.aborted).toBe(false);
    expect(registry.has('pull:model')).toBe(true);
    // abort() now only reaches the SECOND (latest) controller — the first is lost.
    expect(registry.abort('pull:model')).toBe(true);
    expect(second?.signal.aborted).toBe(true);
    expect(first?.signal.aborted).toBe(false);
  });
});
