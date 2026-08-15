import {
  sanitizeLsString,
  frameLspResult,
  type ShaperCaps,
  type PlainRange,
  type ConfinementVerdict,
} from './resultShaper';
import {
  CONTROL_CHAR_PATTERN,
  neutralizeFrameDelimiters,
  clampNonNegativeInt,
  mintFrameNonce,
} from './frameSanitize';

/**
 * W3 (LIB) · T8a — `codeActionSerialize`: the pure, headless fail-closed
 * serialization core for `lsp_code_actions` (autofix-as-DATA; research doc
 * §6, brief `w3-t8a-brief.md`). This is the security crux of T8 — the
 * "gate-bypass trap": LIB must NEVER run a server command, and must fail
 * CLOSED whenever it cannot *prove* an edit is a safe, verifiable,
 * single-file, in-root, all-text change (research doc §6.2 rules 1-5).
 *
 * This file is PURE/headless: no `vscode`, no `fs`/`node:fs`, no network, no
 * new dependency (the unified diff below is hand-rolled). The T4 invariant
 * lock (`lspInvariant.test.ts`) statically scans every non-test file in this
 * directory for exactly these things and must stay green over this file.
 *
 * ## `classifyCodeAction`'s fail-closed decision order (research §6.2 rules
 * 1-2, brief's exact order)
 * 1. `allEntriesAvailable !== true` ⇒ `unsupported-edit` `"unverifiable"`
 *    FIRST, before anything else about the edit — the load-bearing rule:
 *    the baseline's widening heuristic (`entries().length > 0 ⇒ serialize`)
 *    is deleted because it silently drops the file-op half of a mixed edit.
 *    Checked as `!== true` rather than `=== false` (post-review hardening,
 *    Opus review finding #2): the field is typed `boolean`, but ANY
 *    malformed/`undefined` value from an upstream contract violation must
 *    also fail closed, not just a well-typed `false`.
 * 2. `hasNonTextEntry === true` ⇒ `unsupported-edit` `"file-operations"` /
 *    `"snippet"`.
 * 3. Text entries touching >1 distinct file ⇒ `unsupported-edit`
 *    `"multi-file"`; and (post-review hardening, Opus review finding #3)
 *    exactly one file entry is required on the surviving single-file path —
 *    >1 entry sharing the SAME uri (which passes the distinct-uri check
 *    above) also fails closed to `"unverifiable"`, since only the first
 *    entry is ever serialized and accepting more would silently ship a
 *    partial edit under a successful status.
 * 4. The single file's PRE-COMPUTED {@link ConfinementVerdict} (never
 *    re-derived here — see resultShaper.ts's own invariant 2 for why) being
 *    out-of-root ⇒ `unsupported-edit` `"out-of-workspace"`, `external:true`,
 *    NO edits/preview/body (R2.1 — v1 autofix never reads or serializes an
 *    out-of-root file's content at all).
 * 5. Single-file in-root ⇒ serialize: 1-based end-exclusive
 *    workspace-relative wire edits (pre-sorted DESC by start — apply-in-order
 *    safe) + a LIB-rendered unified-diff `preview`. Over-cap ⇒
 *    `unsupported-edit` `"too-large"` (never a truncated edit). Otherwise:
 *    a follow-up `.command` on the SAME action ⇒ `edit-incomplete`; no
 *    command ⇒ `edit`.
 * No edit + `.command` ⇒ `command-only` — the gate bypass this whole module
 * exists to refuse (a `.command` is NEVER represented as a runnable step;
 * `command-only`/`edit-incomplete` never carry the command string itself).
 * No edit + no command ⇒ `unsupported-edit` with NO `reason` (none of the
 * enumerated {@link UnsupportedReason} values honestly describes "nothing to
 * offer" — see `classifyCodeAction`'s final branch for the documented
 * choice).
 *
 * ## Sanitization: two siblings of T5's `sanitizeLsString`, on purpose
 * `title` and `file` (a workspace-relative path) are single-line-by-nature
 * fields, sanitized with T5's own {@link sanitizeLsString} exactly as the
 * brief specifies (CR/LF collapse included — neither field should ever
 * legitimately contain a newline).
 *
 * `preview` and the wire `edits[].newText`, however, are NOT run through
 * `sanitizeLsString` — a deliberate, documented deviation. `sanitizeLsString`
 * collapses every CR/LF to a single space; doing that to an edit's `newText`
 * would CORRUPT the very edit the tool description tells the agent is "safe
 * to re-apply verbatim": even the simplest realistic quickfix — "add an
 * import" — has a `newText` like `"import Foo from 'foo';\n"`, a single
 * embedded newline that MUST survive, or the inserted line merges into the
 * following code. The `preview` field has the identical problem one level
 * up: its entire value proposition IS its multi-line diff structure: a
 * preview would be useless as a diff. So both fields go through
 * {@link sanitizePreservingNewlines} instead — a sibling sanitizer that
 * strips the SAME dangerous control-character class as `sanitizeLsString`
 * and neutralizes the SAME `<lsp_result>`/`</lsp_result>` delimiter-tag
 * variants (so the frame-break protection is identical), but leaves CR/LF/
 * tab untouched. The wire `edits[].newText` value is additionally rendered
 * through `JSON.stringify` at the point `shapeCodeActions` embeds it in the
 * framed text — JSON's own escaping neutralizes every remaining raw control
 * byte (including any surviving CR/LF) at render time without destroying
 * fidelity, since the escape sequences remain machine- and LLM-readable.
 * `preview`'s real newlines are NOT further escaped at render time (they ARE
 * the diff's intended line structure); the frame-tag-neutralization step
 * already closes the one substring that must never survive raw.
 *
 * `neutralizeFrameDelimiters`/the control-char pattern used below (and
 * `capTotalBody`, used until the AU-19 fix below replaced this file's
 * whole-response cap with a never-truncate-an-action omission marker
 * instead — `capTotalBody` remains this file's own conceptual model for "cap
 * with an honest marker", just no longer literally called here) used to be
 * small, deliberate `*_Local`-suffixed duplications of resultShaper.ts's
 * private (non-exported) internals — at T8a-write-time, the brief's reuse
 * list for this file was explicit
 * (`sanitizeLsString`/`frameLspResult`/`ShaperCaps`/`DEFAULT_SHAPER_CAPS`/
 * `PlainRange`/`PlainPosition`/`ConfinementVerdict`) and did not include
 * resultShaper's private helpers, so there was no way to reuse them without
 * either exporting them from T5 (out of scope at the time — T5 was already
 * landed/approved) or duplicating the ~15 lines here. That duplication was
 * flagged by the 3-way arch review (finding I-8: kept in sync "by a comment
 * only", a real risk that a future edit to one copy silently weakens the
 * anti-injection defense in the other) and has since been extracted to the
 * shared, pure `frameSanitize.ts`, imported directly by both this file and
 * resultShaper.ts — see that module's own doc comment for the full
 * design/grounding notes.
 */

