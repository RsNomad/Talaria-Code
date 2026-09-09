#!/usr/bin/env node
/**
 * W0-0 (round-2 DEFER close-out program pre-flight) — a "comment-only diff"
 * gate for a LATER workstream (WS-F13, FI-01 comment-archaeology retirement)
 * to run on every commit that claims to touch ONLY comments.
 *
 * A `git diff -U0` regex gate is the obvious first idea and is WRONG: a
 * changed-code line inside a string literal that still happens to CONTAIN a
 * comment-review marker word (this repo's `AcpBackend.ts` has two such
 * literals) reads, to a line-based diff, exactly like a comment edit. This
 * script instead compares the two revisions' ASTs:
 *
 *   1. Parse each revision with `ts.createSourceFile`.
 *   2. Reprint each with `ts.createPrinter({ removeComments: true })`.
 *   3. Require the two printed strings to be BYTE-EQUAL.
 *
 * Printer-equality is immune to whitespace/formatting churn inside comments
 * and to a rewritten comment that happens to contain a code-shaped word,
 * because it never looks at comment text at all — it only compares the
 * code structure that survives `removeComments: true`.
 *
 * That check has exactly one known blind spot (critic finding I-11):
 * `removeComments: true` strips EVERY comment before comparing, including a
 * newly ADDED `@ts-ignore`/`@ts-nocheck`/etc. pragma. A pragma comment
 * changes compiler or tooling BEHAVIOUR, not just prose — an added
 * `@ts-ignore` would silence a real type error at that line — yet it would
 * pass both this printer check AND `tsc` (which only ever sees the
 * suppressed error, never the suppression itself as a diff). This repo has
 * no ESLint to catch that separately, so this script ALSO extracts the
 * MULTISET of pragma-bearing comments per file and fails on any change,
 * regardless of what the printer check concluded.
 *
 * The multiset check is deliberately order-insensitive: a pragma comment
 * that is only MOVED (deleted from one line and re-added, verbatim, on a
 * different line of the same file) still passes it, since the multiset of
 * pragma text is unchanged. That residual gap is backstopped by the
 * per-commit `tsc` run in `npm run gate`: the surrounding code is
 * byte-identical (this script already proved that), so `tsc`'s error set
 * for the file is fixed, and a pragma moved to no-longer-cover its original
 * error (a stray `@ts-ignore`, or an `@ts-expect-error` no longer preceding
 * any error) resurfaces immediately as a red `tsc` run rather than silently
 * passing this gate.
 *
 * Usage:
 *   node scripts/assert-comment-only-diff.mjs --commit <parent> <sha> [--allow <glob>...]
 *     For every file changed between <parent> and <sha> (`git diff
 *     --name-only`, run in the CURRENT working directory — invoke this from
 *     the repository root, or point it at another repo via `cwd` for
 *     testing):
 *       - `.ts`/`.tsx` files: fetch both revisions via `git show
 *         <rev>:<path>` and run the two checks above; when `--allow` globs
 *         are given, also require the file to match at least one of them.
 *       - every OTHER changed file (e.g. `package.json`, `*.mjs`, `*.yml`):
 *         a comment-only commit has no legitimate reason to touch a
 *         non-TypeScript file, so each one is UNCONDITIONALLY required to
 *         be covered by an `--allow` glob — with none given, or none
 *         matching, the commit fails. (Its content is not further
 *         inspected: a non-TS file cannot be run through the TS printer.)
 *       - fail if any changed file is `*.test.ts` / `*.test.tsx` (a
 *         comment-only commit must not touch tests).
 *
 *   node scripts/assert-comment-only-diff.mjs --files <a.ts> <b.ts>
 *     Self-test mode: run the same two checks against two files already on
 *     disk. Used by `src/tooling/assertCommentOnlyDiff.test.ts` so the
 *     vitest suite needs no git fixtures or a real commit pair.
 *
 * Exit code is 0 iff every check passes; 2 on a usage error; otherwise 1,
 * with one printed reason per failing check.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

/**
 * Comments carrying any of these markers change compiler or tooling
 * BEHAVIOUR (a suppressed type error, a skipped coverage line, a disabled
 * formatter run, ...), not just prose — `removeComments: true` strips them
 * from the printer-equality check above, so they need their own gate.
 *
 * The coverage-tool markers are matched as their real DIRECTIVE forms
 * (`c8 ignore`, `v8 ignore`, `istanbul ignore`), not the bare tool names —
 * matching bare `c8`/`v8`/`istanbul` as substrings would also flag ordinary
 * prose that merely mentions the word (e.g. "a v8 engine quirk"), and
 * editing or deleting such a comment would then spuriously fail this gate.
 */
