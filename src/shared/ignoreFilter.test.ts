import { describe, expect, it } from 'vitest';
import { isPathValid } from 'ignore';

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

describe('createIgnoreFilter — AUDIT-5 F-6: the out-of-scope contract is LOUD (regression pins, not RED)', () => {
  it('throws on out-of-scope input — the documented node-ignore contract callers must pre-validate against', () => {
    const filter = createIgnoreFilter([]);
    expect(() => filter('../sibling/a.ts')).toThrow(RangeError);
    expect(() => filter('/abs/a.ts')).toThrow(RangeError);
  });

  it("isPathValid from 'ignore' is the boundary validator (executed probe P5 pinned)", () => {
    expect(isPathValid('')).toBe(false);
    expect(isPathValid('.')).toBe(false);
    expect(isPathValid('..')).toBe(false);
    expect(isPathValid('../sibling/a.ts')).toBe(false);
    expect(isPathValid('/abs/a.ts')).toBe(false);
    // NOT pinned: `isPathValid`'s drive-letter rejection is a Windows-only
    // code path (`ignore`'s `setupWindows()` swaps in a
    // `^[a-z]:\//i`-aware `isNotRelative`, gated on `process.platform ===
    // 'win32'` — node_modules/ignore/index.js). On POSIX (the Fedora ship
    // target and Linux CI) `'C:/abs/a.ts'` doesn't match the plain
    // `REGEX_TEST_INVALID_PATH` (`/^\.{0,2}\/|^\.{1,2}$/`), so it's treated
    // as an ordinary valid relative path — `isPathValid` legitimately
    // returns `true` there. This is a portable-vs-host-OS distinction in
    // the third-party library itself, not something `isPathValid` promises
    // cross-platform, so it isn't a portable "out-of-scope" fixture to pin.
    expect(isPathValid('src/app.ts')).toBe(true);
    expect(isPathValid('index/manifest.json')).toBe(true);
  });
});
