/**
 * nextedit/fileWindow.ts — V-1 fix: a bounded, SCANNED window around the
 * cursor, in place of the whole document.
 *
 * ROOT CAUSE (`tier2-remediation-architecture.md` §1.1/§1.3): the shell used
 * to send `document.getText()` — the WHOLE file — as `fileContext`/`docText`/
 * `preEditDocText`. The request-level mint (`scan.ts`) fail-closed rejects
 * any content field over `secretScanner.ts`'s `MAX_SCAN_CONTENT` (16 000
 * chars) or containing a line over `MAX_SCAN_LINE` (2 000 chars) — both
 * deliberate DoS/leak guards, never to be loosened. So next-edit was
 * structurally dead on every file over ~16 KB, on EVERY trigger.
 *
 * FIX: bound the doc-level context to a CONTIGUOUS slice around the cursor,
 * vendor-conformant — the design this project's own remediation architecture
 * cites sweep-next-edit-v2-7B's published `inference.py` for: `{initial_file}`
 * is built as `lines[cursor_line-150 : cursor_line+150]`, never the whole
 * file (the vendor's model card states this directly: "~300 lines of file
 * context around the cursor"). `maxLinesEachSide` below carries that same
 * constant. `maxChars`/`maxLineChars` are chosen so the window structurally
 * clears the mint's own bounds (`maxChars=12_000 < MAX_SCAN_CONTENT=16_000`,
 * `maxLineChars=2_000 === MAX_SCAN_LINE`) — the scanner's SECRET rules still
 * apply on top of this size guarantee; a window that stays under-budget on
 * SIZE can still be rejected for a matched secret, and that is the scanner
 * working as designed, not a bypass (`shell.vscode.test.ts`'s egress-drift
 * lock proves both directions).
 *
 * PURE, no `vscode`/`node:fs` import — this file lands inside the existing
 * `nextEditPurity.test.ts` scan root and is unit-tested headlessly
 * (`fileWindow.test.ts`).
 */

export interface FileWindowOptions {
  /** Maximum ADDITIONAL lines walked outward on each side of the cursor
   *  line (the cursor line itself is always the seed and is not counted
   *  against this). 150 = the vendor's own constant. */
  readonly maxLinesEachSide: number;
  /** Maximum total chars (terminators included) the returned `.text` may
   *  carry — a SHARED budget, spent by whichever side is walked next. */
  readonly maxChars: number;
  /** A candidate line whose CONTENT (terminator excluded — matching
   *  `secretScanner.ts`'s own `/\r?\n/`-split measurement) exceeds this is
   *  never added, and permanently stops the side that hit it. */
  readonly maxLineChars: number;
}

export interface FileWindow {
  /** The contiguous slice, terminators intact (never re-terminated: a
   *  window ending at the document's true last line carries whatever
   *  terminator — or lack of one — that line has in the source text). */
  readonly text: string;
  /** 0-based inclusive line index the window starts at. */
  readonly startLine: number;
  /** 0-based inclusive line index the window ends at. */
  readonly endLine: number;
}

/**
 * The frozen V-1 constants (`tier2-remediation-architecture.md` §1.3).
 * Exported so callers (`shell.vscode.ts`) and tests share exactly one
 * definition rather than restating the numbers at each call site.
 */
export const DEFAULT_FILE_WINDOW_OPTIONS: FileWindowOptions = Object.freeze({
  maxLinesEachSide: 150,
  maxChars: 12_000,
  maxLineChars: 2_000,
});

/** Splits `text` into lines, each retaining its own trailing '\n' (the final
 *  chunk's terminator is omitted when the text has none) — the same
 *  "line, keep terminator" contract `shell.vscode.ts`, `formats/sweepV2.ts`
 *  and `formats/genericInstruct.ts` each already carry their own private
 *  copy of. Duplicated on purpose (this module must stay dependency-free of
 *  the shell) rather than reaching into a sibling file's un-exported helper. */
function splitKeepingNewlines(text: string): string[] {
  const parts = text.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    lines.push(`${parts[i]}\n`);
  }
  const last = parts[parts.length - 1];
  if (last !== undefined && last !== '') {
    lines.push(last);
  }
  return lines;
}

/** `lineWithTerminator`'s content length, terminator excluded — mirrors
 *  `secretScanner.ts`'s `contentHasOversizedLine`, which measures lines via
 *  `content.split(/\r?\n/)` (i.e. a CRLF terminator is not counted against
 *  the bound either). Matching that measurement exactly is what makes this
 *  module's `maxLineChars` a genuine pre-check for the mint's own
 *  `MAX_SCAN_LINE` bound, not an approximation that could disagree with it
 *  at the boundary. */
