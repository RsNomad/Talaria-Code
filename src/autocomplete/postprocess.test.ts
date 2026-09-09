import { describe, it, expect } from 'vitest';
import { postprocessCompletion, trimAtStopTokens } from './postprocess';

describe('trimAtStopTokens', () => {
  it('returns the text unchanged when no stop token appears', () => {
    expect(trimAtStopTokens('result = a + b', ['<|endoftext|>'])).toBe(
      'result = a + b',
    );
  });

  it('cuts the text at the first occurrence of any stop token', () => {
    expect(
      trimAtStopTokens('result = a + b<|fim_suffix|>garbage', [
        '<|fim_prefix|>',
        '<|fim_suffix|>',
      ]),
    ).toBe('result = a + b');
  });

  it('picks the earliest cut point across multiple matching stop tokens', () => {
    expect(trimAtStopTokens('foo\nbar\nbaz', ['\nbaz', '\nbar'])).toBe('foo');
  });

  it('handles an empty stop list', () => {
    expect(trimAtStopTokens('foo', [])).toBe('foo');
  });
});

describe('postprocessCompletion', () => {
  const base = { prefix: '', suffix: '', model: 'qwen2.5-coder:1.5b-base' };

  it('returns undefined for an empty completion', () => {
    expect(
      postprocessCompletion({ ...base, completion: '', stop: [] }),
    ).toBeUndefined();
  });

  it('returns undefined for a whitespace-only completion', () => {
    expect(
      postprocessCompletion({ ...base, completion: '   \n  ', stop: [] }),
    ).toBeUndefined();
  });

  it('trims at the first stop token', () => {
    expect(
      postprocessCompletion({
        ...base,
        completion: 'a + b<|endoftext|>junk',
        stop: ['<|endoftext|>'],
      }),
    ).toBe('a + b');
  });

  it('removes a markdown code fence wrapper', () => {
    expect(
      postprocessCompletion({
        ...base,
        completion: '```typescript\nconst x = 1;\n```',
        stop: [],
      }),
    ).toBe('const x = 1;');
  });

  it('drops a duplicate leading space when the prefix already ends with a space', () => {
    expect(
      postprocessCompletion({
        prefix: 'const x = ',
        suffix: '',
        model: 'qwen2.5-coder:1.5b-base',
        completion: ' 1;',
        stop: [],
      }),
    ).toBe('1;');
  });

  it('strips <think>...</think> blocks for qwen3 models', () => {
    expect(
      postprocessCompletion({
        prefix: '',
        suffix: '',
        model: 'qwen3-coder:7b',
        completion: '<think>reasoning about it</think>\nconst x = 1;',
        stop: [],
      }),
    ).toBe('const x = 1;');
  });

  it('returns undefined when the completion is just a repeat of the line above', () => {
    expect(
      postprocessCompletion({
        prefix: 'function add(a, b) {\n  return a + b;\n',
        suffix: '',
        model: 'qwen2.5-coder:1.5b-base',
        completion: '  return a + b;',
        stop: [],
      }),
    ).toBeUndefined();
  });

  it('leaves an unrelated completion untouched', () => {
    expect(
      postprocessCompletion({
        ...base,
        completion: 'return a + b;',
        stop: [],
      }),
    ).toBe('return a + b;');
  });
});

/**
 * WS-D D1 (L2-CA-01) — golden table pinning TODAY's `postprocessCompletion`
 * outputs for the near-duplicate check across the buckets the bounded
 * rewrite (MAX_REPEAT_CHECK_CHARS pre-check + exact length-gap short-circuit
 * + two-row Levenshtein) must reproduce byte-identically. These expected
 * values were captured by RUNNING the current (pre-fix) implementation —
 * they are the arbiter of result-preservation, not a hand-derived model of
 * the algorithm. Must stay IDENTICAL after the bounded rewrite.
 */
describe('postprocessCompletion — near-duplicate golden table (WS-D D1, result-preserving)', () => {
  const model = 'qwen2.5-coder:1.5b-base';
  // Exactly 20 chars each, so length-based buckets below land where intended.
  const BASE20 = 'the quick brown fox1';
  // 1-char substitution vs BASE20 -> editDistance 1 -> ratio 1/20 = 0.05 (< 0.1, repeated).
  const ONE_EDIT_20 = 'the quick brown fox2';
  // 5-char substitution vs BASE20 -> editDistance 5 -> ratio 5/20 = 0.25 (>= 0.1, not repeated).
  const FIVE_EDIT_20 = 'zhe Quick_browN fox9';

  interface GoldenRow {
    readonly name: string;
    readonly prefixLastLine: string;
    readonly completionFirstLine: string;
    readonly expected: string | undefined;
  }

  const rows: GoldenRow[] = [
    {
      name: 'identical lines (>4 chars) -> near-duplicate, dropped',
      prefixLastLine: BASE20,
      completionFirstLine: BASE20,
      expected: undefined,
    },
    {
      name: '1-char edit on a 20-char line -> near-duplicate, dropped',
      prefixLastLine: BASE20,
      completionFirstLine: ONE_EDIT_20,
      expected: undefined,
    },
    {
      name: '5-char edit on a 20-char line -> not a near-duplicate, kept',
      prefixLastLine: BASE20,
      completionFirstLine: FIVE_EDIT_20,
      expected: FIVE_EDIT_20,
    },
    {
      name: 'lengths differ by >=10% -> not a near-duplicate, kept',
      prefixLastLine: BASE20,
      completionFirstLine: 'short',
      expected: 'short',
    },
    {
      name: 'both lines <=4 chars -> not a near-duplicate, kept',
      prefixLastLine: 'abcd',
      completionFirstLine: 'abcd',
      expected: 'abcd',
    },
    {
      name: 'whitespace-only completion -> blank, dropped',
      prefixLastLine: BASE20,
      completionFirstLine: '   ',
      expected: undefined,
    },
  ];

  it.each(rows)('$name', ({ prefixLastLine, completionFirstLine, expected }) => {
    const result = postprocessCompletion({
      prefix: prefixLastLine,
      suffix: '',
      model,
      completion: completionFirstLine,
      stop: [],
    });
    expect(result).toBe(expected);
  });
});

/**
 * WS-D D1 (L2-CA-01) — the bug: `editDistance`'s full `(a+1)x(b+1)` matrix,
 * called unconditionally from `lineIsRepeated` for any pair of lines over 4
 * chars, lets a server-controlled 1 MiB completion line attempt a
 * ~30 x 1M-cell allocation against a short prefix line. Bound with a
 * per-test timeout so a still-broken implementation FAILS fast instead of
 * hanging the suite.
 */
describe('postprocessCompletion — bounded near-duplicate check perf (WS-D D1, L2-CA-01)', () => {
  it(
    'returns within 50ms for a 1 MiB completion line against a 30-char prefix line',
    () => {
      const prefix = 'y'.repeat(30);
      const completion = 'x'.repeat(1024 * 1024);
      const start = performance.now();
      const result = postprocessCompletion({
        prefix,
        suffix: '',
        model: 'qwen2.5-coder:1.5b-base',
        completion,
        stop: [],
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
      // Wildly different lengths -> not a near-duplicate -> completion passes through.
      expect(result).toBe(completion);
    },
    2000,
  );
});