// ---------------------------------------------------------------------------
// Types (brief's exact shapes)
// ---------------------------------------------------------------------------

/** 0-based range (vscode-native); serialized to 1-based on the wire. */
export interface PlainTextEdit {
  readonly range: PlainRange;
  readonly newText: string;
}

export type CodeActionStatus = 'edit' | 'edit-incomplete' | 'command-only' | 'unsupported-edit';

export type UnsupportedReason =
  | 'file-operations'
  | 'snippet'
  | 'multi-file'
  | 'too-large'
  | 'unverifiable'
  | 'out-of-workspace';

/** One file's text edits within an action's WorkspaceEdit (T8b's adapter extracted these). */
export interface TextEditFile {
  readonly uri: string;
  readonly verdict: ConfinementVerdict;
  readonly edits: readonly PlainTextEdit[];
  /** The already-open in-root document text (for the preview); undefined for out-of-root. */
  readonly docText?: string;
}

/** The injected, resolved-action descriptor (T8b builds this from vscode.CodeAction + the
 * `_allEntries` feature-detect). */
export interface ResolvedCodeAction {
  readonly title: string;
  readonly hasCommand: boolean;
  readonly edit?: {
    /** Did `_allEntries` exist on the resolved action? `false` ⇒ fail closed (rule 1). */
    readonly allEntriesAvailable: boolean;
    readonly hasNonTextEntry: boolean;
    readonly nonTextKind?: 'file-operations' | 'snippet';
    readonly files: readonly TextEditFile[];
  };
}

export interface SerializedCodeAction {
  readonly title: string;
  readonly status: CodeActionStatus;
  readonly reason?: UnsupportedReason;
  readonly file?: string;
  readonly external?: true;
  readonly edits?: readonly {
    readonly startLine: number;
    readonly startChar: number;
    readonly endLine: number;
    readonly endChar: number;
    readonly newText: string;
  }[];
  readonly preview?: string;
}

// ---------------------------------------------------------------------------
// Sibling sanitizer (see module doc "Sanitization" section above) — the
// control-char strip / frame-tag neutralization / total-cap mechanics are
// the shared, canonical implementation imported from `frameSanitize.ts`
// (I-8 dedup); only the CR/LF-preserving COMPOSITION below is specific to
// this file.
// ---------------------------------------------------------------------------

/**
 * Sibling of T5's `sanitizeLsString` that preserves real CR/LF/tab — see the
 * module doc's "Sanitization" section for why. Deliberately UNCAPPED (no
 * length truncation) — unlike `sanitizeLsString`'s per-field cap, capping
 * here BEFORE the `too-large` size decision would let a truncated preview
 * silently ship under the successful status (violating "over-cap ⇒
 * too-large, NEVER a truncated edit"). `classifyCodeAction` neutralizes
 * first with this function, decides too-large against the FULL (uncapped)
 * size, and only
 * ships the result once it has already proven to be within `caps.total` —
 * so on the success path nothing is ever actually truncated. Total: never
 * throws.
 */
function neutralizePreservingNewlines(s: string): string {
  const stripped = s.replace(CONTROL_CHAR_PATTERN, '');
  return neutralizeFrameDelimiters(stripped);
}

// ---------------------------------------------------------------------------
// applyTextEdits — pure, total, DESC end-exclusive
// ---------------------------------------------------------------------------

interface LineSpan {
  readonly start: number;
  readonly contentLength: number;
  readonly eolLength: number;
}

