/*
 * FIX WAVE 2 — F-8: `disabled={pending}` destroys keyboard focus.
 *
 * THE BUG. `Toggle` rendered `disabled={disabled}` and every SettingsPanel row
 * passed `disabled={pending}`. A keyboard-only user tabs to the switch and
 * presses Space; the correlated request goes in flight; the button becomes
 * natively `disabled` mid-flight; the browser blurs it (a disabled element
 * cannot hold focus and is removed from the tab order); when the response
 * lands, focus is on `<body>`. Retrying a REFUSED toggle — the single most
 * likely outcome on these two mutually-exclusive rows — then means tabbing
 * through the entire panel again to get back to the control you were already
 * on.
 *
 * THE FIX. In-flight is not disablement, it is BUSY. `aria-disabled` +
 * a click guard makes the control non-interactive while keeping it focusable
 * and in the tab order (the WAI-ARIA "keep focusable, mark disabled" posture;
 * `aria-busy` names the in-flight state for the screen reader). Genuine,
 * indefinite disablement — Tools/Skills rows with no permission — keeps the
 * NATIVE `disabled`, which is the right primitive when there is nothing to
 * wait for and nothing to retry.
 *
 * WHY THIS IS A PURE FUNCTION TEST — corrected (final review, Finding 5).
 *
 * This block used to justify itself with "this repo has no jsdom and no
 * testing-library (an open owner decision), so 'the button kept focus' cannot
 * be asserted directly: there is no DOM to focus." Wave 5.2 FALSIFIED that on
 * both counts. The repo now has a `webview-dom` vitest project on jsdom with
 * `@testing-library/react` + `user-event` (`vitest.config.ts`), and focus
 * retention IS asserted directly against a real rendered tree —
 * `SettingsPanel.dom.test.tsx`, "the switch still has focus after a REFUSED
 * toggle settles", which drives a real click and a real round trip and then
 * asserts `toHaveFocus()`.
 *
 * The real reason this file stays a pure test is SCOPE DISCIPLINE, not
 * capability (`docs/testing/dom-tests.md`: DOM tests assert WIRING — that a
 * decision reaches the screen; assertions about DECISIONS live in the pure
 * tests and stay there). The two are complements, not duplicates:
 *
 *  - This file pins the decision TABLE EXHAUSTIVELY — every combination of
 *    `disabled` × `busy`, which of the two disablement mechanisms each one
 *    selects, and whether a click is forwarded. `Toggle` calls
 *    `toggleInteraction` and renders nothing but its result, so a mutation to
 *    that decision goes RED here, in microseconds, with no DOM in sight.
 *  - The DOM test proves ONE of those combinations actually survives the trip
 *    to the screen. It does not enumerate the table, and enumerating it there
 *    would be slower and no stronger.
 */
import { describe, it, expect } from 'vitest';
import { toggleInteraction } from './Toggle';

describe('toggleInteraction — F-8: in-flight is BUSY, not disabled', () => {
  it('idle: fully interactive, neither mechanism engaged', () => {
    expect(toggleInteraction(false, false)).toEqual({
      nativeDisabled: false,
      ariaDisabled: undefined,
      ariaBusy: undefined,
      interactive: true,
    });
  });

  it('undefined props behave exactly like false (every existing caller omits both)', () => {
    expect(toggleInteraction(undefined, undefined)).toEqual(toggleInteraction(false, false));
  });

  /*
   * THE F-8 ASSERTION. `nativeDisabled` MUST stay false while busy — that
   * single field is the whole bug. If a later edit "simplifies" this back to
   * `nativeDisabled: disabled || busy`, the control is blurred mid-flight
   * again and this test is the thing that says so.
   */
  it('BUSY: never natively disabled (that is what blurs it) — non-interactive via ARIA instead', () => {
    const busy = toggleInteraction(false, true);
    expect(
      busy.nativeDisabled,
      'F-8: a busy toggle must NOT set the native `disabled` attribute — that removes it from the tab order and blurs it mid-flight, dumping a keyboard user on <body>',
    ).toBe(false);
    expect(busy.ariaDisabled, 'a busy toggle must still announce as disabled').toBe(true);
    expect(busy.ariaBusy, 'a busy toggle must announce the in-flight state').toBe(true);
  });

  it('BUSY: the click guard is what makes it non-interactive, since the native attribute no longer can', () => {
    expect(
      toggleInteraction(false, true).interactive,
      'F-8: dropping the native `disabled` only keeps focus — a click guard must still stop a second gesture reaching onChange while one is in flight',
    ).toBe(false);
  });

  it('genuinely DISABLED (not busy): keeps the native attribute — nothing to wait for, nothing to retry', () => {
    const off = toggleInteraction(true, false);
    expect(off.nativeDisabled).toBe(true);
    expect(off.interactive).toBe(false);
    expect(off.ariaBusy, 'a disabled-but-idle control is not busy').toBeUndefined();
  });

  it('disabled AND busy: genuine disablement wins the mechanism, busy still announced', () => {
    const both = toggleInteraction(true, true);
    expect(both.nativeDisabled).toBe(true);
    expect(both.interactive).toBe(false);
    expect(both.ariaBusy).toBe(true);
  });

  it('exhaustive: a click reaches onChange in EXACTLY the idle state', () => {
    const table = [
      { disabled: false, busy: false, interactive: true },
      { disabled: false, busy: true, interactive: false },
      { disabled: true, busy: false, interactive: false },
      { disabled: true, busy: true, interactive: false },
    ] as const;
    for (const row of table) {
      expect(
        toggleInteraction(row.disabled, row.busy).interactive,
        `disabled=${row.disabled} busy=${row.busy}`,
      ).toBe(row.interactive);
    }
  });

  /*
   * The two mechanisms must never BOTH be engaged: `aria-disabled` on a
   * natively-disabled control is redundant, and — the reason it matters here
   * — a future edit that set both would make the "is it focusable?" question
   * ambiguous to read, which is precisely the confusion F-8 came out of.
   */
  it('the two mechanisms are mutually exclusive — exactly one disablement signal at a time', () => {
    for (const disabled of [false, true]) {
      for (const busy of [false, true]) {
        const i = toggleInteraction(disabled, busy);
        expect(
          i.nativeDisabled && i.ariaDisabled === true,
          `disabled=${disabled} busy=${busy}: native disabled and aria-disabled must never both be set`,
        ).toBe(false);
      }
    }
  });
});

/**
 * Audit B-5. F-8 removed the native `disabled` attribute from the switch on
 * purpose (a busy control must stay focusable), which left ONE line —
 * `Toggle.tsx:103`'s `if (!interaction.interactive) return;` — as the entire
 * double-click protection. Deleting it left the suite at the exact baseline.
 */
describe('toggleInteraction — B-5: a busy switch is not interactive', () => {
  it('busy means NOT interactive (a second click must be ignored)', () => {
    expect(toggleInteraction(false, true).interactive).toBe(false);
  });

  it('busy keeps the control focusable — no native disabled (F-8)', () => {
    const interaction = toggleInteraction(false, true);
    expect(interaction.nativeDisabled).toBe(false);
    expect(interaction.ariaBusy).toBe(true);
  });

  it('disabled means NOT interactive, and IS natively disabled', () => {
    const interaction = toggleInteraction(true, false);
    expect(interaction.interactive).toBe(false);
    expect(interaction.nativeDisabled).toBe(true);
  });

  it('idle and enabled IS interactive (non-vacuous)', () => {
    expect(toggleInteraction(false, false).interactive).toBe(true);
  });
});
