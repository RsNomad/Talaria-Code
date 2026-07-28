import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import vitestConfig from '../vitest.config';

/**
 * FINAL REVIEW — FINDING 4, found INDEPENDENTLY by all three lenses.
 *
 * THE HOLE. `vitest.config.ts` replaced vitest's bare default include (any
 * `.test.`/`.spec.` file in the js/ts/jsx/tsx family, at any depth) with three
 * narrow project globs. A test file that matches none of them IS NEVER RUN,
 * and the suite stays green at full strength — no warning, no count change,
 * exit 0. The code lens proved it: `nextedit/Probe.test.tsx` asserting
 * `1 === 2` left the gate at 176 files / 3283 pass, exit 0.
 *
 * WHY A LOCK AND NOT A COMMENT. `vitest.config.ts:24-31` already documents
 * this honestly — "If you add a test outside `src/` or `webview/src/`, or with
 * any other extension, IT WILL NOT RUN and the suite will still be green." A
 * comment is the remedy for a reader; it is not a remedy in a repo whose
 * doctrine is locks, and it cannot help the one person who matters here — the
 * author who names a file `.tsx` by reflex and never reads this config. Task
 * 4's orphan proof was a one-shot capture at a point in time; this is the
 * standing guard.
 *
 * THE INVARIANT: every test-shaped file in the repository matches EXACTLY ONE
 * project glob.
 *
 *  - Zero matches = an ORPHAN. It never runs; its assertions are decoration.
 *  - Two matches = double collection. The projects are documented as DISJOINT
 *    ("`*.test.ts` and `*.dom.test.tsx` can never both match one file"), and a
 *    file collected twice runs twice — in `node` AND in `jsdom`, where any
 *    module branching on `typeof window` behaves differently. That is the
 *    correctness argument the config's own header makes.
 *
 * MECHANISM. The globs are READ FROM THE REAL CONFIG, never restated here — a
 * lock that hard-codes its subject drifts from it silently.
 *
 * Matching is a small self-contained glob→RegExp translation rather than
 * `picomatch`. `picomatch` IS what vitest's include resolution is built on and
 * was the first choice, but it is a TRANSITIVE dependency of this repo, not a
 * declared one, and it ships no types — importing it means depending on
 * something no `package.json` here promises, which is a poor foundation for a
 * lock whose whole job is to still be standing in a future wave. The
 * translation below is FAIL-CLOSED instead: it accepts only the glob syntax it
 * genuinely implements (`**` + `/`, `*`, literals) and the test immediately after
 * REFUSES any config glob using anything else, so an unsupported pattern
 * breaks this lock loudly rather than being silently mismatched.
 */

const REPO_ROOT = join(__dirname, '..');

/**
 * Directories the collector never walks. `dist`/`coverage`/`.vscode-test` are
 * build or tool output (and gitignored); `node_modules` and `.git` are
 * self-evident. Everything else IS walked, including `docs/`, `media/` and
 * `.superpowers/` — an orphan hides best somewhere nobody thinks of as a
 * source root, which is exactly why the walk must not be narrowed to `src/`.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.vscode-test']);

/** Vitest's own default test-file shape: `.test.`/`.spec.` in the js/ts family. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Repo-relative POSIX paths of every test-shaped file, walked from the root. */
function collectTestShapedFiles(dir: string = REPO_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(abs).isDirectory();
    } catch {
      continue; // a broken symlink is not a test file
    }
    if (isDirectory) {
      found.push(...collectTestShapedFiles(abs));
    } else if (TEST_FILE.test(entry)) {
      found.push(relative(REPO_ROOT, abs).split(sep).join('/'));
    }
  }
  return found;
}

/**
 * The `include` globs of every project in the REAL config, flattened.
 * Deliberately typed loosely and validated below rather than trusted: the
 * point of reading the config is that it can change.
 */
function projectIncludeGlobs(): string[] {
  const projects = (vitestConfig as { test?: { projects?: unknown[] } }).test?.projects ?? [];
  return projects.flatMap((project) => {
    const include = (project as { test?: { include?: string[] } }).test?.include ?? [];
    return include;
  });
}

