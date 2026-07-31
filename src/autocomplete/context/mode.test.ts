import { describe, it, expect } from 'vitest';
import { crossFileMode, injectSnippetsAsComments } from './mode';
import type { BackendCapabilities, FimTemplate, CrossFileSnippet } from '../types';

function capabilities(overrides: Partial<BackendCapabilities> = {}): BackendCapabilities {
  return {
    nativeFim: true,
    assemblesCrossFileServerSide: false,
    streaming: true,
    ...overrides,
  };
}

function template(overrides: Partial<FimTemplate> = {}): FimTemplate {
  return {
    render: () => '',
    stop: [],
    ...overrides,
  };
}

describe('crossFileMode — precedence', () => {
  it('returns none when cross-file is disabled, even if the backend assembles server-side', () => {
    const caps = capabilities({ assemblesCrossFileServerSide: true });
    const result = crossFileMode(caps, template({ supportsSnippets: true }), {
      crossFileEnabled: false,
      prefixInjection: true,
    });
    expect(result).toBe('none');
  });

  it('returns input-extra when the backend assembles cross-file context server-side', () => {
    const caps = capabilities({ assemblesCrossFileServerSide: true, nativeFim: true });
    const result = crossFileMode(caps, template(), {
      crossFileEnabled: true,
      prefixInjection: false,
    });
    expect(result).toBe('input-extra');
  });

  it('prefers input-extra over template even when the template supports snippets', () => {
    const caps = capabilities({ assemblesCrossFileServerSide: true, nativeFim: false });
    const result = crossFileMode(caps, template({ supportsSnippets: true }), {
      crossFileEnabled: true,
      prefixInjection: true,
    });
    expect(result).toBe('input-extra');
  });

  it('returns template when the backend is not native-FIM and the resolved template supports snippets', () => {
    const caps = capabilities({ assemblesCrossFileServerSide: false, nativeFim: false });
    const result = crossFileMode(caps, template({ supportsSnippets: true }), {
      crossFileEnabled: true,
      prefixInjection: false,
    });
    expect(result).toBe('template');
  });

  it('does not select template for a nativeFim backend even when supportsSnippets is true', () => {
    const caps = capabilities({ assemblesCrossFileServerSide: false, nativeFim: true });
    const result = crossFileMode(caps, template({ supportsSnippets: true }), {
      crossFileEnabled: true,
      prefixInjection: true,
    });
    expect(result).toBe('comment-inject');
  });

  it('returns comment-inject when prefixInjection is on and neither input-extra nor template apply', () => {
    const caps = capabilities({ assemblesCrossFileServerSide: false, nativeFim: true });
    const result = crossFileMode(caps, template({ supportsSnippets: false }), {
      crossFileEnabled: true,
      prefixInjection: true,
    });
    expect(result).toBe('comment-inject');
  });

  it('returns none when nothing else matches (native-FIM, template-incapable, no prefix injection)', () => {
    const caps = capabilities({ assemblesCrossFileServerSide: false, nativeFim: true });
    const result = crossFileMode(caps, template({ supportsSnippets: false }), {
      crossFileEnabled: true,
      prefixInjection: false,
    });
    expect(result).toBe('none');
  });
});