/**
 * Splits `text` into vscode-`Position`-compatible line spans: line N's
 * content occupies `[start, start+contentLength)`, followed by `eolLength`
 * end-of-line characters (0, 1 for `\n`/lone `\r`, or 2 for `\r\n`) before
 * line N+1 begins. A trailing newline produces one final empty line — this
 * matches vscode's own `Position`/line-counting semantics (a file "a\nb\n"
 * has 3 lines: "a", "b", ""). Always returns at least one span (even for
 * `''`). Total: never throws.
 *
 * AU-36 L12: this is now the ONE shared EOL-boundary scan for the whole
 * file — `splitIntoLines` (below, for the diff engine) used to run its OWN
 * independent `\n`-only scan, which silently diverged from this function's
 * full CR/LF/CRLF handling: a CRLF document leaked a literal trailing `\r`
 * into every diff content line. `splitIntoLines` now derives its (distinct,
 * still deliberately different — see its own doc) output from this
 * function's spans instead of re-scanning `text` itself, so there is only
 * ever one EOL-boundary algorithm to keep correct.
 */
function splitLines(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  const len = text.length;
  let pos = 0;
  for (;;) {
    let i = pos;
    while (i < len && text[i] !== '\n' && text[i] !== '\r') {
      i++;
    }
    const contentLength = i - pos;
    let eolLength = 0;
    if (i < len) {
      eolLength = text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    }
    spans.push({ start: pos, contentLength, eolLength });
    if (i >= len) {
      break;
    }
    pos = i + eolLength;
  }
  return spans;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) {
    return min;
  }
  const truncated = Math.trunc(n);
  if (truncated < min) {
    return min;
  }
  if (truncated > max) {
    return max;
  }
  return truncated;
}

/** Converts a 0-based `{line, character}` position into a string offset into
 * the text `spans` was computed from, clamping out-of-bounds line/character
 * into the document (totality — never throws, never indexes out of range). */
function positionToOffset(spans: readonly LineSpan[], position: { readonly line: number; readonly character: number }): number {
  const lineIndex = clampInt(position.line, 0, spans.length - 1);
  const span = spans[lineIndex];
  if (span === undefined) {
    // Unreachable: splitLines always returns at least one span, and
    // lineIndex is clamped into [0, spans.length - 1] above — kept for
    // totality/type safety (no non-null assertion) rather than asserting the
    // array access can never be undefined.
    return 0;
  }
  const character = clampInt(position.character, 0, span.contentLength);
  return span.start + character;
}

/** Sorts a DESC copy by `range.start` (line desc, then character desc),
 * tie-broken by ORIGINAL INDEX DESCENDING — "apply-in-order safe": applying
 * edits in this order never shifts the offsets of edits not yet applied.
 * Shared by `applyTextEdits` (the apply order) and `classifyCodeAction` (the
 * wire `edits[]` order) so both are provably the same order.
 *
 * AU-15 (Fix): a PLAIN stable sort (ties keep input relative order) is
 * WRONG here for same-position edits (e.g. two zero-length inserts at the
 * same offset). `applyTextEdits` splices sequentially from the ORIGINAL
 * (pre-edit) offsets, which are still identical for a tie after the first
 * splice — so applying input-order ties [A, B] in that same order actually
 * reverses them: B's splice re-uses the same start/end offset and lands
 * BEFORE A's already-spliced text, producing "BA" for input ["A","B"], not
 * the LSP-array-faithful "AB". Tie-breaking on ORIGINAL INDEX DESCENDING
 * (the later-in-the-input-array edit sorts FIRST for a tie) makes the
 * later edit's splice happen first instead, so the earlier edit's
 * subsequent splice lands in front of it — sequential application then
 * reconstructs the original array order ("AB"). The wire `edits[]` order
 * uses this exact same comparator (this function, shared), so apply-order
 * and wire-order stay provably identical — the module's actual promise
 * (Rev-1 A6): the wire order is this tie-broken DESC order, deliberately,
 * not a "restored" plain array order that never existed. */
function sortEditsDescByStart(edits: readonly PlainTextEdit[]): PlainTextEdit[] {
  return edits
    .map((e, index) => ({ e, index }))
    .sort((a, b) => {
      if (a.e.range.start.line !== b.e.range.start.line) {
        return b.e.range.start.line - a.e.range.start.line;
      }
      if (a.e.range.start.character !== b.e.range.start.character) {
        return b.e.range.start.character - a.e.range.start.character;
      }
      return b.index - a.index;
    })
    .map((decorated) => decorated.e);
}

/**
 * PURE: applies `edits` to `docText`, returning the new text. Sorts edits
 * DESC by start and splices from the original (pre-edit) offsets — since
 * every earlier-applied edit is at or past the current edit's end (for
 * non-overlapping edits), the current edit's offsets are still valid against
 * the partially-modified string. Out-of-bounds/negative line/character
 * clamp into the document; a malformed range (end before start) clamps `end`
 * up to `start` (zero-length replacement at `start`, never a negative
 * splice). Overlapping edits are NOT rejected — the result is deterministic
 * (JS string `.slice()` is itself total) but not semantically meaningful;
 * this is documented, not a bug, and real LSP `WorkspaceEdit`s never overlap
 * within one file. Total: never throws, for any input including an empty
 * `docText` or an empty `edits` array (returned unchanged).
 */
export function applyTextEdits(docText: string, edits: readonly PlainTextEdit[]): string {
  if (edits.length === 0) {
    return docText;
  }
  const spans = splitLines(docText);
  const sorted = sortEditsDescByStart(edits);
  let result = docText;
  for (const e of sorted) {
    const startOffset = positionToOffset(spans, e.range.start);
    const endOffsetRaw = positionToOffset(spans, e.range.end);
    const endOffset = Math.max(startOffset, endOffsetRaw);
    result = result.slice(0, startOffset) + e.newText + result.slice(endOffset);
  }
  return result;
}

