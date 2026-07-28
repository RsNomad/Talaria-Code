import { describe, it, expect } from 'vitest';
import { windowAroundCursor, DEFAULT_FILE_WINDOW_OPTIONS, type FileWindowOptions } from './fileWindow';

/**
 * V-1 fix — `windowAroundCursor` is the pure core the shell's construction
 * site (`shell.vscode.ts`) calls to bound `fileContext`/`docText`/
 * `preEditDocText` to a SCANNED window around the cursor instead of the
 * whole document (`tier2-remediation-architecture.md` §1.3). Vendor-
 * conformant: sweep-next-edit-v2-7B's own `inference.py` builds
 * `{initial_file}` as `lines[cursor_line-150 : cursor_line+150]`, never the
 * whole file. `maxChars=12_000 < secretScanner.ts`'s `MAX_SCAN_CONTENT`
 * (16_000) and `maxLineChars=2_000 === MAX_SCAN_LINE`, so the window
 * structurally satisfies the request-level mint's own size bounds — the
 * mint's SECRET rules still apply on top (proven by `shell.vscode.test.ts`'s
 * egress-drift lock, not here — this file is pure line-math only).
 */

function linesOf(n: number, mkLine: (i: number) => string = (i) => `line${i}`): string[] {
  return Array.from({ length: n }, (_, i) => mkLine(i));
}

