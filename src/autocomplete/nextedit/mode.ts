/*
 * nextedit/mode.ts — the R5 pure halves.
 *
 * Task 12 (T2 M-2 carry-forward): this file used to also hold
 * `applyToggleRequest`/`ToggleDecision`/`withToggle` — the pre-Task-2
 * REFUSAL-based toggle-transition half ("turning the second source on while
 * the first is ratified is REFUSED"). Task 2 (§5.5/D7) re-based the Guard
 * (`guard.ts`) off `vscode.Memento` onto the `talaria.nextEdit.source` enum
 * setting, which made mutual exclusion STRUCTURAL — an enum cannot hold two
 * "on" values, so the second toggle simply BECOMES the new value and
 * REPLACES the first (`guard.ts`'s own `applyToggleToSource`) — and stopped
 * calling this trio entirely. Confirmed dead-in-production by grep (no
 * import anywhere outside this file and its own `mode.test.ts`) before
 * deletion here, along with the `mode.test.ts` assertions that exercised the
 * "refused" rows production no longer emits.
 *
 * What remains is genuinely still live: `resolveNextEditMode` backs
 * `NextEditGuard.getMode()`, and `sanitizeStoredToggles` backs the one-time
 * §5.3 globalState->setting migration (`guard.ts`'s `migrateNextEditToggles`)
 * — both imported from `./mode` by `guard.ts`.
 */
export type NextEditMode = 'off' | 'next' | 'generic' | 'conflict';
export interface ToggleState { next: boolean; generic: boolean }
export interface ToggleRequest { source: 'next' | 'generic'; on: boolean }

/** The inner half. 'conflict' survives only as sanitizeStoredToggles' input classification. */
export function resolveNextEditMode(nextEnabled: boolean, genericEnabled: boolean): NextEditMode {
  if (nextEnabled && genericEnabled) return 'conflict';
  if (nextEnabled) return 'next';
  if (genericEnabled) return 'generic';
  return 'off';
}

/** Cold-start hygiene: a hand-edited store holding BOTH on resets to BOTH off («скинет в OFF»). */
export function sanitizeStoredToggles(stored: ToggleState): { accepted: ToggleState; didReset: boolean } {
  if (stored.next && stored.generic) {
    return { accepted: { next: false, generic: false }, didReset: true };
  }
  return { accepted: stored, didReset: false };
}