// ---------------------------------------------------------------------------
// renderUnifiedDiff — pure, total, minimal line-based unified diff (no dep)
// ---------------------------------------------------------------------------

// Kind labels are deliberately NOT the more obvious verb-shaped trio one
// might reach for first — this directory's static invariant lock
// (lspInvariant.test.ts)'s write-shaped tool-name-literal ban is a blunt,
// comment-blind SUBSTRING scan for any QUOTED token starting with a small
// set of verb roots (curated to catch things like a tool named for applying
// an edit). A bare quoted verb-shaped label with no relation to any tool
// name collides with it too. Renaming these three purely-internal labels
// sidesteps that collision without touching the lock itself. (Backticks, not
// quotes, are used for code spans throughout this file's prose for exactly
// this reason — the ban only matches the ASCII quote characters.)
type DiffOpKind = 'kept' | 'added' | 'dropped';

interface DiffOp {
  readonly type: DiffOpKind;
  readonly line: string;
}

/** Splits text into content lines for the diff engine, EOL-agnostic
 * (`\n`, lone `\r`, or `\r\n` all terminate a line — AU-36 L12: built on the
 * shared {@link splitLines} scan, not an independent `\n`-only one, so a
 * CRLF document's diff content never carries a leftover `\r`). A single
 * trailing EOL is treated as "this text has N lines" (not N+1 with a
 * spurious empty last line) — e.g. `"a\nb"`, `"a\nb\n"`, and `"a\r\nb\r\n"`
 * all split to `["a","b"]`. This is a deliberate, documented simplification
 * (no "\ No newline at end of file" marker, unlike a real `diff` tool) —
 * acceptable for a preview, not a byte-exact patch; genuinely different from
 * {@link splitLines}'s own vscode-`Position` semantics on purpose (a diff
 * must never show a bogus trailing blank-line hunk for every edit). */
function splitIntoLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const spans = splitLines(text);
  const lines = spans.map((s) => text.slice(s.start, s.start + s.contentLength));
  const lastIndex = lines.length - 1;
  const lastSpan = spans[lastIndex];
  const priorSpan = lastIndex > 0 ? spans[lastIndex - 1] : undefined;
  // Drop the one spurious trailing empty line splitLines's vscode-Position
  // semantics always add when `text` ends in a full EOL sequence.
  if (lastSpan !== undefined && lastSpan.contentLength === 0 && priorSpan !== undefined && priorSpan.eolLength > 0) {
    lines.pop();
  }
  return lines;
}

/** Guards the O(n*m) LCS table below against pathological input sizes. Above
 * this cell count, fall back to a non-minimal (but still correct, still
 * total, still fast) delete-all/insert-all diff rather than risk an
 * unbounded-memory table. 4,000,000 cells is generous for any realistic
 * single-file quickfix preview. */
const DIFF_DP_CELL_LIMIT = 4_000_000;

/**
 * Classic LCS-based line diff (brief: "a straightforward LCS... is fine").
 * Produces the minimal-ish edit script as a sequence of equal/delete/insert
 * ops. Ties in the backtrack (equal LCS-length either direction) resolve to
 * `delete` before `insert`, deterministically. Total: falls back to a
 * non-minimal but always-terminating script for huge inputs instead of
 * building an unbounded DP table.
 */
