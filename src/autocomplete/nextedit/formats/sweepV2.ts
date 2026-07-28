// nextedit/formats/sweepV2.ts — Job B Task 6 (RENDER) + Task 7 (PARSE) ·
// sweep-next-edit-v2-7B. Every literal token, the block skeleton, the
// line-number convention, and `compute_prefill`'s two branches are
// transcribed verbatim from `docs/research/wave-5.1/04-wire-formats.md`
// §1.2/§1.4/§1.6/§8, itself read directly out of
// https://huggingface.co/sweepai/sweep-next-edit-v2-7B/blob/main/inference.py
// (`PROMPT_TEMPLATE`, `DIFF_FORMAT`, `compute_prefill`, `STOP_TOKENS`,
// `MAX_NEW_TOKENS`, `do_sample=False`) — RE-VERIFIED against that same
// source at write-time (see the shipping commit message for the
// re-verification note). No literal here is a guess: anything not
// directly sourced is called out below as [вывод] with its own citation.
//
// `parse`'s single governing property (09-jobB-final-plan.md's Global
// Constraints, verbatim): "Fail-closed parsing. Malformed ⇒ dismiss. Every
// parser also enforces `stopReason === 'stop'`." Every branch below RETURNS
// before the next rule runs — there is no fallthrough that could let a
// later "looks fine" check paper over an earlier failed one.
//
// Field-by-field object construction only, no spread — this file lives
// under `src/autocomplete/` and is in scope for `ringBuffer.test.ts`'s
// repo-wide `SPREAD_RE`/`CAST_RE` purity guards.
import type { EditableRegion, NextEditCursor, NextEditRequest, NextEditVerdict, RecentDiff } from '../types';
import type { NextEditFormat, NextEditModelOutput, NextEditRenderResult, RenderedNextEditPrompt } from './types';
import { isPureInsertionAboveCursor } from './shared';

const FILE_SEP = '<|file_sep|>';
const CURSOR_TOKEN = '<|cursor|>';
const ENDOFTEXT = '<|endoftext|>';
// `04` §1.1/§1.6: `STOP_TOKENS = ["<|endoftext|>", "<|file_sep|>"]` — this
// exact order (endoftext first).
const STOP_TOKENS = [ENDOFTEXT, FILE_SEP] as const;
// `04` §1.1: `MAX_NEW_TOKENS = 1024`.
const MAX_TOKENS = 1024;
// `04` §1.1/§1.2: `num_lines_before/after = 10` — exposed for the shell
// (a later task) to build `req.region` via `anchors.ts`'s
// `regionAroundCursor`; this module never recomputes the window itself,
// it only renders whatever `req.region` already carries.
const WINDOW_LINES = 10;
// `08` §4.3 / `01-arch-and-pattern.md` §4.6: the 4,000-char `recent_changes`
// budget. The exact number is carried from the architecture doc's design
// (not itself re-derived from `inference.py`, which this pass did not find
// a client-side history budget in at all — the vendor script takes
// `recent_diffs` as a caller-supplied list with no internal cap).
const DIFF_CHAR_BUDGET = 4000;

/**
 * Splits `text` into lines, each retaining its own trailing '\n' (the final
 * chunk's terminator is omitted when the text has none). A local twin of
 * `formats/shared.ts`'s private `splitLinesKeepingTerminators` — Task 5's
 * module is frozen and does not export that helper, and this file needs
 * the identical "line, keep terminator" contract for two different jobs
 * (`relativeCursorOffset`'s line lookup, and `computePrefill`'s
 * `changesAboveCursor` branch, which ports `04` §1.4's own
 * `code_block[:relative_cursor].splitlines(True)`). Duplicated on purpose
 * rather than reaching into a sibling task's frozen file.
 */
