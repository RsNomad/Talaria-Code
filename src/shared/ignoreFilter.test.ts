import { describe, expect, it } from 'vitest';

import { createIgnoreFilter } from './ignoreFilter';

describe('createIgnoreFilter', () => {
  it('ignores default excludes even with no .gitignore content', () => {
    const isIgnored = createIgnoreFilter([]);
    expect(isIgnored('node_modules/x.js')).toBe(true);
    expect(isIgnored('.git/HEAD')).toBe(true);
    expect(isIgnored('dist/bundle.js')).toBe(true);
    expect(isIgnored('image.png')).toBe(true);
  });

  it('does not ignore ordinary source files', () => {
    const isIgnored = createIgnoreFilter([]);
    expect(isIgnored('src/index.ts')).toBe(false);
  });

  it('applies patterns from .gitignore content, including negation', () => {
    const isIgnored = createIgnoreFilter(['*.log\n!important.log\n']);
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('important.log')).toBe(false);
  });

  it('applies extra user-configured patterns', () => {
    const isIgnored = createIgnoreFilter([], ['generated/**']);
    expect(isIgnored('generated/schema.ts')).toBe(true);
    expect(isIgnored('src/generated-thing.ts')).toBe(false);
  });

  it('combines multiple discovered .gitignore files', () => {
    const isIgnored = createIgnoreFilter(['*.tmp\n', 'secrets/\n']);
    expect(isIgnored('a.tmp')).toBe(true);
    expect(isIgnored('secrets/key.pem')).toBe(true);
  });
});
