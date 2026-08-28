import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { bridge } from '../bridge';
import { useDebouncedPersist } from './useDebouncedPersist';

function Harness({ n, delay }: { n: number; delay: number }) {
  useDebouncedPersist(() => ({ n }), [n], delay);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CA-10: useDebouncedPersist coalesces writes', () => {
  it('[perf genuine-RED] N rapid dep changes cause exactly ONE trailing setState (not N)', () => {
    vi.useFakeTimers();
    const setState = vi.spyOn(bridge, 'setState');
    const { rerender } = render(<Harness n={0} delay={400} />);
    setState.mockClear(); // ignore the mount schedule; count only the burst
    act(() => {
      for (let n = 1; n <= 5; n++) rerender(<Harness n={n} delay={400} />);
    });
    expect(setState).not.toHaveBeenCalled(); // still pending — coalesced, not per-render
    act(() => { vi.advanceTimersByTime(400); });
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenLastCalledWith({ n: 5 });
  });

  it('flushes immediately when the document becomes hidden', () => {
    vi.useFakeTimers();
    const setState = vi.spyOn(bridge, 'setState');
    const { rerender } = render(<Harness n={0} delay={400} />);
    setState.mockClear();
    act(() => { rerender(<Harness n={3} delay={400} />); });
    expect(setState).not.toHaveBeenCalled();
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenLastCalledWith({ n: 3 });
    if (original) Object.defineProperty(document, 'visibilityState', original);
  });

  it('flushes the latest snapshot on unmount', () => {
    vi.useFakeTimers();
    const setState = vi.spyOn(bridge, 'setState');
    const { rerender, unmount } = render(<Harness n={0} delay={400} />);
    setState.mockClear();
    act(() => { rerender(<Harness n={9} delay={400} />); });
    act(() => { unmount(); });
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenLastCalledWith({ n: 9 });
  });
});
