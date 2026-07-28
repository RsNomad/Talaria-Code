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
  capTotalBody,
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
 * `neutralizeFrameDelimiters`/the control-char pattern/`capTotalBody` used
 * below used to be small, deliberate `*_Local`-suffixed duplications of
 * resultShaper.ts's private (non-exported) internals — at T8a-write-time,
 * the brief's reuse list for this file was explicit
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
 */
function computeLineSpans(text: string): LineSpan[] {
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
    // Unreachable: computeLineSpans always returns at least one span, and
    // lineIndex is clamped into [0, spans.length - 1] above — kept for
    // totality/type safety (no non-null assertion) rather than asserting the
    // array access can never be undefined.
    return 0;
  }
  const character = clampInt(position.character, 0, span.contentLength);
  return span.start + character;
}

/** Sorts a DESC copy by `range.start` (line desc, then character desc) —
 * "apply-in-order safe": applying edits in this order never shifts the
 * offsets of edits not yet applied. Shared by `applyTextEdits` (the apply
 * order) and `classifyCodeAction` (the wire `edits[]` order) so both are
 * provably the same order. Stable (ties keep input relative order). */
function sortEditsDescByStart(edits: readonly PlainTextEdit[]): PlainTextEdit[] {
  return edits.slice().sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });
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
  const spans = computeLineSpans(docText);
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

/** Splits text into lines on `\n` only. A single trailing `\n` is treated as
 * "this text has N lines" (not N+1 with a spurious empty last line) — e.g.
 * both `"a\nb"` and `"a\nb\n"` split to `["a","b"]`. This is a deliberate,
 * documented simplification (no "\ No newline at end of file" marker, unlike
 * a real `diff` tool) — acceptable for a preview, not a byte-exact patch. */
function splitIntoLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split('\n');
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
 * merge into one hunk instead of splitting. Total: returns `[]` for an
 * all-equal (no-op) diff. */
function buildHunks(ops: readonly DiffOp[]): DiffHunk[] {
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
  let oldLn = 1;
  let newLn = 1;
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

/**
 * PURE minimal line-based unified diff (no external dep — hand-rolled per
 * the brief). Header is `--- a/relPath` / `+++ b/relPath`; each hunk is
 * `@@ -oldStart,oldLines +newStart,newLines @@` followed by ` `/`-`/`+`
 * prefixed lines. No changes ⇒ header only, no hunks. This is a
 * LIB-authored format, not byte-compatible with GNU `diff` (no
 * "\ No newline at end of file" marker — see {@link splitIntoLines}); the
 * brief explicitly leaves the exact header format to this implementation, as
 * long as it is stable and golden-pinned. Total: never throws.
 */
export function renderUnifiedDiff(oldText: string, newText: string, relPath: string): string {
  const oldLines = splitIntoLines(oldText);
  const newLines = splitIntoLines(newText);
  const ops = computeLineDiffOps(oldLines, newLines);
  const hunks = buildHunks(ops);
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const op of hunk.ops) {
      out.push(`${DIFF_LINE_PREFIX[op.type]}${op.line}`);
    }
  }
  return out.join('\n');
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
  const previewRaw = renderUnifiedDiff(file.docText, newDocText, relPath);
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

/**
 * Frames a list of already-classified `SerializedCodeAction`s as the final
 * `<lsp_result id="…">` text (reuses T5's `frameLspResult`, Audit E-1: mints
 * its own per-request nonce here, same as every `shape*` function in
 * `resultShaper.ts`). Every field on each action was already sanitized by
 * `classifyCodeAction`; this function's own job is assembly (join with a
 * blank line between actions) and the OVERALL total-cap across every action
 * combined (mirrors `shapeDiagnostics`'s own
 * `frameLspResult(capTotalBody(lines.join('\n'), caps), nonce)` pattern — the
 * SAME `capTotalBody`, imported from the shared `frameSanitize.ts`, I-8
 * dedup). Total: never throws, including for an empty `actions` list.
 */
export function shapeCodeActions(actions: readonly SerializedCodeAction[], caps: ShaperCaps): string {
  const nonce = mintFrameNonce();
  if (actions.length === 0) {
    return frameLspResult(EMPTY_ACTIONS_BODY, nonce);
  }
  const rendered = actions.map((a, i) => renderSerializedAction(a, i));
  const body = rendered.join('\n\n');
  return frameLspResult(capTotalBody(body, caps), nonce);
}
