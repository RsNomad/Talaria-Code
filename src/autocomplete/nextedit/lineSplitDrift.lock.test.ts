/**
 * W5.2 — the five-copy drift lock (final-review A-1).
 *
 * Five private copies of split-lines-keeping-terminators exist across the
 * next-edit surface. They agree today; NOTHING tied them. The architecture
 * lens ranked that #2 for next-wave pain, precisely worded:
 *
 *   "the first eol fix must land in five places and nothing fails when it
 *    lands in four"
 *
 * This file is the thing that fails when it lands in four.
 *
 * It deliberately does NOT consolidate them: those modules were frozen
 * per-task on purpose (`sweepV2.ts:49-56`, `genericInstruct.ts:220-229` both
 * say so), and merging would couple five modules that were decoupled on
 * purpose. Tying them costs nothing and keeps them independent.
 *
 * The lock extracts each function from SOURCE and evaluates it, so it cannot
 * be satisfied by a re-export or by a helper that only looks similar.
 *
 * Implementer's note (deviation from the brief's literal listing, kept and
 * explained rather than silently "fixed"): the brief's own `extractSplitter`
 * feeds the extracted BODY straight to `new Function('text', body)`. Every
 * one of the five copies declares `const lines: string[] = [];` inside that
 * body — a TypeScript type annotation — and the native `Function`
 * constructor is a plain-JS parser with no TypeScript awareness, so that
 * verbatim approach throws `SyntaxError: Missing initializer in const
 * declaration` on ALL FIVE copies, including the reference. Confirmed by
 * running the brief's code byte-for-byte before changing anything (see the
 * task report). Fixed by transpiling the extracted FUNCTION TEXT (signature
 * included, so parameter/return type annotations are also handled) through
 * the project's own `typescript` compiler (`ts.transpileModule`, already a
 * devDependency — no new dependency added) before constructing the
 * callable. This still extracts each function from SOURCE and evaluates it
 * — transpilation only strips type syntax, it does not alter runtime
 * behaviour, so the lock's core property (comparing the five copies'
 * ACTUAL behaviour) is unchanged.
 *
 * Attribution fix (independent-review finding, kept and explained rather
 * than silently patched): the per-probe comparison originally treated
 * `COPIES[0]` (`formats/shared.ts`) as a privileged reference and compared
 * the other four against it with `toEqual`, which throws on the FIRST
 * mismatch. When `shared.ts` itself was the copy that drifted, every
 * failure blamed whichever non-reference copy came first in iteration
 * order (`formats/sweepV2.ts`) — detection was fine, attribution was not,
 * and attribution is this file's entire reason to exist. Fixed by
 * `diagnoseDrift` below: with five peers and no privileged reference, the
 * only honest signal is which copies agree with each other and which one
 * stands apart. It groups the five outputs, names the minority as outliers
 * when a strict majority (more than 2 of 5) agrees, and says plainly that
 * no majority exists — rather than guessing at a scapegoat — when the
 * split is too even to attribute. See the in-memory synthetic tests below
 * (which exercise the attribution logic directly, without touching disk)
 * and the task report for the real five-file break/revert proof.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { must } from '../../testing/must';

const REPO_SRC = join(__dirname, '..', '..');

const COPIES: ReadonlyArray<{ label: string; file: string; fn: string }> = [
  { label: 'formats/shared.ts', file: 'autocomplete/nextedit/formats/shared.ts', fn: 'splitLinesKeepingTerminators' },
  { label: 'formats/sweepV2.ts', file: 'autocomplete/nextedit/formats/sweepV2.ts', fn: 'splitKeepingNewlines' },
  { label: 'formats/genericInstruct.ts', file: 'autocomplete/nextedit/formats/genericInstruct.ts', fn: 'splitKeepingNewlines' },
  { label: 'nextedit/shell.vscode.ts', file: 'autocomplete/nextedit/shell.vscode.ts', fn: 'splitKeepingNewlines' },
  { label: 'context/editTrackerAdapter.ts', file: 'autocomplete/context/editTrackerAdapter.ts', fn: 'splitKeepingNewlines' },
];

/** Pulls `function <name>(text: string): string[] { … }` out of the source and
 *  builds a callable from its full declaration text (signature + body), so
 *  that TypeScript syntax anywhere in it (e.g. `const lines: string[] = []`)
 *  goes through the real TS compiler rather than a plain-JS `Function`
 *  parser. Throws loudly if the shape moved — a silently-unfound function
 *  would make this whole file vacuous. */
