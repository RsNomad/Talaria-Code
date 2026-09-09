import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * W0-0 (round-2 DEFER close-out program pre-flight) — self-test for
 * `scripts/assert-comment-only-diff.mjs`, the gate a LATER workstream
 * (WS-F13, FI-01 comment-archaeology retirement) will run on every
 * comment-only commit before it lands.
 *
 * The script's core claim is "printer-equality": parse both revisions of a
 * file with `ts.createSourceFile`, reprint each with
 * `ts.createPrinter({ removeComments: true })`, and require the two printed
 * strings to be byte-equal. That is a strictly stronger check than a
 * `git diff -U0` regex gate — it is immune to whitespace/formatting churn
 * inside comments AND to a rewritten comment that happens to mention a
 * changed-code marker word (case ii below is exactly the shape that fools a
 * line-based regex: a real code token changes, but the enclosing string
 * still contains "no longer" both before and after — `AcpBackend.ts` has two
 * such literals in production, see the finding's brief).
 *
 * Printer-equality alone has one known blind spot (critic finding I-11):
 * `removeComments: true` strips EVERY comment before comparing, including a
 * newly-added `@ts-ignore`/`@ts-nocheck`/etc. pragma — a comment that changes
 * compiler or tooling BEHAVIOUR, not just prose. This repo has no ESLint to
 * catch that separately, so the script ALSO diffs the multiset of
 * pragma-bearing comments per file and fails on any change (case iii below).
 *
 * All three cases run the script in its `--files <a> <b>` self-test mode
 * (comparing two files written to a temp dir) so this test needs no git
 * fixtures or a real commit pair.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const scriptPath = path.join(repoRoot, 'scripts', 'assert-comment-only-diff.mjs');

function runFilesMode(textA: string, textB: string): number | null {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'talaria-comment-only-diff-'));
  try {
    const aPath = path.join(dir, 'a.ts');
    const bPath = path.join(dir, 'b.ts');
    writeFileSync(aPath, textA, 'utf8');
    writeFileSync(bPath, textB, 'utf8');
    const result = spawnSync(process.execPath, [scriptPath, '--files', aPath, bPath], {
      encoding: 'utf8',
    });
    return result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('assert-comment-only-diff.mjs --files (W0-0)', () => {
  it('(i) exits 0 when the two sources differ ONLY in comment text', () => {
    const a = `export function add(x: number, y: number): number {\n  // old comment\n  return x + y;\n}\n`;
    const b = `export function add(x: number, y: number): number {\n  // NEW comment, rewritten entirely\n  return x + y;\n}\n`;

    expect(runFilesMode(a, b)).toBe(0);
  });

  it('(ii) exits 1 when a real token changes inside a string literal that still contains "no longer" both before and after', () => {
    const a = `export const s = 'this is no longer true';\n`;
    const b = `export const s = 'this is no longer FALSE';\n`;

    expect(runFilesMode(a, b)).toBe(1);
  });

  it('(iii) exits 1 when the only change is an added "// @ts-ignore" line — printer-equality alone would say 0, the pragma-multiset diff catches it', () => {
    const a = `export function risky(): number {\n  return 1;\n}\n`;
    const b = `export function risky(): number {\n  // @ts-ignore\n  return 1;\n}\n`;

    expect(runFilesMode(a, b)).toBe(1);
  });
});

describe('assert-comment-only-diff.mjs --files pragma anchoring (W0-0 review M1)', () => {
  it('exits 0 editing a comment that merely mentions "v8" but is not a "v8 ignore" directive', () => {
    // Before the fix, the pragma markers were matched as bare substrings
    // ('c8'/'v8'/'istanbul'), so this prose comment about the V8 engine was
    // wrongly treated as pragma-bearing — editing its text changed the
    // "pragma" multiset and spuriously failed the gate (exactly the
    // WS-F13 workflow on files that mention V8/Node). Anchoring to the real
    // directive form ('v8 ignore') means this edit is genuinely comment-only.
    const a = `export function run(): number {\n  // this relies on a v8 engine quirk\n  return 1;\n}\n`;
    const b = `export function run(): number {\n  // this relies on a v8 engine quirk, now documented in detail\n  return 1;\n}\n`;

    expect(runFilesMode(a, b)).toBe(0);
  });
});

/** Run one `git` command in `dir`, throwing with stderr on non-zero exit. */
function runGit(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Create a throwaway git repo in a fresh temp dir and return its path. */
function initFixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'talaria-comment-only-diff-commit-'));
  runGit(dir, ['init', '--quiet']);
  return dir;
}

/**
 * Write `files` (name -> content) into `dir` and commit them, using
 * per-invocation `-c` overrides so the test needs no ambient git identity
 * and never prompts for a GPG passphrase. Returns the new commit's SHA.
 */
