// nextedit/formats/genericInstruct.ts — Job B Task 8 (RENDER only; parse is
// Task 9). The Generic source: `qwen2.5-coder:7b` again, on the FIM
// endpoint, emulating next-edit via an INSTRUCT prompt — NOT sweep-v2's
// format (falsehood #6, `05-model-reuse.md` §2.2: base qwen was NOT scored
// in its pretraining format; the artefact that scored 55.62% is ChatML +
// XML tags + an English instruction + an assistant prefill). This module
// shares NO rendering code with `sweepV2.ts` — it is a third, independent
// format (`05` §2.3's table).
//
// Every literal below is transcribed verbatim from Sweep's published eval
// prompt for base qwen — blog appendix `qwen_prompt.md`, quoted in full in
// `docs/research/wave-5.1/05-model-reuse.md` §2.1 (itself sourced from
// https://blog.sweep.dev/posts/oss-next-edit, "Appendix → Prompt
// Construction") — RE-VERIFIED against that same URL at write-time (see the
// shipping commit message for the re-verification note). This exact prompt
// is also transcribed independently in `08-jobB-final-architecture.md` §4.4
// and `.superpowers/sdd/task-8-brief.md`; all three agree byte-for-byte
// WITH EACH OTHER — which is not the same as agreeing with the published
// artefact. Two details are NOT verifiable and must not be described as
// verbatim (`G-vendor-spec-audit.md` §4):
//   1. Whether the published prompt ends `<code_block>` or `<code_block>\n`.
//      The only published copy is a rendered fenced block, and that renderer
//      strips exactly one trailing newline from every block on the page
//      (0 trailing empty line-spans across all 10 blocks) — so the HTML
//      CANNOT answer it. **не нашёл источник.**
//   2. The prompt's six blank lines render as a single SPACE in the published
//      artefact, not as empty lines; ours are empty. A control on the sibling
//      post shows the renderer does preserve that distinction, so it is a
//      content signal. **не нашёл источник** for whether the spaces were in
//      the eval harness or entered via the blog's MDX — deliberately left
//      alone as a beta lever (`08` §6.3), not changed here. The
//      trailing-newline risk is bounded either way: `parse` strips exactly
//      one leading '\n' from the completion, so both conventions parse
//      identically.
// `<|im_start|>` (151644) / `<|im_end|>` (151645) are verified special
// tokens in the base qwen tokenizer, which also ships a full ChatML
// `chat_template` (`04-wire-formats.md` §4.1; `05` §2.4).
//
// Field-by-field object construction only, no spread — this file lives
// under `src/autocomplete/` and is in scope for `ringBuffer.test.ts`'s
// repo-wide `SPREAD_RE`/`CAST_RE` purity guards.
import type { EditableRegion, NextEditCursor, NextEditRequest, NextEditVerdict, RecentDiff } from '../types';
import type { NextEditFormat, NextEditModelOutput, NextEditRenderResult, RenderedNextEditPrompt } from './types';
import { isPureInsertionAboveCursor } from './shared';

// The five literal control/XML tokens the sourced prompt uses. Also this
// format's `sentinels` (task-8-brief.md, exact order) — the egress mint
// rejects any request-side content containing these.
const IM_START = '<|im_start|>';
const IM_END = '<|im_end|>';
const CURRENT_FILE_OPEN = '<current_file>';
const RECENT_CHANGES_OPEN = '<recent_changes>';
const CODE_BLOCK_OPEN = '<code_block>';
const CODE_BLOCK_CLOSE = '</code_block>';

// task-8-brief.md: `stops ['</code_block>', '<|im_end|>', '<|endoftext|>']`
// — this exact order. `<|im_start|>`/`<|im_end|>` are verified qwen special
// tokens (`04` §4.1); `<|endoftext|>` is qwen's EOS (same source). The
// closing XML tag as a stop string is [вывод] from the prompt's own framing
// ("Respond with only the updated contents of the <code_block>, wrapped in
// the XML tags") — unlike sweep-v2, there is no `inference.py`-equivalent
// script for this prompt to read a literal vendor STOP_TOKENS list from.
const STOP_TOKENS = [CODE_BLOCK_CLOSE, IM_END, '<|endoftext|>'] as const;
// task-8-brief.md: `maxTokens: 1024`.
const MAX_TOKENS = 1024;
// task-8-brief.md / `08` §4.4: `windowLines: 10` — the same ±10-line window
// shape the 55.62% figure was measured on (`05` §2.1's `<code_block>` is
// the ~21-line block, not a whole file). Exposed for the shell (a later
// task) to build `req.region` via `anchors.ts`'s `regionAroundCursor`; this
// module never recomputes the window itself, it only renders whatever
// `req.region` already carries — same convention as `sweepV2.ts`.
const WINDOW_LINES = 10;
// `08` §4.3's sweep-v2 diff budget, reused here for the SAME "don't let one
// oversized diff crowd out the whole recent-changes section" rationale
// (`01-arch-and-pattern.md` §4.6's skip-not-crop precedent). Not itself
// re-derived from any qwen_prompt.md source — the appendix quotes the
// prompt's FRAME, not a fill budget for `{recent_changes}`.
const DIFF_CHAR_BUDGET = 4000;

