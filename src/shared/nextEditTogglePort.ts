/*
 * W5.1 R5 (Task 13) — the capability the webview's `nextEdit.toggle` request
 * is answered from.
 *
 * `TalariaViewProvider` must be able to serve the toggle WITHOUT knowing that
 * a `NextEditGuard` (or an autocomplete tree, or the `talaria.nextEdit.source`
 * setting it is backed by since Task 2 §5.5) exists —
 * the view provider is host plumbing, the Guard is the autocomplete zone's.
 * This narrow port is the seam between them, mirroring the `FindFilesFn`
 * injection `context.searchFiles` already uses: `extension.ts` owns the
 * composition, the provider owns the transport.
 *
 * `request` is deliberately NOT `NextEditGuard.requestToggle`. The one
 * legitimate implementation wraps `requestNextEditToggle`
 * (`src/autocomplete/nextedit/shell.vscode.ts`), which adds the two things
 * the Guard structurally cannot: the unsupported-FIM-backend refusal for
 * Generic (the Guard is transport-blind and cannot see
 * `getAutocompleteBackend()`) and the one-shot `08` §6.3 setup note on an
 * accepted Generic toggle-on. Binding this port straight to the Guard would
 * silently drop both. Task 14 locks that at the source level.
 *
 * `onDidChange` returns a structural `{ dispose(): void }` rather than a
 * `vscode.Disposable` so this file stays import-free and can be referenced
 * from either side of the composition without dragging `vscode` along; a real
 * `vscode.Disposable` satisfies it structurally.
 *
 * T-19 (C1+C2, boundary move): moved from `src/host/nextEditTogglePort.ts`
 * to `src/shared/` — `src/autocomplete/index.ts` (outside `host/`) needed
 * it, which was a zone-crossing edge (`autocomplete/` reaching into
 * `host/`). Byte-identical body; only the file's location (and this
 * module's own relative import of `protocol`) changed.
 */
import type { NextEditToggleSource, NextEditToggleState } from './protocol';

export interface NextEditTogglePort {
  /**
   * Apply one toggle gesture. Resolves with the newly RATIFIED state; REJECTS
   * with the user-facing refusal message when the request is refused — since
   * Task 2 (§5.5/D7) that means ONLY the unsupported-FIM-backend refusal for
   * Generic: the state lives in the `talaria.nextEdit.source` enum now, so
   * mutual exclusion is structural and turning the second source on RESOLVES
   * with the replaced state (both rows move via the `onDidChange` push)
   * instead of rejecting. The rejection message is what the panel row shows
   * inline — it must stay readable and must never carry a response body or an
   * API key.
   */
  request(source: NextEditToggleSource, on: boolean): Promise<NextEditToggleState>;

  /** The currently ratified state — read on webview mount to seed the rows. */
  getState(): NextEditToggleState;

  /**
   * Fires on every genuine state change (never on a refusal — nothing
   * changed). Since Task 2 this rides `onDidChangeConfiguration`, so a NATIVE
   * settings-page edit of `talaria.nextEdit.source` reaches the rows through
   * the same push as a webview toggle.
   */
  onDidChange(listener: (state: NextEditToggleState) => void): { dispose(): void };
}
