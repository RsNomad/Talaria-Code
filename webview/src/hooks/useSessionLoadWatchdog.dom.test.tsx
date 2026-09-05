/**
 * UX-04b: `pendingSessionLoad`'s spinner had NO deadline — a wedged
 * `tab.load` spun forever. This hook arms ONE timer per DISTINCT pending
 * load (keyed on `pending.tabId` + `pending.sessionId`), fires `onTimeout`
 * once at the deadline, and cancels/re-arms whenever the pending load's
 * IDENTITY changes (a new load replacing an old one, or clearing to
 * `undefined` once the host's terminal `tab.bound`/`tab.error` disarms it —
 * `transcript.ts`'s `clearResolvedSessionLoad`).
 *
 * WS-R4 (merged on this branch) already closes this wedge HOST-side at
 * `SESSION_ESTABLISH_DEADLINE_MS` (120s) — this hook is deliberately DEFENSE
 * IN DEPTH at a longer deadline (130s), firing only when NO host terminal
 * ever arrives at all.
 *
 * `vi.useFakeTimers()`/`vi.useRealTimers()` try/finally + `vi.getTimerCount()`
 * leak checks mirror `ApprovalCard.dom.test.tsx`'s own local-timer pattern
 * (this workspace's only prior fake-timer hook coverage).
 */
import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useSessionLoadWatchdog, SESSION_LOAD_WATCHDOG_MS } from './useSessionLoadWatchdog';

type Pending = { tabId: string; sessionId: string } | undefined;

describe('UX-04b: useSessionLoadWatchdog', () => {
  it(`fires onTimeout exactly once, ${SESSION_LOAD_WATCHDOG_MS}ms after a pending load is set`, () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      renderHook(() => useSessionLoadWatchdog({ tabId: 'tab-1', sessionId: 'sess-1' }, onTimeout));

      act(() => {
        vi.advanceTimersByTime(SESSION_LOAD_WATCHDOG_MS - 1);
      });
      expect(onTimeout, 'must not fire before the deadline').not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending load replaced by a DIFFERENT one before its deadline cancels the old timer — only the replacement can fire, and only 130s after IT armed', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const { rerender } = renderHook(({ pending }: { pending: Pending }) => useSessionLoadWatchdog(pending, onTimeout), {
        initialProps: { pending: { tabId: 'tab-1', sessionId: 'sess-1' } as Pending },
      });

      // Most of the way through the FIRST load's deadline...
      act(() => {
        vi.advanceTimersByTime(100_000);
      });
      // ...a second click replaces it with a DIFFERENT session before it fires.
      rerender({ pending: { tabId: 'tab-1', sessionId: 'sess-2' } });

      // The OLD timer's original deadline (130s after ITS OWN arm, i.e. 30s
      // from here) passes with no fire — it was cancelled, not just outrun.
      act(() => {
        vi.advanceTimersByTime(29_999);
      });
      expect(onTimeout, 'the cancelled OLD timer must not fire').not.toHaveBeenCalled();

      // The REPLACEMENT needs the FULL 130s from ITS OWN arm (the rerender
      // above) — advancing the remaining distance to that deadline.
      act(() => {
        vi.advanceTimersByTime(SESSION_LOAD_WATCHDOG_MS - 29_999);
      });
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pending cleared to undefined before the deadline disarms the watchdog entirely — no fire, no leaked timer', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const { rerender } = renderHook(({ pending }: { pending: Pending }) => useSessionLoadWatchdog(pending, onTimeout), {
        initialProps: { pending: { tabId: 'tab-1', sessionId: 'sess-1' } as Pending },
      });

      act(() => {
        vi.advanceTimersByTime(50_000);
      });
      // The host's tab.bound/tab.error terminal lands -> App clears pendingSessionLoad.
      rerender({ pending: undefined });

      act(() => {
        vi.advanceTimersByTime(SESSION_LOAD_WATCHDOG_MS * 2);
      });
      expect(onTimeout, 'a cleared load must never fire').not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unmounting with a load still pending clears its timer (no leak)', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const { unmount } = renderHook(() =>
        useSessionLoadWatchdog({ tabId: 'tab-1', sessionId: 'sess-1' }, onTimeout),
      );
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
