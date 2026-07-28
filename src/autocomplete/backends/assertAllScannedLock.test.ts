import { describe, it, expect } from 'vitest';
import { collectNonTestTsSources } from '../../host/purityScan';

/**
 * W6-FD's `assertAllScanned` wire-adjacent egress backstop
 * (`context/assertAllScanned.ts`) is wired into all 5 FIM backends today, but
 * — unlike its peer W5 invariants (`CAST_RE`/`SPREAD_RE`/the factory-import
 * ban, all recursive static walks in `context/ringBuffer.test.ts`/
 * `context/scannedSnippetTestFactory.test.ts`) — its presence was enforced
 * only by convention + copied per-backend tests. `final-3way-2-arch.md`
 * finding I-5: "a 6th (future) FIM backend that POSTs snippets could forget
 * `assertAllScanned` and no test would catch it".
 *
 * This is that mechanized lock, in the same shape as `mcp/lsp/
 * lspInvariant.test.ts` ("the lsp lock" I-5's own recommendation names): a
 * blunt, hard-to-fool TEXT scan (no AST/semantic analysis) over every
 * non-test `.ts` file directly under `backends/` — re-read from disk on
 * every run (`collectNonTestTsSources`, the shared walker
 * `src/host/purityScan.ts` centralizes, W6-FK/I-9), so a future 6th backend
 * file's fetch-without-backstop status is picked up automatically by the
 * SCAN LOGIC with zero edits to it. (Mirror of the F-F correction in
 * `authGuardLock.test.ts:20-25`: that is narrower than "zero edits here" —
 * the exact-count sanity check below, `expect(files.length).toBe(7)` at
 * :102, DOES need bumping when the file count changes.) Because this is a
 * blunt text scan, a source file's OWN doc comments must never casually
 * mention `fetch(`/`assertAllScanned(` in prose — same accepted caveat every
 * existing scan in this repo already carries.
 *
 * Rule: any non-allowlisted file containing an egress call (`fetch(`) must
 * also contain the backstop call (`assertAllScanned(`). This is a
 * TOKEN-PRESENCE approximation, the same precision bar every peer lock in
 * this family uses (`CAST_RE`/`SPREAD_RE`/the factory-import ban) — it does
 * NOT prove the two calls are on the same request path. A file could call
 * `fetch` in one function and `assertAllScanned` in a wholly unrelated one
 * and this lock would not notice (documented residual, accepted at the same
 * bar as the peer scans; the real per-backend behavioral tests, W6-FD,
 * cover actual wiring correctness — this lock only guards against the
 * invariant being silently absent).
 */

interface BackendSource {
  readonly file: string;
  readonly content: string;
}

const BACKENDS_DIR = __dirname;

