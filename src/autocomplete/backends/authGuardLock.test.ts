import { describe, it, expect } from 'vitest';
import { collectNonTestTsSources } from '../../host/purityScan';

/**
 * A4 (`final-3way-2-arch.md` egress-guard follow-up): A2 fixed
 * `VllmFimBackend.ts` sending an `Authorization: Bearer <key>` header with
 * NO call to `assertSecureAuthTransport` first — S4.2's CWE-319 transport
 * guard, which refuses to put the key on the wire over cleartext http to a
 * remote host (`secureTransport.ts:46-54`). Nothing caught the omission
 * until an architecture review read the file by hand. This is the
 * mechanized lock that makes the NEXT instance of that same mistake fail
 * the build instead of shipping silently — the same shape as its sibling
 * lock in this same directory, `assertAllScannedLock.test.ts` (which guards
 * the analogous W5 secret-scan choke-point, `assertAllScanned`), itself
 * built on the shared walker this file also uses,
 * `collectNonTestTsSources` (`src/host/purityScan.ts`).
 *
 * Mechanism: a blunt, hard-to-fool TEXT scan (no AST/semantic analysis)
 * over every non-test `.ts` file directly under `backends/` — re-read from
 * disk on every run, so a future 6th backend file's Authorization-without-
 * guard status is picked up automatically by the SCAN LOGIC with zero edits
 * to it. (F-F: that is narrower than "zero edits here" — the exact-count
 * sanity check in the first `it` below, `expect(files.length).toBe(7)`,
 * DOES need bumping when the file count changes, same as its sibling
 * `assertAllScannedLock.test.ts:98`.) Because this is a blunt text scan, a
 * source file's OWN doc comments must never casually mention
 * `Authorization`/`assertSecureAuthTransport(` in prose — same accepted
 * caveat every existing scan in this repo already carries
 * (`assertAllScannedLock.test.ts:21-23`).
 *
 * Rule: any non-allowlisted file containing the token `Authorization` must
 * also contain a call to `assertSecureAuthTransport(`. This is a
 * TOKEN-PRESENCE approximation, the same precision bar every peer lock in
 * this family uses — it does NOT prove the two are on the same request
 * path. A file could contain both tokens on unrelated code paths (e.g. one
 * function that sets the header, a wholly different function that happens
 * to call the guard for an unrelated request) and this lock would not
 * notice. That is a DOCUMENTED, ACCEPTED residual, same bar as
 * `assertAllScannedLock.test.ts:25-34`: this lock only guards against the
 * guard call being silently ABSENT. Actual same-path wiring correctness is
 * carried by the per-backend behavioral tests (A2's "guard throws AND
 * fetch never called", e.g. `VllmFimBackend.test.ts`). A lock that
 * overstates itself is worse than one that doesn't exist, because it buys
 * false confidence — so this is said plainly, not left implicit.
 *
 * `AUTHORIZATION_PATTERN` is deliberately CASE-INSENSITIVE: HTTP header
 * names are case-insensitive on the wire, so a hypothetical future backend
 * that wrote `headers.set('authorization', ...)` (lowercase) would still be
 * sending the same secret — a case-sensitive scan would create exactly the
 * kind of silent blind spot this lock exists to close. Verified this does
 * not currently pull in any extra file: a case-insensitive grep for
 * `authorization` across every non-test file in `backends/` today returns
 * the identical 3 hits as the case-sensitive one (see the allowlist comment
 * below).
 */

interface BackendSource {
  readonly file: string;
  readonly content: string;
}

const BACKENDS_DIR = __dirname;

/**
 * Audit B-12. The old predicate was the literal token `Authorization`, so a
 * backend that authenticates with `x-api-key` (Anthropic-style), `api-key`
 * (Azure OpenAI-style) or `Proxy-Authorization` would carry a credential and
 * skip `assertSecureAuthTransport` with the lock still green. This is the same
 * class as the PROVEN `setKeysForSync?.()` hole one directory over: a lock
 * keyed on one spelling of the thing it guards.
 */