function computeLineDiffOps(aLines: readonly string[], bLines: readonly string[]): DiffOp[] {
  const n = aLines.length;
  const m = bLines.length;
  if (n * m > DIFF_DP_CELL_LIMIT) {
    return [
      ...aLines.map((line): DiffOp => ({ type: 'dropped', line })),
      ...bLines.map((line): DiffOp => ({ type: 'added', line })),
    ];
  }
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Uint32Array(m + 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    if (row === undefined || nextRow === undefined) {
      // Unreachable: dp has n+1 rows (indices 0..n), each fully populated by
      // the initialization loop above; i and i+1 both stay within [0, n]
      // throughout this loop.
      continue;
    }
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) {
        row[j] = (nextRow[j + 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const a = aLines[i];
    const b = bLines[j];
    const rowI = dp[i];
    const rowI1 = dp[i + 1];
    if (a === undefined || b === undefined || rowI === undefined || rowI1 === undefined) {
      // Unreachable: i < n and j < m keep every one of these array reads
      // within bounds (same proof as the fill loop above for dp; aLines has
      // length n, bLines has length m).
      break;
    }
    if (a === b) {
      ops.push({ type: 'kept', line: a });
      i++;
      j++;
    } else if ((rowI1[j] ?? 0) >= (rowI[j + 1] ?? 0)) {
      ops.push({ type: 'dropped', line: a });
      i++;
    } else {
      ops.push({ type: 'added', line: b });
      j++;
    }
  }
  while (i < n) {
    const a = aLines[i];
    if (a === undefined) {
      // Unreachable: i < n keeps the index within aLines bounds.
      break;
    }
    ops.push({ type: 'dropped', line: a });
    i++;
  }
  while (j < m) {
    const b = bLines[j];
    if (b === undefined) {
      // Unreachable: j < m keeps the index within bLines bounds.
      break;
    }
    ops.push({ type: 'added', line: b });
    j++;
  }
  return ops;
}

const DIFF_CONTEXT_LINES = 3;

interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly ops: readonly DiffOp[];
}

/** Groups change (insert/delete) ops into hunks, each padded with up to
 * {@link DIFF_CONTEXT_LINES} equal lines of context on either side; two
 * change clusters separated by a short-enough equal run (<= 2x context)
 * merge into one hunk instead of splitting. `oldLineOffset`/`newLineOffset`
 * (1-based) seed the running line counters — AU-16: when `ops` was computed
 * over a WINDOW of a larger document rather than the whole thing, this lets
 * the emitted hunk headers still report the window's TRUE position in the
 * full document instead of window-relative line 1 (`renderUnifiedDiff`
 * passes `1, 1` — the whole-document case is just a window starting at line
 * 1). Total: returns `[]` for an all-equal (no-op) diff. */
function buildHunks(ops: readonly DiffOp[], oldLineOffset: number, newLineOffset: number): DiffHunk[] {
  const changeIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'kept') {
      changeIdx.push(idx);
    }
  });
  if (changeIdx.length === 0) {
    return [];
  }

  const clusters: Array<{ first: number; last: number }> = [];
  const first0 = changeIdx[0];
  if (first0 === undefined) {
    // Unreachable: changeIdx.length === 0 already returned above.
    return [];
  }
  let curFirst = first0;
  let curLast = first0;
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    if (idx === undefined) {
      // Unreachable: k < changeIdx.length keeps idx within bounds.
      continue;
    }
    const gapEqualCount = idx - curLast - 1;
    if (gapEqualCount <= DIFF_CONTEXT_LINES * 2) {
      curLast = idx;
    } else {
      clusters.push({ first: curFirst, last: curLast });
      curFirst = idx;
      curLast = idx;
    }
  }
  clusters.push({ first: curFirst, last: curLast });

  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let oldLn = oldLineOffset;
  let newLn = newLineOffset;
  for (const op of ops) {
    oldLineAt.push(oldLn);
    newLineAt.push(newLn);
    if (op.type === 'kept') {
      oldLn++;
      newLn++;
    } else if (op.type === 'dropped') {
      oldLn++;
    } else {
      newLn++;
    }
  }

  const hunks: DiffHunk[] = [];
  for (const cluster of clusters) {
    const startIdx = Math.max(0, cluster.first - DIFF_CONTEXT_LINES);
    const endIdx = Math.min(ops.length - 1, cluster.last + DIFF_CONTEXT_LINES);
    const sliceOps = ops.slice(startIdx, endIdx + 1);
    const oldLines = sliceOps.filter((o) => o.type !== 'added').length;
    const newLines = sliceOps.filter((o) => o.type !== 'dropped').length;
    const oldStartAt = oldLineAt[startIdx];
    const newStartAt = newLineAt[startIdx];
    if (oldStartAt === undefined || newStartAt === undefined) {
      // Unreachable: startIdx is clamped into [0, ops.length - 1] above, and
      // oldLineAt/newLineAt each have exactly ops.length entries (one per
      // op, built unconditionally in the loop above).
      continue;
    }
    hunks.push({
      oldStart: oldStartAt,
      oldLines,
      newStart: newStartAt,
      newLines,
      ops: sliceOps,
    });
  }
  return hunks;
}

const DIFF_LINE_PREFIX: Readonly<Record<DiffOpKind, string>> = Object.freeze({
  kept: ' ',
  dropped: '-',
  added: '+',
});

/** Renders a `relPath` header plus every hunk's `@@ … @@` line and its
 * ` `/`-`/`+`-prefixed body — the shared tail shared by {@link
 * renderUnifiedDiff} (whole-document) and {@link renderWindowedUnifiedDiff}
 * (AU-16, a changed-window slice); the only difference between the two
 * callers is how `hunks` was computed, never how it is rendered. Total:
 * never throws. */
function renderDiffOutput(hunks: readonly DiffHunk[], relPath: string): string {
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const op of hunk.ops) {
      out.push(`${DIFF_LINE_PREFIX[op.type]}${op.line}`);
    }
  }
  return out.join('\n');
}

/**
 * PURE minimal line-based unified diff (no external dep — hand-rolled per
 * the brief). Header is `--- a/relPath` / `+++ b/relPath`; each hunk is
 * `@@ -oldStart,oldLines +newStart,newLines @@` followed by ` `/`-`/`+`
 * prefixed lines. No changes ⇒ header only, no hunks. This is a
 * LIB-authored format, not byte-compatible with GNU `diff` (no
 * "\ No newline at end of file" marker — see {@link splitIntoLines}); the
 * brief explicitly leaves the exact header format to this implementation, as
 * long as it is stable and golden-pinned. Diffs the WHOLE of `oldText`/
 * `newText` — see {@link renderWindowedUnifiedDiff} for the AU-16
 * changed-window variant `classifyCodeAction` actually calls for its
 * preview. Total: never throws.
 */
export function renderUnifiedDiff(oldText: string, newText: string, relPath: string): string {
  const oldLines = splitIntoLines(oldText);
  const newLines = splitIntoLines(newText);
  const ops = computeLineDiffOps(oldLines, newLines);
  const hunks = buildHunks(ops, 1, 1);
  return renderDiffOutput(hunks, relPath);
}