// The assistant turn is entirely fixed scaffolding text — task-8-brief.md:
// "the prompt ENDS mid-assistant-turn; `prefill` = the assistant turn's
// text through `<code_block>\n`." No request field is substituted into it.
const PREFILL =
  `${IM_START}assistant\n` +
  `I have inferred the user's intentions and will fully implement the user's changes.\n` +
  `\n` +
  `${CODE_BLOCK_OPEN}\n`;

/**
 * One `{recent_changes}` entry. task-8-brief.md: "most-recent-first
 * `original:\n{before}\nupdated:\n{after}` pairs" — **не нашёл источник**
 * for the inner encoding: `qwen_prompt.md`'s appendix quotes the prompt's
 * FRAME (the `<recent_changes>` tags), not what fills them; there is no
 * `inference.py`-equivalent script for this prompt the way sweep-v2 has
 * one. `[вывод]`: this shape is the same `original:`/`updated:` prose the
 * SAME vendor documents for its own sweep-v1 script
 * (`04-wire-formats.md` §2.2's `build_prompt`), reused here for
 * consistency — no `<|file_sep|>{path}:{s}:{e}` header, because that token
 * belongs to sweep-v2's dialect, not this one (`05` §2.3: "shares no
 * rendering code with sweepV2").
 */
function renderDiffPair(diff: RecentDiff): string {
  return `original:\n${diff.before}\nupdated:\n${diff.after}`;
}

/**
 * `{recent_changes}` — most-recent-first (Task 2's diff-pairs ring is
 * already most-recent-first BY CONSTRUCTION — `req.diffs` is consumed in
 * the order it arrives, never re-sorted here, mirroring `sweepV2.ts`'s own
 * `renderRecentChanges`), whole-pair skip-not-crop under
 * `DIFF_CHAR_BUDGET`: STOP (not skip-and-continue) at the first pair that
 * would push the running total over budget, never crop a pair's own text.
 *
 * The separator joining MULTIPLE kept pairs is SOURCED
 * (`G-vendor-spec-audit.md` §3): the vendor's v1 reference builds the
 * prompt as a flat parts list and returns `"\n".join(prompt_parts)`, so
 * consecutive diff blocks are separated by exactly one `'\n'` —
 * https://huggingface.co/sweepai/sweep-next-edit-1.5B/blob/main/run_model.py
 * Corroborated by the training-format block in
 * https://blog.sweep.dev/posts/oss-next-edit which shows two consecutive
 * diff blocks with no separator line between them.
 *
 * Scope, stated honestly: both sources are v1-generation. v2's
 * `inference.py` takes `recent_changes` as a pre-formatted caller string,
 * so v2 publishes no join of its own; carrying v1's is inference from the
 * same vendor's executable code for the immediately preceding model in the
 * same family with the same block shape. The INNER encoding of each pair
 * (`renderDiffPair` above) remains **не нашёл источник** — that is a
 * separate gap, and `run_model.py` cannot close it because it documents a
 * different prompt.
 */
