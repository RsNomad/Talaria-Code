// nextedit/formats/genericInstruct.test.ts — Job B Task 8 · generic-instruct
// render + render-drift goldens. Every literal below is transcribed from
// Sweep's published eval prompt for base qwen (blog appendix `qwen_prompt.md`,
// quoted verbatim in `docs/research/wave-5.1/05-model-reuse.md` §2.1 —
// re-verified against https://blog.sweep.dev/posts/oss-next-edit at
// write-time — see the implementation's own doc comment + the commit
// message for the citation). The golden (`describe('golden prompt')`) pins
// the FULL wire string for a fixed fixture so a one-character token drift
// fails loudly — see the RED-first planted-mutation note in the task
// report for the mechanical proof that this golden actually bites.
import { describe, it, expect } from 'vitest';
import { genericInstructFormat, render } from './genericInstruct';
import type { EditableRegion, NextEditCursor, NextEditRequest, RecentDiff } from '../types';
import type { NextEditModelOutput, RenderedNextEditPrompt, StopReason } from './types';

function region(over: Partial<EditableRegion> & { startLine: number; endLine: number; content: string }): EditableRegion {
  return {
    uri: 'file:///src/example.ts',
    filepath: 'src/example.ts',
    startLine: over.startLine,
    endLine: over.endLine,
    content: over.content,
  };
}

function cursor(line: number, character: number): NextEditCursor {
  return { uri: 'file:///src/example.ts', line, character };
}

// generic-instruct's render consumes no cursor field and no fileContext/
// preEditRegion field at all (§4.4: no cursor marker anywhere in the ChatML
// prompt — the sourced skeleton has no `<|cursor|>`-equivalent token, unlike
// sweep-v2). `cursor`/`changesAboveCursor`/`preEditRegion`/`fileContext` are
// still populated below because `NextEditRequest` requires them, but no test
// varies them to prove a render dependency — there is none.
function makeRequest(params: {
  region: EditableRegion;
  cursor?: NextEditCursor;
  preEditDocText?: string | null;
  docText?: string;
  diffs?: readonly RecentDiff[];
}): NextEditRequest {
  return {
    model: 'qwen2.5-coder:7b',
    cursor: params.cursor ?? cursor(params.region.startLine, 0),
    region: params.region,
    preEditRegion: null,
    fileContext: '',
    docText: params.docText ?? params.region.content,
    preEditDocText: params.preEditDocText ?? null,
    changesAboveCursor: false,
    diffs: params.diffs ?? [],
    docVersion: 1,
  };
}

// ---------------------------------------------------------------------
// The golden fixture: a 3-line region (`{current_section}`), a distinct
// pre-edit whole file (`{original_file}`, proving the fallback chain is
// exercised correctly — this fixture supplies `preEditDocText`, NOT the
// `docText` fallback branch, which gets its own dedicated test below), and
// one recent diff (`{recent_changes}`).
// ---------------------------------------------------------------------

const FILE_PATH = 'src/example.ts';

const REGION_CONTENT = 'function mul(a, b) {\n' + '  return a * b;\n' + '}'; // 3 lines, no trailing newline

const ORIGINAL_FILE =
  'function add(a, b) {\n' +
  '  return a + b;\n' +
  '}\n' +
  '\n' +
  'function mul(a, b) {\n' +
  '  return a * b_OLD;\n' +
  '}\n'; // distinct marker (b_OLD) proves this is NOT region.content

const GOLDEN_DIFF: RecentDiff = {
  uri: 'file:///src/example.ts',
  filepath: FILE_PATH,
  startLine: 4,
  endLine: 6,
  before: 'function mul(a, b) {\n  return a * b_OLD;\n}\n',
  after: 'function mul(a, b) {\n  return a * b;\n}\n',
};

function fixtureReq(): NextEditRequest {
  return makeRequest({
    region: region({ startLine: 4, endLine: 6, content: REGION_CONTENT }),
    cursor: cursor(5, 2),
    preEditDocText: ORIGINAL_FILE,
    diffs: [GOLDEN_DIFF],
  });
}

// Assembled independently from the documented skeleton (05 §2.1), not by
// calling the implementation.
const RECENT_CHANGES = 'original:\n' + GOLDEN_DIFF.before + '\n' + 'updated:\n' + GOLDEN_DIFF.after;

