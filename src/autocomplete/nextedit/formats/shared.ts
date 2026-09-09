// nextedit/formats/shared.ts — Job B Task 5 · helpers common to BOTH format
// modules (08 §4.2 "Common — one owner each": region math lives in
// anchors.ts; this file owns the two remaining cross-family helpers). Pure,
// no vscode import.
//
// WS-F4 F4-1 (FI-12): this module also owns the cross-format budget/cursor/
// stop-trim helpers `sweepV2.ts` and `genericInstruct.ts` each carried as
// byte-identical private copies (plus the line splitter, exported below).
// This task ADDS the shared originals only — both format modules' own
// copies are consolidated (deleted, replaced by an import of these) in
// F4-2; until then both sets coexist and `nextedit/lineSplitDrift.lock.test.ts`
// keeps comparing all five splitter copies, this file's now-exported one
// included.
import type { EditableRegion, NextEditCursor } from '../types';

/**
 * Splits `text` into lines, each line retaining its own trailing '\n' (the
 * final chunk's terminator is omitted when the text has none). EXPORTED as
 * of WS-F4 F4-1 (FI-12) — `sliceLines` and `isPureInsertionAboveCursor` both
 * need "lines with their terminators attached" and must agree on the same
 * split, so this is the single place that does it; `sweepV2.ts` and
 * `genericInstruct.ts` each also need the identical contract and currently
 * carry their own private byte-twin (`splitKeepingNewlines`) rather than
 * import this one — F4-2 replaces both with an import of this function.
 */
export function splitLinesKeepingTerminators(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/** Count of '\n' characters in `text` — used to locate the 0-based line containing a character offset. */
function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

/**
 * Lines [startLine, endLine] (0-based inclusive) of `text`, preserving each
 * line's own terminator (the last line's terminator is omitted when the
 * source text doesn't have one there). Out-of-range indices degrade to
 * whatever `Array.prototype.slice` would return (an empty string for a
 * range entirely past the end) rather than throwing.
 */
export function sliceLines(text: string, startLine: number, endLine: number): string {
  return splitLinesKeepingTerminators(text).slice(startLine, endLine + 1).join('');
}

/**
 * Sweep's low-value filter (04-wire-formats.md §1.5,
 * `is_pure_insertion_above_cursor`): true when `completion` differs from
 * `regionText` only by inserting whole lines strictly ABOVE the cursor's
 * line — the cursor's own line and everything after it must reappear
 * byte-identical in `completion`.
 *
 * `relativeCursor` is a character offset into `regionText`. The cursor's
 * 0-based line index is the count of '\n' characters strictly before that
 * offset, so a cursor sitting exactly at column 0 of line N is treated as
 * being ON line N (not the line before it) — deliberately NOT a byte-literal
 * port of the vendor's `len(code_block[:relative_cursor].splitlines(True))`,
 * which undercounts by one at that exact boundary for any N >= 1 (an
 * unflagged quirk of Python's `splitlines(keepends=True)`: a prefix that
 * ends exactly on a line terminator contributes no partial "current" line).
 *
 * `relativeCursor === 0` (cursor on the block's very first line) IS ported
 * as an explicit guard, mirroring the vendor reference's own crash site:
 * in `inference.py`, `current_line_index` is 0 exactly when
 * `relative_cursor` is 0, and the reference then reads
 * `code_block_lines[current_line_index - 1]` == `code_block_lines[-1]` —
 * silently the block's LAST line, not the first. We special-case the same
 * trigger condition instead of inheriting that silent wraparound.
 */
export function isPureInsertionAboveCursor(
  regionText: string,
  completion: string,
  relativeCursor: number,
): boolean {
  if (relativeCursor === 0) return false;

  if (regionText.trim() === completion.trim()) return false;

  const lineIndex = countNewlines(regionText.slice(0, relativeCursor));
  const regionLines = splitLinesKeepingTerminators(regionText);
  if (lineIndex >= regionLines.length) return false;
  const cursorLine = regionLines[lineIndex];
  if (cursorLine === undefined) {
    // Unreachable: lineIndex < regionLines.length was just checked above,
    // and countNewlines never returns a negative index.
    return false;
  }

  if (cursorLine.trim() === '') return false;

  const prefix = regionLines.slice(0, lineIndex).join('');
  const suffix = regionLines.slice(lineIndex + 1).join('');

  return completion.startsWith(prefix) && completion.endsWith(cursorLine + suffix);
}

/**
 * Character offset of `cursor` within `region.content` (UTF-16 code units,
 * matching `NextEditCursor.character`'s own unit — the same convention
 * `vscode.Position` uses, per `types.ts`). This is `relative_cursor` in
 * `04` §1.2/§1.4 — the reference script receives it pre-computed by its
 * own host, so there is no vendor formula for THIS half; the clamping
 * below is a fail-closed local design choice ([вывод]), mirroring
 * `anchors.ts`'s own clamp-at-each-edge style: a stale or out-of-window
 * cursor degrades to the nearest in-bounds offset rather than producing a
 * negative or out-of-range splice point.
 *
 * WS-F4 F4-1 (FI-12): moved verbatim from `sweepV2.ts` (byte-identical twin
 * also in `genericInstruct.ts`), calling THIS module's own exported
 * splitter instead of either format's private `splitKeepingNewlines` twin —
 * both format modules' own copies are consolidated onto this one in F4-2.
 */
export function relativeCursorOffset(region: EditableRegion, cursor: NextEditCursor): number {
  const lines = splitLinesKeepingTerminators(region.content);
  const lastLineIndex = Math.max(lines.length - 1, 0);
  const lineIndex = Math.min(Math.max(cursor.line - region.startLine, 0), lastLineIndex);

  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    // i < lineIndex <= lastLineIndex keeps i within lines' bounds whenever
    // lines is non-empty (the only case this loop body runs) — the `?? 0`
    // fallback mirrors `lineText`'s own established pattern just below and
    // is unreachable, not a behavior change.
    offset += lines[i]?.length ?? 0;
  }
  const lineText = lines[lineIndex] ?? '';
  const lineTextNoTerminator = lineText.endsWith('\n') ? lineText.slice(0, -1) : lineText;
  const character = Math.min(Math.max(cursor.character, 0), lineTextNoTerminator.length);
  return offset + character;
}