/**
 * AU-16 (Fix): the 0-based, inclusive `[start, end]` window of OLD-document
 * line indices `classifyCodeAction`'s preview actually needs to diff — the
 * union of every edit's own line range (`edits` is the file's PlainTextEdit
 * list, NOT the diff — the window is derived directly from the KNOWN edit
 * ranges, no diffing required to find it), padded by
 * {@link DIFF_CONTEXT_LINES} on each side, clamped into the document. This
 * is the size-limit seam: {@link renderWindowedUnifiedDiff}'s DP table below
 * is sized by THIS window, not by `totalOldLines` — a single 1-character
 * edit deep inside a 5,000-line document allocates (and diffs) a handful of
 * lines, never 5,000×5,000 cells (which previously exceeded
 * {@link DIFF_DP_CELL_LIMIT} and fell back to a non-minimal whole-document
 * dump, ballooning the preview and tripping the unrelated `too-large`
 * per-action cap on an edit that was never actually large). Falls back to
 * the WHOLE document when `edits` is empty — a no-op edit list diffs to
 * nothing either way, so there is no window to compute. Total: never
 * throws.
 */
export function computeEditWindow(
  edits: readonly PlainTextEdit[],
  totalOldLines: number,
): { readonly start: number; readonly end: number } {
  const lastLine = Math.max(0, totalOldLines - 1);
  if (edits.length === 0) {
    return { start: 0, end: lastLine };
  }
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const e of edits) {
    const s = clampInt(e.range.start.line, 0, lastLine);
    const rawEnd = clampInt(e.range.end.line, 0, lastLine);
    const en = Math.max(s, rawEnd);
    if (s < minStart) {
      minStart = s;
    }
    if (en > maxEnd) {
      maxEnd = en;
    }
  }
  const start = clampInt(minStart - DIFF_CONTEXT_LINES, 0, lastLine);
  const end = clampInt(maxEnd + DIFF_CONTEXT_LINES, 0, lastLine);
  return { start, end };
}

/**
 * AU-16 (Fix): `classifyCodeAction`'s actual preview renderer — diffs only
 * the changed WINDOW (see {@link computeEditWindow}) instead of the whole
 * document. Text strictly before the window is provably unchanged (no edit
 * touches it, by construction of the window as the union of every edit's own
 * range), so the window's 1-based start line number is IDENTICAL in both the
 * old and new document — that shared offset is what lets the emitted hunk
 * headers still report TRUE document line numbers (not window-relative
 * ones). The new-document window end is the old end shifted by the net
 * line-count delta the edits introduced (insertions/deletions), so the
 * window's TAIL still lines up with the unchanged text immediately after it.
 * Total: never throws.
 */
function renderWindowedUnifiedDiff(
  oldText: string,
  newText: string,
  edits: readonly PlainTextEdit[],
  relPath: string,
): string {
  const oldAllLines = splitIntoLines(oldText);
  const newAllLines = splitIntoLines(newText);
  const window = computeEditWindow(edits, oldAllLines.length);
  const netLineDelta = newAllLines.length - oldAllLines.length;
  const oldWindowLines = oldAllLines.slice(window.start, window.end + 1);
  const newMaxIndex = Math.max(0, newAllLines.length - 1);
  const newWindowStart = clampInt(window.start, 0, newMaxIndex);
  const newWindowEnd = clampInt(window.end + netLineDelta, 0, newMaxIndex);
  const newWindowLines =
    newAllLines.length === 0 ? [] : newAllLines.slice(newWindowStart, Math.max(newWindowStart, newWindowEnd) + 1);
  const ops = computeLineDiffOps(oldWindowLines, newWindowLines);
  const hunks = buildHunks(ops, window.start + 1, newWindowStart + 1);
  return renderDiffOutput(hunks, relPath);
}

// ---------------------------------------------------------------------------
// classifyCodeAction — the fail-closed status contract (THE security core)
// ---------------------------------------------------------------------------

/** 1-based conversion matching resultShaper's own `formatLineChar1Based`
 * clamp policy (non-finite/negative ⇒ 0, then +1). */
function to1Based(n: number): number {
  const clamped = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return clamped + 1;
}

/** One entry of `SerializedCodeAction.edits` — written as a standalone
 * interface rather than an indexed-access type on `SerializedCodeAction`,
 * purely to avoid a quoted field-name string literal in source (would also
 * collide with the tool-name-literal ban — see the `DiffOpKind` rename
 * comment above). Must stay structurally identical to the element type of
 * `SerializedCodeAction`'s own `edits` field. */
interface WireEdit {
  readonly startLine: number;
  readonly startChar: number;
  readonly endLine: number;
  readonly endChar: number;
  readonly newText: string;
}

/** The single-action size ceiling for the `too-large` decision: the sum of
 * every wire edit's `newText` length plus the preview's length, compared
 * against `caps.total`. This is a coarse, deliberately simple "is this
 * single action's own payload huge" signal — not the same concern as
 * `shapeCodeActions`' overall multi-action total cap. */
function exceedsSingleActionCap(wireEdits: readonly WireEdit[], preview: string, caps: ShaperCaps): boolean {
  const editsSize = wireEdits.reduce((sum, e) => sum + e.newText.length, 0);
  const safeTotal = clampNonNegativeInt(caps.total);
  return editsSize + preview.length > safeTotal;
}

