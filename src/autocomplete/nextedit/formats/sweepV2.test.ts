// nextedit/formats/sweepV2.test.ts — Job B Task 6 · sweep-next-edit-v2-7B
// render + render-drift goldens. Every literal below is transcribed from
// `04-wire-formats.md` §1.2/§1.4 (re-verified against `inference.py` at
// write-time — see the implementation's own doc comment + the commit
// message for the citation). The golden (`describe('golden prompt')`)
// pins the FULL wire string for a fixed fixture so a one-character token
// drift fails loudly — see the RED-first planted-mutation note in the
// task report for the mechanical proof that this golden actually bites.
import { describe, it, expect } from 'vitest';
import { sweepV2Format, render } from './sweepV2';
import type { EditableRegion, NextEditCursor, NextEditRequest, RecentDiff } from '../types';
import type { NextEditModelOutput, RenderedNextEditPrompt, StopReason } from './types';

const FILE_SEP = '<|file_sep|>';
const CURSOR_TOKEN = '<|cursor|>';

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

function makeRequest(params: {
  region: EditableRegion;
  cursor: NextEditCursor;
  changesAboveCursor?: boolean;
  preEditRegion?: string | null;
  diffs?: readonly RecentDiff[];
  fileContext?: string;
}): NextEditRequest {
  return {
    model: 'sweep-next-edit-v2-7B',
    cursor: params.cursor,
    region: params.region,
    preEditRegion: params.preEditRegion ?? null,
    fileContext: params.fileContext ?? '',
    docText: params.region.content,
    preEditDocText: null,
    changesAboveCursor: params.changesAboveCursor ?? false,
    diffs: params.diffs ?? [],
    docVersion: 1,
  };
}

// ---------------------------------------------------------------------
// The golden fixture (Step 1 of the brief): a 12-line region, one diff.
// The cursor sits on the REGION'S OWN FIRST LINE with
// `changesAboveCursor: true` — the ONLY combination under `04` §1.4's
// `compute_prefill` that can ever produce a non-empty prefill NOT ending
// in '\n' (the default branch's `rfind('\n')+1` construction always
// either returns '' or a string ending exactly at a '\n'; the
// `changesAboveCursor` branch only avoids a trailing '\n' when the
// prefix never leaves the cursor's own first line). This is not an
// arbitrary choice: it is the only fixture shape that can make the
// mandatory "prompt ends with the prefill, no trailing newline" wire
// invariant true, so the golden is built around it deliberately.
// ---------------------------------------------------------------------

const FILE_PATH = 'src/example.ts';

const REGION_CONTENT =
  '  return a - b;\n' +
  '}\n' +
  '\n' +
  'function mul(a, b) {\n' +
  '  return a * b;\n' +
  '}\n' +
  '\n' +
  'function div(a, b) {\n' +
  '  return a / b;\n' +
  '}\n' +
  '\n' +
  '// end of file'; // 12 lines (region-relative 0..11), no trailing newline

const FILE_CONTEXT =
  '// full file context (±150 lines)\n' +
  'function add(a, b) {\n' +
  '  return a + b;\n' +
  '}\n';

const GOLDEN_DIFF: RecentDiff = {
  uri: 'file:///src/example.ts',
  filepath: FILE_PATH,
  startLine: 8, // 0-based inclusive -> wire 9
  endLine: 9, // 0-based inclusive -> wire 10
  before: 'function mul(a, b) {\n  return a*b;\n',
  after: 'function mul(a, b) {\n  return a * b;\n',
};

function fixtureReq(): NextEditRequest {
  return makeRequest({
    region: region({ startLine: 5, endLine: 16, content: REGION_CONTENT }), // 12 lines, 0-based 5..16
    cursor: cursor(5, 2), // region's own first line (5 === region.startLine), char 2 (after the 2-space indent)
    changesAboveCursor: true,
    preEditRegion: null, // exercises the documented fallback (04 §1.3 / 08 §4.3)
    diffs: [GOLDEN_DIFF],
    fileContext: FILE_CONTEXT,
  });
}