/**
 * `08` §4.3 / `01-arch-and-pattern.md` §4.6: the 4,000-char `recent_changes`
 * budget. The exact number is carried from the architecture doc's design
 * (not itself re-derived from `inference.py`, which this pass did not find
 * a client-side history budget in at all — the vendor script takes
 * `recent_diffs` as a caller-supplied list with no internal cap).
 *
 * WS-F4 F4-1 (FI-12): byte-identical constant in `sweepV2.ts:43` and
 * `genericInstruct.ts:78` — both consolidated onto this one in F4-2.
 */
export const DIFF_CHAR_BUDGET = 4000;

/**
 * Whole-item skip-not-crop budgeting, generalized out of both formats'
 * byte-identical `renderRecentChanges` loops (`sweepV2.ts:214-227` via
 * `renderDiffBlock`, `genericInstruct.ts:132-145` via `renderDiffPair`) —
 * the ONLY difference between the two copies was the render callback, now
 * `renderOne`. STOPS (a `break`, never a skip-and-continue) at the first
 * item that would push the running total over `budget` — an item that
 * would fit AFTER a too-large one is never reached, mirroring
 * `context/mode.ts`'s `injectSnippetsAsComments` skip-not-crop rationale
 * (`01-arch-and-pattern.md` §4.6). `separator.length` is charged as part of
 * the added cost for every item after the first, matching both copies'
 * hard-coded `+1` for their single-character `'\n'` join.
 *
 * WS-F4 F4-1 (FI-12): both copies are consolidated onto this function in
 * F4-2.
 */
export function renderBudgetedBlocks<T>(
  items: readonly T[],
  renderOne: (item: T) => string,
  budget: number,
  separator: string,
): string {
  const blocks: string[] = [];
  let usedChars = 0;
  for (const item of items) {
    const block = renderOne(item);
    const addedChars = block.length + (blocks.length > 0 ? separator.length : 0);
    if (usedChars + addedChars > budget) break;
    blocks.push(block);
    usedChars += addedChars;
  }
  return blocks.join(separator);
}

/**
 * Trims `text` at the first occurrence of any of `stops`, SEQUENTIAL and
 * order-sensitive over the RUNNING result: each stop searches the text as
 * already trimmed by every earlier stop in `stops`, never the original
 * `text` — `04` §1.6's own loop, ported verbatim (byte-identical in
 * `sweepV2.ts:352-357` and `genericInstruct.ts:409-415`, both walking
 * `STOP_TOKENS`; the tokens differ per format, which is why they become
 * the `stops` parameter here).
 *
 * WS-F4 F4-1 (FI-12): both copies are consolidated onto this function in
 * F4-2.
 */
export function trimAtFirstStopToken(text: string, stops: readonly string[]): string {
  let out = text;
  for (const stop of stops) {
    const idx = out.indexOf(stop);
    if (idx !== -1) out = out.slice(0, idx);
  }
  return out;
}