function renderRecentChanges(diffs: readonly RecentDiff[]): string {
  const blocks: string[] = [];
  let usedChars = 0;
  for (const diff of diffs) {
    const block = renderDiffPair(diff);
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
 * `05-model-reuse.md` §2.1, verbatim (re-verified against
 * https://blog.sweep.dev/posts/oss-next-edit at write-time — see the
 * shipping commit message):
 *
 *   <|im_start|>user
 *   Here are contents of the user's file before any changes were made:
 *   <current_file>
 *   {original_file}
 *   </current_file>
 *
 *   The user recently made the following changes:
 *
 *   <recent_changes>
 *   {recent_changes}
 *   </recent_changes>
 *
 *   Here's the section to edit:
 *
 *   <code_block>
 *   {current_section}
 *   </code_block>
 *
 *   Rewrite <code_block> to help the user finish writing their changes.
 *   Respond with only the updated contents of the <code_block>, wrapped in
 *   the XML tags.<|im_end|>
 *   <|im_start|>assistant
 *   I have inferred the user's intentions and will fully implement the
 *   user's changes.
 *
 *   <code_block>
 *
 * (each line break above IS a literal '\n' in the wire string). The prompt
 * ENDS at the opening `<code_block>` tag of the assistant turn — the model
 * continues generation from there; `prompt.endsWith(prefill)` is a locked
 * invariant (`formats/types.ts`, Task 5).
 */
export function render(req: NextEditRequest): NextEditRenderResult {
  const { region } = req;

  if (region.content.length === 0) {
    // NOT a vendor rule — a render-time judgment call ([вывод], mirroring
    // sweepV2.ts's identical choice): an empty window carries no
    // `<code_block>` content worth sending, and every possible model output
    // would be a guaranteed no-op round trip.
    return { kind: 'skip', reason: 'empty-region' };
  }

  // task-8-brief.md: "{original_file} = req.preEditDocText ?? req.docText —
  // the file BEFORE the recent changes (05 §2.1 verbatim: 'before any
  // changes were made'); the fallback covers the no-shadow case (documented
  // in-module, 08 §4.4)." When the edit tracker has recorded no pre-edit
  // shadow (no changes yet, or a shadow was never captured), rendering the
  // CURRENT text as "before" degrades the prompt's own claim but keeps the
  // shape well-formed rather than sending an empty/missing section.
  const originalFile = req.preEditDocText ?? req.docText;
  // task-8-brief.md: "{current_section} = req.region.content (the ±10
  // window — the block shape the 55.62% was measured on)." Render never
  // re-windows; `req.region` arrives already sliced by the shell (a later
  // task, via anchors.ts's regionAroundCursor) — same convention sweepV2.ts
  // uses for its own `region.content`.
  const currentSection = region.content;
  const recentChanges = renderRecentChanges(req.diffs);

  const head =
    `${IM_START}user\n` +
    `Here are contents of the user's file before any changes were made:\n` +
    `${CURRENT_FILE_OPEN}\n` +
    `${originalFile}\n` +
    `</current_file>\n` +
    `\n` +
    `The user recently made the following changes:\n` +
    `\n` +
    `${RECENT_CHANGES_OPEN}\n` +
    `${recentChanges}\n` +
    `</recent_changes>\n` +
    `\n` +
    `Here's the section to edit:\n` +
    `\n` +
    `${CODE_BLOCK_OPEN}\n` +
    `${currentSection}\n` +
    `${CODE_BLOCK_CLOSE}\n` +
    `\n` +
    `Rewrite ${CODE_BLOCK_OPEN} to help the user finish writing their changes. Respond with only the updated contents of the ${CODE_BLOCK_OPEN}, wrapped in the XML tags.${IM_END}\n`;

  const prompt = head + PREFILL;

  return {
    kind: 'rendered',
    prompt: {
      prompt,
      prefill: PREFILL,
      stop: STOP_TOKENS,
      temperature: 0,
      maxTokens: MAX_TOKENS,
    },
  };
}

/**
 * Splits `text` into lines, each retaining its own trailing '\n' (the final
 * chunk's terminator is omitted when the text has none). A local twin of
 * `formats/shared.ts`'s private `splitLinesKeepingTerminators` and
 * `sweepV2.ts`'s own `splitKeepingNewlines` — Task 5's module is frozen and
 * does not export it, and `sweepV2.ts` owns its private copy for the same
 * "two different jobs need the identical split" reason (its own doc
 * comment). This file's render (Task 8) never needed cursor placement at
 * all — `05` §2.3: no cursor marker anywhere in the ChatML prompt — so
 * there was no prior copy here; parse (Task 9) is the first consumer.
 * Duplicated on purpose rather than reaching into a sibling task's frozen
 * file or another format module's private helper.
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
 * Character offset of `cursor` within `region.content` (UTF-16 code units)
 * — needed here only for `isPureInsertionAboveCursor`'s `relativeCursor`
 * parameter (Task 9's own rule; the render half never computes this).
 * Structurally identical to `sweepV2.ts`'s own `relativeCursorOffset`
 * (same clamp-at-each-edge fail-closed style — an out-of-window cursor
 * degrades to the nearest in-bounds offset rather than throwing).
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

// task-9-brief.md's echo-dismissal set (Job B Task 9 fix, Opus-review-
// flagged) — the four sentinels this format renders OUTSIDE the
// STOP_TOKENS set. Reuses the module's existing named consts (above); no
// duplicate literals. `IM_END` and `CODE_BLOCK_CLOSE` are deliberately
// EXCLUDED — those are STOP_TOKENS, the happy-path stop markers, already
// consumed by the trim loop in `parse` before this set is ever checked.
const ECHO_SENTINELS = [IM_START, CURRENT_FILE_OPEN, RECENT_CHANGES_OPEN, CODE_BLOCK_OPEN] as const;

/**
 * task-9-brief.md / `08-jobB-final-architecture.md` §4.4, rules in order —
 * PLUS one echo-dismissal rule this doc comment used to (wrongly) claim
 * didn't apply here (corrected by Job B Task 9's own fix, Opus-review-
 * flagged): this format never renders sweep-v2's `<|cursor|>` marker (`05`
 * §2.3), so THAT one signal really is absent — but it renders FIVE of its
 * OWN sentinels (`<|im_start|>`, `<|im_end|>`, `<current_file>`,
 * `<recent_changes>`, `<code_block>`/`</code_block>`), and the model
 * echoing any of the four NON-stop ones back into its output is exactly the
 * same danger sweep-v2's cursor-echo rule guards against — see rule 3,
 * below:
 *
 *   1. `stopReason !== 'stop'` ⇒ `invalid`, FIRST and unconditional
 *      (09-jobB-final-plan.md Global Constraints, verbatim: "Fail-closed
 *      parsing... Every parser also enforces `stopReason === 'stop'`.") A
 *      truncated generation is the same "syntactically plausible,
 *      dangerously truncated" shape `sweepV2.ts`'s rule 1 guards against
 *      (`04` §8 rule 1). The REASON string chosen within this unconditional
 *      branch is a refinement only — `kind` is `'invalid'` either way, no
 *      exception. Both task-9-brief.md and `08` §4.4 separately name a
 *      distinct `'unterminated-block'` reason ("no closing tag anywhere AND
 *      the stop was not the tag"), but read literally that condition is
 *      unreachable as an INDEPENDENT rule after this one: "the stop was not
 *      the tag" is tautologically true whenever `stopReason !== 'stop'` (a
 *      matched stop STRING is exactly what makes `stopReason` `'stop'` in
 *      the first place) — so by the time a third, separate check could run,
 *      every non-`'stop'` reason has already exited here, with no path left
 *      for a different `kind`. This implementation resolves that
 *      (Opus-review-flagged, per the task's own instruction) tension by
 *      keeping ONE unconditional gate and using "no `</code_block>`
 *      anywhere in the RAW output" only to pick the more specific, provable
 *      reason (`'unterminated-block'`) over the general one
 *      (`'length-cap'`) — never to change `kind`.
 *   2. Stop-token remnants trimmed at the FIRST occurrence, walking
 *      `STOP_TOKENS` in order — the identical algorithm `sweepV2.ts`'s own
 *      `parse` uses (its own doc comment: `04` §1.6's loop, ported
 *      verbatim). Because `CODE_BLOCK_CLOSE` is `STOP_TOKENS[0]`, this trim
 *      loop IS "completion = text up to `</code_block>`"
 *      (task-9-brief.md); because the loop is a no-op when none of the
 *      three tokens appear anywhere, it is ALSO "the whole text when the
 *      runner already stopped ON the tag" (task-9-brief.md's second
 *      fixture) — one algorithm implements both documented behaviours, no
 *      special case needed. `08` §4.4, verbatim: "the stop string is
 *      consumed server-side, so its absence with `stopReason === 'stop'`
 *      is NOT malformed."
 *   3. Any of `ECHO_SENTINELS` (`<|im_start|>`, `<current_file>`,
 *      `<recent_changes>`, the opening `<code_block>`) present anywhere in
 *      the already-trimmed completion ⇒ `invalid('sentinel-echo')` —
 *      DISMISSED, never stripped, mirroring `sweepV2.ts`'s own
 *      `<|cursor|>`-echo rule (`sweepV2.ts:338-340`; `04-wire-formats.md`
 *      §8 row 2's posture — "a prompt sentinel present in the output ⇒
 *      treat as malformed, safer than stripping — never strip" — extended
 *      here by **[вывод]** direct analogy, since row 2 itself only names
 *      v2's single cursor marker, not this format's four-sentinel set).
 *      Runs in the SAME relative position `sweepV2.ts` runs its own check
 *      — immediately after the STOP_TOKENS trim loop (rule 2), before any
 *      other rule — so a legitimately-stopped `</code_block>` or a trimmed
 *      `<|im_end|>` remnant is already gone and can never false-positive
 *      here. `<|im_end|>` and `</code_block>` (the STOP_TOKENS) are
 *      deliberately EXCLUDED from `ECHO_SENTINELS` — they are the happy
 *      path, already handled by rule 2, and dismissing on them here would
 *      break every normal response.
 *   4. Strip exactly ONE leading `'\n'` from the completion, if present
 *      (task-9-brief.md / `08` §4.4: "strip the block's one leading
 *      newline ... the block opened `<code_block>\n`") — some runners
 *      re-emit the newline the prompt's own trailing `<code_block>\n`
 *      already accounts for; stripping every leading blank line would be a
 *      different, unsourced rule, so exactly one is removed, never more.
 *   5. Empty/whitespace completion ⇒ `no-op` — not itself a
 *      task-9-brief.md or `08` §4.4 bullet, but the same
 *      "accidental whole-region deletion" danger `04` §1.6 point 3 /
 *      `sweepV2.ts`'s rule 5 guards against: without this, a degenerate
 *      empty completion would fall through to `rewrite` with
 *      `newText: ''`. **[вывод]**, mirroring `sweepV2.ts` by direct
 *      analogy — the same danger applies to a smaller, non-prefixed
 *      `newText` here.
 *   6. `newText === region.content`, byte-exact ⇒ `no-op`
 *      (task-9-brief.md / `08` §4.4: "`≡ region.content` ⇒ `no-op`").
 *      `newText` here IS the completion alone — NOT `prefill + completion`
 *      as in `sweepV2.ts`. task-9-brief.md's own Step-1 fixture proves
 *      this: the pinned `newText: 'const x = 2;\n'` carries no `PREFILL`
 *      text at all. This is structurally sound: `PREFILL` (this module's
 *      own const, above) is ChatML scaffolding through the opening
 *      `<code_block>` tag — English instruction-turn prose plus the bare
 *      tag — it carries no CODE for a completion to be re-attached to,
 *      unlike sweep-v2's prefill (a real code-prefix substring of the
 *      region itself, `04` §1.4).
 *   7. `isPureInsertionAboveCursor` (`formats/shared.ts`, Task 5) ⇒
 *      `no-op` (task-9-brief.md / `08` §4.4 — "✔ (shared helper)" in the
 *      fail-closed map, `08` §4.5). `relativeCursor` is computed by this
 *      module's own `relativeCursorOffset`, above.
 *   8. Else `rewrite`, over `req.region` — never a model-derived region
 *      (same invariant as `sweepV2.ts`'s final rule).
 */
function parse(output: NextEditModelOutput, _rendered: RenderedNextEditPrompt, req: NextEditRequest): NextEditVerdict {
  if (output.stopReason !== 'stop') {
    const hasClosingTag = output.text.includes(CODE_BLOCK_CLOSE);
    return { kind: 'invalid', reason: hasClosingTag ? 'length-cap' : 'unterminated-block' };
  }

  let completion = output.text;
  for (const stop of STOP_TOKENS) {
    const idx = completion.indexOf(stop);
    if (idx !== -1) {
      completion = completion.slice(0, idx);
    }
  }

  for (const sentinel of ECHO_SENTINELS) {
    if (completion.includes(sentinel)) {
      return { kind: 'invalid', reason: 'sentinel-echo' };
    }
  }

  if (completion.startsWith('\n')) {
    completion = completion.slice(1);
  }

  if (completion.trim() === '') {
    return { kind: 'no-op' };
  }

  const newText = completion;

  if (newText === req.region.content) {
    return { kind: 'no-op' };
  }

  const relativeCursor = relativeCursorOffset(req.region, req.cursor);
  if (isPureInsertionAboveCursor(req.region.content, newText, relativeCursor)) {
    return { kind: 'no-op' };
  }

  return { kind: 'rewrite', region: req.region, newText };
}

export const genericInstructFormat: NextEditFormat = {
  id: 'generic-instruct',
  windowLines: WINDOW_LINES,
  sentinels: [IM_START, IM_END, CURRENT_FILE_OPEN, RECENT_CHANGES_OPEN, CODE_BLOCK_OPEN, CODE_BLOCK_CLOSE],
  render,
  parse,
};