// Assembled independently from the documented skeleton (04 §1.2), not by
// calling the implementation. `\n` placement below has been derived by
// hand from the verbatim PROMPT_TEMPLATE/DIFF_FORMAT triple-quoted
// strings (see the module doc comment in sweepV2.ts) — every '+' below
// corresponds to one literal '\n' the Python template inserts between
// fields, no more, no less.
const RECENT_CHANGES =
  `${FILE_SEP}${FILE_PATH}:9:10\n` + 'original:\n' + GOLDEN_DIFF.before + '\n' + 'updated:\n' + GOLDEN_DIFF.after;

const CODE_BLOCK_WITH_CURSOR = '  ' + CURSOR_TOKEN + 'return a - b;\n' + REGION_CONTENT.slice('  return a - b;\n'.length);

const PREFILL = '  '; // changesAboveCursor branch: first line's own prefix only, no '\n' yet

const EXPECTED_PROMPT =
  `${FILE_SEP}${FILE_PATH}\n` + // line 1 of PROMPT_TEMPLATE
  `${FILE_CONTEXT}\n` + // {initial_file}{retrieval_results='' } + template's own '\n'
  `${RECENT_CHANGES}\n` + // {recent_changes} + template's own '\n'
  `${FILE_SEP}original/${FILE_PATH}:6:17\n` + // start=5+1, end=16+1
  `${REGION_CONTENT}\n` + // {prev_section} (fallback = region.content) + '\n'
  `${FILE_SEP}current/${FILE_PATH}:6:17\n` +
  `${CODE_BLOCK_WITH_CURSOR}\n` +
  `${FILE_SEP}updated/${FILE_PATH}:6:17\n` +
  PREFILL; // prompt ENDS here, no trailing '\n'

describe('golden prompt (render-drift lock — 04 §1.2/§1.4, wire bytes pinned)', () => {
  it('renders the exact pinned wire string for the fixed fixture', () => {
    const r = sweepV2Format.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toBe(EXPECTED_PROMPT);
  });

  it('prompt ends with the prefill, with no trailing newline', () => {
    const r = sweepV2Format.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt.endsWith(r.prompt.prefill)).toBe(true);
    expect(r.prompt.prompt.endsWith('\n')).toBe(false);
  });

  it('the prefill matches the pinned value exactly', () => {
    const r = sweepV2Format.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prefill).toBe(PREFILL);
  });
});

describe('sampling params — pinned exactly (04 §1.1)', () => {
  it('temperature 0, maxTokens 1024, stop = [endoftext, file_sep] in that order', () => {
    const r = sweepV2Format.render(fixtureReq());
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.temperature).toBe(0);
    expect(r.prompt.maxTokens).toBe(1024);
    expect(r.prompt.stop).toEqual(['<|endoftext|>', '<|file_sep|>']);
  });
});

describe('line ranges are 1-based inclusive (04 §1.2)', () => {
  it('region {startLine:40, endLine:60} renders header ":41:61"', () => {
    const req = makeRequest({
      region: region({ startLine: 40, endLine: 60, content: 'irrelevant content\n' }),
      cursor: cursor(40, 0),
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain(':41:61');
    // and it appears on all three of original/current/updated
    expect(r.prompt.prompt).toContain(`${FILE_SEP}original/src/example.ts:41:61`);
    expect(r.prompt.prompt).toContain(`${FILE_SEP}current/src/example.ts:41:61`);
    expect(r.prompt.prompt).toContain(`${FILE_SEP}updated/src/example.ts:41:61`);
  });
});

describe('cursor on the region first line', () => {
  it('changesAboveCursor=false ⇒ empty prefill (04 §1.4 default-branch early return, "legal, not a bug")', () => {
    const req = makeRequest({
      region: region({
        startLine: 2,
        endLine: 4,
        content: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
      }),
      cursor: cursor(2, 6), // region.startLine === cursor.line
      changesAboveCursor: false,
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prefill).toBe('');
  });
});

describe('changesAboveCursor=true — 04 §1.4 True branch', () => {
  it('prefills the first line plus only the immediately-following blank lines, not the cursor line', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 4, content: 'aaa\n\n\nbbb\nccc\n' }),
      cursor: cursor(3, 0), // start of "bbb", after two blank lines
      changesAboveCursor: true,
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    // first line "aaa\n" + the two blank lines' own '\n's, "bbb" itself excluded
    expect(r.prompt.prefill).toBe('aaa\n\n\n');
  });
});

