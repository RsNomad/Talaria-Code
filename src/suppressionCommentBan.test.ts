import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectAllTsSources } from './host/purityScan';

/**
 * Task 6.2 fix wave — review finding C-1 (Critical).
 *
 * THE HOLE THIS CLOSES. `src/host/backend/acp/types.test-d.ts` carries a
 * battery of counted `expectTypeOf` locks (task 6.2, GUARD-INTEGRITY.md §9;
 * ten at the time of the review below, more since) whose own header claimed
 * "No assertion in this file can be simultaneously present and false." That
 * claim was false: inserting `// @ts-nocheck` as the file's line 1 (when it
 * had exactly ten locks — reproduced personally, not just cited) made all
 * ten assertions present and false, with **zero** movement in either gate
 * command — `npm test` still reported `Tests 10 passed (10)` / `Type Errors
 * no errors`, and `npm run check-types` still exited 0. `@ts-nocheck`
 * disables the checker for the WHOLE file before a single assertion is
 * evaluated, so vitest's typecheck runner sees no diagnostics to fail on —
 * the counted-suite mechanism (deletion moves the count, violation goes
 * RED) has nothing to react to, because from tsc's point of view nothing
 * was checked at all. `@ts-ignore` does the same per-line: silences the one
 * diagnostic below it, present or not. This defect is independent of the
 * exact lock count — adding or removing locks in `types.test-d.ts` never
 * changes whether `@ts-nocheck`/`@ts-ignore` can silence all of them at
 * once, which is why this ban scans by CONTENT, not by count.
 *
 * WHY THIS IS THE RIGHT POLARITY. A scan that BANS a pattern fails CLOSED
 * when it is blind to a file (a spurious RED on an innocent file is merely
 * noisy); a scan that requires PRESENCE of a pattern fails OPEN when blind
 * (a scanner that can't find "the guard" says nothing is wrong, precisely
 * when something is). `commandParity.test.ts` shipped a Critical on exactly
 * this distinction. Banning `@ts-nocheck`/`@ts-ignore` is a BAN — the right
 * family — mirroring `purityScan.ts`'s own `VSCODE_IMPORT_BAN`/
 * `FS_IMPORT_BAN` and this file's sibling scans (`contextPurity.test.ts`,
 * `assertAllScannedLock.test.ts`, `lspInvariant.test.ts`): a blunt,
 * hard-to-fool TEXT scan, re-read from disk on every run, not an
 * AST/semantic analysis.
 *
 * WHAT IS BANNED, AND WHY NOT MORE.
 *  - `@ts-nocheck` and `@ts-ignore` (in either a `//` line comment or a
 *    `/* … *\/` block comment — BOTH forms were verified locally to actually
 *    suppress a real `tsc --strict` error for `@ts-ignore`; only the `//`
 *    form suppresses for `@ts-nocheck`, but the block form is banned anyway
 *    because it reads as a working suppression to a human and is exactly
 *    the kind of comment that lies about what it does, which this whole
 *    task programme exists to eliminate). BAN polarity means over-banning a
 *    dead block-comment spelling costs nothing but a false alarm.
 *  - `@ts-expect-error` is DELIBERATELY NOT banned. Unlike the other two, it
 *    is self-policing: `tsc` reports "Unused '@ts-expect-error' directive"
 *    the moment the line below it stops erroring (verified in this task's
 *    own Plant 3 re-run and by V10 in GUARD-INTEGRITY.md) — it cannot rot in
 *    place the way `@ts-nocheck`/`@ts-ignore` can, and `types.test-d.ts`
 *    itself legitimately uses one as half of a deliberate redundant pair.
 *    Banning it would break a real, correct guard for no safety gain.
 *  - `eslint-disable` is DELIBERATELY NOT banned. `package.json` has no
 *    `lint` script and no `eslint`/`@typescript-eslint/*` devDependency
 *    (verified: `grep -c eslint package.json` → 0) — nothing in this repo's
 *    gate ever reads an `eslint-disable` comment, so banning it protects
 *    nothing today and would itself be an unverified assurance about a tool
 *    that isn't installed. Add it here the day ESLint is wired into the
 *    gate, not before.
 *
 * SCOPE: `src/` AND `webview/src/`, both walked with the SAME
 * {@link collectAllTsSources} call from this one file (a plain Node `fs`
 * walk needs no vitest project wiring to reach either tree — this test
 * itself runs under the `host` project by virtue of its own `src/*.test.ts`
 * path, same as `purityScan.test.ts`'s existing `src/`-wide scan). `src/`
 * is where the counted-guard family C-1 falls on actually lives today.
 * `webview/src/` is included too even though — separately, per task 6.2
 * review finding I-1 — no `.test-d.ts` file placed there was collected by
 * ANY gate command before this fix wave: an `@ts-nocheck` sitting in
 * webview source is exactly as deceptive as one under `src/`, costs nothing
 * extra to also ban (verified zero exemptions needed there too, same as
 * `src/`), and stays correctly scoped once I-1's webview typecheck wiring
 * makes a future webview `.test-d.ts` file a real counted guard.
 *
 * ZERO EXEMPTIONS TODAY, VERIFIED HERE, NOT JUST ASSERTED: the "real lock"
 * test below asserts the offender list is `[]` against the ACTUAL repo
 * tree, re-read on every run — if that ever needs an allowlist entry, the
 * assertion itself will say so by failing, not by a stale comment claiming
 * cleanliness.
 *
 * SELF-REFERENCE: this file is itself collected by its own scan (`src/`
 * includes it) — deliberately not excluded, the same "the walk sees the
 * tree it's standing in" proof `testTopology.lock.test.ts` and
 * `purityScan.test.ts` already use. The ban pattern is ANCHORED to the
 * start of a (trimmed) line — `^\s*(?:\/\/|\/\*)\s*@ts-(?:nocheck|ignore)\b`
 * — mirroring how `tsc` itself only honors these directives as the first
 * token of a comment, not anywhere a comment mentions them in prose. Every
 * mention of the banned tokens in THIS file's own doc comments above is
 * inside a `*`-continuation line of a `/** … *\/` block (never the line's
 * first token) or inside a quoted string literal in the code below (never a
 * real `//`/`/*` line-opener in this file's own source text) — the sanity
 * test near the bottom proves the pattern does not confuse the two.
 */

