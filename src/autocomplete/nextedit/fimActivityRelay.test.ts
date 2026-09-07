import { describe, it, expect, vi } from 'vitest';
import { fimActivityRelay, attachFimActivity, detachFimActivity } from './fimActivityRelay';
import type { FimActivityListener } from '../provider';

/**
 * WS-F3 F3-6 (FI-06) — the direct pin for the swap-guard identity check that
 * moved out of `shell.vscode.ts` into this leaf. F3-1's golden masters only
 * observe the guard INDIRECTLY (through the shell's trigger/dispose paths);
 * this file pins it directly against fake listeners, spy-per-method, so the
 * guard's own logic — not just the surface it sits behind — has a test that
 * fails if the `=== listener` identity check is ever weakened or dropped.
 *
 * Module-level state (`currentFimActivity`) is shared across this file's own
 * tests, same as the real module shares it across the whole process — each
 * test below explicitly attaches/detaches rather than relying on import
 * order, so the suite is order-independent regardless of vitest's execution
 * order within the file.
 */

function fakeListener(commandId: string | undefined = undefined): FimActivityListener {
  return {
    requestStarted: vi.fn(),
    resultShown: vi.fn(),
    accepted: vi.fn(),
    acceptCommandId: vi.fn(() => commandId),
  };
}

describe('fimActivityRelay — WS-F3 F3-6 (FI-06): the attach/swap/detach-guard direct pin', () => {
  it('a fresh module (nothing attached) reaches the no-op: no throw, nothing forwarded', () => {
    const listener = fakeListener();
    // Ensure the module slot is at its no-op baseline for this test.
    detachFimActivity(listener);

    expect(() => fimActivityRelay.requestStarted()).not.toThrow();
    expect(listener.requestStarted).not.toHaveBeenCalled();
    expect(fimActivityRelay.acceptCommandId()).toBeUndefined();
  });

  it('attach A: the relay forwards to A', () => {
    const a = fakeListener('cmd-a');
    attachFimActivity(a);

    fimActivityRelay.accepted();
    expect(a.accepted).toHaveBeenCalledTimes(1);
    expect(fimActivityRelay.acceptCommandId()).toBe('cmd-a');

    detachFimActivity(a);
  });

  it('attach A, attach B (swap): the relay forwards to B, not A', () => {
    const a = fakeListener();
    const b = fakeListener();
    attachFimActivity(a);
    attachFimActivity(b);

    fimActivityRelay.accepted();
    expect(b.accepted).toHaveBeenCalledTimes(1);
    expect(a.accepted).not.toHaveBeenCalled();

    detachFimActivity(b);
  });

  it('attach A, attach B, detach A: the relay STILL forwards to B — the stale registration must not reset the slot (the guard\'s whole point)', () => {
    const a = fakeListener();
    const b = fakeListener();
    attachFimActivity(a);
    attachFimActivity(b);

    detachFimActivity(a);

    fimActivityRelay.accepted();
    expect(b.accepted).toHaveBeenCalledTimes(1);
    expect(a.accepted).not.toHaveBeenCalled();

    detachFimActivity(b);
  });

  it('attach B, detach B: the relay returns to the no-op', () => {
    const b = fakeListener();
    attachFimActivity(b);
    detachFimActivity(b);

    expect(() => fimActivityRelay.requestStarted()).not.toThrow();
    expect(b.requestStarted).not.toHaveBeenCalled();
    expect(fimActivityRelay.acceptCommandId()).toBeUndefined();
  });
});
