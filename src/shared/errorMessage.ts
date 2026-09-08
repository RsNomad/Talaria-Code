/**
 * FI-11 (WS-F8 F8-2): the ONE shared home for the naive `err instanceof Error
 * ? err.message : String(err)` idiom — before this task duplicated,
 * byte-identically, in ~17 files across `src/host/`/`src/autocomplete/`.
 *
 * Deliberately NOT `src/shared/errorText.ts`'s `describeError` — that is a
 * separate, richer serializer (JSON-RPC `.data` folding, home-path
 * redaction, a `[object Object]`-proof fallback chain) with its own 13
 * pre-existing adopters and its own behavioural contract (`errorText.test.ts`).
 * This module is the OTHER, simpler idiom's single source of truth: every
 * call site this task repoints produced `err.message`/`String(err)` before
 * the move and produces the exact same string after it — a pure DRY, not a
 * behaviour upgrade. A caller that wants the richer redacted/JSON-RPC-aware
 * text should use `describeError`, not this.
 *
 * Webview-safe by construction (no `vscode`, no `node:*` import) — several
 * of this task's 17 call sites live under `src/autocomplete/`, which shares
 * build targets with the webview bundle one directory over.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