function lineContentLength(lineWithTerminator: string): number {
  if (lineWithTerminator.endsWith('\r\n')) return lineWithTerminator.length - 2;
  if (lineWithTerminator.endsWith('\n')) return lineWithTerminator.length - 1;
  return lineWithTerminator.length;
}

/**
 * Returns the contiguous slice of `text` centered on `cursorLine`, bounded
 * by `opts`.
 *
 * Algorithm (deterministic): the cursor line is always the seed (a walk
 * OUTWARD from it presupposes it is already included — this is also what
 * keeps the result "a contiguous slice containing the cursor line" a
 * structural guarantee, not a best-effort one). From there, the window
 * grows one line at a time, alternating up/down in ROUND-ROBIN order (try
 * up, then try down, repeat) so a tight char budget grows both sides
 * symmetrically rather than exhausting itself in one direction first. A
 * side permanently stops (for the rest of the call) the first time its next
 * candidate line would:
 *   (i)   exceed `maxLinesEachSide` additional lines on that side, or
 *   (ii)  push the SHARED running total over `maxChars`, or
 *   (iii) itself be longer than `maxLineChars` — an oversized line is never
 *         included, and the side does not skip past it to keep going: it
 *         stops exactly there (matching `secretScanner.ts`'s own "reject
 *         the whole snippet fail-closed", never "silently skip the bad
 *         line").
 * `cursorLine` is clamped to `[0, lastLineIndex]` before anything else, so a
 * stale/out-of-range cursor (or an empty document) degrades to a
 * well-formed window rather than throwing.
 */
export function windowAroundCursor(
  text: string,
  cursorLine: number,
  opts: FileWindowOptions = DEFAULT_FILE_WINDOW_OPTIONS,
): FileWindow {
  const lines = splitKeepingNewlines(text);
  if (lines.length === 0) {
    return { text: '', startLine: 0, endLine: 0 };
  }

  const lastIndex = lines.length - 1;
  const anchor = Math.min(Math.max(cursorLine, 0), lastIndex);
  // `anchor` is clamped into `[0, lastIndex]` and `lines.length > 0` was
  // just checked above, so `lines[anchor]` always exists — the `?? ''`
  // fallback mirrors `sweepV2.ts`'s/`genericInstruct.ts`'s own established
  // pattern for a `noUncheckedIndexedAccess` access already proven in
  // bounds, and is unreachable, not a behavior change.
  const seed = lines[anchor] ?? '';

  let startLine = anchor;
  let endLine = anchor;
  let totalChars = seed.length;
  let linesUsedUp = 0;
  let linesUsedDown = 0;
  let upBlocked = false;
  let downBlocked = false;

  function tryExtendUp(): boolean {
    if (startLine - 1 < 0) return false;
    if (linesUsedUp >= opts.maxLinesEachSide) return false;
    // `startLine - 1 >= 0` was just checked above, so this index is always
    // in bounds — same unreachable `?? ''` fallback as `seed`, above.
    const candidate = lines[startLine - 1] ?? '';
    if (lineContentLength(candidate) > opts.maxLineChars) return false;
    if (totalChars + candidate.length > opts.maxChars) return false;
    startLine -= 1;
    totalChars += candidate.length;
    linesUsedUp += 1;
    return true;
  }

  function tryExtendDown(): boolean {
    if (endLine + 1 > lastIndex) return false;
    // `endLine + 1 <= lastIndex` was just checked above, so this index is
    // always in bounds — same unreachable `?? ''` fallback as `seed`, above.
    if (linesUsedDown >= opts.maxLinesEachSide) return false;
    const candidate = lines[endLine + 1] ?? '';
    if (lineContentLength(candidate) > opts.maxLineChars) return false;
    if (totalChars + candidate.length > opts.maxChars) return false;
    endLine += 1;
    totalChars += candidate.length;
    linesUsedDown += 1;
    return true;
  }

  while (!upBlocked || !downBlocked) {
    if (!upBlocked) {
      upBlocked = !tryExtendUp();
    }
    if (!downBlocked) {
      downBlocked = !tryExtendDown();
    }
  }

  return {
    text: lines.slice(startLine, endLine + 1).join(''),
    startLine,
    endLine,
  };
}
