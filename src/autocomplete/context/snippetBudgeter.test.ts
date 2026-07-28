import { describe, it, expect } from 'vitest';
import { buildSnapshot, snippetBudgetChars } from './snippetBudgeter';
import { scannedSnippetForTest } from './scannedSnippetTestFactory';
import type { CrossFileSnippet } from '../types';
import type { ScannedSnippet } from './types';
import { must } from '../../testing/must';

function snippet(overrides: Partial<CrossFileSnippet>): ScannedSnippet {
  return scannedSnippetForTest({
    uri: 'file:///default.ts',
    filepath: 'default.ts',
    content: 'const a = 1;',
    kind: 'recently-edited',
    startLine: 0,
    endLine: 0,
    ...overrides,
  });
}

describe('snippetBudgetChars', () => {
  it('returns 2048 for input-extra', () => {
    expect(snippetBudgetChars('input-extra')).toBe(2048);
  });

  it('returns 1024 for template', () => {
    expect(snippetBudgetChars('template')).toBe(1024);
  });

  it('returns 512 for comment-inject', () => {
    expect(snippetBudgetChars('comment-inject')).toBe(512);
  });

  it('returns 0 for none', () => {
    expect(snippetBudgetChars('none')).toBe(0);
  });
});

describe('buildSnapshot — mode none', () => {
  it('returns an empty frozen snapshot regardless of input', () => {
    const scanned = [snippet({ uri: 'file:///a.ts' })];
    const result = buildSnapshot(scanned, 'none');

    expect(result.snippets).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snippets)).toBe(true);
  });
});

describe('buildSnapshot — priority ladder', () => {
  it('caps recently-edited at 3 snippets even when more are available', () => {
    const scanned = Array.from({ length: 5 }, (_, i) =>
      snippet({ uri: `file:///edited-${i}.ts`, kind: 'recently-edited', content: 'x' }),
    );

    const result = buildSnapshot(scanned, 'template');

    expect(result.snippets).toHaveLength(3);
  });

  it('caps recently-opened at 5 snippets even when more are available', () => {
    const scanned = Array.from({ length: 7 }, (_, i) =>
      snippet({ uri: `file:///opened-${i}.ts`, kind: 'recently-opened', content: 'x' }),
    );

    const result = buildSnapshot(scanned, 'template');

    expect(result.snippets).toHaveLength(5);
  });

  it('orders most-relevant-LAST: recently-edited (higher priority) survivors are the LAST elements', () => {
    const opened1 = snippet({ uri: 'file:///o1.ts', kind: 'recently-opened', content: 'o1' });
    const opened2 = snippet({ uri: 'file:///o2.ts', kind: 'recently-opened', content: 'o2' });
    const edited1 = snippet({ uri: 'file:///e1.ts', kind: 'recently-edited', content: 'e1' });
    const edited2 = snippet({ uri: 'file:///e2.ts', kind: 'recently-edited', content: 'e2' });

    // Deliberately fed in a mixed, non-ladder order to prove the OUTPUT order
    // is determined by priority, not input order.
    const result = buildSnapshot([opened1, edited1, opened2, edited2], 'template');

    expect(result.snippets.map((s) => s.content)).toEqual(['o1', 'o2', 'e1', 'e2']);
  });

  it('most-relevant-LAST holds for the input-extra (llama.cpp) assembly mode', () => {
    const opened = snippet({ uri: 'file:///o.ts', kind: 'recently-opened', content: 'o' });
    const edited = snippet({ uri: 'file:///e.ts', kind: 'recently-edited', content: 'e' });

    const result = buildSnapshot([opened, edited], 'input-extra');

    expect(result.snippets[result.snippets.length - 1]).toBe(edited);
  });

  it('most-relevant-LAST holds for the template (qwen repo-FIM) assembly mode', () => {
    const opened = snippet({ uri: 'file:///o.ts', kind: 'recently-opened', content: 'o' });
    const edited = snippet({ uri: 'file:///e.ts', kind: 'recently-edited', content: 'e' });

    const result = buildSnapshot([opened, edited], 'template');

    expect(result.snippets[result.snippets.length - 1]).toBe(edited);
  });
});

