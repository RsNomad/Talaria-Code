// nextedit/anchors.ts — pure line-range math, no vscode import.
// regionAroundCursor: the editable window sent to the model, centered on the
// CURSOR (never the last edit — 08 §4.2: a last-edit region can put the
// cursor out of range, producing a malformed prompt).
// remapRange: re-projects a tracked range across document edits. VS Code has
// no position-anchor API, so this is the fail-closed heart of next-edit:
// ANY overlap between an edit and the tracked range returns null and the
// caller dismisses the proposal — never guess a partial remap.
import type { LineRange } from './types';

export interface ContentChangeLite { startLine: number; endLine: number; newLineCount: number }

/**
 * The window [cursorLine - windowLines, cursorLine + windowLines], clamped
 * independently at each edge to [0, docLineCount - 1] so the region never
 * escapes document bounds. docLineCount <= 0 (no real vscode.TextDocument
 * ever reports this; lineCount is always >= 1) is treated as a single
 * zero-length line rather than producing an inverted range. A cursorLine
 * outside [0, docLineCount - 1] (e.g. stale position past EOF) is clamped
 * to the same bounds before computing the window, so the returned range is
 * always well-formed. A non-positive windowLines degrades to a cursor-only
 * single-line region.
 */
export function regionAroundCursor(cursorLine: number, docLineCount: number, windowLines: number): LineRange {
  const maxLine = Math.max(0, docLineCount - 1);
  // M-T3-1: a non-positive window degrades to a cursor-only single-line
  // region — never an inverted {start > end} range.
  const window = Math.max(0, windowLines);
  const cursor = Math.min(Math.max(cursorLine, 0), maxLine);
  const startLine = Math.min(Math.max(cursor - window, 0), maxLine);
  const endLine = Math.min(Math.max(cursor + window, 0), maxLine);
  return { startLine, endLine };
}

/**
 * Re-projects `range` across `changes`, applied in event order.
 * ORDERING CONTRACT (M-T3-2): "event order" is NOT VS Code delivery order.
 * A raw multi-part `TextDocumentChangeEvent.contentChanges` array arrives
 * in NO guaranteed order (microsoft/vscode#11487); whoever assembles
 * `ContentChangeLite[]` from real events must resolve ordering FIRST — see
 * `context/editTrackerAdapter.ts`'s descending sort (commit 554e716).
 * remapRange trusts its input is already event-ordered and does NOT
 * re-sort (the T12 shell carries this contract).
 * Each change is checked against the range as of that point in the
 * sequence (a prior shift can bring a later change into overlap — see the
 * multi-change test).
 * - ANY overlap (inclusive-range intersection, boundary touch counts) =>
 *   null, and null propagates through the rest of the sequence unchanged.
 * - Entirely above (change.endLine < range.startLine): the range shifts by
 *   delta = newLineCount - (change.endLine - change.startLine + 1).
 * - Entirely below (change.startLine > range.endLine): unchanged.
 */
export function remapRange(range: LineRange, changes: readonly ContentChangeLite[]): LineRange | null {
  let startLine = range.startLine;
  let endLine = range.endLine;
  for (const change of changes) {
    const overlaps = change.startLine <= endLine && change.endLine >= startLine;
    if (overlaps) return null;
    if (change.endLine < startLine) {
      const originalSpan = change.endLine - change.startLine + 1;
      const delta = change.newLineCount - originalSpan;
      startLine += delta;
      endLine += delta;
    }
    // else: entirely below (change.startLine > endLine) — unchanged.
  }
  return { startLine, endLine };
}
