// nextedit/types.ts — declarations only, no logic, no vscode import
export type NextEditFormatId = 'sweep-v2' | 'generic-instruct';
export type NextEditTransportId = 'ollama' | 'openai-compat';
export interface LineRange { startLine: number; endLine: number }            // 0-based inclusive
export interface NextEditCursor { uri: string; line: number; character: number }
export interface EditableRegion { uri: string; filepath: string; startLine: number; endLine: number; content: string }
/**
 * C-4 — COORDINATE SPACE, not just the base. `startLine`/`endLine` are
 * 0-based inclusive (like every `LineRange` here) AND they are expressed in
 * the OLD, PRE-CHANGE document: `editTrackerAdapter.ts` records
 * `change.range`, which vscode defines in the document as it was BEFORE the
 * change was applied. They are therefore NOT valid offsets into the current
 * file, and every later edit in that document moves what they refer to.
 * Consumers must treat them as a label on the `before`/`after` pair, never as
 * a cursor into current text (`sweepV2.ts`'s diff header does exactly that;
 * `shell.vscode.ts`'s `computeChangesAboveCursor` accepts the resulting
 * imprecision deliberately and documents why).
 */
export interface RecentDiff { uri: string; filepath: string; startLine: number; endLine: number; before: string; after: string }
export interface NextEditRequest {
  model: string;
  cursor: NextEditCursor;
  region: EditableRegion;
  preEditRegion: string | null;
  /**
   * V-1 fix — a bounded, SCANNED window around the cursor (`fileWindow.ts`'s
   * `windowAroundCursor`, vendor-conformant ±150 lines), NOT the whole
   * document. Always ends in '\n' (`shell.vscode.ts`'s
   * `ensureTrailingNewline`) — the sweepV2/generic render contract.
   */
  fileContext: string;
  /** Same ±150-line windowed contract as `fileContext` — see
   *  `fileWindow.ts`. NOT the whole document (pre-V-1-fix behaviour: this
   *  field used to carry `document.getText()` unbounded, which made the
   *  request-level mint's own size bounds reject every file over ~16 KB). */
  docText: string;
  /** The pre-edit shadow's window, same ±150-line contract as `docText`.
   *  `null` when no shadow was recorded (no changes yet, or none captured)
   *  — NOT the whole pre-edit document. */
  preEditDocText: string | null;
  changesAboveCursor: boolean;
  diffs: readonly RecentDiff[];
  docVersion: number;
}
declare const NEXT_EDIT_SCANNED: unique symbol;                              // mirrors context/types.ts:57-58
export type ScannedNextEditRequest = NextEditRequest & { readonly [NEXT_EDIT_SCANNED]: true };
export type NextEditVerdict =
  | { kind: 'rewrite'; region: EditableRegion; newText: string }
  | { kind: 'no-op' }
  | { kind: 'invalid'; reason: string };
export interface AnchoredProposal { region: EditableRegion; newText: string; docVersion: number; cursorLine: number }
export type NextEditFsmState =
  | { kind: 'idle' } | { kind: 'proposed'; p: AnchoredProposal } | { kind: 'jumped'; p: AnchoredProposal };
export type NextEditFsmEvent =
  | { kind: 'proposalReady'; p: AnchoredProposal }
  | { kind: 'tabJump' } | { kind: 'tabAccept' } | { kind: 'esc' }
  | { kind: 'docChanged'; remapped: LineRange | null }
  | { kind: 'focusLost' } | { kind: 'editorChanged' }
  | { kind: 'fimVisibility'; visible: boolean }
  | { kind: 'applyResult'; ok: boolean };
export type NextEditEffect =
  | { kind: 'setContext'; key: 'talaria.nextEdit.jumpVisible' | 'talaria.nextEdit.jumped'; value: boolean }
  | { kind: 'showDecorations'; p: AnchoredProposal }
  | { kind: 'reveal'; range: LineRange }
  | { kind: 'applyEdit'; region: EditableRegion; newText: string }
  | { kind: 'clearAll' }
  | { kind: 'noteOnce'; msgId: string };