const PREFILL =
  '<|im_start|>assistant\n' +
  "I have inferred the user's intentions and will fully implement the user's changes.\n" +
  '\n' +
  '<code_block>\n';

const EXPECTED_PROMPT =
  '<|im_start|>user\n' +
  "Here are contents of the user's file before any changes were made:\n" +
  '<current_file>\n' +
  `${ORIGINAL_FILE}\n` +
  '</current_file>\n' +
  '\n' +
  'The user recently made the following changes:\n' +
  '\n' +
  '<recent_changes>\n' +
  `${RECENT_CHANGES}\n` +
  '</recent_changes>\n' +
  '\n' +
  "Here's the section to edit:\n" +
  '\n' +
  '<code_block>\n' +
  `${REGION_CONTENT}\n` +
  '</code_block>\n' +
  '\n' +
  'Rewrite <code_block> to help the user finish writing their changes. Respond with only the updated contents of the <code_block>, wrapped in the XML tags.<|im_end|>\n' +
  PREFILL;

describe('golden prompt (render-drift lock — 05 §2.1 / qwen_prompt.md, wire bytes pinned)', () => {
  it('renders the exact pinned wire string for the fixed fixture', () => {
    const r = genericInstructFormat.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toBe(EXPECTED_PROMPT);
  });

  it('prompt ends with the prefill', () => {
    const r = genericInstructFormat.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt.endsWith(r.prompt.prefill)).toBe(true);
  });

  it('prompt ends with the opening <code_block> tag — the prompt ends mid-assistant-turn', () => {
    const r = genericInstructFormat.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt.endsWith('<code_block>\n')).toBe(true);
  });

  it('the prefill matches the pinned value exactly (the assistant turn through <code_block>\\n)', () => {
    const r = genericInstructFormat.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prefill).toBe(PREFILL);
  });
});

describe('sampling params — pinned exactly (task-8-brief.md)', () => {
  it('temperature 0, maxTokens 1024, stop = [</code_block>, <|im_end|>, <|endoftext|>] in that order', () => {
    const r = genericInstructFormat.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.temperature).toBe(0);
    expect(r.prompt.maxTokens).toBe(1024);
    expect(r.prompt.stop).toEqual(['</code_block>', '<|im_end|>', '<|endoftext|>']);
  });
});

describe('the format contract (Task 5 shape)', () => {
  it('id, windowLines, sentinels are pinned exactly', () => {
    expect(genericInstructFormat.id).toBe('generic-instruct');
    expect(genericInstructFormat.windowLines).toBe(10);
    expect(genericInstructFormat.sentinels).toEqual([
      '<|im_start|>',
      '<|im_end|>',
      '<current_file>',
      '<recent_changes>',
      '<code_block>',
      '</code_block>',
    ]);
  });

  it('parse is implemented (Task 9): it no longer throws, and a trivial empty output resolves to no-op', () => {
    const req = fixtureReq();
    const v = genericInstructFormat.parse(
      { text: '', stopReason: 'stop' },
      { prompt: '', prefill: '', stop: [], temperature: 0, maxTokens: 1024 },
      req,
    );
    expect(v).toEqual({ kind: 'no-op' });
  });
});

describe('<code_block> — req.region.content rendered verbatim (the ±10-line window around the cursor, built upstream by anchors.ts; render never re-windows)', () => {
  it('a differently-shaped region (not the golden fixture) renders as the code_block verbatim', () => {
    const req = makeRequest({
      region: region({ startLine: 100, endLine: 101, content: 'const different = "REGION_MARKER";\nconst two = 2;' }),
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain(
      '<code_block>\nconst different = "REGION_MARKER";\nconst two = 2;\n</code_block>',
    );
  });
});

describe('{original_file} — preEditDocText, falling back to docText (05 §2.1 prose: "before any changes were made")', () => {
  it('preEditDocText, when present, is used verbatim for <current_file> — NOT docText', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 0, content: 'X' }),
      preEditDocText: 'PRE_EDIT_MARKER',
      docText: 'CURRENT_DOC_MARKER',
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('<current_file>\nPRE_EDIT_MARKER\n</current_file>');
    expect(r.prompt.prompt).not.toContain('CURRENT_DOC_MARKER');
  });

  it('preEditDocText === null ⇒ falls back to docText (the no-shadow case, 08 §4.4)', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 0, content: 'X' }),
      preEditDocText: null,
      docText: 'CURRENT_DOC_MARKER',
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('<current_file>\nCURRENT_DOC_MARKER\n</current_file>');
  });
});

