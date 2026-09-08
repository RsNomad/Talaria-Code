/*
 * FI-15 (feeds FI-05): `Composer.tsx`'s preset picker (~:1192-1240) and mode
 * picker (~:1268-1326) are two near-duplicate APG-menu implementations. Their
 * KEYBOARD/focus behaviour is ALREADY single-sourced via the `useMenuFocus`
 * hook (`presetMenu`/`modeMenu` — see `webview/src/hooks/useMenuFocus.ts`).
 * What was duplicated (and drift-prone) is the JSX container chrome: the
 * `<div role="menu" …>` wrapper. Grounded on the live HEAD (`2bccd98`): the
 * two containers are IDENTICAL — same `role`, same attribute order, same
 * className apart from the interpolated `min-w` token — no deeper a11y drift
 * was found beyond that (only doc-comments above each container differ, and
 * those do not render). This component single-sources that chrome so a
 * future edit to one picker's container cannot silently diverge from the
 * other's; each caller still owns its own trigger button and menu items
 * (those differ meaningfully — 2-line radio rows w/ icon vs. a header caption
 * + a "None" item + single-line rows — and stay inline per the brief).
 *
 * BEHAVIOUR-PRESERVING: the rendered `role`/`aria-label`/className string is
 * byte-identical to each picker's pre-extraction container (see
 * `MenuPopup.dom.test.tsx`'s exact-className assertions and the untouched
 * `Composer.pickers.dom.test.tsx` suite, which still exercises both pickers
 * end-to-end through real `useMenuFocus` instances).
 */
import type { KeyboardEvent, ReactNode } from 'react';

interface MenuPopupProps {
  ariaLabel: string;
  /** The ONLY per-menu container variance today — e.g. `'min-w-[184px]'`
   * (preset) vs. `'min-w-[160px]'` (mode). */
  minWidthClass: string;
  /** Matches `useMenuFocus`'s `onMenuKey` handler type exactly (its `e`
   * parameter is React's `KeyboardEvent` with no type argument, i.e.
   * `KeyboardEvent<Element>`) — no `any`/`as` needed to wire it straight
   * through to this `<div>`'s `onKeyDown`. */
  onKeyDown: (e: KeyboardEvent) => void;
  children: ReactNode;
}

export function MenuPopup({ ariaLabel, minWidthClass, onKeyDown, children }: MenuPopupProps) {
  return (
    <div
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`absolute bottom-full left-0 z-30 mb-1 ${minWidthClass} overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg`}
    >
      {children}
    </div>
  );
}