describe('buildSnapshot — per-mode budget', () => {
  it('fits two 500-char-capped snippets under the 2048 input-extra budget', () => {
    const a = snippet({ uri: 'file:///a.ts', kind: 'recently-edited', content: 'a'.repeat(500) });
    const b = snippet({ uri: 'file:///b.ts', kind: 'recently-edited', content: 'b'.repeat(500) });

    const result = buildSnapshot([a, b], 'input-extra');

    expect(result.snippets).toHaveLength(2);
  });

  it('only fits ONE 500-char-capped snippet under the 512 comment-inject budget', () => {
    const a = snippet({ uri: 'file:///a.ts', kind: 'recently-edited', content: 'a'.repeat(500) });
    const b = snippet({ uri: 'file:///b.ts', kind: 'recently-edited', content: 'b'.repeat(500) });

    const result = buildSnapshot([a, b], 'comment-inject');

    expect(result.snippets).toHaveLength(1);
    expect(must(result.snippets[0]).content).toBe('a'.repeat(500));
  });
});

describe('buildSnapshot — line-aligned extraction, skip-not-crop (A4, security-load-bearing)', () => {
  it('never bisects a line when capping a snippet to the 500-char per-snippet cap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}-${'x'.repeat(20)}`); // ~28 chars/line
    const content = lines.join('\n'); // well over 500 chars
    const a = snippet({ uri: 'file:///a.ts', kind: 'recently-edited', content });

    const result = buildSnapshot([a], 'input-extra');

    expect(result.snippets).toHaveLength(1);
    const emitted = must(result.snippets[0]).content;
    expect(emitted.length).toBeLessThanOrEqual(500);
    // Every line in the emitted content must be an EXACT original line —
    // never a partial/bisected line.
    const emittedLines = emitted.split('\n');
    for (const line of emittedLines) {
      expect(lines).toContain(line);
    }
    // And it must be a prefix of the original lines, in order.
    expect(lines.slice(0, emittedLines.length)).toEqual(emittedLines);
  });

  it('skips a candidate whose already-capped content still exceeds the remaining mode budget, WITHOUT cropping it further', () => {
    // First candidate consumes exactly 500 of comment-inject's 512-char budget.
    const first = snippet({ uri: 'file:///first.ts', kind: 'recently-edited', content: 'f'.repeat(500) });
    // Second candidate is also exactly 500 chars (one line) — only 12 chars of
    // budget remain, nowhere near enough. It must be SKIPPED WHOLE, never
    // cropped down to fit the leftover 12 chars.
    const second = snippet({ uri: 'file:///second.ts', kind: 'recently-edited', content: 's'.repeat(500) });

    const result = buildSnapshot([first, second], 'comment-inject');

    expect(result.snippets).toHaveLength(1);
    expect(must(result.snippets[0]).content).toBe('f'.repeat(500));
    // The second snippet's uri must not appear anywhere in the output —
    // proving it was skipped, not silently cropped to a partial/empty string.
    expect(result.snippets.some((s) => s.uri === 'file:///second.ts')).toBe(false);
  });

  it('drops a snippet whose single first line alone exceeds the per-snippet cap (no partial-line content emitted)', () => {
    const oneGiantLine = 'x'.repeat(700); // no newlines — a single line over the 500 cap
    const a = snippet({ uri: 'file:///a.ts', kind: 'recently-edited', content: oneGiantLine });
    const b = snippet({ uri: 'file:///b.ts', kind: 'recently-opened', content: 'fine' });

    const result = buildSnapshot([a, b], 'input-extra');

    expect(result.snippets.some((s) => s.uri === 'file:///a.ts')).toBe(false);
    expect(result.snippets.some((s) => s.uri === 'file:///b.ts')).toBe(true);
  });

  it('the emitted content is byte-exact to what will be sent (no re-truncation of an already-within-cap snippet)', () => {
    const content = 'small snippet, well under the cap';
    const a = snippet({ uri: 'file:///a.ts', content });

    const result = buildSnapshot([a], 'input-extra');

    expect(must(result.snippets[0]).content).toBe(content);
  });
});

