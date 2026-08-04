/**
 * Host <-> Webview protocol — RE-EXPORT of the single source of truth.
 * ------------------------------------------------------------------
 * The canonical contract lives at `src/shared/protocol.ts` (host side). This
 * file used to be a hand-mirrored COPY that drifted (it carried webview-only
 * `ControlMethod` members `session.list` / `session.load` the host copy
 * lacked). It is now a thin re-export so there is exactly ONE definition of
 * every protocol type, imported by both build targets:
 *   - the esbuild host bundle imports `src/shared/protocol.ts` directly;
 *   - this webview bundle (Vite root = `webview/`) re-exports it here so all
 *     22 webview consumers keep their unchanged `./protocol` import specifier.
 *
 * `export type *` (not bare `export *`) is deliberate: almost everything the
 * shared module exports is a type — no Node/`vscode` imports — so this stays
 * the `isolatedModules`-safe, zero-runtime-emit form for the bulk of the
 * contract. `makePanelData` (W4 §7 B2) is the one genuine runtime VALUE the
 * mock backends need (the typed `panel.data` constructor) — re-exported
 * explicitly below, same pure/no-Node-import posture as everything else here.
 * `PANEL_SCOPE` (Task 2, P1 entry-point fix §3.3) is the second: App.tsx's
 * hydrate-boot fetch branch narrows to GLOBAL-scoped panels only, and that
 * narrowing needs the real runtime lookup table, not just its type.
 *
 * Do NOT re-add type declarations here. Change the contract in
 * `src/shared/protocol.ts` and both sides stay in lockstep by construction.
 */
export type * from '../../src/shared/protocol';
export { makePanelData, MAX_TABS, BOOTSTRAP_TAB_ID, PANEL_SCOPE } from '../../src/shared/protocol';