const AUTHORIZATION_PATTERN = /\b(?:Authorization|Proxy-Authorization|x-api-key|api-key|x-goog-api-key)\b/i;
const ASSERT_SECURE_AUTH_TRANSPORT_PATTERN = /\bassertSecureAuthTransport\s*\(/;

/**
 * Allowlist decision (A4 — re-verified at write-time, not taken from the
 * brief's word): a grep for the literal token `Authorization` across every
 * non-test file in `backends/` (7 files: 5 FIM backends + `http.ts` +
 * `secureTransport.ts`) shows it appears in `CodestralFimBackend.ts`,
 * `OpenAICompatFimBackend.ts`, `VllmFimBackend.ts`, and (T-6 F4)
 * `LlamaCppInfillBackend.ts` — the four backends that actually send a
 * Bearer header, each pairing it with `assertSecureAuthTransport(`. Neither
 * `http.ts` (SSE/NDJSON response STREAM PARSERS only — they consume an
 * already-issued `Response` and never build a header) nor
 * `secureTransport.ts` (the guard itself — its own source names the
 * IDENTIFIER `assertSecureAuthTransport` in its declaration, but never the
 * STRING `Authorization`) contains the token, so both already pass this
 * rule VACUOUSLY today, same as `OllamaFimBackend.ts` (no `apiKey` field at
 * all — `/api/generate` has no auth story this codebase speaks to). No
 * allowlist entry changes that outcome today: naming a file that already
 * passes vacuously would be dead weight (jobA-common.md YAGNI; this
 * brief's own framing — "An allowlist entry that isn't needed is dead
 * weight"). The `Set` itself is kept (empty) so the mechanism has an
 * explicit, discoverable place for a FUTURE legitimately-exempt file,
 * mirroring why `assertAllScannedLock.test.ts` names its own allowlist
 * explicitly rather than leaving a future author to guess — but nothing is
 * named in it because nothing needs to be today.
 */
const ALLOWLIST = new Set<string>([]);

function loadBackendSources(): BackendSource[] {
  return collectNonTestTsSources(BACKENDS_DIR);
}

/**
 * The mechanized lock itself: every non-allowlisted file that contains the
 * `Authorization` token but does NOT also contain a call to
 * `assertSecureAuthTransport(` is an offender.
 */
function authorizationWithoutGuard(files: readonly BackendSource[]): string[] {
  return files
    .filter((f) => !ALLOWLIST.has(f.file))
    .filter((f) => AUTHORIZATION_PATTERN.test(f.content) && !ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test(f.content))
    .map((f) => f.file);
}

describe('authGuardLock — every backend that sends Authorization must also call assertSecureAuthTransport (A4)', () => {
  it('discovers all 5 current FIM backends + the 2 helper files (non-vacuous file discovery)', () => {
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

  it('no non-allowlisted backend file contains Authorization without also calling assertSecureAuthTransport( (the real lock, run over the current tree)', () => {
    expect(authorizationWithoutGuard(loadBackendSources())).toEqual([]);
  });

  it('sanity: the 4 backends that DO send a Bearer header contain both Authorization and assertSecureAuthTransport( (the rule is exercised for real, not vacuously true)', () => {
    const sources = loadBackendSources();
    // T-6 F4: `LlamaCppInfillBackend.ts` joined this list — it gained an
    // optional `apiKey` (trim-normalized Bearer + `assertSecureAuthTransport`
    // gate, the vLLM pattern verbatim), so it graduates out of the
    // "vacuous" bucket below into this one, exercised for real like its
    // three siblings. `OllamaFimBackend.ts` is the one that stays vacuous —
    // its options type has no `apiKey` field at all; `/api/generate` has no
    // auth story this codebase speaks to.
    for (const name of ['CodestralFimBackend.ts', 'OpenAICompatFimBackend.ts', 'VllmFimBackend.ts', 'LlamaCppInfillBackend.ts']) {
      const source = sources.find((f) => f.file === name);
      expect(source).toBeDefined();
      expect(AUTHORIZATION_PATTERN.test(source?.content ?? '')).toBe(true);
      expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test(source?.content ?? '')).toBe(true);
    }
  });

  it("sanity: Ollama passes vacuously — no Authorization token at all (grounds the brief's vacuous-pass claim instead of assuming it)", () => {
    const sources = loadBackendSources();
    for (const name of ['OllamaFimBackend.ts']) {
      const source = sources.find((f) => f.file === name);
      expect(source).toBeDefined();
      expect(AUTHORIZATION_PATTERN.test(source?.content ?? '')).toBe(false);
    }
  });

  it('sanity: neither helper file (http.ts, secureTransport.ts) contains Authorization either — grounds the empty-allowlist decision (no live violation is hidden by leaving the allowlist empty)', () => {
    const sources = loadBackendSources();
    for (const name of ['http.ts', 'secureTransport.ts']) {
      const source = sources.find((f) => f.file === name);
      expect(source).toBeDefined();
      expect(AUTHORIZATION_PATTERN.test(source?.content ?? '')).toBe(false);
    }
  });

  it('the guard patterns actually match realistic call/assignment shapes, incl. a whitespace-before-paren evasion form and a lowercase header-name evasion form (sanity check on the mechanism itself)', () => {
    expect(AUTHORIZATION_PATTERN.test('headers.Authorization = `Bearer ${key}`;')).toBe(true);
    expect(AUTHORIZATION_PATTERN.test('Authorization: `Bearer ${key}`,')).toBe(true);
    expect(AUTHORIZATION_PATTERN.test("headers.set('authorization', `Bearer ${key}`);")).toBe(true);
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test('assertSecureAuthTransport(url, !!apiKey);')).toBe(true);
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test('assertSecureAuthTransport (url, hasKey);')).toBe(true);
    // Negative control: a similarly-spelled-but-different word must not match.
    expect(AUTHORIZATION_PATTERN.test('// requests must be pre-authorized by the user')).toBe(false);
    expect(ASSERT_SECURE_AUTH_TRANSPORT_PATTERN.test('// see assertSecureAuthTransport for the backstop it never calls')).toBe(false);
  });
});