function splitKeepingNewlines(text: string): string[] {
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
 */
function relativeCursorOffset(region: EditableRegion, cursor: NextEditCursor): number {
  const lines = splitKeepingNewlines(region.content);
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
 * Ports `04` §1.4 `compute_prefill`, BOTH branches, verbatim in shape:
 *
 *   def compute_prefill(code_block, relative_cursor, changes_above_cursor=False):
 *       if changes_above_cursor:
 *           prefill = code_block[:relative_cursor]
 *           prefilled_lines = prefill.splitlines(True)
 *           NUM_LINES_ABOVE = 1
 *           before_split = "".join(prefilled_lines[:NUM_LINES_ABOVE])
 *           after_split = "".join(prefilled_lines[NUM_LINES_ABOVE:])
 *           for char in after_split:
 *               if char == "\n": before_split += "\n"
 *               else: break
 *           return before_split
 *       else:
 *           prefix_before_cursor = code_block[:relative_cursor]
 *           if "\n" not in prefix_before_cursor:
 *               return ""
 *           prefill_end = prefix_before_cursor.rfind("\n") + 1
 *           return code_block[:prefill_end]
 *
 * `codeBlock` is the UNSPLICED region text (never the `<|cursor|>`-carrying
 * variant) and `relativeCursor` is the SAME character offset used to
 * splice the cursor marker — the vendor reference reuses one value for
 * both jobs (`code_block[:relative_cursor]` appears at both call sites)
 * and this port does too. The default branch's `""` early return is
 * documented by `04` as "legal, not a bug": a cursor on the block's first
 * line yields an empty prefill.
 */
function computePrefill(codeBlock: string, relativeCursor: number, changesAboveCursor: boolean): string {
  if (changesAboveCursor) {
    const prefix = codeBlock.slice(0, relativeCursor);
    const prefixLines = splitKeepingNewlines(prefix);
    const NUM_LINES_ABOVE = 1;
    let beforeSplit = prefixLines.slice(0, NUM_LINES_ABOVE).join('');
    const afterSplit = prefixLines.slice(NUM_LINES_ABOVE).join('');
    for (const ch of afterSplit) {
      if (ch === '\n') {
        beforeSplit += '\n';
      } else {
        break;
      }
    }
    return beforeSplit;
  }

  const prefixBeforeCursor = codeBlock.slice(0, relativeCursor);
  if (!prefixBeforeCursor.includes('\n')) {
    return '';
  }
  const prefillEnd = prefixBeforeCursor.lastIndexOf('\n') + 1;
  return codeBlock.slice(0, prefillEnd);
}

/**
 * `04` §1.2 `DIFF_FORMAT`, verbatim:
 *
 *   DIFF_FORMAT = """<|file_sep|>{file_path}:{start_line}:{end_line}
 *   original:
 *   {old_code}
 *   updated:
 *   {new_code}"""
 *
 * — one recent-change entry. Line numbers use the SAME 1-based-inclusive
 * convention as the main skeleton's `:{start}:{end}` header ([вывод]: `04`
 * only states this convention for the region header explicitly, but
 * `DIFF_FORMAT` uses the identical `{start_line}:{end_line}` field names,
 * and `RecentDiff.startLine/endLine` follow the same 0-based-inclusive
 * internal convention as every other `LineRange`-shaped field in this
 * codebase — `nextedit/types.ts`'s own doc comment).
 *
 * C-4 — and they are OLD-DOCUMENT coordinates: they index the document as it
 * was before that change, while `{initial_file}` in the same prompt is the
 * CURRENT text. The two therefore do not share a coordinate space. That is
 * accepted, not a defect to fix here: this header labels a `before`/`after`
 * pair the model reads as history, and the vendor format offers no way to
 * express "where this used to be" other than the numbers of the time. Do not
 * "align" these with `{initial_file}` — they are not the same axis.
 */
function renderDiffBlock(diff: RecentDiff): string {
  const start = diff.startLine + 1;
  const end = diff.endLine + 1;
  return `${FILE_SEP}${diff.filepath}:${start}:${end}\noriginal:\n${diff.before}\nupdated:\n${diff.after}`;
}

/**
 * `{recent_changes}` — most-recent-first (Task 2's diff-pairs ring is
 * already most-recent-first BY CONSTRUCTION —
 * `context/ringBuffer.ts`'s own doc comment: "most-recently-recorded
 * first"; `08-jobB-final-architecture.md` §9.1 — so `req.diffs` is
 * consumed in the order it arrives, never re-sorted here), whole-pair
 * skip-not-crop under `DIFF_CHAR_BUDGET`: mirrors
 * `context/mode.ts`'s `injectSnippetsAsComments` (`:86-94`) — STOP (not
 * skip-and-continue) at the first pair that would push the running total
 * over budget, never crop a pair's own text
 * (`01-arch-and-pattern.md` §4.6's "mirror injectSnippetsAsComments'
 * skip-not-crop rationale").
 *
 * Kept pairs are joined by a single '\n'. SOURCED
 * (`G-vendor-spec-audit.md` §3): the vendor's v1 reference builds the
 * prompt as a flat parts list and returns `"\n".join(prompt_parts)`, so
 * consecutive diff blocks are separated by exactly one '\n' —
 * https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py
 * Corroborated by the training-format block in
 * https://blog.sweep.dev/posts/oss-next-edit which shows two consecutive
 * diff blocks with no separator line between them.
 *
 * Scope, stated honestly: both sources are v1-generation. v2's
 * `inference.py` takes `recent_changes` as a pre-formatted caller string,
 * so v2 publishes no join of its own; carrying v1's is inference from the
 * same vendor's executable code for the immediately preceding model in the
 * same family with the same block shape.
 */
function renderRecentChanges(diffs: readonly RecentDiff[]): string {
  const blocks: string[] = [];
  let usedChars = 0;
  for (const diff of diffs) {
    const block = renderDiffBlock(diff);
    const addedChars = block.length + (blocks.length > 0 ? 1 : 0); // +1 for the '\n' join, once there's a prior block
    if (usedChars + addedChars > DIFF_CHAR_BUDGET) {
      break;
    }
    blocks.push(block);
    usedChars += addedChars;
  }
  return blocks.join('\n');
}

/**
 * `04` §1.2 `PROMPT_TEMPLATE`, verbatim (re-verified against
 * https://huggingface.co/sweepai/sweep-next-edit-v2-7B/blob/main/inference.py
 * at write-time):
 *
 *   <|file_sep|>{file_path}
 *   {initial_file}{retrieval_results}
 *   {recent_changes}
 *   <|file_sep|>original/{file_path}:{start_line}:{end_line}
 *   {prev_section}
 *   <|file_sep|>current/{file_path}:{start_line}:{end_line}
 *   {code_block}
 *   <|file_sep|>updated/{file_path}:{start_line}:{end_line}
 *   {prefill}
 *
 * (each Python source line break above IS a literal '\n' in the wire
 * string — the prompt has no line breaks beyond these). `{retrieval_results}`
 * is ALWAYS '' here (v1 never populates retrieval — `04` §1.2) and sits
 * adjacent to `{initial_file}` with NO separator, exactly as the template
 * shows. The prompt ENDS at `{prefill}` — no trailing newline is ever
 * appended beyond what `{prefill}` itself contains.
 */
export function render(req: NextEditRequest): NextEditRenderResult {
  const { region } = req;

  if (region.content.length === 0) {
    // NOT a vendor rule — a render-time judgment call ([вывод]): an empty
    // window carries no `original/current/updated` text worth sending,
    // and every possible model output would be a guaranteed no-op round
    // trip. `NextEditRenderResult`'s `'skip'` branch exists exactly for
    // this "quiet no-request" case (`formats/types.ts`).
    return { kind: 'skip', reason: 'empty-region' };
  }

  const filePath = region.filepath;
  const startLine = region.startLine + 1; // 04 §1.2: 0-based-inclusive internal -> 1-based-inclusive wire
  const endLine = region.endLine + 1;

  const relativeCursor = relativeCursorOffset(region, req.cursor);
  const codeBlockWithCursor =
    region.content.slice(0, relativeCursor) + CURSOR_TOKEN + region.content.slice(relativeCursor);
  const prefill = computePrefill(region.content, relativeCursor, req.changesAboveCursor);

  // ADR-018 / `G-vendor-spec-audit.md` §1: `original/` is the PRE-EDIT block.
  // Three sources agree — the v2 model card ("Code block around cursor before
  // the last edit"), the blog's published TRAINING format
  // (`contents_prior_to_most_recent_change`), and v1's `run_model.py`, which
  // takes `original_content` and `current_content` as SEPARATE parameters.
  // The reference `inference.py` assigns `prev_section = code_block` only
  // because its `build_prompt` has no parameter a pre-edit block could come
  // from — a demo's limitation, not a specification.
  //
  // So this fallback is a DEGRADED path (no shadow ⇒ nothing better to send),
  // NOT "the vendor reference's literal behaviour" as it was previously
  // described.
  const prevSection = req.preEditRegion ?? region.content;

  const recentChanges = renderRecentChanges(req.diffs);
  const retrievalResults = ''; // 04 §1.2: always empty in v1.

  const prompt =
    `${FILE_SEP}${filePath}\n` +
    `${req.fileContext}${retrievalResults}\n` +
    `${recentChanges}\n` +
    `${FILE_SEP}original/${filePath}:${startLine}:${endLine}\n` +
    `${prevSection}\n` +
    `${FILE_SEP}current/${filePath}:${startLine}:${endLine}\n` +
    `${codeBlockWithCursor}\n` +
    `${FILE_SEP}updated/${filePath}:${startLine}:${endLine}\n` +
    `${prefill}`;

  return {
    kind: 'rendered',
    prompt: {
      prompt,
      prefill,
      stop: STOP_TOKENS,
      temperature: 0,
      maxTokens: MAX_TOKENS,
    },
  };
}

/**
 * `04-wire-formats.md` §1.6 + §8 (rules 1, 2, 6, 7, 9) /
 * `08-jobB-final-architecture.md` §4.3 (this exact numbered list, which is
 * itself `04`'s rules consolidated in application order) — every rule below
 * is sourced, none invented:
 *
 *   1. `stopReason !== 'stop'` ⇒ `invalid('length-cap')`, no exceptions.
 *      A length-capped generation is truncated mid-rewrite — it is
 *      SYNTACTICALLY PLAUSIBLE (it looks like a valid partial block), which
 *      is exactly why it is the most dangerous shape to let through (`04`
 *      §2.3 ①, the sweep-v1 mass-deletion lesson this project treats as
 *      canonical even though `04` documented it on a sibling model).
 *   2. Stop-token remnants trimmed at the first occurrence, walking
 *      `STOP_TOKENS` in order — `04` §1.6's own loop, ported verbatim:
 *      `for stop in STOP_TOKENS: if stop in completion: completion =
 *      completion[:completion.index(stop)]`.
 *   3. `<|cursor|>` present anywhere in the (already-trimmed) output ⇒
 *      `invalid('cursor-echo')` — DISMISSED, never stripped (`04` §8 row 2:
 *      "the marker is in the input; nothing guarantees the model won't emit
 *      it ... treat presence as malformed, safer than stripping").
 *   4. Reconstruct the full updated block as `prefill + completion` — the
 *      runner's `completion` EXCLUDES the prefill by construction (`04`
 *      §1.6: `new_tokens = outputs[0][inputs["input_ids"].shape[1]:]`);
 *      reversing this order would duplicate or drop the region's head.
 *   5. Empty/whitespace completion ⇒ `no-op` (`04` §1.6 point 3).
 *   6. Reconstructed block `===` `region.content`, byte-exact, no trim ⇒
 *      `no-op` (`04` §1.6 point 4).
 *   7. `isPureInsertionAboveCursor` (`formats/shared.ts`, Task 5 — already
 *      ported with the vendor's own `relativeCursor === 0` guard, `04`
 *      §1.5) ⇒ `no-op`.
 *   8. Else `rewrite`, over `req.region` — the SAME region the request
 *      carried. Region coordinates come from the request, never from the
 *      model's output: the model only ever rewrites the region it was
 *      GIVEN, so there is nothing to "locate" in the response.
 */
function parse(output: NextEditModelOutput, rendered: RenderedNextEditPrompt, req: NextEditRequest): NextEditVerdict {
  if (output.stopReason !== 'stop') {
    return { kind: 'invalid', reason: 'length-cap' };
  }

  let completion = output.text;
  for (const stop of STOP_TOKENS) {
    const idx = completion.indexOf(stop);
    if (idx !== -1) {
      completion = completion.slice(0, idx);
    }
  }

  if (completion.includes(CURSOR_TOKEN)) {
    return { kind: 'invalid', reason: 'cursor-echo' };
  }

  const newText = rendered.prefill + completion;

  if (completion.trim() === '') {
    return { kind: 'no-op' };
  }

  if (newText === req.region.content) {
    return { kind: 'no-op' };
  }

  const relativeCursor = relativeCursorOffset(req.region, req.cursor);
  if (isPureInsertionAboveCursor(req.region.content, newText, relativeCursor)) {
    return { kind: 'no-op' };
  }

  return { kind: 'rewrite', region: req.region, newText };
}

export const sweepV2Format: NextEditFormat = {
  id: 'sweep-v2',
  windowLines: WINDOW_LINES,
  // 09-jobB-final-plan.md Task 6: sentinels: ['<|file_sep|>', '<|cursor|>', '<|endoftext|>'] — exact order.
  sentinels: [FILE_SEP, CURSOR_TOKEN, ENDOFTEXT],
  render,
  parse,
};
