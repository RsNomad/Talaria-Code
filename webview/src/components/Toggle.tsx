/* Accessible on/off switch used by Tools / Skills / Settings panels. */
interface ToggleProps {
  on: boolean;
  /**
   * GENUINE, indefinite disablement — the control cannot be operated and
   * there is nothing to wait for (e.g. a row the user has no permission to
   * change). Renders the NATIVE `disabled` attribute, which correctly drops
   * the control out of the tab order.
   *
   * For "a request issued from this control is in flight", use {@link busy}
   * instead — see F-8 below.
   */
  disabled?: boolean;
  /**
   * FIX WAVE 2 — F-8. IN-FLIGHT: a request issued from THIS control has not
   * come back yet. Non-interactive, but deliberately NOT natively `disabled`.
   *
   * A keyboard-only user tabs to the switch and presses Space; if the button
   * went `disabled` mid-flight the browser would blur it (a disabled element
   * cannot hold focus and leaves the tab order), and when the response landed
   * focus would be sitting on `<body>`. Retrying a REFUSED toggle — much the
   * likeliest outcome on the two mutually-exclusive Next Edit rows — would
   * then mean tabbing through the whole panel again to get back to the
   * control they never meant to leave.
   *
   * So busy keeps focus and expresses non-interactivity through
   * `aria-disabled` plus a click guard (the WAI-ARIA "keep it focusable, mark
   * it disabled" posture), with `aria-busy` naming the in-flight state.
   */
  busy?: boolean;
  label: string;
  onChange?: (next: boolean) => void;
  /**
   * Fix wave Finding 2 (SettingsPanel «Next Edit Suggestions» rows): an
   * optional stable id so a `<label htmlFor={id}>` elsewhere in the row can
   * associate with THIS button specifically — narrowing the switch's
   * clickable/labelled region to just that label (e.g. the row title)
   * instead of relying on `<label>` containment, which activates on a click
   * anywhere inside it, including unrelated prose. `aria-label` below still
   * carries the accessible name either way; `id` only adds the `for`
   * association. Unused by every other caller (Tools/Skills/config rows),
   * so omitting it changes nothing for them.
   */
  id?: string;
  /**
   * T11 (§6-parity minor — RAG "Enable codebase index" row): a native HTML
   * tooltip naming WHY the control is disabled (e.g. the trust-gate
   * reason). Deliberately NOT `aria-disabled` — `toggleInteraction`'s own
   * invariant (below) is that native `disabled` and `aria-disabled` are
   * never BOTH engaged on this element; genuine indefinite disablement
   * already uses the native attribute, which VoiceOver/NVDA/JAWS all
   * announce correctly on its own. `title` adds the sighted-hover
   * explanation `ActionButton` gives its own disabled buttons, without
   * reopening that settled single-mechanism decision.
   */
  title?: string;
}

/**
 * The rendered form of {@link ToggleProps.disabled} / {@link ToggleProps.busy}.
 * Exactly one disablement MECHANISM is ever engaged: the native attribute for
 * genuine disablement, ARIA for in-flight.
 */
export interface ToggleInteraction {
  /** The native `disabled` attribute — removes the control from the tab order. */
  readonly nativeDisabled: boolean;
  /** `aria-disabled`, for the busy case that must stay focusable. Omitted when unset. */
  readonly ariaDisabled: true | undefined;
  /** `aria-busy`, whenever a request from this control is in flight. Omitted when unset. */
  readonly ariaBusy: true | undefined;
  /** Whether a click should be forwarded to `onChange`. */
  readonly interactive: boolean;
}

/**
 * F-8's decision, extracted so it is provable without a DOM. `Toggle` renders
 * nothing but this result, so `Toggle.test.ts` exercises the real code path.
 *
 * The repo gained jsdom + testing-library in wave 5.2 (ADR-015), and
 * `SettingsPanel.dom.test.tsx` now locks the RENDERED half — that the busy
 * control keeps keyboard focus across the round trip and carries `aria-busy`.
 * This pure extraction is still the right home for the DECISION and must not
 * be moved there: a DOM test earns its cost only for wiring, never for a
 * decision (`docs/testing/dom-tests.md`).
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

export function Toggle({ on, disabled, busy, label, onChange, id, title }: ToggleProps) {
  const interaction = toggleInteraction(disabled, busy);
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={interaction.nativeDisabled}
      aria-disabled={interaction.ariaDisabled}
      aria-busy={interaction.ariaBusy}
      // The guard the dropped native attribute no longer provides: without it
      // a busy control would still be fully clickable (and Space/Enter-able,
      // since it is still focused — which is the entire point).
      onClick={() => {
        if (!interaction.interactive) return;
        onChange?.(!on);
      }}
      className={`relative inline-flex h-4 w-7 flex-none items-center rounded-full transition-colors disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40 ${
        on ? 'bg-accent' : 'bg-overlay border border-border'
      }`}
    >
      <span
        className={`absolute h-3 w-3 rounded-full shadow transition-all ${
          on ? 'bg-accent-fg right-0.5' : 'bg-fg left-0.5'
        }`}
      />
    </button>
  );
}
