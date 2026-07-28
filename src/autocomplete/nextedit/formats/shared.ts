// nextedit/formats/shared.ts — Job B Task 5 · helpers common to BOTH format
// modules (08 §4.2 "Common — one owner each": region math lives in
// anchors.ts; this file owns the two remaining cross-family helpers). Pure,
// no vscode import.

/**
 * Splits `text` into lines, each line retaining its own trailing '\n' (the
 * final chunk's terminator is omitted when the text has none). Internal —
 * not exported; `sliceLines` and `isPureInsertionAboveCursor` both need
 * "lines with their terminators attached" and must agree on the same split,
 * so this is the single place that does it.
 */
function splitLinesKeepingTerminators(text: string): string[] {
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