/**
 * RED-first non-vacuous proof, IN-MEMORY (no disk write into `backends/`
 * itself) — same reasoning as `assertAllScannedLock.test.ts`'s own
 * in-memory injection block (its lines 141-157): `backends/` is a
 * directory OTHER test files in this same suite write real temp probe
 * files into, concurrently, from a different vitest worker
 * (`ringBuffer.test.ts`'s I-5 probes, `scannedSnippetTestFactory.test.ts`'s
 * factory-import probe) — a disk-race class `contextPurity.test.ts` (I-9)
 * already diagnosed and avoided. Appending a synthetic entry to the REAL,
 * already-collected file list proves the exact same thing with zero
 * filesystem race: the real recursive walk reaches `backends/` (proven
 * above), and the SAME filter the real assertion uses flags an injected
 * violation.
 *
 * The A4 brief calls out the FIRST test below as the important one: "a
 * lock that has never been observed to flag anything is decoration." It is
 * also, almost verbatim, the actual bug A2 fixed — a backend that builds an
 * `Authorization` header and never calls the transport guard.
 */
describe('authGuardLock — RED-first non-vacuous proof (in-memory injection)', () => {
  it('flags a hypothetical 6th backend that sends Authorization but forgets assertSecureAuthTransport (the important test — this IS the bug A2 fixed, reproduced)', () => {
    const withInjectedViolation: BackendSource[] = [
      ...loadBackendSources(),
      {
        file: '__hypothetical_6th_backend__.ts',
        content:
          'const headers: Record<string, string> = { "Content-Type": "application/json" };\n' +
          'if (this.opts.apiKey) { headers.Authorization = `Bearer ${this.opts.apiKey}`; }\n' +
          'const response = await fetch(url, { method: "POST", headers, body });',
      },
    ];
    expect(authorizationWithoutGuard(withInjectedViolation)).toContain('__hypothetical_6th_backend__.ts');
  });

  it('does NOT flag the same hypothetical backend once it also calls assertSecureAuthTransport( (negative control — proves the check is not just "flag every file that mentions Authorization")', () => {
    const withFix: BackendSource[] = [
      ...loadBackendSources(),
      {
        file: '__hypothetical_6th_backend__.ts',
        content:
          'assertSecureAuthTransport(url, !!this.opts.apiKey);\n' +
          'const headers: Record<string, string> = { "Content-Type": "application/json" };\n' +
          'if (this.opts.apiKey) { headers.Authorization = `Bearer ${this.opts.apiKey}`; }',
      },
    ];
    expect(authorizationWithoutGuard(withFix)).not.toContain('__hypothetical_6th_backend__.ts');
  });

  it('a hypothetical backend with neither token passes (vacuous case — mirrors OllamaFimBackend.ts today, negative control 2)', () => {
    const withNeitherToken: BackendSource[] = [
      ...loadBackendSources(),
      {
        file: '__hypothetical_no_auth_backend__.ts',
        content: 'const response = await fetch(url, { method: "POST", body });',
      },
    ];
    expect(authorizationWithoutGuard(withNeitherToken)).not.toContain('__hypothetical_no_auth_backend__.ts');
  });

  it('flags a backend that authenticates with x-api-key instead of Authorization (audit B-12)', () => {
    const withInjectedViolation: BackendSource[] = [
      ...loadBackendSources(),
      {
        file: 'AnthropicStyleFimBackend.ts',
        content:
          "const headers: Record<string, string> = { 'content-type': 'application/json' };\n" +
          "headers['x-api-key'] = this.opts.apiKey;\n" +
          'const response = await fetch(url, { method: "POST", headers });\n',
      },
    ];
    expect(authorizationWithoutGuard(withInjectedViolation)).toContain('AnthropicStyleFimBackend.ts');
  });
});