describe('windowAroundCursor — pure line-window math', () => {
  it('an empty document yields an empty window', () => {
    const w = windowAroundCursor('', 0, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w).toEqual({ text: '', startLine: 0, endLine: 0 });
  });

  it('a whole small file (well under every cap) is returned unchanged — same text, startLine 0', () => {
    const text = `${linesOf(5).join('\n')}\n`;
    const w = windowAroundCursor(text, 2, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w.text).toBe(text);
    expect(w.startLine).toBe(0);
    expect(w.endLine).toBe(4);
  });

  it('the cursor line is always included, even at BOF (line 0): the up side clamps, the down side grows', () => {
    const text = `${linesOf(400).join('\n')}\n`;
    const w = windowAroundCursor(text, 0, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w.startLine).toBe(0);
    expect(w.text.startsWith('line0\n')).toBe(true);
    // Down side is capped at maxLinesEachSide (150): cursor line + 150 below.
    expect(w.endLine).toBe(150);
  });

  it('the cursor line is always included, even at EOF (last line): the down side clamps, the up side grows', () => {
    const lines = linesOf(400);
    const text = lines.join('\n'); // no trailing terminator — last line has none
    const lastLine = lines.length - 1;
    const w = windowAroundCursor(text, lastLine, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w.endLine).toBe(lastLine);
    expect(w.startLine).toBe(lastLine - 150);
    expect(w.text.endsWith(`line${lastLine}`)).toBe(true);
  });

  it('a cursorLine past EOF clamps to the last real line (never an out-of-range window)', () => {
    const text = `${linesOf(10).join('\n')}\n`;
    const w = windowAroundCursor(text, 9999, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w.endLine).toBe(9); // 10 lines: indices 0..9
    expect(w.startLine).toBe(0);
  });

  it('a negative cursorLine clamps to line 0', () => {
    const text = `${linesOf(10).join('\n')}\n`;
    const w = windowAroundCursor(text, -5, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w.startLine).toBe(0);
  });

  it('maxLinesEachSide caps growth on BOTH sides in a huge, uniform file — exactly 150 up + cursor + 150 down', () => {
    const text = `${linesOf(1000).join('\n')}\n`;
    const cursorLine = 500;
    const w = windowAroundCursor(text, cursorLine, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w.startLine).toBe(cursorLine - 150);
    expect(w.endLine).toBe(cursorLine + 150);
    expect(w.endLine - w.startLine + 1).toBe(301);
  });

  it('maxChars caps the window even when maxLinesEachSide would allow more (a shared, cumulative budget)', () => {
    // 1000 lines of 100 chars each — the line-count cap (150/side, 301 total)
    // would allow ~30 100 chars, comfortably over a tight 1 000-char budget.
    const bigLine = (i: number): string => `L${i}`.padEnd(100, 'x');
    const text = `${linesOf(1000, bigLine).join('\n')}\n`;
    const opts: FileWindowOptions = { maxLinesEachSide: 150, maxChars: 1000, maxLineChars: 2000 };
    const w = windowAroundCursor(text, 500, opts);
    expect(w.text.length).toBeLessThanOrEqual(1000);
    // The line-count cap was NOT what stopped this window — the char budget
    // was, well before either side reached 150 lines.
    expect(w.endLine - w.startLine + 1).toBeLessThan(301);
  });

  it('alternation keeps the cursor roughly centered under a tight char cap (symmetric growth, not all-up-then-all-down)', () => {
    // Each line (with its '\n') is exactly 6 chars: "lineNN\n" for 2-digit N,
    // "lineN\n" for 1-digit — pick a uniform width so the arithmetic is exact.
    const mk = (i: number): string => `ln${String(i).padStart(3, '0')}`; // "lnNNN" = 5 chars + '\n' = 6
    const text = `${linesOf(400, mk).join('\n')}\n`;
    const cursorLine = 200;
    // Budget for the seed (6 chars) + exactly 10 more lines (60 chars) = 66.
    const opts: FileWindowOptions = { maxLinesEachSide: 150, maxChars: 66, maxLineChars: 2000 };
    const w = windowAroundCursor(text, cursorLine, opts);
    const upCount = cursorLine - w.startLine;
    const downCount = w.endLine - cursorLine;
    // Symmetric round-robin growth: neither side may outgrow the other by
    // more than one line at the point the shared budget runs out.
    expect(Math.abs(upCount - downCount)).toBeLessThanOrEqual(1);
    expect(upCount + downCount).toBe(10);
  });

  it('an oversized line stops the UP side exactly there — the line itself is never included, and it does not touch the down side', () => {
    const lines = linesOf(400);
    lines[195] = 'x'.repeat(2001); // 5 lines above cursor(200), content-length 2001 > maxLineChars(2000)
    const text = `${lines.join('\n')}\n`;
    const opts: FileWindowOptions = { maxLinesEachSide: 150, maxChars: 12_000, maxLineChars: 2000 };
    const w = windowAroundCursor(text, 200, opts);
    expect(w.startLine).toBe(196); // stopped one line short of the oversized line (196..199 are the 4 lines that fit)
    expect(w.text).not.toContain('x'.repeat(2001));
    // The down side is unaffected — it still reaches its own 150-line cap.
    expect(w.endLine).toBe(350);
  });

  it('an oversized line far above the cursor (outside the 150-line reach anyway) changes nothing observable', () => {
    const lines = linesOf(400);
    lines[10] = 'x'.repeat(5000); // 190 lines above cursor(200) — already unreachable
    const text = `${lines.join('\n')}\n`;
    const w = windowAroundCursor(text, 200, DEFAULT_FILE_WINDOW_OPTIONS);
    expect(w.startLine).toBe(50); // 200 - 150, exactly the ordinary line-count cap
    expect(w.text).not.toContain('x'.repeat(5000));
  });

  it('a CRLF-terminated oversized line is measured by CONTENT length (matching secretScanner.ts\'s own /\\r?\\n/ split), not raw length including the \\r', () => {
    const lines = linesOf(400);
    // Content length exactly 2000 (not counting \r\n) — must NOT be treated
    // as oversized (the bound is "> 2000", not ">=").
    lines[199] = 'y'.repeat(2000);
    const text = `${lines.join('\r\n')}\r\n`;
    const opts: FileWindowOptions = { maxLinesEachSide: 150, maxChars: 12_000, maxLineChars: 2000 };
    const w = windowAroundCursor(text, 200, opts);
    // line 199 (one above the cursor) must be included — its CONTENT length
    // is exactly at the cap, not over it.
    expect(w.startLine).toBeLessThanOrEqual(199);
  });

  it('DEFAULT_FILE_WINDOW_OPTIONS matches the frozen V-1 constants and is itself frozen', () => {
    expect(DEFAULT_FILE_WINDOW_OPTIONS).toEqual({ maxLinesEachSide: 150, maxChars: 12_000, maxLineChars: 2_000 });
    expect(Object.isFrozen(DEFAULT_FILE_WINDOW_OPTIONS)).toBe(true);
  });

  it('the returned window is always a CONTIGUOUS slice of the source text (join of consecutive whole lines, terminators intact)', () => {
    // Built from lines that each carry their OWN terminator — the exact
    // contract `windowAroundCursor`'s internal split produces — so the
    // expected slice can be computed by index without re-deriving split
    // semantics from `String.split('\n')` (which yields a trailing empty
    // element for a newline-terminated string and would make this
    // cross-check ambiguous rather than a faithful mirror of the contract).
    const termLines = linesOf(400).map((l) => `${l}\n`);
    const text = termLines.join('');
    const w = windowAroundCursor(text, 200, DEFAULT_FILE_WINDOW_OPTIONS);
    const expected = termLines.slice(w.startLine, w.endLine + 1).join('');
    expect(w.text).toBe(expected);
  });
});
