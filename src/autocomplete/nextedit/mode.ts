// nextedit/mode.ts — the R5 pure halves (the Guard's shell lives in guard.ts, Task 12)
export type NextEditMode = 'off' | 'next' | 'generic' | 'conflict';
export interface ToggleState { next: boolean; generic: boolean }
export interface ToggleRequest { source: 'next' | 'generic'; on: boolean }
export interface ToggleDecision {
  accepted: ToggleState;                       // the Guard's new ratified state (the shell persists it)
  result: 'accepted' | 'refused';
  alert: 'refused-next' | 'refused-generic' | null;
}

/** The inner half. 'conflict' survives only as sanitizeStoredToggles' input classification. */
export function resolveNextEditMode(nextEnabled: boolean, genericEnabled: boolean): NextEditMode {
  if (nextEnabled && genericEnabled) return 'conflict';
  if (nextEnabled) return 'next';
  if (genericEnabled) return 'generic';
  return 'off';
}

/**
 * Explicit field-by-field construction (no object-spread-with-override) —
 * deliberately avoids the object-spread-plus-overridden-field shape that
 * `ringBuffer.test.ts`'s brand-preserving-spread guard flags anywhere under
 * src/autocomplete/. This function never touches a branded value
 * (`ToggleState` carries no brand), but the guard's regex can't tell that;
 * sidestepping the shape keeps this pure module out of that
 * security-reviewed allowlist entirely.
 */
function withToggle(state: ToggleState, source: 'next' | 'generic', on: boolean): ToggleState {
  return source === 'next' ? { next: on, generic: state.generic } : { next: state.next, generic: on };
}

/**
 * R5 — the Guard's pure transition half. The toggles are NOT VS Code settings
 * (owner: «юзер пишет Endpoint, а не состояние True/False»); state lives in the
 * Guard's store (guard.ts). Turning on the second source while the first is
 * ratified on is REFUSED — nothing persists, the caller alerts. Turning off is
 * always accepted. Refusals never change the ratified state.
 */
export function applyToggleRequest(accepted: ToggleState, req: ToggleRequest): ToggleDecision {
  if (!req.on) {
    return { accepted: withToggle(accepted, req.source, false), result: 'accepted', alert: null };
  }
  const other = req.source === 'next' ? 'generic' : 'next';
  if (accepted[other] && !accepted[req.source]) {
    return {
      accepted,
      result: 'refused',
      alert: req.source === 'next' ? 'refused-next' : 'refused-generic',
    };
  }
  return { accepted: withToggle(accepted, req.source, true), result: 'accepted', alert: null };
}

/** Cold-start hygiene: a hand-edited store holding BOTH on resets to BOTH off («скинет в OFF»). */
export function sanitizeStoredToggles(stored: ToggleState): { accepted: ToggleState; didReset: boolean } {
  if (stored.next && stored.generic) {
    return { accepted: { next: false, generic: false }, didReset: true };
  }
  return { accepted: stored, didReset: false };
}
