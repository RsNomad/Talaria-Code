import { describe, it, expect, vi } from 'vitest';
import { RootRegistry } from './rootRegistry';
import type { CheckpointTrackerLike } from './trackerContract';

describe('RootRegistry (W4-T2 Deliverable 2)', () => {
  it('getOrCreate mints exactly ONE coordinator per canonical root, cached on repeat calls', () => {
    const registry = new RootRegistry();
    const factory = vi.fn(() => undefined);
    const first = registry.getOrCreate('/ws-a', factory);
    const second = registry.getOrCreate('/ws-a', factory);
    expect(second).toBe(first); // same instance
    expect(factory).toHaveBeenCalledTimes(1); // NOT re-invoked on a cache hit
  });

  it('a DIFFERENT canonical root mints a DIFFERENT, independent coordinator', () => {
    const registry = new RootRegistry();
    const a = registry.getOrCreate('/ws-a', () => undefined);
    const b = registry.getOrCreate('/ws-b', () => undefined);
    expect(a).not.toBe(b);
    // Independent lease state — proves this is a real two-root registry, not
    // a shared/aliased bridge (the Obs "aliased roots must resolve to ONE
    // coordinator" concern's mirror image: two GENUINELY different roots
    // must resolve to TWO coordinators).
    expect(a.tryAcquireTurnLease('session-1')).toBe(true);
    expect(b.tryAcquireTurnLease('session-2')).toBe(true);
  });

  it('get(rootId) returns the registered coordinator, or undefined for an unknown key', () => {
    const registry = new RootRegistry();
    const created = registry.getOrCreate('/ws-a', () => undefined);
    expect(registry.get('/ws-a')).toBe(created);
    expect(registry.get('/ws-unknown')).toBeUndefined();
  });

  it('threads the tracker the factory returns onto the new coordinator', () => {
    const registry = new RootRegistry();
    const tracker = {} as CheckpointTrackerLike;
    const root = registry.getOrCreate('/ws-a', () => tracker);
    expect(root.tracker).toBe(tracker);
  });

  it('values() enumerates every registered coordinator', () => {
    const registry = new RootRegistry();
    registry.getOrCreate('/ws-a', () => undefined);
    registry.getOrCreate('/ws-b', () => undefined);
    expect([...registry.values()]).toHaveLength(2);
    expect(registry.size).toBe(2);
  });

  it('W6-FI-c Part 2 (W4-F5): threads notifyCheckpointsChanged onto the new coordinator ONCE, cached on repeat calls (mirrors the tracker factory)', () => {
    const registry = new RootRegistry();
    const notify = vi.fn();
    const first = registry.getOrCreate('/ws-a', () => undefined, notify);
    const second = registry.getOrCreate('/ws-a', () => undefined, vi.fn()); // a DIFFERENT notify on the cache-hit call — must be ignored
    expect(second).toBe(first);

    first.refreshCheckpointsPanel();
    expect(notify).toHaveBeenCalledTimes(1); // the ORIGINAL (mint-time) callback fired, not the 2nd call's
  });

  it('W6-FI-c Part 2 (W4-F5 placement fix): two "controller mints" on the SAME root (two getOrCreate calls) both reach the ONE wired refresh implementation — no N× per-caller duplication', () => {
    const registry = new RootRegistry();
    const notify = vi.fn();
    // Simulates AcpBackend.buildSessionPort being called TWICE for two
    // SessionControllers sharing one root — both calls resolve through
    // `resolveRootCoordinator` -> `rootRegistry.getOrCreate` for the SAME
    // canonical root.
    const rootForControllerA = registry.getOrCreate('/ws-shared', () => undefined, notify);
    const rootForControllerB = registry.getOrCreate('/ws-shared', () => undefined, vi.fn());
    expect(rootForControllerB).toBe(rootForControllerA); // the SAME RootCoordinator instance

    // Both "controllers" trigger a refresh independently (their own turn's
    // checkpoint event) — each call reaches the SAME underlying
    // implementation (the ONE `notify` wired at mint time), never a
    // per-controller reimplementation.
    rootForControllerA.refreshCheckpointsPanel();
    rootForControllerB.refreshCheckpointsPanel();
    expect(notify).toHaveBeenCalledTimes(2); // both calls landed on the SAME implementation
  });

  it('disposeAll clears the registry — a subsequent get() returns undefined and getOrCreate mints fresh state', () => {
    const registry = new RootRegistry();
    const before = registry.getOrCreate('/ws-a', () => undefined);
    before.tryAcquireTurnLease('session-1');

    registry.disposeAll();

    expect(registry.get('/ws-a')).toBeUndefined();
    expect(registry.size).toBe(0);
    const after = registry.getOrCreate('/ws-a', () => undefined);
    expect(after).not.toBe(before);
    expect(after.anyLiveTurn()).toBe(false); // fresh lease state, not inherited
  });
});