function extractSplitter(file: string, fn: string): (text: string) => string[] {
  const source = readFileSync(join(REPO_SRC, file), 'utf8');
  const start = source.indexOf(`function ${fn}(`);
  if (start === -1) throw new Error(`drift lock setup: ${fn} not found in ${file}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`drift lock setup: could not close ${fn} in ${file}`);
  const fnText = source.slice(start, end);
  const { outputText } = ts.transpileModule(fnText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  });
  // Deliberate dynamic Function construction, not a lint suppression — this
  // repo has no ESLint config or devDependency (no .eslintrc*/eslint.config.*,
  // nothing named "eslint" in package.json), so a `no-new-func` directive
  // here would suppress nothing. This is the mechanism the whole lock
  // depends on: it evaluates each copy's SOURCE text directly, which is
  // what makes the lock unsatisfiable by a re-export or lookalike helper.
  return new Function(`${outputText}\nreturn ${fn};`)() as (text: string) => string[];
}

/**
 * Pure, in-memory grouping over already-computed outputs — no file I/O, no
 * privileged reference. With five peers and no ground truth for which one
 * is "correct", the only honest signal is which copies agree with each
 * other and which stand apart:
 *
 * - All outputs identical → returns `null` (no drift).
 * - A strict majority (more than 2 of the 5) share one output → returns a
 *   message naming the minority OUTLIER(S) relative to that majority. This
 *   is what correctly blames `COPIES[0]` when IT is the one that drifted,
 *   instead of always blaming whichever non-reference copy happens to be
 *   compared first.
 * - No group has a strict majority (e.g. a 2-2-1 split, or all five
 *   different) → says so explicitly and lists every group, rather than
 *   picking an arbitrary scapegoat the evidence doesn't support.
 */
function diagnoseDrift(results: ReadonlyArray<{ label: string; output: string[] }>): string | null {
  const groups = new Map<string, string[]>(); // serialized output -> labels that produced it
  for (const r of results) {
    const key = JSON.stringify(r.output);
    const existing = groups.get(key);
    if (existing) existing.push(r.label);
    else groups.set(key, [r.label]);
  }
  if (groups.size === 1) return null;

  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const topLabels = must(entries[0])[1];

  if (topLabels.length > results.length / 2) {
    const outliers = entries.slice(1).flatMap(([, labels]) => labels);
    const verb = outliers.length === 1 ? 'disagrees' : 'disagree';
    return (
      `${outliers.join(', ')} ${verb} with the majority (${topLabels.join(', ')}), which agree with each ` +
      'other. No copy is treated as a privileged reference — this is a majority/outlier reading, not a ' +
      'comparison against a fixed baseline.'
    );
  }

  const clusters = entries.map(([, labels]) => `[${labels.join(', ')}]`).join(' vs ');
  return (
    `no majority: the five copies split into ${entries.length} disagreeing groups with none over half — ` +
    `${clusters}. Cannot single out one copy as "the" drifted one from this input alone.`
  );
}

const CORPUS: ReadonlyArray<{ name: string; input: string }> = [
  { name: 'empty string', input: '' },
  { name: 'single line, no terminator', input: 'alpha' },
  { name: 'single line with trailing \\n', input: 'alpha\n' },
  { name: 'two lines, no trailing terminator', input: 'alpha\nbeta' },
  { name: 'two lines, trailing terminator', input: 'alpha\nbeta\n' },
  { name: 'CRLF throughout', input: 'alpha\r\nbeta\r\n' },
  { name: 'mixed CRLF and LF', input: 'alpha\r\nbeta\ngamma\r\n' },
  { name: 'lone CR (old-Mac)', input: 'alpha\rbeta' },
  { name: 'consecutive blank lines', input: 'alpha\n\n\nbeta\n' },
  { name: 'leading blank line', input: '\nalpha\n' },
  { name: 'only newlines', input: '\n\n\n' },
  { name: 'trailing whitespace before terminator', input: 'alpha   \nbeta\t\n' },
];

describe('A-1 drift lock: five private line-splitters must agree byte-for-byte', () => {
  it('setup: all five are found and are really five DISTINCT source locations', () => {
    const files = new Set(COPIES.map((c) => c.file));
    expect(files.size, 'the corpus must cover five distinct files, not one file five times').toBe(5);
    for (const copy of COPIES) {
      expect(() => extractSplitter(copy.file, copy.fn), `${copy.label} could not be extracted`).not.toThrow();
    }
  });

  it('setup: the corpus really discriminates (a constant function would fail it)', () => {
    const firstCopy = must(COPIES[0]);
    const reference = extractSplitter(firstCopy.file, firstCopy.fn);
    const outputs = new Set(CORPUS.map((c) => JSON.stringify(reference(c.input))));
    expect(outputs.size, 'a corpus that maps every input to one output would rubber-stamp anything').toBeGreaterThan(6);
  });

  for (const probe of CORPUS) {
    it(`all five agree on: ${probe.name}`, () => {
      const results = COPIES.map((copy) => ({
        label: copy.label,
        output: extractSplitter(copy.file, copy.fn)(probe.input),
      }));

      // Round-trip property: joining a copy's OWN output must reproduce the
      // input exactly. This is what "keeping terminators" MEANS, it is
      // checked per-copy (no reference needed), and on its own it already
      // names a copy that drops/duplicates characters correctly and
      // unambiguously — the majority/outlier reading below is for the
      // harder case where a copy still round-trips but partitions the text
      // differently than its peers (e.g. extra/misplaced split points).
      for (const r of results) {
        expect(r.output.join(''), `${r.label} does not round-trip on ${JSON.stringify(probe.input)}`).toBe(
          probe.input,
        );
      }

      const diagnosis = diagnoseDrift(results);
      if (diagnosis !== null) {
        throw new Error(
          `DRIFT on ${probe.name} (${JSON.stringify(probe.input)}): ${diagnosis} An eol/newline-semantics ` +
            'change landed in some copies and not others — that is exactly the failure this lock exists to name.',
        );
      }
    });
  }
});

describe('diagnoseDrift: majority/outlier attribution (in-memory synthetic injection, no disk I/O)', () => {
  // These inject fabricated {label, output} pairs — never reading any file —
  // to prove the attribution ALGORITHM itself is correct in isolation,
  // independent of the real extraction above. This is what caught (and now
  // guards) the original bug: a fixed-reference comparison that always
  // blamed the first non-reference copy in iteration order, even when the
  // "reference" was the one that had actually drifted.

  it('all five agree: no drift reported', () => {
    const results = COPIES.map((c) => ({ label: c.label, output: ['same'] }));
    expect(diagnoseDrift(results)).toBeNull();
  });

  it('the REFERENCE copy (COPIES[0], formats/shared.ts) is the one that drifted: it is named, not the next copy in line', () => {
    const results = [
      { label: 'formats/shared.ts', output: ['DRIFTED'] },
      { label: 'formats/sweepV2.ts', output: ['same'] },
      { label: 'formats/genericInstruct.ts', output: ['same'] },
      { label: 'nextedit/shell.vscode.ts', output: ['same'] },
      { label: 'context/editTrackerAdapter.ts', output: ['same'] },
    ];
    const message = diagnoseDrift(results);
    expect(message).not.toBeNull();
    // Must open by naming the actual outlier, not the first non-reference
    // entry (`formats/sweepV2.ts`) that the old fixed-reference loop always
    // blamed regardless of who really drifted.
    expect(message!.startsWith('formats/shared.ts disagrees')).toBe(true);
  });

  it('a NON-reference copy (formats/genericInstruct.ts) drifted: it is still named correctly', () => {
    const results = [
      { label: 'formats/shared.ts', output: ['same'] },
      { label: 'formats/sweepV2.ts', output: ['same'] },
      { label: 'formats/genericInstruct.ts', output: ['DRIFTED'] },
      { label: 'nextedit/shell.vscode.ts', output: ['same'] },
      { label: 'context/editTrackerAdapter.ts', output: ['same'] },
    ];
    const message = diagnoseDrift(results);
    expect(message).not.toBeNull();
    expect(message!.startsWith('formats/genericInstruct.ts disagrees')).toBe(true);
  });

  it('3-vs-2 split: both minority copies are named relative to the majority', () => {
    const results = [
      { label: 'formats/shared.ts', output: ['A'] },
      { label: 'formats/sweepV2.ts', output: ['A'] },
      { label: 'formats/genericInstruct.ts', output: ['A'] },
      { label: 'nextedit/shell.vscode.ts', output: ['B'] },
      { label: 'context/editTrackerAdapter.ts', output: ['C'] },
    ];
    const message = diagnoseDrift(results);
    expect(message).not.toBeNull();
    expect(message!.startsWith('nextedit/shell.vscode.ts, context/editTrackerAdapter.ts disagree')).toBe(true);
    expect(message).toContain('formats/shared.ts, formats/sweepV2.ts, formats/genericInstruct.ts');
  });

  it('no strict majority (2-2-1 split): reports honestly instead of guessing a scapegoat', () => {
    const results = [
      { label: 'formats/shared.ts', output: ['A'] },
      { label: 'formats/sweepV2.ts', output: ['A'] },
      { label: 'formats/genericInstruct.ts', output: ['B'] },
      { label: 'nextedit/shell.vscode.ts', output: ['B'] },
      { label: 'context/editTrackerAdapter.ts', output: ['C'] },
    ];
    const message = diagnoseDrift(results);
    expect(message).not.toBeNull();
    expect(message!.startsWith('no majority')).toBe(true);
    for (const r of results) expect(message).toContain(r.label);
  });

  it('all five disagree differently: reports honestly instead of guessing a scapegoat', () => {
    const results = COPIES.map((c, i) => ({ label: c.label, output: [`unique-${i}`] }));
    const message = diagnoseDrift(results);
    expect(message).not.toBeNull();
    expect(message!.startsWith('no majority')).toBe(true);
    for (const r of results) expect(message).toContain(r.label);
  });
});
