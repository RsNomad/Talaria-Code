import { describe, it, expect, vi } from 'vitest';
import { RootCoordinator } from './RootCoordinator';
import type { CheckpointTrackerLike } from './trackerContract';

/**
 * W4-T2: the REAL per-root turn-lease coordinator (replaces the T1a
 * always-granted single-instance bridge). Locks the data-safety invariants
 * the brief's gate lists: real refusal, idempotent same-session re-acquire,
 * holder-checked release, root-scoped positive turn ordinals, and a
 * SEPARATE root-scoped negative baseline-ordinal counter (F3).
 */
describe('RootCoordinator (W4-T2 real per-root lease)', () => {
  it('exposes the injected tracker + rootId unchanged', () => {
    const tracker = {} as CheckpointTrackerLike;
    const root = new RootCoordinator('/ws', tracker);
    expect(root.tracker).toBe(tracker);
    expect(root.rootId).toBe('/ws');
  });

  it('tracker is undefined when none is injected (checkpoints unwired)', () => {
    const root = new RootCoordinator('/ws', undefined);
    expect(root.tracker).toBeUndefined();
  });

  describe('tryAcquireTurnLease — real single-holder contention', () => {
    it('grants the first acquire', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.tryAcquireTurnLease('session-a')).toBe(true);
    });

    it('REFUSES a DIFFERENT session while the lease is held (one live turn per root)', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.tryAcquireTurnLease('session-a')).toBe(true);
      expect(root.tryAcquireTurnLease('session-b')).toBe(false);
    });

    it('the SAME session re-acquiring is idempotent-true (never refuses itself)', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.tryAcquireTurnLease('session-a')).toBe(true);
      expect(root.tryAcquireTurnLease('session-a')).toBe(true);
      expect(root.tryAcquireTurnLease('session-a')).toBe(true);
    });

    it('acquire -> refuse -> release -> now-grantable to the second session', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.tryAcquireTurnLease('session-a')).toBe(true);
      expect(root.tryAcquireTurnLease('session-b')).toBe(false);
      root.releaseTurnLease('session-a');
      expect(root.tryAcquireTurnLease('session-b')).toBe(true);
    });
  });

  describe('releaseTurnLease — holder-checked, idempotent', () => {
    it('releasing an absent/never-acquired holder is a safe no-op', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(() => root.releaseTurnLease('never-acquired')).not.toThrow();
      expect(root.anyLiveTurn()).toBe(false);
    });

    it('a NON-holder release does NOT clear the real holder (crash/dispose must release under the CORRECT id)', () => {
      const root = new RootCoordinator('/ws', undefined);
      root.tryAcquireTurnLease('session-a');
      root.releaseTurnLease('session-b'); // wrong id — no-op
      expect(root.anyLiveTurn()).toBe(true);
      root.releaseTurnLease('session-a'); // correct id — releases
      expect(root.anyLiveTurn()).toBe(false);
    });

    it('is safe to call twice in a row (double release / crash-then-dispose ordering)', () => {
      const root = new RootCoordinator('/ws', undefined);
      root.tryAcquireTurnLease('session-a');
      root.releaseTurnLease('session-a');
      expect(() => root.releaseTurnLease('session-a')).not.toThrow();
      expect(root.anyLiveTurn()).toBe(false);
    });
  });

  describe('anyLiveTurn — the restore/redo interlock predicate', () => {
    it('false when idle, true while ANY holder (turn OR one-shot id) holds the lease', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.anyLiveTurn()).toBe(false);
      root.tryAcquireTurnLease('one-shot-1');
      expect(root.anyLiveTurn()).toBe(true);
    });

    it('goes false the instant the sole holder releases — no deadlock', () => {
      const root = new RootCoordinator('/ws', undefined);
      root.tryAcquireTurnLease('session-a');
      root.releaseTurnLease('session-a');
      expect(root.anyLiveTurn()).toBe(false);
      // a following turn can then acquire — proves no residual deadlock
      expect(root.tryAcquireTurnLease('session-b')).toBe(true);
    });
  });

  describe('nextTurnOrdinal — root-scoped positive monotonic counter (§2c)', () => {
    it('starts at 1 and increments by 1 on every call', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.nextTurnOrdinal()).toBe(1);
      expect(root.nextTurnOrdinal()).toBe(2);
      expect(root.nextTurnOrdinal()).toBe(3);
    });

    it('is independent of the baseline counter (no cross-contamination)', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.nextBaselineOrdinal()).toBe(-1);
      expect(root.nextTurnOrdinal()).toBe(1);
      expect(root.nextBaselineOrdinal()).toBe(-2);
      expect(root.nextTurnOrdinal()).toBe(2);
    });
  });

  describe('nextBaselineOrdinal — root-scoped NEGATIVE monotonic counter (F3)', () => {
    it('starts at -1 and decrements by 1 on every call (never collides with a positive turn ordinal)', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(root.nextBaselineOrdinal()).toBe(-1);
      expect(root.nextBaselineOrdinal()).toBe(-2);
      expect(root.nextBaselineOrdinal()).toBe(-3);
    });
  });

  describe('refreshCheckpointsPanel — W6-FI-c Part 2 (3-way ARCH I-4c, W4-F5 placement fix)', () => {
    it('invokes the injected notifyCheckpointsChanged callback', () => {
      const notify = vi.fn();
      const root = new RootCoordinator('/ws', undefined, notify);
      root.refreshCheckpointsPanel();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('is a safe no-op when no callback was injected (2-arg construction — every pre-existing call site)', () => {
      const root = new RootCoordinator('/ws', undefined);
      expect(() => root.refreshCheckpointsPanel()).not.toThrow();
    });

    it('every call reaches the SAME wired callback — never re-constructed per call (the F5 fix: sourced ONCE, not N×)', () => {
      const notify = vi.fn();
      const root = new RootCoordinator('/ws', undefined, notify);
      root.refreshCheckpointsPanel();
      root.refreshCheckpointsPanel();
      root.refreshCheckpointsPanel();
      expect(notify).toHaveBeenCalledTimes(3);
    });
  });

  it('two SEPARATE RootCoordinator instances (two roots) never share lease/ordinal state', () => {
    const a = new RootCoordinator('/ws-a', undefined);
    const b = new RootCoordinator('/ws-b', undefined);
    expect(a.tryAcquireTurnLease('session-1')).toBe(true);
    // A DIFFERENT root's lease is untouched — acquiring on b never contends with a.
    expect(b.tryAcquireTurnLease('session-2')).toBe(true);
    expect(a.anyLiveTurn()).toBe(true);
    expect(b.anyLiveTurn()).toBe(true);
    expect(a.nextTurnOrdinal()).toBe(1);
    expect(b.nextTurnOrdinal()).toBe(1); // independent counters, both start at 1
  });
});
