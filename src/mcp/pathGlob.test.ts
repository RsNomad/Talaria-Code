import { describe, expect, it } from 'vitest';

import { matchesPathGlobs } from './pathGlob';

describe('matchesPathGlobs', () => {
  it('matches everything when globs is undefined or empty', () => {
    expect(matchesPathGlobs('src/foo.ts', undefined)).toBe(true);
    expect(matchesPathGlobs('src/foo.ts', [])).toBe(true);
  });

  it('`**` matches any prefix, including zero segments', () => {
    expect(matchesPathGlobs('src/foo.ts', ['src/**'])).toBe(true);
    expect(matchesPathGlobs('lib/foo.ts', ['src/**'])).toBe(false);
  });

  it('a single `*` does not cross a path separator', () => {
    expect(matchesPathGlobs('src/foo.ts', ['src/*.ts'])).toBe(true);
    expect(matchesPathGlobs('src/sub/foo.ts', ['src/*.ts'])).toBe(false);
  });

  it('`**` in the middle crosses segments', () => {
    expect(matchesPathGlobs('src/sub/deep/foo.ts', ['src/**/foo.ts'])).toBe(true);
    expect(matchesPathGlobs('src/foo.ts', ['src/**/foo.ts'])).toBe(true);
  });

  it('a leading `!` pattern excludes matches even when a positive pattern matches', () => {
    const globs = ['src/**', '!**/*.test.*'];
    expect(matchesPathGlobs('src/foo.ts', globs)).toBe(true);
    expect(matchesPathGlobs('src/foo.test.ts', globs)).toBe(false);
  });

  it('with only negative patterns, anything not excluded matches', () => {
    expect(matchesPathGlobs('src/foo.ts', ['!**/*.test.*'])).toBe(true);
    expect(matchesPathGlobs('src/foo.test.ts', ['!**/*.test.*'])).toBe(false);
  });
});
