/*
 * F-8's decision (`Toggle.tsx`), extracted to a button-flavored home so it
 * can be applied mechanically wherever a plain `<button>` — not just
 * `Toggle`'s switch — renders `disabled` while a request is in flight.
 *
 * THE RULE. There are exactly two reasons a control stops accepting input:
 *  - GENUINE, INDEFINITE disablement — nothing to wait for, nothing to retry
 *    (a trust gate, a no-selection guard, "you don't have permission"). The
 *    native `disabled` attribute is the right primitive here: it correctly
 *    drops the control out of the tab order.
 *  - IN-FLIGHT — a request issued from THIS control (or one that mutex-locks
 *    it, e.g. another row's restore) has not come back yet. Native `disabled`
 *    is WRONG here: a keyboard/screen-reader user who just pressed the
 *    control gets blurred to `<body>` the instant it goes disabled (a
 *    disabled element cannot hold focus), and when the response lands they
 *    have to tab through the whole panel again to find their way back —
 *    worst exactly when a REFUSED request means they'd want to retry
 *    immediately. Busy instead keeps the control focusable and expresses
 *    non-interactivity through `aria-disabled` + `aria-busy`, with an
 *    explicit click-guard standing in for the native attribute's own
 *    click-blocking (WAI-ARIA's "keep it focusable, mark it disabled"
 *    posture).
 *
 * `toggleInteraction`'s invariant, unchanged by the move: exactly ONE
 * disablement MECHANISM is ever engaged. `nativeDisabled = isDisabled` —
 * NEVER `|| isBusy`, which is the one line this whole extraction exists to
 * keep honest — `ariaDisabled = !isDisabled && isBusy`, `ariaBusy = isBusy`,
 * `interactive = !isDisabled && !isBusy`.
 *
 * MIXED sites (a control gated by BOTH a genuine condition and an in-flight
 * one — e.g. Skills' hub Install button, `disabled={installing || stale}`)
 * split their condition into the two arguments: the genuine-indefinite half
 * goes first (stays native), the in-flight half goes second (goes busy).
 * `busyInteraction(stale, installing)` keeps `stale` natively disabled (there
 * is nothing to wait for — the shown preview no longer describes what
 * Install would act on) while `installing` goes busy.
 *
 * WHY ONE FUNCTION, TWO NAMES. `Toggle.tsx` keeps importing (and re-exporting,
 * so `Toggle.test.ts` still resolves `toggleInteraction` from `./Toggle`
 * unchanged) `toggleInteraction` under its original name — it is the switch's
 * own decision and every existing test/caller already spells it that way.
 * `busyInteraction` is the identical function under the name a `<button>`
 * call site reads more naturally; there is ONE implementation, never two
 * copies to drift.
 *
 * ⟐ CARVE-OUT — `SettingsPanel.tsx`'s "Enable codebase index" `<select>`
 * (documented at `SettingsPanel.tsx:110-115`, decision V11) deliberately does
 * NOT route through this helper: `aria-disabled` does not suppress a native
 * `<select>` (a screen reader still opens and operates the listbox), so the
 * ARIA-only busy posture this module provides has no real effect there — the
 * guard would have to move into `onChange`, which changes the control's
 * semantics rather than just its disablement mechanism. That `<select>` stays
 * on plain native `disabled` for its own indefinite gate (the trust gate),
 * unchanged by this file. AU-40 (this sweep) is scoped to `<button>` elements
 * only — do not re-implement the select against this helper.
 */

/**
 * The rendered form of a control's genuine/`in-flight` disablement. Exactly
 * one disablement MECHANISM is ever engaged: the native attribute for
 * genuine disablement, ARIA for in-flight.
 */
export interface ToggleInteraction {
  /** The native `disabled` attribute — removes the control from the tab order. */
  readonly nativeDisabled: boolean;
  /** `aria-disabled`, for the busy case that must stay focusable. Omitted when unset. */
  readonly ariaDisabled: true | undefined;
  /** `aria-busy`, whenever a request from this control is in flight. Omitted when unset. */
  readonly ariaBusy: true | undefined;
  /** Whether a click should be forwarded to the control's handler. */
  readonly interactive: boolean;
}

/**
 * F-8's decision, extracted so it is provable without a DOM. Both `Toggle`
 * and every swept `<button>` render nothing but this result, so
 * `Toggle.test.ts` exercises the real code path for every caller at once.
 */
export function toggleInteraction(disabled?: boolean, busy?: boolean): ToggleInteraction {
  const isDisabled = disabled === true;
  const isBusy = busy === true;
  return {
    // Never `|| isBusy` — that is the F-8 bug, and it is the one line this
    // whole extraction exists to keep honest.
    nativeDisabled: isDisabled,
    ariaDisabled: !isDisabled && isBusy ? true : undefined,
    ariaBusy: isBusy ? true : undefined,
    interactive: !isDisabled && !isBusy,
  };
}

/**
 * AU-40: the button-reading alias — identical function, read naturally at a
 * plain `<button>` call site (`genuine-indefinite`, `in-flight`) rather than
 * `Toggle`'s own `(disabled, busy)` vocabulary. ONE implementation.
 */
export const busyInteraction = toggleInteraction;