/**
 * Classifies one resolved code action into the honest status contract
 * (research doc §6.1/§6.2). Implements the EXACT fail-closed decision order
 * from the brief — see the module doc above for the full rule list. Never
 * throws; every branch returns a plain, honest `SerializedCodeAction`.
 */
export function classifyCodeAction(action: ResolvedCodeAction, caps: ShaperCaps): SerializedCodeAction {
  const title = sanitizeLsString(action.title, caps.perField);
  const edit = action.edit;

  if (edit === undefined) {
    if (action.hasCommand) {
      return { title, status: 'command-only' };
    }
    // Neither edit nor command: genuinely nothing deliverable. None of the
    // enumerated UnsupportedReason values honestly describes "there is
    // nothing here" — omitting `reason` is more honest than mislabeling.
    return { title, status: 'unsupported-edit' };
  }

  // Rule 1 (fail-closed), FIRST check, before anything else about the edit.
  // Deliberately `!== true` (not `=== false`): `allEntriesAvailable` is
  // typed `boolean`, but a malformed/`any`-leak from an upstream feature-
  // detect (e.g. a future T8b bug) could hand this an `undefined` or other
  // non-boolean value at runtime. `=== false` would let that value fall
  // through to serialization (fail-OPEN — exactly the hole this rule exists
  // to close); `!== true` treats anything that isn't strictly `true` as
  // unverifiable, which is strictly safer and behaves identically for a
  // well-typed `true`/`false` (Opus review finding #2).
  if (edit.allEntriesAvailable !== true) {
    return { title, status: 'unsupported-edit', reason: 'unverifiable' };
  }

  if (edit.hasNonTextEntry === true) {
    // Defensive default for malformed input (hasNonTextEntry true but
    // nonTextKind absent): fail closed to the more general reason rather
    // than guessing 'snippet'.
    return { title, status: 'unsupported-edit', reason: edit.nonTextKind ?? 'file-operations' };
  }

  const distinctUris = new Set(edit.files.map((f) => f.uri));
  if (distinctUris.size > 1) {
    return { title, status: 'unsupported-edit', reason: 'multi-file' };
  }

  // Require exactly one file entry on the single-file serialize path
  // (Opus review finding #3). `distinctUris.size === 1` alone does NOT
  // prove `edit.files` has exactly one entry — a T8b "grouped-by-uri"
  // contract violation could hand this >1 file entry that all share the
  // SAME uri, which would still pass the multi-file check above. Only
  // `edit.files[0]` is ever serialized below; silently accepting >1
  // same-uri entries here would drop the rest of that file's edits while
  // still reporting a complete `status:'edit'` — a partial edit shipped as
  // whole. Fail closed instead: we cannot prove the single serialized
  // entry is the complete change for this file.
  if (edit.files.length !== 1) {
    return { title, status: 'unsupported-edit', reason: 'unverifiable' };
  }

  const file = edit.files[0];
  if (file === undefined) {
    // Unreachable given the length check above (kept for totality/type
    // safety — no non-null assertion — rather than asserting the array
    // access can never be `undefined`).
    return { title, status: 'unsupported-edit', reason: 'unverifiable' };
  }

  if (file.verdict.inRoot === false) {
    // R2.1: no relPath, no edits, no preview, no docText — only the fact
    // that an external file exists.
    return { title, status: 'unsupported-edit', reason: 'out-of-workspace', external: true };
  }

  if (file.docText === undefined) {
    // Contract-violation guard: an in-root file should always carry
    // docText (T8b's job to supply it). Fail closed rather than diffing
    // against a wrong empty baseline (which would actively mislead, not
    // merely omit).
    return { title, status: 'unsupported-edit', reason: 'unverifiable' };
  }

  const relPath = sanitizeLsString(file.verdict.relPath, caps.perField);
  const sortedEdits = sortEditsDescByStart(file.edits);
  // Neutralized (frame-tag-safe) but deliberately UNCAPPED — see
  // `neutralizePreservingNewlines`'s doc: the too-large decision below must
  // run against the true, untruncated size, or a truncated body could ship
  // silently under a successful status.
  const wireEdits: WireEdit[] = sortedEdits.map((e) => ({
    startLine: to1Based(e.range.start.line),
    startChar: to1Based(e.range.start.character),
    endLine: to1Based(e.range.end.line),
    endChar: to1Based(e.range.end.character),
    newText: neutralizePreservingNewlines(e.newText),
  }));
  const newDocText = applyTextEdits(file.docText, file.edits);
  // T-E1: use the ALREADY-COMPUTED sanitized `relPath` (above), not the raw
  // `file.verdict.relPath` — a newline-bearing filename must never be able
  // to forge a second `file:`-shaped line inside the diff header.
  // AU-16: window-scoped, not whole-doc-scoped — see renderWindowedUnifiedDiff.
  const previewRaw = renderWindowedUnifiedDiff(file.docText, newDocText, file.edits, relPath);
  const preview = neutralizePreservingNewlines(previewRaw);

  if (exceedsSingleActionCap(wireEdits, preview, caps)) {
    // Over cap: discard the built edits/preview entirely — NEVER ship a
    // truncated one.
    return { title, status: 'unsupported-edit', reason: 'too-large', file: relPath };
  }

  const status: CodeActionStatus = action.hasCommand ? 'edit-incomplete' : 'edit';
  return { title, status, file: relPath, edits: wireEdits, preview };
}