describe('{recent_changes} — original:/updated: pairs, most-recent-first, whole-pair skip-not-crop under 4000 chars (не нашёл источник for the inner encoding — [вывод], task-8-brief.md)', () => {
  it('a single diff renders as "original:\\n{before}\\nupdated:\\n{after}"', () => {
    const diff: RecentDiff = {
      uri: 'file:///f.ts',
      filepath: 'f.ts',
      startLine: 0,
      endLine: 0,
      before: 'BEFORE_X\n',
      after: 'AFTER_X\n',
    };
    const req = makeRequest({ region: region({ startLine: 0, endLine: 0, content: 'Y' }), diffs: [diff] });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('<recent_changes>\noriginal:\nBEFORE_X\n\nupdated:\nAFTER_X\n\n</recent_changes>');
  });

  it('zero diffs ⇒ an empty <recent_changes> block, not omitted', () => {
    const req = makeRequest({ region: region({ startLine: 0, endLine: 0, content: 'Y' }), diffs: [] });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('<recent_changes>\n\n</recent_changes>');
  });

  it('an oversized pair is absent entirely; a small pair that fits is kept whole (skip-not-crop)', () => {
    const smallDiff: RecentDiff = {
      uri: 'file:///f.ts',
      filepath: 'f.ts',
      startLine: 0,
      endLine: 0,
      before: 'SMALL_MARKER_XYZ old\n',
      after: 'SMALL_MARKER_XYZ new\n',
    };
    const hugeDiff: RecentDiff = {
      uri: 'file:///f.ts',
      filepath: 'f.ts',
      startLine: 1,
      endLine: 1,
      before: 'HUGE_MARKER_XYZ ' + 'x'.repeat(5000) + '\n',
      after: 'HUGE_MARKER_XYZ ' + 'y'.repeat(5000) + '\n',
    };
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 0, content: 'Y' }),
      diffs: [smallDiff, hugeDiff], // most-recent-first: small kept, huge pushed over budget
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('SMALL_MARKER_XYZ');
    expect(r.prompt.prompt).not.toContain('HUGE_MARKER_XYZ');
  });

  it('multiple diffs that fit are joined, most-recent-first (array order preserved)', () => {
    const first: RecentDiff = { uri: 'file:///f.ts', filepath: 'f.ts', startLine: 0, endLine: 0, before: 'FIRST_OLD\n', after: 'FIRST_NEW\n' };
    const second: RecentDiff = { uri: 'file:///f.ts', filepath: 'f.ts', startLine: 1, endLine: 1, before: 'SECOND_OLD\n', after: 'SECOND_NEW\n' };
    const req = makeRequest({ region: region({ startLine: 0, endLine: 0, content: 'Y' }), diffs: [first, second] });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    const firstIdx = r.prompt.prompt.indexOf('FIRST_OLD');
    const secondIdx = r.prompt.prompt.indexOf('SECOND_OLD');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

describe('empty region ⇒ skip (render-time "nothing to send" judgment call, not a vendor rule — mirrors sweepV2 Task 6)', () => {
  it('returns { kind: "skip" }, not a rendered request', () => {
    const req = makeRequest({ region: region({ startLine: 0, endLine: 0, content: '' }) });
    const r = render(req);
    expect(r.kind).toBe('skip');
  });
});

// =======================================================================
// Task 9 — parse. task-9-brief.md / `08-jobB-final-architecture.md` §4.4,
// rules in order:
//   1. stopReason !== 'stop' ⇒ invalid, FIRST and unconditional
//      (09-jobB-final-plan.md Global Constraints, verbatim: "Fail-closed
//      parsing... Every parser also enforces `stopReason === 'stop'`.")
//   2. completion = text up to `</code_block>`, OR the whole text when the
//      runner already stopped ON the tag (the stop string was consumed
//      server-side — its absence with stopReason === 'stop' is NOT
//      malformed, 08 §4.4) — implemented as one STOP_TOKENS trim loop,
//      structurally identical to sweepV2.ts's own (CODE_BLOCK_CLOSE is
//      STOP_TOKENS[0], so "up to the tag" and "whole text when absent"
//      are the SAME algorithm, no special case).
//   3. strip exactly ONE leading '\n' from the completion, if present
//      (task-9-brief.md / 08 §4.4: "the block opened `<code_block>\n`").
//   4. empty/whitespace completion ⇒ no-op — not itself a task-9-brief.md
//      bullet, but the orchestrator's explicit instruction + the SAME
//      "accidental whole-region deletion" danger sweepV2's rule 5 guards
//      against ([вывод], mirrors sweepV2 by direct analogy).
//   5. newText === region.content (byte-exact) ⇒ no-op. NOTE: newText here
//      is the completion ALONE — task-9-brief.md's own Step-1 fixture pins
//      `newText: 'const x = 2;\n'` with NO prefill text prepended, unlike
//      sweepV2's `prefill + completion`. This is because genericInstruct's
//      PREFILL (this module's own const) is ChatML scaffolding through the
//      opening `<code_block>` tag — English instruction-turn prose plus the
//      bare tag — it carries no CODE for a completion to be re-attached to.
//   6. isPureInsertionAboveCursor (formats/shared.ts, Task 5) ⇒ no-op.
//   7. else rewrite, over req.region (never a model-derived region).
//
// A documented, load-bearing DEVIATION from a literal reading of
// task-9-brief.md's own "rules in order" list: the brief separately names
// "no closing tag anywhere AND the stop was not the tag ⇒
// invalid('unterminated-block')" as though it were a THIRD, independently
// reachable rule after rule 1. Read literally, it cannot be: "the stop was
// not the tag" is TAUTOLOGICALLY true whenever stopReason !== 'stop' (a
// matched stop STRING is exactly what makes stopReason 'stop' in the first
// place) — so by the time this check could run, rule 1 has already
// returned invalid for every non-'stop' reason, with no path left for a
// DIFFERENT `kind`. Both task-9-brief.md and 08 §4.4 name a distinct
// 'unterminated-block' reason, so this implementation keeps rule 1 as ONE
// unconditional gate (kind is 'invalid' for every non-'stop' reason, no
// exceptions — satisfying the Global Constraints verbatim) and uses
// "no `</code_block>` anywhere in the RAW output" only to pick the more
// specific, PROVABLE reason string ('unterminated-block') over the general
// one ('length-cap') — never to change `kind`. Flagged for the Opus review
// per the task's own instruction ("this is exactly the kind of branch the
// Opus review must scrutinize").
//
// RED-first: every `it` below was run against the Task-8 stub (which
// unconditionally throws) and failed before `parse` was implemented — see
// the task report for the captured RED output. The dangerous-direction
// tests are placed FIRST in each describe block. Every "well-formed ⇒
// rewrite" test has an explicit "mutate ⇒ invalid/no-op" non-vacuity
// sibling.
// =======================================================================

const out = (text: string, stopReason: StopReason = 'stop'): NextEditModelOutput => ({ text, stopReason });

// `rendered` is unused by this format's parse (see the module doc comment:
// PREFILL carries no code content to reattach) — a placeholder is passed
// everywhere below rather than a real render() result.
const PLACEHOLDER_RENDERED: RenderedNextEditPrompt = { prompt: '', prefill: '', stop: [], temperature: 0, maxTokens: 1024 };

describe('parse — fail-closed: stopReason !== "stop" (09 Global Constraints / 04 §8 rule 1, applied here)', () => {
  // The dangerous direction FIRST: a truncated-but-plausible, PROPERLY
  // CLOSED block must never slip through as `rewrite` just because the
  // text itself looks clean and well-framed.
  it.each([
    ['length', 'invalid'],
    ['unknown', 'invalid'],
  ])('stopReason=%s fails closed to %s, even though the text is a clean, properly closed block', (reason, kind) => {
    const v = genericInstructFormat.parse(out('const x = 2;\n</code_block>', reason as StopReason), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v.kind).toBe(kind);
  });

  it('non-vacuity sibling: the SAME properly-closed text with stopReason="stop" parses to rewrite (the check above is not always-invalid)', () => {
    const v = genericInstructFormat.parse(out('const x = 2;\n</code_block>', 'stop'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v.kind).toBe('rewrite');
  });

  it('reason is "length-cap" when the closing tag IS present despite the non-stop reason, and never leaks the payload text', () => {
    const v = genericInstructFormat.parse(
      out('SECRET_LOOKING_PAYLOAD</code_block>MORE_SECRET', 'length'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v).toEqual({ kind: 'invalid', reason: 'length-cap' });
  });

  it('reason is "unterminated-block" when no closing tag appears anywhere, and never leaks the payload text', () => {
    const v = genericInstructFormat.parse(out('SECRET_LOOKING_PAYLOAD', 'unknown'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'invalid', reason: 'unterminated-block' });
  });
});

describe('parse — instruction-ignored / structurally-off output (task-9-brief.md Step 1, fixture 3)', () => {
  it('missing closing tag with a non-tag stop reason ⇒ invalid (unterminated-block) — the model rambled instead of closing the block', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\n… and here is why: the code', 'unknown'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v).toEqual({ kind: 'invalid', reason: 'unterminated-block' });
  });

  it('documented residual: the SAME rambling text with stopReason="stop" is accepted as rewrite — the one ambiguity task-9-brief.md explicitly carves out (no closing tag + "stop" ⇒ ambiguous-but-legal, matching fixture 2 below); protected only by the region-bounded/two-gesture/undo defense (08 §12), never by this parser', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\n… and here is why: the code', 'stop'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v.kind).toBe('rewrite');
  });
});

describe('parse — extraction: completion up to </code_block>, or the whole text when the tag was consumed server-side (task-9-brief.md Step 1, fixtures 1+2)', () => {
  it('fixture 1: extracts content before </code_block>, no leading newline to strip', () => {
    const v = genericInstructFormat.parse(out('const x = 2;\n</code_block>'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'rewrite', region: fixtureReq().region, newText: 'const x = 2;\n' });
  });

  it('fixture 2: runner stopped ON the tag (tag absent from text) ⇒ accepted, the whole text is the completion', () => {
    const v = genericInstructFormat.parse(out('const x = 2;\n'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v.kind).toBe('rewrite');
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).toBe('const x = 2;\n');
  });

  it('garbage after the closing tag never influences the verdict or reaches newText', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\n</code_block>\nhere is why I made this change: ...'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v.kind).toBe('rewrite');
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).not.toContain('here is why');
    expect(v.newText).toBe('const x = 2;\n');
  });

  it('non-vacuity sibling: WITHOUT the closing tag, that same trailing prose IS part of the completion (proves the extraction is tag-driven, not a content heuristic)', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\nhere is why I made this change: ...'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v.kind).toBe('rewrite');
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).toContain('here is why');
  });

  it('an <|im_end|> remnant is also trimmed even without a </code_block> tag present', () => {
    const v = genericInstructFormat.parse(out('const x = 2;\n<|im_end|>trailing junk'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v.kind).toBe('rewrite');
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).toBe('const x = 2;\n');
  });

  it('an <|endoftext|> remnant is also trimmed', () => {
    const v = genericInstructFormat.parse(out('const x = 2;\n<|endoftext|>trailing junk'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v.kind).toBe('rewrite');
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).toBe('const x = 2;\n');
  });
});

