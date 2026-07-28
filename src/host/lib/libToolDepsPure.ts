import path from 'node:path';

import type { PlainTextEdit } from '../../mcp/lsp/codeActionSerialize';
import type { RawCodeActionEdit, RawCodeActionFile } from '../../mcp/lsp/lspToolContract';

/**
 * W3 (LIB) · T7b/T8b — the genuinely pure sub-logic pulled out of the vscode
 * adapter (`libToolDeps.vscode.ts`) per the brief's "extract + unit-test any
 * cleanly-pure helper" instruction. No `vscode`/`fs` import — plain
 * `node:path` string math (T7b) and plain-object classification (T8b) only,
 * so this is testable without an extension host and without touching the
 * filesystem.
 */

/**
 * Builds one joined candidate absolute path per workspace root, for a
 * workspace-relative path argument (`resolvePathArg`). Pure: this only forms
 * the candidates to try, in root order — it does NOT decide containment.
 * `resolveWithinWorkspaceReal` (fs-touching, injected in the adapter) makes
 * the actual realpath/confinement decision per candidate; the FIRST
 * candidate it accepts wins. A `../` escape or absolute override in
 * `relPath` is intentionally left unresolved here (`path.join` only joins —
 * it does not sandbox), matching `resolveWithinWorkspace`'s own division of
 * labor (`pathConfine.ts`): this function's job is candidate construction
 * only, never the security decision.
 */
export function buildCandidatePaths(relPath: string, roots: readonly string[]): string[] {
  return roots.map((root) => path.join(root, relPath));
}

/**
 * Workspace-relative display path for a confined, canonical target — mirrors
 * `canonicalizeEditPath`'s own `relPath` convention (`pathConfine.ts`):
 * forward-slash-normalized regardless of OS separator, so a Windows dev box
 * (dev-only; Fedora/Linux is the ship target) renders the identical
 * `foo/bar.ts` shape a Fedora box would. Never throws — `path.relative` is
 * pure string math; an out-of-root pair (a caller/test artifact — the real
 * adapter only calls this with a root `buildConfinementVerdict` already
 * selected via `findContainingRoot`) still returns a value, never crashes.
 */