const PRAGMA_MARKERS = Object.freeze([
  '@ts-ignore',
  '@ts-nocheck',
  '@ts-expect-error',
  '/// <reference',
  '@__PURE__',
  '@vitest-environment',
  '@jsx',
  'prettier-ignore',
  'c8 ignore',
  'v8 ignore',
  'istanbul ignore',
]);

/** Parse `sourceText` and reprint it with every comment stripped. */
function printedCodeOnly(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printFile(sourceFile);
}

/**
 * Every real comment token in `sourceText` (single-line and block), found
 * via the TypeScript scanner rather than a text regex so that a string
 * literal containing `//` or `/*` never counts as a comment.
 */
function extractAllComments(sourceText) {
  const comments = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sourceText);
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push(scanner.getTokenText());
    }
    kind = scanner.scan();
  }
  return comments;
}

/** The sorted list (multiset representation) of pragma-bearing comments. */
function pragmaMultiset(sourceText) {
  return extractAllComments(sourceText)
    .filter((comment) => PRAGMA_MARKERS.some((marker) => comment.includes(marker)))
    .sort();
}

function multisetsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compares one file's two revisions. Returns an array of human-readable
 * failure reasons — empty iff the file's diff is comment-only.
 */
function compareRevisions(label, fileNameBefore, textBefore, fileNameAfter, textAfter) {
  const reasons = [];

  const printedBefore = printedCodeOnly(fileNameBefore, textBefore);
  const printedAfter = printedCodeOnly(fileNameAfter, textAfter);
  if (printedBefore !== printedAfter) {
    reasons.push(`${label}: code differs once comments are removed (not a comment-only change)`);
  }

  const pragmaBefore = pragmaMultiset(textBefore);
  const pragmaAfter = pragmaMultiset(textAfter);
  if (!multisetsEqual(pragmaBefore, pragmaAfter)) {
    reasons.push(
      `${label}: pragma-bearing comment set changed — before=${JSON.stringify(pragmaBefore)} after=${JSON.stringify(pragmaAfter)}`,
    );
  }

  return reasons;
}

/**
 * Minimal glob→RegExp: `**` matches across `/`, `*` matches within a
 * segment, `?` matches exactly one non-`/` character (NOT a regex
 * "zero-or-one" quantifier — left unescaped it would otherwise leak
 * straight into the compiled pattern as one).
 */
/**
 * Escape every RegExp metacharacter in a literal so it matches verbatim — a
 * standard escapeRegExp sanitizer (js/regex-injection). The `--allow` globs
 * arrive as command-line arguments, so their literal characters MUST be
 * escaped before they reach `new RegExp`; the `*`/`?` wildcards are translated
 * to fixed safe fragments by the caller and never pass through here raw.
 */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function globToRegExp(glob) {
  let pattern = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (ch === '?') {
      pattern += '[^/]';
    } else {
      // Every non-wildcard character is escaped through escapeRegExp so no
      // metacharacter from the CLI-supplied glob leaks into the compiled
      // pattern; combined with the fixed wildcard fragments above (and no
      // nested quantifiers), the result is injection- and ReDoS-safe.
      pattern += escapeRegExp(ch);
    }
  }
  pattern += '$';
  return new RegExp(pattern);
}

function isTestPath(filePath) {
  const base = path.basename(filePath);
  return base.endsWith('.test.ts') || base.endsWith('.test.tsx');
}

