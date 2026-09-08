import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useComposerResize, MIN_H } from './useComposerResize';

/**
 * WS-F5 F5-3 (FI-05, part 1/2): `useComposerResize` moved the drag/keyboard
 * height state out of `Composer.tsx` verbatim — this harness renders the
 * SAME `role="separator"` shape the component's grabber uses
 * (`Composer.tsx`'s `aria-valuenow`/`aria-valuemax`/`onPointerDown`/
 * `onKeyDown` wiring), so these tests exercise the real extracted hook
 * through the same DOM contract the component relies on. None of this
 * key-delta/floor/ceiling behaviour had unit coverage before the move — it
 * previously required a full `Composer` render to reach at all.
 */
function Harness({
  initialHeight,
  onHeightChange,
}: {
  initialHeight: number;
  onHeightChange: (height: number) => void;
}) {
  const { height, maxH, startResize, resizeByKey } = useComposerResize(initialHeight, onHeightChange);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize composer"
      aria-valuenow={height}
      aria-valuemin={MIN_H}
      aria-valuemax={maxH}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={resizeByKey}
    />
  );
}

function renderHarness(initialHeight: number, onHeightChange: (height: number) => void) {
  render(<Harness initialHeight={initialHeight} onHeightChange={onHeightChange} />);
  return screen.getByRole('separator', { name: 'Resize composer' });
}

describe('WS-F5 F5-3: useComposerResize (moved verbatim from Composer.tsx)', () => {
  it('ArrowUp increases height by 16 and fires onHeightChange with the new value', () => {
    const onHeightChange = vi.fn();
    const separator = renderHarness(120, onHeightChange);

    fireEvent.keyDown(separator, { key: 'ArrowUp' });

    expect(separator).toHaveAttribute('aria-valuenow', '136');
    expect(onHeightChange).toHaveBeenCalledWith(136);
  });

  it('ArrowDown decreases height by 16 and fires onHeightChange with the new value', () => {
    const onHeightChange = vi.fn();
    const separator = renderHarness(120, onHeightChange);

    fireEvent.keyDown(separator, { key: 'ArrowDown' });

    expect(separator).toHaveAttribute('aria-valuenow', '104');
    expect(onHeightChange).toHaveBeenCalledWith(104);
  });

  it('ArrowDown at the floor (MIN_H) stays clamped at MIN_H and STILL fires onHeightChange(MIN_H) — characterized, not "fixed"', () => {
    const onHeightChange = vi.fn();
    const separator = renderHarness(MIN_H, onHeightChange);

    fireEvent.keyDown(separator, { key: 'ArrowDown' });

    expect(separator).toHaveAttribute('aria-valuenow', String(MIN_H));
    expect(onHeightChange).toHaveBeenCalledWith(MIN_H);
  });

  it('ArrowUp clamps at the viewport-derived ceiling (60% of window.innerHeight)', () => {
    const original = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true, writable: true });
      const onHeightChange = vi.fn();
      const separator = renderHarness(290, onHeightChange);

      fireEvent.keyDown(separator, { key: 'ArrowUp' });

      expect(separator).toHaveAttribute('aria-valuenow', '300');
      expect(onHeightChange).toHaveBeenCalledWith(300);
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: original, configurable: true, writable: true });
    }
  });

  it('a non-arrow key is a no-op: height unchanged, onHeightChange not called, event not preventDefault-ed', () => {
    const onHeightChange = vi.fn();
    const separator = renderHarness(120, onHeightChange);

    const notPrevented = fireEvent.keyDown(separator, { key: 'Enter' });

    expect(notPrevented).toBe(true);
    expect(separator).toHaveAttribute('aria-valuenow', '120');
    expect(onHeightChange).not.toHaveBeenCalled();
  });
});
