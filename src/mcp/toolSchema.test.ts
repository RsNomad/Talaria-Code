import { describe, expect, it } from 'vitest';

import { CODEBASE_SEARCH_JSON_SCHEMA, codebaseSearchInputSchema } from './toolSchema';

describe('codebaseSearchInputSchema', () => {
  it('accepts a minimal query and defaults k to 10', () => {
    const parsed = codebaseSearchInputSchema.parse({ query: 'where is auth handled' });
    expect(parsed).toEqual({ query: 'where is auth handled', k: 10 });
  });

  it('rejects a missing query', () => {
    expect(() => codebaseSearchInputSchema.parse({})).toThrow();
  });

  it('rejects k outside [1, 50] or non-integer k', () => {
    expect(() => codebaseSearchInputSchema.parse({ query: 'x', k: 0 })).toThrow();
    expect(() => codebaseSearchInputSchema.parse({ query: 'x', k: 51 })).toThrow();
    expect(() => codebaseSearchInputSchema.parse({ query: 'x', k: 1.5 })).toThrow();
  });

  it('accepts path_globs and language', () => {
    const parsed = codebaseSearchInputSchema.parse({
      query: 'x',
      k: 5,
      path_globs: ['src/**', '!**/*.test.*'],
      language: 'typescript',
    });
    expect(parsed.path_globs).toEqual(['src/**', '!**/*.test.*']);
    expect(parsed.language).toBe('typescript');
  });

  it('V-21: rejects more than 16 path_globs entries (amplifier cap)', () => {
    const tooMany = Array.from({ length: 17 }, (_, i) => `src/${i}/**`);
    expect(() => codebaseSearchInputSchema.parse({ query: 'x', path_globs: tooMany })).toThrow();
    // 16 stays accepted — the cap is exclusive of the boundary, not off-by-one.
    expect(() =>
      codebaseSearchInputSchema.parse({ query: 'x', path_globs: tooMany.slice(0, 16) }),
    ).not.toThrow();
  });

  it('V-21: rejects a path_globs entry longer than 256 characters (amplifier cap)', () => {
    const tooLong = 'a'.repeat(257);
    expect(() => codebaseSearchInputSchema.parse({ query: 'x', path_globs: [tooLong] })).toThrow();
    // 256 stays accepted.
    expect(() =>
      codebaseSearchInputSchema.parse({ query: 'x', path_globs: ['a'.repeat(256)] }),
    ).not.toThrow();
  });
});

describe('CODEBASE_SEARCH_JSON_SCHEMA', () => {
  it('requires only query, and exposes exactly the pinned property set', () => {
    expect(CODEBASE_SEARCH_JSON_SCHEMA.required).toEqual(['query']);
    expect(Object.keys(CODEBASE_SEARCH_JSON_SCHEMA.properties).sort()).toEqual(
      ['k', 'language', 'path_globs', 'query'].sort(),
    );
  });

  it('pins k bounds to [1, 50] with a default of 10', () => {
    expect(CODEBASE_SEARCH_JSON_SCHEMA.properties.k).toEqual({
      type: 'integer',
      default: 10,
      minimum: 1,
      maximum: 50,
    });
  });
});