describe('parse — exactly ONE leading newline is stripped (task-9-brief.md / 08 §4.4: "the block opened <code_block>\\n")', () => {
  it('a single leading newline is stripped', () => {
    const v = genericInstructFormat.parse(out('\nconst x = 2;\n</code_block>'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'rewrite', region: fixtureReq().region, newText: 'const x = 2;\n' });
  });

  it('non-vacuity sibling: TWO leading newlines only have ONE stripped, not both (this is exact-one stripping, not a general trim)', () => {
    const v = genericInstructFormat.parse(out('\n\nconst x = 2;\n</code_block>'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'rewrite', region: fixtureReq().region, newText: '\nconst x = 2;\n' });
  });
});

describe('parse — no-op signals', () => {
  it('empty completion ⇒ no-op', () => {
    const v = genericInstructFormat.parse(out('</code_block>'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('whitespace-only completion ⇒ no-op', () => {
    const v = genericInstructFormat.parse(out('   \n  </code_block>'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('reconstructed newText byte-identical to region.content ⇒ no-op', () => {
    const v = genericInstructFormat.parse(out(`${REGION_CONTENT}</code_block>`), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('non-vacuity sibling: change ONE character in that same reproduced block ⇒ rewrite, not no-op (identity check is exact, not fuzzy)', () => {
    const mutated = 'X' + REGION_CONTENT.slice(1);
    const v = genericInstructFormat.parse(out(`${mutated}</code_block>`), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v.kind).toBe('rewrite');
  });

  it('pure insertion above cursor ⇒ no-op (04 §1.5, shared.ts helper — genericInstruct has never rendered a cursor marker, but req.cursor is still available to parse for this filter)', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 2, content: 'aaa\nbbb\nccc\n' }),
      cursor: cursor(1, 0), // start of "bbb"
    });
    const v = genericInstructFormat.parse(out('aaa\nNEW\nbbb\nccc\n</code_block>'), PLACEHOLDER_RENDERED, req);
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('non-vacuity sibling: the cursor LINE itself changes ⇒ rewrite, not no-op (the insertion filter is not over-broad)', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 2, content: 'aaa\nbbb\nccc\n' }),
      cursor: cursor(1, 0),
    });
    const v = genericInstructFormat.parse(out('aaa\nBBB!\nccc\n</code_block>'), PLACEHOLDER_RENDERED, req);
    expect(v.kind).toBe('rewrite');
  });
});

describe('parse — echoed prompt sentinels are DISMISSED, never stripped (Job B Task 9 fix; mirrors sweepV2.ts:338-340\'s <|cursor|>-echo rule, 04-wire-formats.md §8 row 2)', () => {
  // Dangerous direction FIRST: a model echoing one of the prompt's own
  // rendered sentinels back, with a clean stopReason: 'stop', must never
  // slip through as a `rewrite` carrying that raw token into newText.
  it('an echoed <|im_start|> with stopReason "stop" ⇒ invalid(sentinel-echo), not rewrite', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\n<|im_start|>user\nmore stuff\n</code_block>'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v).toEqual({ kind: 'invalid', reason: 'sentinel-echo' });
  });

  it('an echoed <current_file> with stopReason "stop" ⇒ invalid(sentinel-echo), not rewrite', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\n<current_file>\nstuff\n</code_block>'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v).toEqual({ kind: 'invalid', reason: 'sentinel-echo' });
  });

  it('an echoed <recent_changes> with stopReason "stop" ⇒ invalid(sentinel-echo), not rewrite', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\n<recent_changes>\nstuff\n</code_block>'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v).toEqual({ kind: 'invalid', reason: 'sentinel-echo' });
  });

  it('an echoed OPENING <code_block> with stopReason "stop" ⇒ invalid(sentinel-echo), not rewrite', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\n<code_block>\nstuff\n</code_block>'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v).toEqual({ kind: 'invalid', reason: 'sentinel-echo' });
  });

  it('non-vacuity sibling: the SAME shape of output WITHOUT the echoed sentinel parses to rewrite (proves the check discriminates, is not always-invalid)', () => {
    const v = genericInstructFormat.parse(
      out('const x = 2;\nmore stuff\n</code_block>'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v.kind).toBe('rewrite');
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).toBe('const x = 2;\nmore stuff\n');
  });

  it('the reason is a machine token, not the payload — never echoes the matched sentinel or surrounding text', () => {
    const v = genericInstructFormat.parse(
      out('SECRET_LOOKING_PAYLOAD<current_file>MORE_SECRET</code_block>'),
      PLACEHOLDER_RENDERED,
      fixtureReq(),
    );
    expect(v).toEqual({ kind: 'invalid', reason: 'sentinel-echo' });
  });

  it('the STOP_TOKENS themselves (<|im_end|>, </code_block>) do NOT trigger the echo check — the happy path is unaffected', () => {
    // A normal response that legitimately stopped on </code_block>: the
    // trim loop consumes the tag before the echo check ever runs, so this
    // must still be `rewrite`, never falsely flagged as sentinel-echo.
    const v = genericInstructFormat.parse(out('const x = 2;\n</code_block>'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v).toEqual({ kind: 'rewrite', region: fixtureReq().region, newText: 'const x = 2;\n' });
  });

  it('an <|im_end|> remnant (already trimmed by rule 2) does not trigger the echo check either', () => {
    const v = genericInstructFormat.parse(out('const x = 2;\n<|im_end|>trailing junk'), PLACEHOLDER_RENDERED, fixtureReq());
    expect(v.kind).toBe('rewrite');
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).toBe('const x = 2;\n');
  });
});

describe('parse — a rewrite always targets the SAME region the request carried, never a model-derived one', () => {
  it('the returned region equals req.region, unchanged', () => {
    const req = fixtureReq();
    const v = genericInstructFormat.parse(out('const x = 2;\n</code_block>'), PLACEHOLDER_RENDERED, req);
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.region).toEqual(req.region);
  });
});