const FETCH_PATTERN = /\bfetch\s*\(/;
const ASSERT_ALL_SCANNED_PATTERN = /\bassertAllScanned\s*\(/;

/**
 * Known non-snippet-POSTing helpers, confirmed by reading every non-test
 * file in `backends/` (7 total: 5 FIM backends + these 2):
 *  - `http.ts` — SSE/NDJSON response STREAM PARSERS only
 *    (`readNdjsonLines`/`readSseEvents`); they consume an already-issued
 *    `Response`, never call `fetch` themselves and never touch
 *    `FimContext.snippets`.
 *  - `secureTransport.ts` — `assertSecureAuthTransport`, a pure
 *    transport-scheme guard (CWE-319) called BEFORE a backend's own
 *    `fetch`; it never calls `fetch` and never sees a snippet.
 * Neither currently contains `fetch(` at all (sanity-checked below) — the
 * allowlist exists to name the known-safe exception explicitly, the same
 * reason `ringBuffer.test.ts`'s `SANCTIONED_FILES`/`SANCTIONED_SPREAD_FILES`
 * name theirs, rather than leave a future author to guess why a file was
 * skipped. Residual (stated honestly, same bar as the peer locks): if
 * either helper is ever extended to itself POST snippets, the allowlist
 * would silently exempt it from this lock — this lock only covers the 5
 * backends' own egress today plus any FUTURE non-allowlisted file.
 */
const ALLOWLIST = new Set<string>(['http.ts', 'secureTransport.ts']);

function loadBackendSources(): BackendSource[] {
  return collectNonTestTsSources(BACKENDS_DIR);
}

/**
 * The mechanized lock itself (~15 lines): every non-allowlisted file that
 * contains a `fetch(` egress call but does NOT also contain an
 * `assertAllScanned(` call is an offender.
 */
function fetchWithoutAssertAllScanned(files: readonly BackendSource[]): string[] {
  return files
    .filter((f) => !ALLOWLIST.has(f.file))
    .filter((f) => FETCH_PATTERN.test(f.content) && !ASSERT_ALL_SCANNED_PATTERN.test(f.content))
    .map((f) => f.file);
}

describe('assertAllScannedLock — every backend egress (fetch) must also call assertAllScanned (I-5)', () => {
  it('discovers all 5 current FIM backends + the 2 allowlisted helpers (non-vacuous file discovery)', () => {
    const files = loadBackendSources().map((f) => f.file);
    for (const expected of [
      'CodestralFimBackend.ts',
      'LlamaCppInfillBackend.ts',
      'OllamaFimBackend.ts',
      'OpenAICompatFimBackend.ts',
      'VllmFimBackend.ts',
      'http.ts',
      'secureTransport.ts',
    ]) {
      expect(files).toContain(expected);
    }
    expect(files.length).toBe(7);
  });

  it('no non-allowlisted backend file contains fetch( without also containing assertAllScanned( (the real lock)', () => {
    expect(fetchWithoutAssertAllScanned(loadBackendSources())).toEqual([]);
  });

  it('sanity: all 5 real backends DO contain fetch( (the rule is exercised for real, not vacuously true)', () => {
    const sources = loadBackendSources();
    for (const name of [
      'CodestralFimBackend.ts',
      'LlamaCppInfillBackend.ts',
      'OllamaFimBackend.ts',
      'OpenAICompatFimBackend.ts',
      'VllmFimBackend.ts',
    ]) {
      const source = sources.find((f) => f.file === name);
      expect(source).toBeDefined();
      expect(FETCH_PATTERN.test(source?.content ?? '')).toBe(true);
      expect(ASSERT_ALL_SCANNED_PATTERN.test(source?.content ?? '')).toBe(true);
    }
  });

  it('sanity: the 2 allowlisted helpers do NOT currently contain fetch( (the exemption hides no live violation today)', () => {
    const sources = loadBackendSources();
    for (const name of ALLOWLIST) {
      const source = sources.find((f) => f.file === name);
      expect(source).toBeDefined();
      expect(FETCH_PATTERN.test(source?.content ?? '')).toBe(false);
    }
  });

  it('the guard patterns actually match realistic call shapes, incl. a whitespace-before-paren evasion form (sanity check on the mechanism itself)', () => {
    expect(FETCH_PATTERN.test('const response = await fetch(url, opts);')).toBe(true);
    expect(FETCH_PATTERN.test('await fetch (url);')).toBe(true);
    expect(ASSERT_ALL_SCANNED_PATTERN.test('assertAllScanned(req.context.snippets);')).toBe(true);
    expect(ASSERT_ALL_SCANNED_PATTERN.test('assertAllScanned (snippets);')).toBe(true);
    // Negative control: mere prose mention of either word must not match a call.
    expect(FETCH_PATTERN.test('// this helper never fetches anything')).toBe(false);
    expect(ASSERT_ALL_SCANNED_PATTERN.test('// see assertAllScanned for the backstop')).toBe(false);
  });
});

/**
 * RED-first non-vacuous proof, IN-MEMORY (no disk write into `backends/`
 * itself) — deliberately NOT the temp-file-on-disk pattern
 * `ringBuffer.test.ts`'s own I-5 probes use. `backends/` is the EXACT
 * directory those probes (`__brand_guard_cast_probe__.ts`,
 * `__brand_guard_spread_probe__.ts`) and `scannedSnippetTestFactory.test.ts`'s
 * own probe (`__factory_import_probe__.ts`) write real temp files into,
 * concurrently, from a DIFFERENT test file/vitest worker — the identical
 * disk-race class `contextPurity.test.ts` (I-9) already diagnosed and
 * deliberately avoided for `context/` ("an ENOENT ... when this probe's
 * finally block deleted the file between that OTHER file's readdirSync
 * listing and its statSync of the same now-gone entry"). Appending a
 * synthetic entry to the REAL, already-collected file list proves the exact
 * same thing with zero filesystem race: the real recursive walk reaches
 * `backends/` (proven above), and the SAME filter the real assertion uses
 * flags an injected violation.
 */
describe('assertAllScannedLock — RED-first non-vacuous proof (in-memory injection)', () => {
  it('flags a hypothetical 6th backend that POSTs snippets but forgets assertAllScanned', () => {
    const withInjectedViolation: BackendSource[] = [
      ...loadBackendSources(),
      {
        file: '__hypothetical_6th_backend__.ts',
        content:
          'const response = await fetch(url, { method: "POST", body: JSON.stringify({ snippets: req.context.snippets }) });',
      },
    ];
    expect(fetchWithoutAssertAllScanned(withInjectedViolation)).toContain('__hypothetical_6th_backend__.ts');
  });

  it('does NOT flag the same hypothetical backend once it also calls assertAllScanned (negative control — proves the check is not just "flag every file with fetch")', () => {
    const withFix: BackendSource[] = [
      ...loadBackendSources(),
      {
        file: '__hypothetical_6th_backend__.ts',
        content: 'assertAllScanned(req.context.snippets);\nconst response = await fetch(url, opts);',
      },
    ];
    expect(fetchWithoutAssertAllScanned(withFix)).not.toContain('__hypothetical_6th_backend__.ts');
  });

  it('an allowlisted-name file with fetch( but no assertAllScanned( is intentionally exempted (documents the allowlist mechanism is real, not vacuous)', () => {
    const withAllowlistedFetch: BackendSource[] = [
      ...loadBackendSources().filter((f) => f.file !== 'http.ts'),
      { file: 'http.ts', content: 'const response = await fetch(someNonSnippetUrl);' },
    ];
    expect(fetchWithoutAssertAllScanned(withAllowlistedFetch)).not.toContain('http.ts');
  });
});
