import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

export const MIN_H = 64;

export interface ComposerResize {
  height: number;
  maxH: number;
  startResize: (e: PointerEvent<Element>) => void;
  resizeByKey: (e: KeyboardEvent<Element>) => void;
}

/**
 * WS-F5 F5-3 (FI-05, part 1/2): the drag/keyboard resize concern extracted
 * verbatim out of `Composer.tsx` — a clean 2-input/4-output seam that reads
 * only its two parameters and this module's own `MIN_H`, and owns none of
 * the composer's other concerns (the message text, file uploads, or the
 * `@`/`/` popups).
 */
export function useComposerResize(
  initialHeight: number,
  onHeightChange: (height: number) => void,
): ComposerResize {
  const [height, setHeight] = useState(initialHeight);
  // T5 (§7.2.3): owns the drag-resize AbortController — see `startResize`
  // and the unmount-cleanup `useEffect` below.
  const resizeAbortRef = useRef<AbortController | null>(null);
  /**
   * W4-T6 (UI#8): the resize grabber's `aria-valuemax` (below) used to be a
   * plain `const` recomputed from `window.innerHeight` inline in the render
   * body — which happened to track the real viewport whenever SOME OTHER
   * prop/state change caused a re-render, but nothing re-rendered this
   * component on an actual window `resize` with no other trigger, so the
   * announced max silently lagged behind reality (a stale snapshot, not a
   * live one) until the next unrelated render. State + a `resize` listener
   * makes it genuinely reactive. `clampH` below is UNCHANGED — it already
   * reads `window.innerHeight` fresh at drag-time, which was always correct;
   * only the DISPLAYED `aria-valuemax` was stale.
   */
  const [maxH, setMaxH] = useState(() =>
    Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.6),
  );

  // W4-T6 (UI#8): keeps `maxH` (the resize grabber's `aria-valuemax`) in
  // sync with the ACTUAL viewport on a real window resize — see the state
  // declaration's doc above for why the old inline-`const` computation went
  // stale.
  useEffect(() => {
    const onResize = () => setMaxH(Math.round(window.innerHeight * 0.6));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---- drag-resize ----

  const clampH = (h: number) => Math.max(MIN_H, Math.min(h, Math.round(window.innerHeight * 0.6)));

  /**
   * T5 (§7.2.3, AU-61 extra-b): one `AbortController` owns BOTH window
   * listeners (MDN: `abort()` removes every listener registered with that
   * signal), so the unmount path (below) and the pointerup path share ONE
   * teardown and neither can forget the other's listener. Before this fix,
   * teardown lived ONLY inside `up`: unmounting mid-drag (e.g. a host
   * panel-switch away from 'chat') leaked both window listeners until the
   * NEXT pointerup anywhere, left `document.body` stuck at
   * `user-select: none`, kept calling `setHeight` on an unmounted
   * component, and later fired `onHeightChange` through a stale closure.
   */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let latest = startH;
    const controller = new AbortController();
    resizeAbortRef.current = controller;
    document.body.style.userSelect = 'none';
    window.addEventListener(
      'pointermove',
      (ev) => {
        latest = clampH(startH + (startY - ev.clientY));
        setHeight(latest);
      },
      { signal: controller.signal },
    );
    window.addEventListener(
      'pointerup',
      () => {
        controller.abort(); // removes both listeners
        resizeAbortRef.current = null;
        document.body.style.userSelect = '';
        onHeightChange(latest);
      },
      { signal: controller.signal },
    );
  };

  // T5 (§7.2.3): unmount-only cleanup — ends an in-progress drag exactly as
  // `pointerup` would, EXCEPT it does NOT call `onHeightChange` (no persist
  // for a drag the unmount cancelled — a deliberate cancel-vs-commit
  // choice). Guarded on the ref so it only touches `userSelect` when a drag
  // was actually active, never clobbering an unrelated future writer of that
  // style. Idempotent: React 19 StrictMode's double-invoke finds the ref
  // already null on its second pass.
  useEffect(
    () => () => {
      if (resizeAbortRef.current) {
        resizeAbortRef.current.abort();
        resizeAbortRef.current = null;
        document.body.style.userSelect = '';
      }
    },
    [],
  );

  const resizeByKey = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = clampH(height + 16);
    else if (e.key === 'ArrowDown') next = clampH(height - 16);
    if (next === null) return;
    e.preventDefault();
    setHeight(next);
    onHeightChange(next);
  };

  return { height, maxH, startResize, resizeByKey };
}