describe('injectSnippetsAsComments', () => {
  function snippet(overrides: Partial<CrossFileSnippet> = {}): CrossFileSnippet {
    return {
      uri: 'file:///repo/src/util.ts',
      filepath: 'src/util.ts',
      content: 'export function helper() {}',
      kind: 'recently-opened',
      startLine: 0,
      endLine: 1,
      ...overrides,
    };
  }

  it('formats a single snippet as a Path header + comment-prefixed body, prepended to the prefix', () => {
    const result = injectSnippetsAsComments('const x = ', [snippet()], 'typescript');
    expect(result).toBe(
      '// Path: src/util.ts\n// export function helper() {}\nconst x = ',
    );
  });

  it('comment-prefixes every body line for multi-line snippet content', () => {
    const s = snippet({ content: 'function helper() {\n  return 1;\n}' });
    const result = injectSnippetsAsComments('const x = ', [s], 'typescript');
    expect(result).toBe(
      '// Path: src/util.ts\n// function helper() {\n//   return 1;\n// }\nconst x = ',
    );
  });

  it('uses the # comment token for python', () => {
    const result = injectSnippetsAsComments('x = ', [snippet()], 'python');
    expect(result).toBe('# Path: src/util.ts\n# export function helper() {}\nx = ');
  });

  it('falls back to # for a language with no known single-line comment token', () => {
    const result = injectSnippetsAsComments('x = ', [snippet()], 'some-unknown-language');
    expect(result).toBe('# Path: src/util.ts\n# export function helper() {}\nx = ');
  });

  it('concatenates multiple snippets in array order', () => {
    const s1 = snippet({ filepath: 'src/a.ts', content: 'const a = 1;' });
    const s2 = snippet({ filepath: 'src/b.ts', content: 'const b = 2;' });
    const result = injectSnippetsAsComments('const x = ', [s1, s2], 'typescript');
    expect(result).toBe(
      '// Path: src/a.ts\n// const a = 1;\n// Path: src/b.ts\n// const b = 2;\nconst x = ',
    );
  });

  it('returns the prefix unchanged when there are no snippets', () => {
    const result = injectSnippetsAsComments('const x = ', [], 'typescript');
    expect(result).toBe('const x = ');
  });

  // `snippets` arrives ordered most-relevant-LAST (types.ts:~25,
  // `FimContext.snippets` doc comment; snippetBudgeter.ts's `buildSnapshot`
  // builds exactly this ordering). `huge` sits FIRST (least relevant) and
  // `small` sits LAST (most relevant) in the two tests below.
  it('skips (does not crop) a snippet that would overflow the budget, preferring the most-relevant (last) one', () => {
    const huge = snippet({ filepath: 'src/big.ts', content: 'x'.repeat(1000) });
    const small = snippet({ filepath: 'src/a.ts', content: 'const a = 1;' });
    const result = injectSnippetsAsComments('const x = ', [huge, small], 'typescript', 100);
    // `small` (most-relevant / last) survives even though it comes after the
    // oversized `huge` (least-relevant / first) in the input array.
    expect(result).toBe('// Path: src/a.ts\n// const a = 1;\nconst x = ');
    expect(result).not.toContain('src/big.ts');
  });

  it('respects a custom budgetChars and keeps the most-relevant (tail) snippets, dropping the least-relevant (head) one first', () => {
    const s1 = snippet({ filepath: 'src/a.ts', content: 'a' });
    const s2 = snippet({ filepath: 'src/b.ts', content: 'b' });
    const s3 = snippet({ filepath: 'src/c.ts', content: 'c' });
    // Budget fits exactly two of the three (all three blocks are equal-length).
    // s1 is least-relevant (first) and must be the one dropped; s2 and s3 (the
    // two most-relevant, tail-most) must survive, emitted in their ORIGINAL
    // (most-relevant-LAST) order.
    const twoBlocks = '// Path: src/b.ts\n// b\n' + '// Path: src/c.ts\n// c\n';
    const result = injectSnippetsAsComments('X', [s1, s2, s3], 'typescript', twoBlocks.length);
    expect(result).toBe(twoBlocks + 'X');
    expect(result).not.toContain('src/a.ts');
  });

  it('defaults the budget to 512 chars when budgetChars is omitted', () => {
    const s = snippet({ content: 'a'.repeat(600) });
    const result = injectSnippetsAsComments('X', [s], 'typescript');
    // the single 600+ char snippet overflows the 512 default budget -> skipped whole
    expect(result).toBe('X');
  });

  // CF-23 / L6 I-14 — the RED-first regression test for the fix: under budget
  // pressure, the formatter must keep the MOST-relevant (last) snippets and
  // drop the LEAST-relevant (first) ones — not the reverse. It must also
  // preserve the OUTPUT ordering the consumer expects (most-relevant-LAST):
  // only the DROP order changes, never the emit order of survivors.
  it('CF-23: under budget pressure, keeps the most-relevant (last) snippets and drops the least-relevant (first) ones, preserving output order', () => {
    const leastRelevant = snippet({ filepath: 'src/least.ts', content: 'const least = 1;' });
    const middle = snippet({ filepath: 'src/middle.ts', content: 'const middle = 2;' });
    const mostRelevant = snippet({ filepath: 'src/most.ts', content: 'const most = 3;' });
    const middleBlock = '// Path: src/middle.ts\n// const middle = 2;\n';
    const mostBlock = '// Path: src/most.ts\n// const most = 3;\n';
    // Budget fits only the two most-relevant (tail) snippets, not all three.
    const budget = middleBlock.length + mostBlock.length;

    const result = injectSnippetsAsComments(
      'const x = ',
      [leastRelevant, middle, mostRelevant],
      'typescript',
      budget,
    );

    // The most-relevant snippets survive; the least-relevant one is dropped.
    expect(result).not.toContain('src/least.ts');
    expect(result).toContain('src/middle.ts');
    expect(result).toContain('src/most.ts');
    // Output order is preserved (still most-relevant-LAST): middle before most.
    expect(result).toBe(middleBlock + mostBlock + 'const x = ');
  });
});