function commitFiles(dir: string, files: Record<string, string>, message: string): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf8');
  }
  runGit(dir, ['add', '--all']);
  runGit(
    dir,
    [
      '-c',
      'user.name=talaria-test',
      '-c',
      'user.email=talaria-test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
  );
  return runGit(dir, ['rev-parse', 'HEAD']).trim();
}

/** Run the script in `--commit` mode with the repo at `dir` as its cwd. */
function runCommitModeIn(dir: string, args: string[]): number | null {
  const result = spawnSync(process.execPath, [scriptPath, '--commit', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return result.status;
}

describe('assert-comment-only-diff.mjs --commit (W0-0 review I2)', () => {
  it('(a) exits 0 for a comment-only .ts change between two real commits', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(
        dir,
        { 'a.ts': `export function add(x: number, y: number): number {\n  // old\n  return x + y;\n}\n` },
        'base',
      );
      const sha = commitFiles(
        dir,
        {
          'a.ts': `export function add(x: number, y: number): number {\n  // NEW comment, rewritten\n  return x + y;\n}\n`,
        },
        'comment tweak',
      );

      expect(runCommitModeIn(dir, [parent, sha])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) exits 1 for a real-code .ts change between two real commits', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(dir, { 'a.ts': `export function add(x: number, y: number): number {\n  return x + y;\n}\n` }, 'base');
      const sha = commitFiles(dir, { 'a.ts': `export function add(x: number, y: number): number {\n  return x - y;\n}\n` }, 'real change');

      expect(runCommitModeIn(dir, [parent, sha])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) exits 1 when a changed file is a *.test.ts, even if its own edit is comment-only', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(
        dir,
        { 'a.ts': 'export const x = 1;\n', 'a.test.ts': `// old\nexport const t = 1;\n` },
        'base',
      );
      const sha = commitFiles(
        dir,
        { 'a.ts': 'export const x = 1;\n', 'a.test.ts': `// NEW\nexport const t = 1;\n` },
        'touch test file',
      );

      expect(runCommitModeIn(dir, [parent, sha])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) exits 1 when a changed file — including a non-TS file, per I1 — is outside the --allow globs', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(
        dir,
        { 'a.ts': `export const x = 1; // old\n`, 'package.json': '{"version":"1.0.0"}\n' },
        'base',
      );
      const sha = commitFiles(
        dir,
        { 'a.ts': `export const x = 1; // NEW\n`, 'package.json': '{"version":"1.0.1"}\n' },
        'comment tweak + version bump',
      );

      // a.ts is comment-only, but package.json is a non-TS file and is not
      // covered by the --allow list, so the whole commit must fail.
      expect(runCommitModeIn(dir, [parent, sha, '--allow', 'a.ts'])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when the non-TS file is explicitly covered by --allow (I1 positive case)', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(
        dir,
        { 'a.ts': `export const x = 1; // old\n`, 'package.json': '{"version":"1.0.0"}\n' },
        'base',
      );
      const sha = commitFiles(
        dir,
        { 'a.ts': `export const x = 1; // NEW\n`, 'package.json': '{"version":"1.0.1"}\n' },
        'comment tweak + version bump',
      );

      expect(runCommitModeIn(dir, [parent, sha, '--allow', 'a.ts', 'package.json'])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 for a commit that changes ONLY a non-TS file, with no --allow (I1 — the original false-safe)', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(dir, { 'a.ts': 'export const x = 1;\n', 'package.json': '{"version":"1.0.0"}\n' }, 'base');
      const sha = commitFiles(dir, { 'a.ts': 'export const x = 1;\n', 'package.json': '{"version":"1.0.1"}\n' }, 'version bump only');

      // Before I1, changedTsFiles would be empty here, the loop over it
      // would do nothing, and the script would wrongly exit 0.
      expect(runCommitModeIn(dir, [parent, sha])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(M3) --allow with zero globs following it is a usage error (exit 2)', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(dir, { 'a.ts': 'export const x = 1;\n' }, 'base');
      const sha = commitFiles(dir, { 'a.ts': 'export const x = 1; // comment\n' }, 'comment');

      expect(runCommitModeIn(dir, [parent, sha, '--allow'])).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(M4) "?" in an --allow glob matches exactly one non-slash character', () => {
    const dir = initFixtureRepo();
    try {
      const parent = commitFiles(
        dir,
        { 'a.ts': 'export const x = 1; // old\n', 'notes.json': '{"a":1}\n' },
        'base',
      );
      const sha = commitFiles(
        dir,
        { 'a.ts': 'export const x = 1; // new\n', 'notes.json': '{"a":2}\n' },
        'comment tweak + notes edit',
      );

      // Before the fix, '?' leaked into the regex as a JS quantifier making
      // the preceding char optional, so 'note?.json' would NOT match the
      // 5-character stem 'notes' and this would wrongly exit 1.
      expect(runCommitModeIn(dir, [parent, sha, '--allow', 'a.ts', 'note?.json'])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
