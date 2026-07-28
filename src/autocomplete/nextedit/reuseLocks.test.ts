import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectNonTestTsSources, type ScannableSource } from '../../host/purityScan';

/**
 * Task 11 Step 2 — the two source-scan locks the brief pins:
 *
 *  1. The literal `num_ctx` appears NOWHERE under `src/autocomplete/`
 *     outside comments (Global Constraints: "No Hermes code ever sends
 *     `num_ctx`. Locked by a source-scan test (Task 11)."). Comments are
 *     allowed to name the token in prose (e.g. this file's own doc
 *     comments, or a future backend explaining why it does NOT send the
 *     field) — the ban is on the token reaching a body literal, i.e. real
 *     code.
 *  2. Every `nextedit/` file that calls `fetch(` also calls BOTH
 *     `assertSecureAuthTransport(` and `mintScannedNextEditRequest(` — the
 *     `nextedit/`-scoped extension of `assertAllScannedLock.test.ts`'s /
 *     `authGuardLock.test.ts`'s directory-sweep idiom
 *     (`../backends/assertAllScannedLock.test.ts`,
 *     `../backends/authGuardLock.test.ts`), reusing the SAME shared walker
 *     (`collectNonTestTsSources`, `src/host/purityScan.ts`) those locks are
 *     built on. Both mechanisms are the same "blunt TOKEN-PRESENCE text
 *     scan, re-read from disk on every run" shape those files document at
 *     length — same accepted residual: it does NOT prove the two calls are
 *     on the SAME request path, only that neither is silently ABSENT from
 *     a file that egresses.
 */

const AUTOCOMPLETE_ROOT = join(__dirname, '..');
const NEXTEDIT_ROOT = __dirname;

/**
 * Strips `/* ... *\/` block comments and `// ...` line comments before the
 * scan — deliberately crude (no string-literal awareness, same "blunt
 * regex, not an AST" posture as every other purity guard in this repo,
 * `src/host/purityScan.ts`'s module doc). Good enough to let this file's
 * OWN doc comments (and a future backend's explanatory comment) mention
 * `num_ctx` in prose without self-tripping the lock.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('LOCK: num_ctx never reaches real code under src/autocomplete/ (Global Constraints)', () => {
  it('the literal num_ctx appears NOWHERE under src/autocomplete/ outside comments', () => {
    const offenders = collectNonTestTsSources(AUTOCOMPLETE_ROOT)
      .filter((f) => stripComments(f.content).includes('num_ctx'))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('the comment-stripper is not a no-op that would rubber-stamp everything (sanity check on the mechanism itself)', () => {
    const withCode = 'const options = { num_ctx: 4096 };';
    expect(stripComments(withCode).includes('num_ctx')).toBe(true);

    const withLineComment = '// never send num_ctx here\nconst options = {};';
    expect(stripComments(withLineComment).includes('num_ctx')).toBe(false);

    const withBlockComment = '/* num_ctx is a server-side-only lever */\nconst options = {};';
    expect(stripComments(withBlockComment).includes('num_ctx')).toBe(false);
  });

  it('RED-first proof: a synthetic in-memory offender IS flagged by the same predicate the real assertion uses (zero disk I/O)', () => {
    const withInjectedViolation: ScannableSource[] = [
      ...collectNonTestTsSources(AUTOCOMPLETE_ROOT),
      { file: 'nextedit/__num_ctx_probe__.ts', content: 'const options = { num_ctx: 8192 };\n' },
    ];
    const offenders = withInjectedViolation
      .filter((f) => stripComments(f.content).includes('num_ctx'))
      .map((f) => f.file);

    expect(offenders).toContain('nextedit/__num_ctx_probe__.ts');
  });

  it('negative control: a synthetic entry that only MENTIONS num_ctx in a comment is not flagged', () => {
    const withCommentOnly: ScannableSource[] = [
      ...collectNonTestTsSources(AUTOCOMPLETE_ROOT),
      { file: 'nextedit/__num_ctx_probe__.ts', content: '// this backend deliberately never sends num_ctx\nconst options = {};\n' },
    ];
    const offenders = withCommentOnly
      .filter((f) => stripComments(f.content).includes('num_ctx'))
      .map((f) => f.file);

    expect(offenders).not.toContain('nextedit/__num_ctx_probe__.ts');
  });
});

interface NextEditSource {
  readonly file: string;
  readonly content: string;
}