describe('diff pairs render whole-or-skipped under the char budget (skip-not-crop)', () => {
  it('an oversized pair is absent entirely; a small pair that fits is kept whole', () => {
    const smallDiff: RecentDiff = {
      uri: 'file:///src/example.ts',
      filepath: FILE_PATH,
      startLine: 0,
      endLine: 0,
      before: 'SMALL_MARKER_XYZ old\n',
      after: 'SMALL_MARKER_XYZ new\n',
    };
    const hugeDiff: RecentDiff = {
      uri: 'file:///src/example.ts',
      filepath: FILE_PATH,
      startLine: 1,
      endLine: 1,
      before: 'HUGE_MARKER_XYZ ' + 'x'.repeat(5000) + '\n',
      after: 'HUGE_MARKER_XYZ ' + 'y'.repeat(5000) + '\n',
    };
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 0, content: 'line\n' }),
      cursor: cursor(0, 0),
      diffs: [smallDiff, hugeDiff], // most-recent-first: small kept, huge pushed over budget
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('SMALL_MARKER_XYZ');
    expect(r.prompt.prompt).not.toContain('HUGE_MARKER_XYZ');
  });
});

describe('cursor splice — the correct character offset within the region', () => {
  it('places <|cursor|> at character 0', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 1, content: 'aaaa\nbbbb\n' }),
      cursor: cursor(0, 0),
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('<|cursor|>aaaa\nbbbb\n');
  });

  it('places <|cursor|> at character 2 (mid-line)', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 1, content: 'aaaa\nbbbb\n' }),
      cursor: cursor(0, 2),
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prompt).toContain('aa<|cursor|>aa\nbbbb\n');
  });
});

describe('prev_section (original/) — 04 §1.3 anomaly, both branches sourced', () => {
  it('preEditRegion, when present, is used VERBATIM for original/ — not the region fallback', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 0, content: 'NEW_TEXT_MARKER\n' }),
      cursor: cursor(0, 0),
      preEditRegion: 'OLD_TEXT_MARKER\n',
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    const originalBlock = r.prompt.prompt.split(`${FILE_SEP}original/src/example.ts:1:1\n`)[1]?.split(`${FILE_SEP}current/`)[0];
    // preEditRegion ('OLD_TEXT_MARKER\n') + the template's own mandatory
    // '\n' separator after {prev_section} — not tidied away (same
    // non-normalizing behaviour as DIFF_FORMAT's double-newline case in
    // the golden fixture).
    expect(originalBlock).toBe('OLD_TEXT_MARKER\n\n');
  });

  it('preEditRegion null ⇒ falls back to the CURRENT region text (04 §1.3: the vendor reference literal behaviour)', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 0, content: 'CURRENT_TEXT_MARKER\n' }),
      cursor: cursor(0, 0),
      preEditRegion: null,
    });
    const r = render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    const originalBlock = r.prompt.prompt.split(`${FILE_SEP}original/src/example.ts:1:1\n`)[1]?.split(`${FILE_SEP}current/`)[0];
    expect(originalBlock).toBe('CURRENT_TEXT_MARKER\n\n');
  });
});

describe('empty region ⇒ skip (render-time "nothing to send" judgment call, not a vendor rule)', () => {
  it('returns { kind: "skip" }, not a rendered request', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 0, content: '' }),
      cursor: cursor(0, 0),
    });
    const r = render(req);
    expect(r.kind).toBe('skip');
  });
});

describe('the format contract (Task 5 shape)', () => {
  it('id, windowLines, sentinels are pinned exactly', () => {
    expect(sweepV2Format.id).toBe('sweep-v2');
    expect(sweepV2Format.windowLines).toBe(10);
    expect(sweepV2Format.sentinels).toEqual(['<|file_sep|>', '<|cursor|>', '<|endoftext|>']);
  });

  it('parse is implemented (Task 7): it no longer throws, and a trivial empty output resolves to no-op', () => {
    const req = fixtureReq();
    const v = sweepV2Format.parse(
      { text: '', stopReason: 'stop' },
      { prompt: '', prefill: '', stop: [], temperature: 0, maxTokens: 1024 },
      req,
    );
    expect(v).toEqual({ kind: 'no-op' });
  });
});

