/*
 * WS-U U1 (UX-01, WCAG 2.1.1): axe `scrollable-region-focusable` flags any
 * `overflow-x-auto` region that actually scrolls but carries no operable tab
 * stop — a keyboard-only user then has no way to reach or pan a
 * horizontally-scrolling code block, table, diff hunk, or tool I/O panel.
 * Fix: measure whether the wrapped element ACTUALLY overflows
 * (`scrollWidth > clientWidth`) and, ONLY while it does, add `tabIndex={0}`
 * plus a NAMED `role="group"` (a named non-landmark container — deliberately
 * NOT `role="region"`, which would flood landmark navigation with one region
 * per code block in a long transcript, ADR-R2-18) and an `aria-label`. A
 * non-overflowing container must never receive any of the three — a dead tab
 * stop (a stop that does nothing) is its own accessibility defect, which is
 * exactly what `scrollable-region-focusable` also flags the other way. No key
 * handler is added: once focused, arrow keys already scroll an
 * `overflow-x-auto` element natively.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * Measures `ref.current`'s actual horizontal overflow after every render
 * (content — not just the element's own box — can change what overflows,
 * e.g. a streaming code block growing longer lines with no resize event) and
 * re-measures on a real size change via `ResizeObserver` when the host
 * provides one. Guarded: some hosts (and, without `webview/test/dom-setup.ts`'s
 * stub, jsdom) have no `ResizeObserver` at all.
 */
export function useIsOverflowing(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return overflowing;
}

interface ScrollRegionProps {
  /** @default 'div' */
  as?: 'div' | 'pre';
  /** Accessible name, applied ONLY while the region is actually focusable. */
  label: string;
  /** MUST include `overflow-x-auto` — the caller's existing classes, unchanged. */
  className: string;
  children: ReactNode;
}

export function ScrollRegion({ as = 'div', label, className, children }: ScrollRegionProps): ReactElement {
  const divRef = useRef<HTMLDivElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const ref = as === 'pre' ? preRef : divRef;
  const overflowing = useIsOverflowing(ref);
  const tabIndex = overflowing ? 0 : undefined;
  const role = overflowing ? 'group' : undefined;
  const ariaLabel = overflowing ? label : undefined;

  if (as === 'pre') {
    return (
      <pre ref={preRef} className={className} tabIndex={tabIndex} role={role} aria-label={ariaLabel}>
        {children}
      </pre>
    );
  }
  return (
    <div ref={divRef} className={className} tabIndex={tabIndex} role={role} aria-label={ariaLabel}>
      {children}
    </div>
  );
}
