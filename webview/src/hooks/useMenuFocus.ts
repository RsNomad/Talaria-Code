/*
 * B3 / path doc §2.3 — the APG menu-button keyboard contract, extracted once
 * from `AttachMenu.tsx` (the repo's only previously-correct APG menu) so the
 * preset and mode pickers in `Composer.tsx` (UI M-1: they claimed
 * `role="menu"` with none of the contract) can adopt the same behavior
 * instead of a third hand-rolled copy. React's own guidance is to extract a
 * custom hook exactly when stateful logic (state + refs + effects) is
 * duplicated across components
 * (https://react.dev/learn/reusing-logic-with-custom-hooks, fetched live for
 * this task).
 *
 * Contract (grounded live for this task):
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/ — "Enter: opens
 *   the menu and places focus on the first menu item."
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu/ — Escape: "Close the menu
 *   that contains focus and return focus to the element or context, e.g.,
 *   menu button or parent menuitem, from which the menu was opened."; Tab:
 *   "move focus out of the menu ... and close all menus"; Up/Down Arrow move
 *   focus to the previous/next item ("optionally wrapping" — this hook
 *   CLAMPS at the ends via `nextRovingIndex(..., { wrap: false })`,
 *   AttachMenu's pre-existing convention and this repo's canonical menu
 *   behavior; B2 §2.2 introduced `nextRovingIndex`).
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/ — "Down Arrow ...
 *   Opens the menu ... moves focus to the first menu item"; "Up Arrow ...
 *   Opens the menu ... moves focus to the LAST menu item." (T-16 F10: this
 *   hook's `onTriggerKey` previously opened at the first item regardless of
 *   which arrow key was pressed — fixed below via `openAtRef`, a one-shot
 *   starting index consumed by the open-effect and reset immediately after,
 *   so a later plain open — click, Enter — is never affected by a prior
 *   ArrowUp.)
 *
 * Extraction safety: `AttachMenu.dom.test.tsx` is a CHARACTERIZATION test of
 * AttachMenu's behavior BEFORE this hook existed. It must stay green,
 * unmodified, after AttachMenu is refactored to call this hook — that is the
 * proof the extraction preserved behavior exactly.
 *
 * Deliberately OUT of scope for this hook: outside-mousedown dismissal. Every
 * call site already owns its own outside-click effect (it needs the
 * trigger-node check, to avoid the opening click immediately re-closing the
 * menu) — see `AttachMenu.tsx`'s own effect and `Composer.tsx:284-302`.
 *
 * Task 20 (WV4-MIN, additive — existing fields/behavior unchanged):
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu/ — "Home: moves focus to
 *   first item"; "End: moves focus to last item". `onMenuKey`'s arrow branch
 *   now also routes Home/End through `nextRovingIndex` (it already computed
 *   both — `rovingIndex.ts:58-61` — this only wires them in). AttachMenu
 *   never emits Home/End itself, so its characterization stays green
 *   unmodified; it simply never triggers the new branch.
 * - `openMenuAt(index)` / `focusItem(index)`: OverflowMenu's local roving
 *   copy is being retired onto this hook. Both pieces of OverflowMenu-local
 *   behavior the hook deliberately doesn't own (see above) still need a way
 *   to reach into the hook's state from outside a keypress: `openMenuAt`
 *   lets a caller open with initial focus on an arbitrary index
 *   (OverflowMenu's G-4 park-on-the-ACTIVE-item, not always index 0/last the
 *   way `openAtRef`'s ArrowUp/ArrowDown cases are); `focusItem` lets a caller
 *   move roving focus programmatically (OverflowMenu's T-16 WV-2 shrink-clamp
 *   effect). Both clamp into `[0, itemCount - 1]`, matching this hook's
 *   existing clamp-not-wrap convention.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { nextRovingIndex } from '../components/rovingIndex';

export interface UseMenuFocusResult {
  /** Whether the menu is currently open. */
  open: boolean;
  /** Index of the menu item that currently owns roving tabindex/focus. */
  focusIdx: number;
  /** Ref callback for menu item `i` — wire to each `role="menuitem"` element. */
  itemRef: (i: number) => (el: HTMLButtonElement | null) => void;
  /** Keydown handler for the menu container: Escape / Tab / ArrowUp / ArrowDown. */
  onMenuKey: (e: KeyboardEvent) => void;
  /** Keydown handler for the trigger: ArrowUp/ArrowDown open the menu when
   * closed (focus lands on the first item via the open-effect below, same
   * as AttachMenu's pre-existing trigger convention). */
  onTriggerKey: (e: KeyboardEvent) => void;
  /** Opens the menu. */
  openMenu: () => void;
  /** Toggles open/closed — mirrors a trigger button's onClick. */
  toggleMenu: () => void;
  /** Closes the menu. `returnFocus` (default true) also moves focus back to
   * the trigger; pass `false` from a selection handler where the click
   * already dismissed the popup and no refocus is needed. */
  closeMenu: (returnFocus?: boolean) => void;
  /** Task 20: opens the menu with initial focus on `index` (clamped into
   * range) instead of the default first item — e.g. OverflowMenu's
   * park-on-the-active-item behavior. */
  openMenuAt: (index: number) => void;
  /** Task 20: moves roving focus to `index` (clamped into range)
   * programmatically, outside of a keypress — e.g. OverflowMenu's
   * shrink-clamp effect re-parking focus after `items` shrinks. */
  focusItem: (index: number) => void;
}