export function toWorkspaceRelative(root: string, canonical: string): string {
  return path.relative(root, canonical).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// W3 (LIB) · T8b — `lsp_code_actions`'s `_allEntries` classification core.
//
// Only the ACT of reaching into a real `vscode.WorkspaceEdit` (the one
// `as unknown as {...}` cast on `_allEntries`, plus the real `.entries()`
// call that reads `.range`/`.newText` off real `vscode.TextEdit`s) is
// build-blind, in `libToolDeps.vscode.ts`. Once those two calls have handed
// back plain data — the RAW `_allEntries()` array (untyped, duck-typed
// `{_type}` entries) and the ALREADY-PLAIN, uri-grouped text edits from the
// PUBLIC `WorkspaceEdit.entries()` — every fail-closed DECISION about that
// data is pure and lives here, so the gate-bypass-trap classification logic
// itself is unit-tested with plain fixtures, not left build-blind.
// ---------------------------------------------------------------------------

/**
 * `FileEditType` discriminant values off VS Code's internal
 * `WorkspaceEdit._allEntries()` DTO union (grounded via direct GitHub source
 * read at T8b write-time, `extHostTypes/workspaceEdit.ts`: `File=1, Text=2,
 * Cell=3, CellReplace=5, Snippet=6`). UNDOCUMENTED in `@types/vscode` (no
 * public `.d.ts` entry) — this is exactly why `_allEntries` itself is a
 * feature-detect, not a typed call, and why this function treats anything
 * that isn't confirmed Text or Snippet as the safe fail-closed default.
 */
const FILE_EDIT_TYPE_TEXT = 2;
const FILE_EDIT_TYPE_SNIPPET = 6;

/** Safely reads a duck-typed `_type` field off an arbitrary `_allEntries()`
 * entry — `undefined` for `null`/non-object/primitive input (never throws;
 * `typeof null === 'object'` is the classic JS trap this guard closes). */
function readEntryType(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  return (raw as { readonly _type?: unknown })._type;
}

/**
 * Classifies the FULL `_allEntries()` result (duck-typed — every entry only
 * needs a readable `_type` field) into T8a's fail-closed
 * `hasNonTextEntry`/`nonTextKind` pair. Fails toward `'file-operations'` for
 * anything that isn't confirmed Text (`_type===2`) or Snippet (`_type===6`)
 * — this includes File(1), Cell(3)/CellReplace(5) (notebook edits — T8a's
 * `nonTextKind` vocabulary has no notebook member, so the closest honest
 * existing category is used), any unrecognized/missing `_type` (version
 * drift), AND any malformed (`null`/non-object/primitive) entry. Pure,
 * total, headless: never throws, no `vscode` import — the caller
 * (`.vscode.ts`, T8b) supplies the real `_allEntries()` array.
 */
export function classifyAllEntries(entries: readonly unknown[]): {
  readonly hasNonTextEntry: boolean;
  readonly nonTextKind?: 'file-operations' | 'snippet';
} {
  for (const raw of entries) {
    const type = readEntryType(raw);
    if (type === FILE_EDIT_TYPE_TEXT) {
      continue;
    }
    if (type === FILE_EDIT_TYPE_SNIPPET) {
      return { hasNonTextEntry: true, nonTextKind: 'snippet' };
    }
    return { hasNonTextEntry: true, nonTextKind: 'file-operations' };
  }
  return { hasNonTextEntry: false };
}

/** Total count of individual text edits across every grouped file — shared
 * by {@link buildRawCodeActionEdit}'s consistency guard. */
function countEdits(files: readonly { readonly edits: readonly PlainTextEdit[] }[]): number {
  return files.reduce((sum, f) => sum + f.edits.length, 0);
}

/**
 * Assembles T8b's `RawCodeActionEdit` (`tools.ts`) from the two build-blind-
 * extracted pieces:
 * - `allEntries` — the RAW `_allEntries()` result, or `undefined` when the
 *   adapter's feature-detect found no such method at all (fail CLOSED).
 * - `publicFiles` — the ALREADY-PLAIN, uri-grouped text edits from the
 *   PUBLIC, documented `WorkspaceEdit.entries()` (real `vscode.TextEdit`
 *   `.range`/`.newText` fields, guaranteed by the public `.d.ts` — unlike
 *   `_allEntries()`'s undocumented per-entry shape, which this function only
 *   ever reads a `_type` tag off of, via {@link classifyAllEntries}).
 *
 * Fail-closed decision order (mirrors T8a's own rule 1, research doc §6.2):
 * 1. `allEntries === undefined` ⇒ `allEntriesAvailable:false` — T8a turns
 *    this into `unsupported-edit` `"unverifiable"` regardless of
 *    `publicFiles`.
 * 2. Any non-text entry (via `classifyAllEntries`) ⇒ `hasNonTextEntry:true`
 *    with the classified `nonTextKind`, `files:[]` (T8a's
 *    `classifyCodeAction` never reads `files` on that branch).
 * 3. A CONSISTENCY GUARD (defense-in-depth for the gate-bypass trap): if
 *    every `_allEntries()` entry classified as text-shaped, the TOTAL edit
 *    count from `_allEntries()` should equal the total edit count
 *    `publicFiles` carries (one `_allEntries()` Text entry per public
 *    `TextEdit`). A mismatch is a version-drift / unknown-shape signal this
 *    function cannot prove safe — fail CLOSED rather than trust it.
 * 4. Otherwise: `allEntriesAvailable:true, hasNonTextEntry:false,
 *    files:publicFiles`.
 *
 * Pure, total, headless: never throws, no `vscode` import.
 */
export function buildRawCodeActionEdit(
  allEntries: readonly unknown[] | undefined,
  publicFiles: readonly RawCodeActionFile[],
): RawCodeActionEdit {
  if (allEntries === undefined) {
    return { allEntriesAvailable: false, hasNonTextEntry: false, files: [] };
  }
  const classified = classifyAllEntries(allEntries);
  if (classified.hasNonTextEntry) {
    return {
      allEntriesAvailable: true,
      hasNonTextEntry: true,
      nonTextKind: classified.nonTextKind,
      files: [],
    };
  }
  if (countEdits(publicFiles) !== allEntries.length) {
    return { allEntriesAvailable: false, hasNonTextEntry: false, files: [] };
  }
  return { allEntriesAvailable: true, hasNonTextEntry: false, files: publicFiles };
}