// =======================================================================
// Task 7 — parse. Every rule below is `08-jobB-final-architecture.md`
// §4.3's numbered list (itself `04-wire-formats.md` §1.6 + §8, consolidated)
// and `09-jobB-final-plan.md`'s Global Constraints ("Fail-closed parsing.
// Malformed ⇒ dismiss. Every parser also enforces `stopReason === 'stop'`.")
// — in order:
//   1. stopReason !== 'stop' ⇒ invalid('length-cap')
//   2. stop-token remnants trimmed at the first occurrence (STOP_TOKENS order)
//   3. <|cursor|> echoed in the (trimmed) output ⇒ invalid('cursor-echo') —
//      dismissed, NEVER stripped (04 §8 row 2)
//   4. reconstruct newText = prefill + completion (completion excludes prefill)
//   5. empty/whitespace completion ⇒ no-op
//   6. newText === region.content (byte-exact) ⇒ no-op
//   7. isPureInsertionAboveCursor ⇒ no-op
//   8. else rewrite, over req.region (never a model-derived region)
//
// RED-first: every `it` below was run against the Task-6 stub (which
// unconditionally throws) and failed before `parse` was implemented — see
// the task report for the captured RED output. The dangerous-direction
// tests (a malformed output slipping through as `rewrite`) are placed
// FIRST in each describe block, per the task's own instruction. Every
// "well-formed ⇒ rewrite" test has an explicit "mutate one token ⇒
// invalid/no-op" sibling so the parser is proven not to be vacuously
// always-accepting.
// =======================================================================

function renderFixture(): RenderedNextEditPrompt {
  const r = sweepV2Format.render(fixtureReq());
  if (r.kind !== 'rendered') throw new Error('expected rendered');
  return r.prompt;
}

const out = (text: string, stopReason: StopReason = 'stop'): NextEditModelOutput => ({ text, stopReason });

describe('parse — fail-closed: stopReason !== "stop" (04 §8 rule 1 / 09 Global Constraints)', () => {
  // The dangerous direction FIRST: a truncated-but-plausible rewrite must
  // NEVER slip through as `rewrite` just because the text itself looks clean.
  it.each([
    ['length', 'invalid'],
    ['unknown', 'invalid'],
  ])('stopReason=%s fails closed to %s, even though the text looks like a clean rewrite', (reason, kind) => {
    const v = sweepV2Format.parse(
      out('fine text, looks like a clean rewrite', reason as StopReason),
      renderFixture(),
      fixtureReq(),
    );
    expect(v.kind).toBe(kind);
  });

  it('stopReason="length" carries a short machine reason, never the raw model text', () => {
    const v = sweepV2Format.parse(out('SECRET_LOOKING_PAYLOAD', 'length'), renderFixture(), fixtureReq());
    expect(v).toEqual({ kind: 'invalid', reason: 'length-cap' });
  });

  it('non-vacuity sibling: the SAME text with stopReason="stop" parses to rewrite (the check above is not always-invalid)', () => {
    const v = sweepV2Format.parse(out('fine text, looks like a clean rewrite', 'stop'), renderFixture(), fixtureReq());
    expect(v.kind).toBe('rewrite');
  });
});

describe('parse — the happy path, and its one-token-mutated malformed sibling', () => {
  it('reconstructs prefill + completion (the completion excludes the prefill — 04 §1.6)', () => {
    const v = sweepV2Format.parse(out('  return b;\n}\n'), renderFixture(), fixtureReq());
    expect(v).toEqual({
      kind: 'rewrite',
      region: fixtureReq().region,
      newText: renderFixture().prefill + '  return b;\n}\n',
    });
  });

  it('non-vacuity sibling: append an echoed <|cursor|> to that SAME well-formed text ⇒ invalid, not a guessed rewrite', () => {
    const v = sweepV2Format.parse(out('  return b;\n}\n' + CURSOR_TOKEN), renderFixture(), fixtureReq());
    expect(v.kind).toBe('invalid');
  });
});