export function useMenuFocus(
  itemCount: number,
  triggerRef: RefObject<HTMLElement | null>,
): UseMenuFocusResult {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // F10: one-shot starting index for the NEXT open, defaulting to the first
  // item (0) — `onTriggerKey` overwrites it to the last item just before an
  // ArrowUp-open. The open-effect below reads it and resets it back to 0
  // immediately, so it never leaks into a later plain open (click/Enter).
  const openAtRef = useRef(0);

  // AttachMenu.tsx's original open-effect, extended for F10: focus the
  // requested start item (first, by default; last, after an ArrowUp-open)
  // one frame after open (rAF — the item isn't in the DOM yet on the same
  // tick the `open` state flips).
  useEffect(() => {
    if (!open) return;
    const start = openAtRef.current;
    openAtRef.current = 0;
    setFocusIdx(start);
    const raf = requestAnimationFrame(() => itemRefs.current[start]?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const openMenu = () => setOpen(true);
  const toggleMenu = () => setOpen((o) => !o);

  const closeMenu = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const move = (next: number) => {
    setFocusIdx(next);
    itemRefs.current[next]?.focus();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Tab') {
      // APG: Tab moves focus out of the menu and closes it — the browser's
      // own default Tab handling moves focus, so this must NOT
      // preventDefault (matches AttachMenu's pre-existing behavior).
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const next = nextRovingIndex(focusIdx, e.key, itemCount, { wrap: false });
      if (next !== null) {
        e.preventDefault();
        move(next);
      }
    }
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (!open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      // F10: ArrowUp opens at the LAST item (APG menu-button); ArrowDown (and
      // every other open path — click, Enter) keeps opening at the first,
      // via `openAtRef`'s default of 0.
      if (e.key === 'ArrowUp' && itemCount > 0) openAtRef.current = itemCount - 1;
      openMenu();
    }
  };

  const itemRef = (i: number) => (el: HTMLButtonElement | null) => {
    itemRefs.current[i] = el;
  };

  // Task 20: caller-driven open-at-index — reuses the same one-shot
  // `openAtRef` the ArrowUp/ArrowDown trigger-open path already writes, so
  // the open-effect's single read-and-reset-to-0 logic stays the only place
  // that consumes it (no second code path to keep in sync).
  const openMenuAt = (index: number) => {
    if (itemCount > 0) openAtRef.current = Math.max(0, Math.min(index, itemCount - 1));
    setOpen(true);
  };
  // Task 20: caller-driven roving-focus move, clamped the same way `move`
  // itself clamps via `onMenuKey`'s Arrow/Home/End branch.
  const focusItem = (index: number) => move(Math.max(0, Math.min(index, itemCount - 1)));

  return {
    open,
    focusIdx,
    itemRef,
    onMenuKey,
    onTriggerKey,
    openMenu,
    toggleMenu,
    closeMenu,
    openMenuAt,
    focusItem,
  };
}
