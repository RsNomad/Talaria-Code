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

  it('skips (does not crop) a snippet that would overflow the budget', () => {
    const small = snippet({ filepath: 'src/a.ts', content: 'const a = 1;' });
    const huge = snippet({ filepath: 'src/big.ts', content: 'x'.repeat(1000) });
    const result = injectSnippetsAsComments('const x = ', [small, huge], 'typescript', 100);
    expect(result).toBe('// Path: src/a.ts\n// const a = 1;\nconst x = ');
    expect(result).not.toContain('src/big.ts');
  });

  it('respects a custom budgetChars and stops adding once the next snippet would overflow', () => {
    const s1 = snippet({ filepath: 'src/a.ts', content: 'a' });
    const s2 = snippet({ filepath: 'src/b.ts', content: 'b' });
    const s3 = snippet({ filepath: 'src/c.ts', content: 'c' });
    const twoBlocks =
      '// Path: src/a.ts\n// a\n' + '// Path: src/b.ts\n// b\n';
    const result = injectSnippetsAsComments('X', [s1, s2, s3], 'typescript', twoBlocks.length);
    expect(result).toBe(twoBlocks + 'X');
    expect(result).not.toContain('src/c.ts');
  });

  it('defaults the budget to 512 chars when budgetChars is omitted', () => {
    const s = snippet({ content: 'a'.repeat(600) });
    const result = injectSnippetsAsComments('X', [s], 'typescript');
    // the single 600+ char snippet overflows the 512 default budget -> skipped whole
    expect(result).toBe('X');
  });
});
