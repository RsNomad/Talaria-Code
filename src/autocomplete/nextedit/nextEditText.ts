/**
 * nextedit/nextEditText.ts — WS-F3 F3-2 (FI-06): the pure text helpers moved
 * out of `shell.vscode.ts`, verbatim.
 *
 * REUSE MODULE, per `reuseLocks.test.ts`'s own named-list idiom (mirroring
 * `fileWindow.ts`'s header): a NEW leaf under `nextedit/` that is not
 * `*.vscode.ts` and not `*.test.ts`, so it is discovered by both
 * `reuseLocks.test.ts`'s network-call guard sweep and
 * `nextEditPurity.test.ts`'s pure/headless-boundary sweep. Named here — not
 * merely counted — for the same reason those locks name every file they
 * touch: it was looked at, and it is clean.
 *
 * PURE, no `vscode`/`node:fs` import — none of the three functions below
 * touches an editor, a document, or the filesystem; each takes plain
 * strings/numbers and returns a plain string. `extractRegionRange` calls
 * `splitLinesKeepingTerminators`/`sliceLines` (imported from
 * `./formats/shared`, the single canonical splitter per ADR-025-H) and the
 * sibling `stripLineTerminator` kept in this module. This module makes no
 * network call of any kind and never spells the banned network-call token,
 * not even in a comment — `reuseLocks.test.ts`'s `:194-200` raw-content
 * sanity scan confirms that byte-for-byte on every run.
 *
 * `toWorkspaceRelativePosixPath` (`shell.vscode.ts:557-559`) is NOT here: it
 * calls `vscode.workspace.asRelativePath` on a `vscode.Uri`, so it is not
 * pure, and moving it into this file would break `nextEditPurity.test.ts`'s
 * vscode-free boundary for this module. It stays in the shell.
 */
import { sliceLines, splitLinesKeepingTerminators } from './formats/shared';

/**
 * CONTRACT (`formats/*`): `fileContext` must end in '\n' — the sweepV2 render
 * splices it directly into the template and the vendor builds the equivalent
 * value via `"".join(lines)`, i.e. always newline-terminated. A file whose
 * last line has no terminator would otherwise glue `{initial_file}` to the
 * next template line.
 */
export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `text` without ONE trailing line terminator, `\r\n` preferred over `\n`.
 *  Never strips a second one: a genuinely blank final line is content. */
export function stripLineTerminator(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

/**
 * C-3 / ADR-018. Reads `text`'s `[startLine, endLine]` span as the SAME RANGE
 * `region.content` is read as, only against the pre-edit text instead of the
 * live document — i.e. the mirror of
 * `getText(new Range(startLine, 0, endLine, lineAt(endLine).text.length))`.
 *
 * Those two values become sweep-v2's `original/` and `current/` blocks — the
 * pair the model diffs — so any difference between them that the user did not
 * make is noise on exactly the axis the model is trained to read as "what the
 * user just changed". `getText` stops at the last line's TEXT LENGTH, before
 * its terminator; `sliceLines` KEEPS terminators. Composing the two here is
 * what makes the pair agree by construction rather than by coincidence.
 *
 * The terminator is dropped only when `endLine` names a line `sliceLines`
 * actually produced. When the span instead runs past the end — to the empty
 * line a trailing newline creates — `getText` stops there too, so the
 * preceding terminator is inside BOTH blocks and must stay. Dropping it
 * unconditionally would inject the same phantom difference in the other
 * direction, including for an untouched region, where the two blocks must be
 * byte-identical.
 *
 * The vendor has no such asymmetry by construction: `inference.py` assigns
 * literally the same string to both blocks, and v1's `run_model.py` passes
 * both through one join.
 */
export function extractRegionRange(text: string, startLine: number, endLine: number): string {
  const lineCount = splitLinesKeepingTerminators(text).length;
  const span = sliceLines(text, startLine, endLine);
  return endLine < lineCount ? stripLineTerminator(span) : span;
}
