/* Accessible on/off switch used by Tools / Skills / Settings panels. */
import { toggleInteraction, type ToggleInteraction } from './busyInteraction';

/**
 * AU-40: `toggleInteraction` + `ToggleInteraction` moved to
 * `busyInteraction.ts` (single source of the F-8 decision, now shared with
 * every swept panel button) — re-exported here so `Toggle.test.ts` and any
 * other existing importer of `./Toggle` keep resolving both unchanged. See
 * `busyInteraction.ts`'s module doc for the full decision + the
 * SettingsPanel `<select>` carve-out.
 */
export { toggleInteraction, type ToggleInteraction };

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
 * The repo gained jsdom + testing-library in wave 5.2 (ADR-015), and
 * `SettingsPanel.dom.test.tsx` locks the RENDERED half — that the busy
 * control keeps keyboard focus across the round trip and carries `aria-busy`.
 * The pure decision itself lives in `busyInteraction.ts` (AU-40) and must not
 * move here: a DOM test earns its cost only for wiring, never for a decision
 * (`docs/testing/dom-tests.md`).
 */
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