function runFilesMode(args) {
  if (args.length !== 2) {
    console.error('Usage: assert-comment-only-diff.mjs --files <a.ts> <b.ts>');
    return 2;
  }
  const [pathA, pathB] = args;
  const textA = readFileSync(pathA, 'utf8');
  const textB = readFileSync(pathB, 'utf8');

  const reasons = compareRevisions(`${pathA} vs ${pathB}`, pathA, textA, pathB, textB);
  if (reasons.length > 0) {
    for (const reason of reasons) console.error(reason);
    return 1;
  }
  console.log(`OK: ${pathA} and ${pathB} are comment-only-equivalent`);
  return 0;
}

function gitShow(rev, filePath) {
  return execFileSync('git', ['show', `${rev}:${filePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runCommitMode(args) {
  const [parent, sha, ...rest] = args;
  if (!parent || !sha) {
    console.error('Usage: assert-comment-only-diff.mjs --commit <parent> <sha> [--allow <glob>...]');
    return 2;
  }

  let allowGlobs = [];
  if (rest.length > 0) {
    if (rest[0] !== '--allow') {
      console.error('Usage: assert-comment-only-diff.mjs --commit <parent> <sha> [--allow <glob>...]');
      return 2;
    }
    allowGlobs = rest.slice(1);
    if (allowGlobs.length === 0) {
      console.error('Usage error: --allow requires at least one glob argument');
      return 2;
    }
  }
  const allowRegexes = allowGlobs.map(globToRegExp);

  const diffOutput = execFileSync('git', ['diff', '--name-only', parent, sha], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const changedFiles = diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const changedTsFiles = changedFiles.filter((filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'));
  const changedNonTsFiles = changedFiles.filter((filePath) => !filePath.endsWith('.ts') && !filePath.endsWith('.tsx'));

  const reasons = [];

  for (const filePath of changedTsFiles) {
    if (isTestPath(filePath)) {
      reasons.push(`${filePath}: a comment-only commit must not touch test files`);
    }
  }

  if (allowGlobs.length > 0) {
    for (const filePath of changedTsFiles) {
      if (!allowRegexes.some((regex) => regex.test(filePath))) {
        reasons.push(`${filePath}: not covered by any --allow glob`);
      }
    }
  }

  // A comment-only commit has no legitimate reason to touch a non-TS file
  // (package.json, a .mjs script, a .yml workflow, ...). Unlike the .ts
  // allow-check above, this one is unconditional: with zero --allow globs,
  // ANY changed non-TS file fails the gate — that is the whole point (a
  // commit that changes ONLY non-TS files must not exit 0).
  for (const filePath of changedNonTsFiles) {
    if (!allowRegexes.some((regex) => regex.test(filePath))) {
      reasons.push(
        `${filePath}: non-TS file changed — comment-only commits may only touch .ts/.tsx files unless explicitly covered by --allow`,
      );
    }
  }

  for (const filePath of changedTsFiles) {
    if (isTestPath(filePath)) continue;

    let textBefore;
    try {
      textBefore = gitShow(parent, filePath);
    } catch {
      reasons.push(`${filePath}: does not exist at ${parent} (added file — not a comment-only change)`);
      continue;
    }

    let textAfter;
    try {
      textAfter = gitShow(sha, filePath);
    } catch {
      reasons.push(`${filePath}: does not exist at ${sha} (deleted file — not a comment-only change)`);
      continue;
    }

    reasons.push(...compareRevisions(filePath, filePath, textBefore, filePath, textAfter));
  }

  if (reasons.length > 0) {
    for (const reason of reasons) console.error(reason);
    return 1;
  }
  console.log(
    `OK: ${changedTsFiles.length} changed .ts/.tsx file(s) are comment-only between ${parent} and ${sha}` +
      `${changedNonTsFiles.length > 0 ? ` (${changedNonTsFiles.length} non-TS file(s) explicitly --allow-listed)` : ''}`,
  );
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];

  if (mode === '--files') {
    process.exitCode = runFilesMode(argv.slice(1));
    return;
  }
  if (mode === '--commit') {
    process.exitCode = runCommitMode(argv.slice(1));
    return;
  }

  console.error(
    'Usage:\n' +
      '  node scripts/assert-comment-only-diff.mjs --commit <parent> <sha> [--allow <glob>...]\n' +
      '  node scripts/assert-comment-only-diff.mjs --files <a.ts> <b.ts>',
  );
  process.exitCode = 2;
}

main();