/**
 * The syntax this translator implements, and therefore the only syntax a
 * project glob may use. Path characters, `/`, `.`, `-`, `_` and `*`. Notably
 * ABSENT: brace expansion `{a,b}`, character classes `[…]`, single-char `?`
 * and negation `!` — all of which `picomatch` supports and this does not.
 */
const SUPPORTED_GLOB_SYNTAX = /^[A-Za-z0-9_./*-]+$/;

/**
 * `glob` as an anchored RegExp.
 *
 *  - `**\/` → any number of whole path segments, INCLUDING ZERO (so
 *    `src/**\/*.test.ts` matches `src/a.test.ts` as well as `src/x/y/a.test.ts`).
 *  - `*` → any run of characters within ONE segment; it never crosses `/`,
 *    which is what keeps `*.test.ts` from swallowing a directory name.
 *  - everything else is a literal, regex-escaped.
 *
 * Throws on unsupported syntax rather than approximating it — a matcher that
 * quietly mis-reads its own subject is the failure mode this whole file exists
 * to prevent.
 */
function globToRegExp(glob: string): RegExp {
  if (!SUPPORTED_GLOB_SYNTAX.test(glob)) {
    throw new Error(
      `testTopology.lock: glob "${glob}" uses syntax this translator does not implement. ` +
        'Extend globToRegExp (and its controls) before adding it to vitest.config.ts.',
    );
  }
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:[^/]+/)*';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else {
      out += glob[i]!.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const GLOBS = projectIncludeGlobs();
const MATCHERS = GLOBS.map((glob) => {
  const re = globToRegExp(glob);
  return { glob, isMatch: (file: string) => re.test(file) };
});

/** How many project globs claim `file`. The invariant says exactly 1. */
function matchCount(file: string): number {
  return MATCHERS.filter(({ isMatch }) => isMatch(file)).length;
}

describe('FINDING 4: the test-collection meta-lock — no test file can be silently orphaned', () => {
  /**
   * Reach, first and hardest. Every assertion in this file is a loop over one
   * of two collections; either being empty would make the whole file pass
   * forever while proving nothing.
   */
  it('reach: the config really exposes its globs and the walk really finds the suite', () => {
    expect(GLOBS.length, 'no include globs were read from vitest.config.ts — every check below is vacuous').toBe(
      3,
    );
    // Pinned by VALUE, so a project renamed or re-scoped is visible in a diff
    // of a file whose name says what it guards.
    expect([...GLOBS].sort()).toEqual([
      'src/**/*.test.ts',
      'webview/src/**/*.dom.test.tsx',
      'webview/src/**/*.test.ts',
    ]);

    const files = collectTestShapedFiles();
    expect(
      files.length,
      'the walk found almost no test files — it is looking in the wrong place or skipping too much',
    ).toBeGreaterThan(150);
    // One known file per project, so the walk is proven to reach all three
    // roots rather than just the biggest one.
    expect(files).toContain('src/autocomplete/nextedit/shell.vscode.test.ts');
    expect(files).toContain('webview/src/components/Toggle.test.ts');
    expect(files).toContain('webview/src/panels/SettingsPanel.dom.test.tsx');
    // And this very file, which is the cheapest possible proof the walk sees
    // the tree it is standing in.
    expect(files).toContain('src/testTopology.lock.test.ts');
  });

  /**
   * The translator's own guard rail. Every other assertion in this file is
   * downstream of `globToRegExp` reading its glob correctly, so the case where
   * it CANNOT must be loud. Brace expansion is the realistic future case: a
   * single `src/**\/*.{test,spec}.ts` would, under a silent approximation,
   * quietly stop matching everything and turn this whole lock green-forever.
   */
  it('the glob translator refuses syntax it does not implement, rather than approximating it', () => {
    for (const glob of GLOBS) {
      expect(() => globToRegExp(glob), `the shipped glob "${glob}" must be translatable`).not.toThrow();
    }
    for (const unsupported of [
      'src/**/*.{test,spec}.ts',
      'src/**/*.test.[jt]s',
      'src/**/?.test.ts',
      '!src/excluded/**/*.test.ts',
    ]) {
      expect(
        () => globToRegExp(unsupported),
        `"${unsupported}" must be REFUSED, not silently mis-translated`,
      ).toThrow(/does not implement/);
    }
  });

  it('every test-shaped file in the repository is collected by EXACTLY ONE project', () => {
    const orphans: string[] = [];
    const doubleCollected: string[] = [];
    for (const file of collectTestShapedFiles()) {
      const count = matchCount(file);
      if (count === 0) orphans.push(file);
      if (count > 1) doubleCollected.push(file);
    }

    expect(
      orphans,
      'ORPHANED: these files match no project glob in vitest.config.ts, so they NEVER RUN and the suite ' +
        'stays green at full strength. Rename them into a collected shape, or widen a project include.',
    ).toEqual([]);
    expect(
      doubleCollected,
      'DOUBLE-COLLECTED: the three projects are documented as disjoint. A file collected twice runs in BOTH ' +
        'node and jsdom, where any module branching on `typeof window` behaves differently.',
    ).toEqual([]);
  });

  /**
   * RED-first proof. The predicate is run against the code lens's EXACT
   * planted path and the architecture lens's other named shapes. In-memory: no
   * probe is written to disk, both because `src/autocomplete/**` is walked by
   * concurrently-running purity scans (the race `nextEditPurity.test.ts`
   * documents) and because a disk probe that failed to clean up would poison
   * every later run.
   */
  it('RED-first proof: the shapes that silently never ran are flagged as orphans', () => {
    // The lens's actual plant — a .tsx under src/, asserting 1 === 2, which
    // left the gate at 176 files / 3283 pass / exit 0.
    expect(matchCount('src/autocomplete/nextedit/Probe.test.tsx')).toBe(0);
    // A test outside both source roots.
    expect(matchCount('test/orphan.test.ts')).toBe(0);
    expect(matchCount('scripts/tooling.test.ts')).toBe(0);
    // `.spec.` — never used in this repo, and collected by none of the globs
    // despite being vitest's own default shape.
    expect(matchCount('src/autocomplete/engine.spec.ts')).toBe(0);
    // A DOM test misfiled under the host root: jsdom is a per-project setting,
    // so this would run in `node` with no `document` if it were `.test.ts`,
    // and not at all as `.dom.test.tsx`.
    expect(matchCount('src/panels/Thing.dom.test.tsx')).toBe(0);
  });

  /**
   * The matcher's negative control. Every assertion above is of the form
   * "count is 0" or "count is []" — all of which a matcher that never matches
   * anything would satisfy. This is the pair that rules that out.
   */
  it('control: the matcher is not "match nothing" — the real shapes DO match, one project each', () => {
    expect(matchCount('src/autocomplete/engine.test.ts')).toBe(1);
    expect(matchCount('src/deeply/nested/thing.test.ts')).toBe(1);
    expect(matchCount('webview/src/components/Toggle.test.ts')).toBe(1);
    expect(matchCount('webview/src/panels/SettingsPanel.dom.test.tsx')).toBe(1);
    // ...and is not "match everything" either: ordinary source is not a test.
    expect(matchCount('src/autocomplete/engine.ts')).toBe(0);
    expect(matchCount('README.md')).toBe(0);
  });

  /**
   * The disjointness the config's header asserts in prose, checked as an
   * identity rather than assumed. `webview/src/**\/*.test.ts` and
   * `webview/src/**\/*.dom.test.tsx` differ only by extension, which is the
   * whole reason the split is claimed to be structural — "a filename suffix is
   * a lock a `git mv` cannot launder".
   */
  it('the webview projects really are disjoint: no path can satisfy both', () => {
    const pureRe = globToRegExp('webview/src/**/*.test.ts');
    const domRe = globToRegExp('webview/src/**/*.dom.test.tsx');
    const pure = (f: string) => pureRe.test(f);
    const dom = (f: string) => domRe.test(f);
    for (const candidate of [
      'webview/src/panels/SettingsPanel.dom.test.tsx',
      'webview/src/panels/SettingsPanel.test.ts',
      'webview/src/a/b/c.dom.test.tsx',
      'webview/src/a/b/c.test.ts',
    ]) {
      expect(pure(candidate) && dom(candidate), `${candidate} was claimed by BOTH webview projects`).toBe(
        false,
      );
    }
  });
});