const SRC_ROOT = join(__dirname);
const WEBVIEW_SRC_ROOT = join(__dirname, '..', 'webview', 'src');

/**
 * Matches a suppression directive only when it is the FIRST token of a
 * (trimmed) line's comment opener — `//` or `/*` — followed by
 * `@ts-nocheck` or `@ts-ignore`. This is what makes the scan self-exempting
 * for this file's own prose: a JSDoc continuation line starts with `*`, not
 * `//`/`/*`, so a paragraph ABOUT the banned tokens never matches the thing
 * it describes. Verified empirically against real `tsc --strict` (not
 * assumed): a `// @ts-ignore` line suppresses; a `/* @ts-ignore *\/` line
 * ALSO suppresses; a `/* @ts-nocheck *\/` line does NOT suppress (only the
 * `//` form does) — banned anyway, see module doc.
 */
const SUPPRESSION_COMMENT_BAN = /^\s*(?:\/\/|\/\*)\s*@ts-(?:nocheck|ignore)\b/;

/**
 * Each root's `file` is relative to ITSELF (`collectAllTsSources`'s own
 * contract), so `src/foo.ts` and `webview/src/foo.ts` would otherwise
 * collide into the same bare `foo.ts` label. Re-prefixing with the root
 * name keeps a future failure message unambiguous about which tree it's in
 * (M-2's diagnosability lesson from this same review: a message that can't
 * name its offender precisely is a defect in its own right).
 */
function collectBanScope() {
  const srcFiles = collectAllTsSources(SRC_ROOT).map((f) => ({ ...f, file: `src/${f.file}` }));
  const webviewFiles = collectAllTsSources(WEBVIEW_SRC_ROOT).map((f) => ({ ...f, file: `webview/src/${f.file}` }));
  return [...srcFiles, ...webviewFiles];
}

/** One match per offending LINE (file + 1-based line number), so a failure
 *  names the exact file and line — never just a boolean. */
function findSuppressionComments(files: readonly { file: string; content: string }[]) {
  const offenders: { file: string; line: number; snippet: string }[] = [];
  for (const source of files) {
    const lines = source.content.split('\n');
    for (const [index, lineText] of lines.entries()) {
      if (SUPPRESSION_COMMENT_BAN.test(lineText)) {
        offenders.push({ file: source.file, line: index + 1, snippet: lineText.trim() });
      }
    }
  }
  return offenders;
}