describe('parse — echoed <|cursor|> is DISMISSED, never stripped (04 §8 row 2)', () => {
  it('a cursor marker anywhere in the output ⇒ invalid (dangerous direction: must not silently strip-and-accept)', () => {
    const v = sweepV2Format.parse(out('a' + CURSOR_TOKEN + 'b'), renderFixture(), fixtureReq());
    expect(v.kind).toBe('invalid');
  });

  it('the reason is a machine token, not the payload — never echoes the matched text', () => {
    const v = sweepV2Format.parse(out('a' + CURSOR_TOKEN + 'b'), renderFixture(), fixtureReq());
    expect(v).toEqual({ kind: 'invalid', reason: 'cursor-echo' });
  });
});

describe('parse — no-op signals (04 §1.6 points 3/4, §1.5)', () => {
  it('empty completion ⇒ no-op', () => {
    const v = sweepV2Format.parse(out(''), renderFixture(), fixtureReq());
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('whitespace-only completion ⇒ no-op', () => {
    const v = sweepV2Format.parse(out('   \n  '), renderFixture(), fixtureReq());
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('reconstructed block byte-identical to region.content ⇒ no-op', () => {
    const completionReproducingTheRest = REGION_CONTENT.slice(PREFILL.length);
    const v = sweepV2Format.parse(out(completionReproducingTheRest), renderFixture(), fixtureReq());
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('non-vacuity sibling: change ONE character in that same reproduced block ⇒ rewrite, not no-op (identity check is exact, not fuzzy)', () => {
    const completionOffByOneChar = 'X' + REGION_CONTENT.slice(PREFILL.length + 1);
    const v = sweepV2Format.parse(out(completionOffByOneChar), renderFixture(), fixtureReq());
    expect(v.kind).toBe('rewrite');
  });

  it('pure insertion above cursor ⇒ no-op (04 §1.5, shared.ts helper ported with the relativeCursor===0 guard)', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 2, content: 'aaa\nbbb\nccc\n' }),
      cursor: cursor(1, 0), // start of "bbb"
      changesAboveCursor: false,
    });
    const r = sweepV2Format.render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    expect(r.prompt.prefill).toBe('aaa\n'); // sanity check against shared.test.ts's own known-good fixture math

    const v = sweepV2Format.parse(out('NEW\nbbb\nccc\n'), r.prompt, req);
    expect(v).toEqual({ kind: 'no-op' });
  });

  it('non-vacuity sibling: the cursor LINE itself changes ⇒ rewrite, not no-op (the insertion filter is not over-broad)', () => {
    const req = makeRequest({
      region: region({ startLine: 0, endLine: 2, content: 'aaa\nbbb\nccc\n' }),
      cursor: cursor(1, 0),
      changesAboveCursor: false,
    });
    const r = sweepV2Format.render(req);
    if (r.kind !== 'rendered') throw new Error('expected rendered');
    const v = sweepV2Format.parse(out('BBB!\nccc\n'), r.prompt, req);
    expect(v.kind).toBe('rewrite');
  });
});

describe('parse — stop-token remnants trimmed at the first occurrence, in STOP_TOKENS order (04 §1.6)', () => {
  it('trims at the first stop-token remnant before judging (garbage after the stop token never influences the verdict)', () => {
    const v = sweepV2Format.parse(out('body\n<|file_sep|>garbage'), renderFixture(), fixtureReq());
    expect(v.kind).toBe('rewrite');
  });

  it('the TRIMMED text, not the raw text, is what a rewrite carries — the garbage never reaches newText', () => {
    const v = sweepV2Format.parse(out('body\n<|file_sep|>garbage'), renderFixture(), fixtureReq());
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).not.toContain('garbage');
    expect(v.newText).toBe(renderFixture().prefill + 'body\n');
  });

  it('an endoftext remnant is also trimmed', () => {
    const v = sweepV2Format.parse(out('  return b;\n}\n<|endoftext|>trailing junk'), renderFixture(), fixtureReq());
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.newText).toBe(renderFixture().prefill + '  return b;\n}\n');
  });
});

describe('parse — a rewrite always targets the SAME region the request carried, never a model-derived one', () => {
  it('the returned region equals req.region, unchanged', () => {
    const req = fixtureReq();
    const v = sweepV2Format.parse(out('  return b;\n}\n'), renderFixture(), req);
    if (v.kind !== 'rewrite') throw new Error('expected rewrite');
    expect(v.region).toEqual(req.region);
  });
});
