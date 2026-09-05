/*
 * A11Y-01 (WCAG 2.4.3): the unmount-on-action sibling of the fixed AU-40.
 * When a control unmounts AS A RESULT of its own activation (an approval
 * option settling, a diff hunk resolving, Send swapping to Stop), the
 * browser silently drops focus to <body> — invisible to a keyboard user.
 * ONE shared source (ADR-UX): the activation handler ARMS this hook with
 * the activated element; after any commit in which that element has left
 * the DOM and focus fell to <body>, focus moves to the caller's stable
 * anchor (which MUST carry tabIndex={-1} to be programmatically focusable —
 * same requirement SectionLabel already documents for its jump target).
 * The bare-`useEffect` (no dep array) is deliberate: the check is two ref
 * reads per commit, and the unmount can land on ANY later commit (the state
 * change that removes the control is asynchronous).
 */
import { useEffect, useRef, type RefObject } from 'react';

export function useFocusAnchorOnUnmount(
  anchorRef: RefObject<HTMLElement | null>,
): (activated: HTMLElement) => void {
  const armedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = armedRef.current;
    if (!el || el.isConnected) return;
    armedRef.current = null;
    if (document.activeElement === document.body || document.activeElement === null) {
      anchorRef.current?.focus();
    }
  });
  return (activated) => {
    armedRef.current = activated;
  };
}
