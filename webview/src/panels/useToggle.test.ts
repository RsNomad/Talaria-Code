/*
 * useToggle rollback correctness (Correctness M4).
 * ------------------------------------------------------------------
 * This repo has no DOM/React test harness, so we test the hook's pure, React-free
 * transitions directly, plus an async integration harness that mirrors the hook's
 * exact control flow (the real {@link SequentialQueue} + functional-updater
 * composition, which React queues in order). The headline case: two RAPID OPPOSING
 * toggles on the same id that BOTH reject must settle back to the true pre-first
 * value — not to a fabricated `!next` that disagrees with the server.
 */
import { describe, it, expect } from 'vitest';
import { SequentialQueue } from '../state/sequentialQueue';
import {
  confirmToggle,
  emptyToggleState,
  issueToggle,
  reconcileToggle,
  rollbackToggle,
  type PerformToggle,
  type ToggleState,
} from './useToggle';

const isOn = (s: ToggleState, id: string, serverValue: boolean): boolean => s.overrides[id] ?? serverValue;

describe('useToggle pure transitions', () => {
  it('issueToggle records the optimistic value and the op sequence', () => {
    const s = issueToggle(emptyToggleState, 'x', false, 1);
    expect(isOn(s, 'x', true)).toBe(false); // optimistic override wins over serverValue
    expect(s.latestSeq.x).toBe(1);
  });

  it('a single reject with no prior confirm DELETES the override (falls back to serverValue, not !next)', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1); // serverValue is true
    s = rollbackToggle(s, 'x', 1);
    expect('x' in s.overrides).toBe(false);
    expect(isOn(s, 'x', true)).toBe(true); // reflects the live server value again
  });

  it('a resolved toggle confirms the value and the override persists', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = confirmToggle(s, 'x', false, 1);
    expect(isOn(s, 'x', true)).toBe(false);
    expect(s.confirmed.x).toBe(false);
  });

  it('rollback of a superseded op does NOT clobber a newer optimistic value', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = issueToggle(s, 'x', true, 2); // a newer, opposing toggle
    s = rollbackToggle(s, 'x', 1); // the older op rejects late
    expect(isOn(s, 'x', false)).toBe(true); // newer optimistic value survives
  });

  it('two opposing toggles that both reject settle to the true pre-first value', () => {
    // serverValue = true. Toggle OFF (seq1) then ON (seq2); FIFO ⇒ seq1 rejects first.
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = issueToggle(s, 'x', true, 2);
    s = rollbackToggle(s, 'x', 1); // superseded — no-op
    s = rollbackToggle(s, 'x', 2); // latest — revert to confirmed (none) ⇒ delete
    expect('x' in s.overrides).toBe(false);
    expect(isOn(s, 'x', true)).toBe(true); // back to the true pre-first (server) value
  });
});

/**
 * Mirror of `useToggle`'s control flow with a plain state cell instead of React's
 * `useState` — functional updaters compose exactly as React queues them, so this
 * faithfully exercises the same rollback logic against the real async queue.
 */
function makeSim(perform: PerformToggle) {
  let state = emptyToggleState;
  const set = (fn: (s: ToggleState) => ToggleState) => {
    state = fn(state);
  };
  const queue = new SequentialQueue();
  let seq = 0;
  const settled: Promise<unknown>[] = [];

  const toggle = (id: string, next: boolean) => {
    const s = ++seq;
    set((st) => issueToggle(st, id, next, s));
    settled.push(
      queue.run(() => perform(id, next)).then(
        () => set((st) => confirmToggle(st, id, next, s)),
        () => set((st) => rollbackToggle(st, id, s)),
      ),
    );
  };

  return {
    toggle,
    on: (id: string, serverValue: boolean) => isOn(state, id, serverValue),
    settle: () => Promise.all(settled),
  };
}

describe('useToggle async integration (SequentialQueue + rollback)', () => {
  it('two opposing toggles that BOTH reject settle to the true pre-first-toggle state', async () => {
    const sim = makeSim(() => Promise.reject(new Error('persist failed')));
    // serverValue = true (skill enabled). Rapidly toggle OFF then ON; both fail.
    sim.toggle('x', false);
    sim.toggle('x', true);
    await sim.settle();
    // The naive `!next` rollback would settle to OFF (disagreeing with the server);
    // the fixed baseline returns the switch to the true pre-first value: ON.
    expect(sim.on('x', true)).toBe(true);
  });

  it('a failed toggle after an intervening SUCCESS lands on what the server actually holds', async () => {
    // serverValue = false. Toggle OFF (fails) then ON (succeeds); FIFO ⇒ OFF rejects
    // first, but it is superseded, and ON confirms — so the switch ends ON.
    const perform: PerformToggle = (_id, next) =>
      next === false ? Promise.reject(new Error('off failed')) : Promise.resolve();
    const sim = makeSim(perform);
    sim.toggle('x', false);
    sim.toggle('x', true);
    await sim.settle();
    expect(sim.on('x', false)).toBe(true); // ON persisted; stale OFF rejection didn't win
  });

  it('a single failed toggle rolls back to the live server value', async () => {
    const sim = makeSim(() => Promise.reject(new Error('nope')));
    sim.toggle('x', false); // serverValue = true
    await sim.settle();
    expect(sim.on('x', true)).toBe(true);
  });
});