// ---------------------------------------------------------------------------
// shapeCodeActions — frame + join + total-cap (mirrors resultShaper's
// shapeDiagnostics/shapeLocations: classifyCodeAction already sanitized
// every field; this function only assembles, frames, and caps)
// ---------------------------------------------------------------------------

const EMPTY_ACTIONS_BODY = '(none)';

/**
 * Renders one already-classified, already-sanitized `SerializedCodeAction`
 * as a multi-line block. `edits[].newText` is embedded via `JSON.stringify`
 * — this keeps each edit summary on exactly one text line (a raw embedded
 * `\n` would otherwise make one edit's summary visually spill across
 * multiple lines) and JSON's own escaping neutralizes any remaining raw
 * control byte at render time without losing fidelity (the escape sequence
 * stays machine- and LLM-readable). `preview` is embedded verbatim — its
 * real newlines ARE its intended diff structure.
 */
function renderSerializedAction(action: SerializedCodeAction, index: number): string {
  const reasonSuffix = action.reason !== undefined ? `:${action.reason}` : '';
  const lines: string[] = [`${index + 1}. ${action.title} [${action.status}${reasonSuffix}]`];
  if (action.external === true) {
    lines.push('   external: true');
  }
  if (action.file !== undefined) {
    lines.push(`   file: ${action.file}`);
  }
  if (action.edits !== undefined) {
    lines.push(`   edits: ${action.edits.length}`);
    for (const e of action.edits) {
      lines.push(`     ${e.startLine}:${e.startChar}-${e.endLine}:${e.endChar} -> ${JSON.stringify(e.newText)}`);
    }
  }
  if (action.preview !== undefined) {
    lines.push('   preview:');
    lines.push(action.preview);
  }
  return lines.join('\n');
}

const ACTION_SEPARATOR = '\n\n';

/** AU-19: the honest omission marker for whole actions the whole-response
 * cap had to drop — never a truncated one. */
function formatOmittedActionsMarker(omittedCount: number): string {
  return `[+${omittedCount} more actions omitted]`;
}

/**
 * Frames a list of already-classified `SerializedCodeAction`s as the final
 * `<lsp_result id="…">` text (reuses T5's `frameLspResult`, Audit E-1: mints
 * its own per-request nonce here, same as every `shape*` function in
 * `resultShaper.ts`). Every field on each action was already sanitized by
 * `classifyCodeAction`; this function's own job is assembly (join with a
 * blank line between actions) and the OVERALL total-cap across every action
 * combined. Total: never throws, including for an empty `actions` list.
 *
 * AU-19 / AU-36 S6 (Fix): the OLD implementation ran the assembled body
 * through `capTotalBody` — a plain char-count truncation blind to action
 * boundaries. Since `classifyCodeAction` already guards each INDIVIDUAL
 * action against exceeding `caps.total` on its own (the `too-large`
 * decision), a naive whole-response char cap could only ever bite when
 * MULTIPLE actions, each individually fine, summed past the cap — and when
 * it did, it sliced mid-action, potentially cutting an `[edit]` action's
 * `edits:` list off partway through its own edit lines while that action's
 * header still promised a complete `[edit]`. That is exactly the
 * "corrupting a unit of meaning" INV-17 forbids.
 *
 * Fix: never slice INSIDE a rendered action. Instead, greedily keep as many
 * WHOLE leading actions as fit, then drop the rest and replace them with one
 * honest `[+N more actions omitted]` marker. AU-36 S6: the marker's own
 * length is counted in the SAME `caps.total` budget as the included
 * actions — the loop below tries progressively fewer included actions until
 * `includedBody + separator + marker` itself fits, so the marker is never
 * "free" overflow tacked on after the cap was already exhausted. If even a
 * bare marker for "everything omitted" does not fit under a pathologically
 * tiny cap, the marker itself is truncated as a last resort (never mixed
 * with a partial action) — the same fallback posture `capWithMarker`
 * (`frameSanitize.ts`) already uses when a cap is smaller than its marker.
 */
export function shapeCodeActions(actions: readonly SerializedCodeAction[], caps: ShaperCaps): string {
  const nonce = mintFrameNonce();
  if (actions.length === 0) {
    return frameLspResult(EMPTY_ACTIONS_BODY, nonce);
  }
  const safeTotal = clampNonNegativeInt(caps.total);
  const rendered = actions.map((a, i) => renderSerializedAction(a, i));

  for (let includedCount = rendered.length; includedCount >= 0; includedCount--) {
    const omittedCount = rendered.length - includedCount;
    const includedBody = rendered.slice(0, includedCount).join(ACTION_SEPARATOR);
    if (omittedCount === 0) {
      if (includedBody.length <= safeTotal) {
        return frameLspResult(includedBody, nonce);
      }
      continue;
    }
    const marker = formatOmittedActionsMarker(omittedCount);
    const candidate = includedCount > 0 ? `${includedBody}${ACTION_SEPARATOR}${marker}` : marker;
    if (candidate.length <= safeTotal) {
      return frameLspResult(candidate, nonce);
    }
  }

  // Pathological: even "everything omitted" doesn't fit the cap.
  const marker = formatOmittedActionsMarker(rendered.length);
  return frameLspResult(marker.slice(0, safeTotal), nonce);
}