describe('suppressionCommentBan — no @ts-nocheck / @ts-ignore anywhere under src/ or webview/src/ (task 6.2 review C-1)', () => {
  it('reach: the walk discovers real files in both trees, including this file itself (non-vacuous file discovery)', () => {
    const files = collectBanScope();
    expect(files.length).toBeGreaterThan(150);
    expect(files.some((f) => f.file === 'src/suppressionCommentBan.test.ts')).toBe(true);
    expect(files.some((f) => f.file === 'src/host/backend/acp/types.test-d.ts')).toBe(true);
    // webview/src/ reach, proven by one file known to exist there today
    // (`purityScan.test.ts` proves reach into `src/` the same way — one
    // known file per scanned root, not just "the walk returned something").
    expect(files.some((f) => f.file === 'webview/src/bridge.ts')).toBe(true);
  });

  it('no file under src/ or webview/src/ contains a @ts-nocheck or @ts-ignore suppression directive (the real lock)', () => {
    const offenders = findSuppressionComments(collectBanScope());

    expect(
      offenders,
      'A suppression directive was found. This disables the type checker (whole-file for @ts-nocheck, ' +
        'one line for @ts-ignore) SILENTLY with respect to every counted gate command — the exact C-1 kill ' +
        'channel (task 6.2 review): the pinned test count and check-types exit code do not move. Remove the ' +
        'suppression and fix the underlying type error instead; if the checker is genuinely wrong here, use a ' +
        '`@ts-expect-error` with a comment naming why (self-policing — tsc errors if it goes unused).',
    ).toEqual([]);
  });

  it('the ban pattern matches realistic suppression shapes (both // and /* forms, both directives, with/without a leading space or indentation)', () => {
    expect(SUPPRESSION_COMMENT_BAN.test('// @ts-nocheck')).toBe(true);
    expect(SUPPRESSION_COMMENT_BAN.test('//@ts-nocheck')).toBe(true);
    expect(SUPPRESSION_COMMENT_BAN.test('  // @ts-ignore')).toBe(true);
    expect(SUPPRESSION_COMMENT_BAN.test('/* @ts-ignore */')).toBe(true);
    expect(SUPPRESSION_COMMENT_BAN.test('\t// @ts-nocheck — temporary, remove before merge')).toBe(true);
  });

  it('the ban pattern does NOT match prose that merely mentions the tokens, or @ts-expect-error (negative control — proves this is not "flag every mention")', () => {
    // A JSDoc continuation line — the shape every doc comment in this repo
    // (including this file's own module doc above) uses to discuss banned
    // tokens without becoming a false positive on itself.
    expect(SUPPRESSION_COMMENT_BAN.test(' * Bans @ts-nocheck and @ts-ignore in prose.')).toBe(false);
    expect(SUPPRESSION_COMMENT_BAN.test('/** @ts-nocheck */')).toBe(false);
    // Prose that happens to open with `//` but does not lead with the
    // directive is not a suppression and must not match.
    expect(SUPPRESSION_COMMENT_BAN.test('// This helper never suppresses type errors.')).toBe(false);
    // The expect-error directive is different — self-policing, deliberately unbanned (see module doc).
    // (Written as prose here, not as a real leading directive: tsc treats
    // ANY comment line starting with "// @ts-expect-error" as a live
    // directive regardless of the words after it, so testing this case
    // means putting the exact string inside a STRING LITERAL argument,
    // never as this file's own leading comment token, below.)
    expect(SUPPRESSION_COMMENT_BAN.test('// @ts-expect-error rawOutput is unknown, see types.test-d.ts')).toBe(
      false,
    );
  });

  /**
   * RED-first non-vacuous proof, IN-MEMORY (no disk write into `src/` or
   * `webview/src/`) — mirrors `contextPurity.test.ts`'s and
   * `purityScan.test.ts`'s own established pattern: append a synthetic
   * entry to the REAL, already-collected file list, proving the real walk
   * reaches both trees (discovery proven above) AND that the SAME filter
   * the real assertion uses actually flags an injected violation.
   */
  it('RED-first proof: a hypothetical file with @ts-nocheck as line 1 trips the ban (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectBanScope(),
      {
        file: 'src/host/backend/acp/__hypothetical_ts_nocheck__.test-d.ts',
        absPath: '',
        content: "// @ts-nocheck\nimport { expectTypeOf } from 'vitest';\nexpectTypeOf<number>().toBeNumber();\n",
      },
    ];
    const offenders = findSuppressionComments(withInjectedViolation).map((o) => o.file);
    expect(offenders).toContain('src/host/backend/acp/__hypothetical_ts_nocheck__.test-d.ts');
  });

  it('RED-first proof: a hypothetical per-line @ts-ignore also trips the ban', () => {
    const withInjectedViolation = [
      ...collectBanScope(),
      {
        file: 'src/host/backend/acp/__hypothetical_ts_ignore__.ts',
        absPath: '',
        content: '// @ts-ignore\nconst leaked: number = "not a number" as unknown as number;\n',
      },
    ];
    const offenders = findSuppressionComments(withInjectedViolation).map((o) => o.file);
    expect(offenders).toContain('src/host/backend/acp/__hypothetical_ts_ignore__.ts');
  });

  it('does NOT flag a hypothetical file that only uses @ts-expect-error (negative control on the REAL collected list)', () => {
    const withLegitimateDirective = [
      ...collectBanScope(),
      {
        file: 'src/host/backend/acp/__hypothetical_expect_error__.test-d.ts',
        absPath: '',
        content:
          "import { expectTypeOf } from 'vitest';\n" +
          '// @ts-expect-error deliberate — proves the pin, not a silencer\n' +
          'expectTypeOf<string>().toEqualTypeOf<number>();\n',
      },
    ];
    const offenders = findSuppressionComments(withLegitimateDirective).map((o) => o.file);
    expect(offenders).not.toContain('src/host/backend/acp/__hypothetical_expect_error__.test-d.ts');
  });
});