describe('buildSnapshot — dedup', () => {
  it('drops a candidate whose range intersects an already-accepted range from a higher-priority rung', () => {
    const edited = snippet({
      uri: 'file:///shared.ts',
      kind: 'recently-edited',
      startLine: 10,
      endLine: 20,
      content: 'edited-wins',
    });
    const opened = snippet({
      uri: 'file:///shared.ts',
      kind: 'recently-opened',
      startLine: 15,
      endLine: 25, // overlaps [10,20] at lines 15-20
      content: 'opened-loses',
    });

    const result = buildSnapshot([edited, opened], 'template');

    expect(result.snippets).toHaveLength(1);
    expect(must(result.snippets[0]).content).toBe('edited-wins');
  });

  it('drops a same-rung candidate intersecting an already-accepted range (first-seen wins)', () => {
    const first = snippet({
      uri: 'file:///shared.ts',
      kind: 'recently-edited',
      startLine: 0,
      endLine: 10,
      content: 'first',
    });
    const overlapping = snippet({
      uri: 'file:///shared.ts',
      kind: 'recently-edited',
      startLine: 5,
      endLine: 15,
      content: 'overlapping',
    });

    const result = buildSnapshot([first, overlapping], 'template');

    expect(result.snippets).toHaveLength(1);
    expect(must(result.snippets[0]).content).toBe('first');
  });

  it('keeps a same-uri candidate whose range does NOT intersect an accepted range', () => {
    const first = snippet({
      uri: 'file:///shared.ts',
      kind: 'recently-edited',
      startLine: 0,
      endLine: 10,
      content: 'first',
    });
    const disjoint = snippet({
      uri: 'file:///shared.ts',
      kind: 'recently-edited',
      startLine: 20,
      endLine: 30,
      content: 'disjoint',
    });

    const result = buildSnapshot([first, disjoint], 'template');

    expect(result.snippets).toHaveLength(2);
  });
});

describe('buildSnapshot — active-document belt-and-braces exclusion', () => {
  it('excludes a candidate whose uri equals the active document, even though ingest should already have dropped it', () => {
    const active = snippet({ uri: 'file:///active.ts', content: 'should-not-appear' });
    const other = snippet({ uri: 'file:///other.ts', content: 'fine' });

    const result = buildSnapshot([active, other], 'template', 'file:///active.ts');

    expect(result.snippets.some((s) => s.uri === 'file:///active.ts')).toBe(false);
    expect(result.snippets.some((s) => s.uri === 'file:///other.ts')).toBe(true);
  });
});

describe('buildSnapshot — the truncation spread is the one sanctioned safe subset-derivation (fix-pass #2)', () => {
  it('the emitted content of a truncated snippet is always a byte-exact PREFIX of the original scanned content', () => {
    // This is the invariant that makes `{ ...candidate, content: trimmed }`
    // (snippetBudgeter.ts's line-truncation spread) safe WITHOUT a cast:
    // `takeWholeLinesWithinBudget` only ever accumulates whole lines from
    // the START of `content`, in order, so whatever it emits was already
    // present — and already scanned — in `candidate.content`. No spread
    // anywhere in this module can introduce a single byte that the secret
    // scanner did not already see. See ringBuffer.test.ts's
    // "no brand-preserving spread ..." guard for the mechanised proof that
    // this is the ONLY sanctioned spread site outside ringBuffer.ts itself.
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}-${'x'.repeat(20)}`);
    const content = lines.join('\n');
    const a = snippet({ uri: 'file:///a.ts', kind: 'recently-edited', content });

    const result = buildSnapshot([a], 'input-extra');

    expect(result.snippets).toHaveLength(1);
    const emitted = must(result.snippets[0]).content;
    expect(emitted.length).toBeLessThan(content.length); // proves truncation actually happened
    expect(content.startsWith(emitted)).toBe(true); // the subset-safety invariant itself
  });

  it('when content already fits, the "truncated" branch is skipped entirely and the original object is emitted unchanged (no spread at all)', () => {
    const content = 'small snippet, well under any cap';
    const a = snippet({ uri: 'file:///a.ts', content });

    const result = buildSnapshot([a], 'input-extra');

    // Identity, not just equality — proves the non-spread branch (`? candidate : ...`)
    // was taken, so no new object was derived at all for this snippet.
    expect(result.snippets[0]).toBe(a);
  });
});

describe('buildSnapshot — frozen output', () => {
  it('freezes both the snapshot and its snippets array', () => {
    const result = buildSnapshot([snippet({})], 'template');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snippets)).toBe(true);
  });

  it('freezes an empty snapshot too', () => {
    const result = buildSnapshot([], 'template');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snippets)).toBe(true);
    expect(result.snippets).toEqual([]);
  });
});