/*
 * V-11 TOGGLE-HONESTY (Tier-2). Two prior dishonesties, both closed by
 * `lastError` + `reconcileToggle`:
 *  1. A rejected persist rolled the switch back with NOTHING surfaced anywhere
 *     — `lastError` now records the reason.
 *  2. A CONFIRMED optimistic value masked every later authoritative
 *     `panel.data` push forever — `reconcileToggle` now lets the server win
 *     again the instant the op that produced the override has fully settled
 *     (no clobbering while one is still in flight).
 */
describe('useToggle V-11 TOGGLE-HONESTY: lastError + reconcile', () => {
  it('a rejected toggle records the rejection reason as lastError', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1); // serverValue is true
    s = rollbackToggle(s, 'x', 1, 'network error');
    expect(s.lastError.x).toBe('network error');
  });

  it('a fresh issueToggle clears a stale lastError left by a prior rejection', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = rollbackToggle(s, 'x', 1, 'network error');
    expect(s.lastError.x).toBe('network error');
    s = issueToggle(s, 'x', true, 2); // a fresh attempt hasn't failed yet
    expect('x' in s.lastError).toBe(false);
  });

  it('a superseded rejection records NEITHER an override revert nor a lastError', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = issueToggle(s, 'x', true, 2); // a newer, opposing toggle supersedes op 1
    s = rollbackToggle(s, 'x', 1, 'stale reason'); // op 1 rejects late — superseded
    expect('x' in s.lastError).toBe(false);
    expect(isOn(s, 'x', false)).toBe(true); // the newer optimistic value still stands
  });

  it('reconcileToggle is a no-op while an op is still in flight — the optimistic value stands', () => {
    const s = issueToggle(emptyToggleState, 'x', false, 1); // issued, never settled
    const reconciled = reconcileToggle(s, 'x');
    expect(reconciled).toBe(s); // same reference: a real no-op, not an equal-but-fresh object
    expect(isOn(reconciled, 'x', true)).toBe(false); // optimistic value still stands
  });

  it('reconcileToggle lets a later disagreeing serverValue win once the op has SETTLED', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = confirmToggle(s, 'x', false, 1); // settles: latestSeq === settledSeq now
    expect(isOn(s, 'x', true)).toBe(false); // still masked — reconcile hasn't run yet

    const reconciled = reconcileToggle(s, 'x');
    expect('x' in reconciled.overrides).toBe(false);
    expect('x' in reconciled.confirmed).toBe(false);
    // A later host push disagreeing with the confirmed value now shows through —
    // the mask is gone, the server is authority again.
    expect(isOn(reconciled, 'x', true)).toBe(true);
  });

  it('reconcileToggle is a no-op once nothing optimistic remains (idempotent, no needless re-render)', () => {
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = confirmToggle(s, 'x', false, 1);
    const once = reconcileToggle(s, 'x');
    const twice = reconcileToggle(once, 'x');
    expect(twice).toBe(once); // same reference — the render-time `if (next !== state)` guard needs this
  });

  it('rapid opposing toggles that both reject settle on the confirmed baseline AND record the LAST rejection', () => {
    // Extends the existing M4 test above (same setup) with the V-11 half.
    let s = issueToggle(emptyToggleState, 'x', false, 1);
    s = issueToggle(s, 'x', true, 2);
    s = rollbackToggle(s, 'x', 1, 'first reject'); // superseded — no-op, including lastError
    expect('x' in s.lastError).toBe(false);
    s = rollbackToggle(s, 'x', 2, 'second reject'); // latest — applies
    expect('x' in s.overrides).toBe(false);
    expect(isOn(s, 'x', true)).toBe(true);
    expect(s.lastError.x).toBe('second reject');
    // Fully settled now: reconcile is a no-op (nothing optimistic left to clear).
    expect(reconcileToggle(s, 'x')).toBe(s);
  });
});