const FETCH_PATTERN = /\bfetch\s*\(/;
const ASSERT_SECURE_AUTH_TRANSPORT_PATTERN = /\bassertSecureAuthTransport\s*\(/;
const MINT_PATTERN = /\bmintScannedNextEditRequest\s*\(/;

/**
 * Finding 4 (reworded — the previous wording said `scan.ts` was "Excluded
 * here", which was FALSE): this set is EMPTY. It excludes nothing today.
 * `scan.ts` itself DECLARES `mintScannedNextEditRequest` (the `export
 * function mintScannedNextEditRequest(` line) but never calls `fetch(` — it
 * passes this lock purely because it contains no `fetch(` call at all
 * (verified by the sanity test below), NOT because it, or anything else, is
 * named in this set. Do not read an empty set as "nothing needs an entry
 * yet, so removing one is safe" — there is nothing to remove. This set
 * exists as a NAMED escape hatch for a FUTURE genuinely-safe non-egress
 * `nextedit/` helper that calls `fetch(` without being a real transport,
 * mirroring `assertAllScannedLock.test.ts`'s/`authGuardLock.test.ts`'s own
 * `ALLOWLIST` idiom of naming known-safe exceptions explicitly rather than
 * leaving a future reader to guess. Add an entry here ONLY with the same
 * explicit justification those files require — never to silence a real
 * violation.
 */
const ALLOWLIST = new Set<string>([]);

function loadNextEditSources(): NextEditSource[] {
  return collectNonTestTsSources(NEXTEDIT_ROOT);
}

function fetchWithoutBothGuards(files: readonly NextEditSource[]): string[] {
  return files
    .filter((f) => !ALLOWLIST.has(f.file))
    .filter((f) => {
      // Finding 1: strip comments BEFORE matching, same as the sibling
      // num_ctx lock above — otherwise a doc comment that merely SPELLS a
      // guard call (with parentheses, e.g. this file's own backend.ts
      // header) satisfies the pattern with zero real guard call present.
      const stripped = stripComments(f.content);
      return (
        FETCH_PATTERN.test(stripped) &&
        (!ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test(stripped) || !MINT_PATTERN.test(stripped))
      );
    })
    .map((f) => f.file);
}

describe('LOCK: every nextedit/ file that calls fetch( also calls assertSecureAuthTransport( and mintScannedNextEditRequest(', () => {
  it('discovers all current nextedit/ source files (non-vacuous file discovery)', () => {
    const files = loadNextEditSources().map((f) => f.file);
    for (const expected of [
      'types.ts',
      'scan.ts',
      'mode.ts',
      'config.ts',
      'anchors.ts',
      'fsm.ts',
      'backend.ts',
      'formats/types.ts',
      'formats/shared.ts',
      'formats/sweepV2.ts',
      'formats/genericInstruct.ts',
      // Task 12 — the Guard and the shell. Both are deliberate additions to
      // this pin: the count is a tripwire that forces every new `nextedit/`
      // file to be looked at by the fetch/guard lock below, not a constant
      // to bump reflexively. Neither of these two calls `fetch(` (the shell
      // reaches the wire only THROUGH `backend.ts`), which is what the
      // "no other nextedit/ file contains fetch( at all today" sanity test
      // below re-verifies from disk on every run.
      'guard.ts',
      'shell.vscode.ts',
      // V-1 fix — `fileWindow.ts`, a new pure helper (no `fetch(` call at
      // all, verified by the "no other nextedit/ file contains fetch("
      // sanity test below). Named here per this pin's own stated purpose:
      // force every new `nextedit/` file through this lock rather than
      // bumping the count reflexively — it was looked at, and it is clean.
      'fileWindow.ts',
    ]) {
      expect(files).toContain(expected);
    }
    expect(files.length).toBe(14);
  });

  it('no non-allowlisted nextedit/ file contains fetch( without also calling BOTH assertSecureAuthTransport( and mintScannedNextEditRequest( (the real lock)', () => {
    expect(fetchWithoutBothGuards(loadNextEditSources())).toEqual([]);
  });

  it('sanity: backend.ts DOES contain fetch( plus both guards (the rule is exercised for real, not vacuously true)', () => {
    const sources = loadNextEditSources();
    const source = sources.find((f) => f.file === 'backend.ts');
    expect(source).toBeDefined();
    expect(FETCH_PATTERN.test(source?.content ?? '')).toBe(true);
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test(source?.content ?? '')).toBe(true);
    expect(MINT_PATTERN.test(source?.content ?? '')).toBe(true);
  });

  it('sanity: no other nextedit/ file contains fetch( at all today (grounds the empty-allowlist decision)', () => {
    const sources = loadNextEditSources();
    for (const source of sources) {
      if (source.file === 'backend.ts') continue;
      expect(FETCH_PATTERN.test(source.content), `unexpected fetch( in ${source.file}`).toBe(false);
    }
  });

  it('the guard patterns actually match realistic call shapes, incl. a whitespace-before-paren evasion form (sanity check on the mechanism itself)', () => {
    expect(FETCH_PATTERN.test('const response = await fetch(url, opts);')).toBe(true);
    expect(FETCH_PATTERN.test('await fetch (url);')).toBe(true);
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test('assertSecureAuthTransport(url, !!apiKey);')).toBe(true);
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test('assertSecureAuthTransport (url, hasKey);')).toBe(true);
    expect(MINT_PATTERN.test('mintScannedNextEditRequest(req, sentinels);')).toBe(true);
    expect(MINT_PATTERN.test('mintScannedNextEditRequest (req, sentinels);')).toBe(true);
    // Negative control: mere prose mention of any of the three must not match a call.
    expect(FETCH_PATTERN.test('// this helper never fetches anything')).toBe(false);

    // Finding 1 (strengthened control): a doc comment that spells the call
    // WITH parentheses — the EXACT shape backend.ts's own header comment uses
    // ("assertSecureAuthTransport(url, !!apiKey)" / "mintScannedNextEditRequest(req,
    // sentinels)") — is what actually fooled fetchWithoutBothGuards before the
    // stripComments() fix above: the raw pattern DOES match it (proven here),
    // so only stripping comments first makes it correctly NOT count as a real
    // call. If the stripComments() step were ever reverted, the second
    // assertion in each pair below would flip to `true` and fail.
    const parenthesizedAuthComment = '// see assertSecureAuthTransport(url, apiKey) for the backstop';
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test(parenthesizedAuthComment)).toBe(true);
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test(stripComments(parenthesizedAuthComment))).toBe(false);

    const parenthesizedMintComment = '// see mintScannedNextEditRequest(req, sentinels) for the mint';
    expect(MINT_PATTERN.test(parenthesizedMintComment)).toBe(true);
    expect(MINT_PATTERN.test(stripComments(parenthesizedMintComment))).toBe(false);
  });

  /**
   * RED-first non-vacuous proof, IN-MEMORY (no disk write into `nextedit/`
   * itself) — same H6-B9 discipline `assertAllScannedLock.test.ts`/
   * `authGuardLock.test.ts` already document at length: appending a
   * synthetic entry to the REAL, already-collected file list proves the
   * predicate fires without racing any concurrently-writing probe test in
   * a sibling directory.
   */
  it('flags a hypothetical future nextedit file that fetches but forgets BOTH guards', () => {
    const withInjectedViolation: NextEditSource[] = [
      ...loadNextEditSources(),
      {
        file: '__hypothetical_future_transport__.ts',
        content: 'const response = await fetch(url, { method: "POST", body });',
      },
    ];
    expect(fetchWithoutBothGuards(withInjectedViolation)).toContain('__hypothetical_future_transport__.ts');
  });

  it('flags a hypothetical file that has ONE guard but not the other (both are required, not either-or)', () => {
    const withOnlyOneGuard: NextEditSource[] = [
      ...loadNextEditSources(),
      {
        file: '__hypothetical_partial_guard__.ts',
        content: 'assertSecureAuthTransport(url, !!apiKey);\nconst response = await fetch(url, opts);',
      },
    ];
    expect(fetchWithoutBothGuards(withOnlyOneGuard)).toContain('__hypothetical_partial_guard__.ts');
  });

  it('does NOT flag the same hypothetical file once it calls BOTH guards (negative control)', () => {
    const withBothGuards: NextEditSource[] = [
      ...loadNextEditSources(),
      {
        file: '__hypothetical_future_transport__.ts',
        content:
          'assertSecureAuthTransport(url, !!apiKey);\n' +
          'mintScannedNextEditRequest(req, sentinels);\n' +
          'const response = await fetch(url, opts);',
      },
    ];
    expect(fetchWithoutBothGuards(withBothGuards)).not.toContain('__hypothetical_future_transport__.ts');
  });
});
