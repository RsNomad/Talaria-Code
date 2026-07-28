import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectNonTestTsSources } from './purityScan';

/**
 * P7-N8 (final-3way-2-arch.md I-6b): mechanizes `purityScan.ts`'s own
 * "never imported by production code (only `*.test.ts` files)" claim, which
 * before this task was PROSE-only (this module's own header doc). Its own
 * doc explicitly cites the precedent this mirrors: `scannedSnippetTestFactory.ts`'s
 * "NEVER import this from production code" claim, mechanized in
 * `scannedSnippetTestFactory.test.ts` as a recursive-scan + import-regex ban.
 * This file is that same shape, for `purityScan.ts` itself.
 *
 * Scan root: `src/` in full (`join(__dirname, '..')` from `src/host/`,
 * `purityScan.ts`'s own home) — RECURSIVE, reusing `collectNonTestTsSources`
 * itself (this scan is itself a CONSUMER of the helper it protects, the same
 * "dogfooding" every peer lock in this family exhibits). `purityScan.ts`'s
 * real consumers today (`assertAllScannedLock.test.ts` under `autocomplete/
 * backends/`, `ringBuffer.test.ts`/`scannedSnippetTestFactory.test.ts`/
 * `contextPurity.test.ts` under `autocomplete/context/`, `policyAcpPurity.test.ts`
 * under `host/backend/`, `lspInvariant.test.ts` under `mcp/lsp/`) span four
 * different subtrees, so a hypothetical FUTURE production importer could show
 * up anywhere under `src/`, not just beside this file — a narrower root would
 * silently miss it, the exact "N independent chances to apply inconsistently"
 * failure mode this module's own doc names as the reason it exists.
 *
 * `src/autocomplete/backends/` and `src/autocomplete/context/` are, per this
 * wave's own established finding (this file's sibling scans —
 * `contextPurity.test.ts`, the `session/` guard in `policyAcpPurity.test.ts`,
 * `assertAllScannedLock.test.ts`), directories where OTHER test files
 * concurrently write and delete real disk probe files. Reading them here as
 * part of the REAL recursive `src/`-wide walk is fine — every peer lock does
 * the same (a transient extra entry never matches THIS file's `purityScan`
 * import regex, so it cannot false-positive the "zero offenders" assertion
 * below), and `collectNonTestTsSources` itself now tolerates the resulting
 * transient ENOENT race with a bounded retry (see that function's own doc —
 * empirically reproduced and fixed at the shared-helper source while
 * building this file, rather than worked around per-caller) — but this
 * file's own non-vacuity proof does NOT add a THIRD/FOURTH disk-probe writer
 * into either directory regardless: it injects the hypothetical violation
 * IN-MEMORY into the already-collected list, the same fix already applied to
 * `contextPurity.test.ts` and the `session/` guard.
 */
const SRC_ROOT = join(__dirname, '..');

/** Mirrors `scannedSnippetTestFactory.test.ts`'s `FACTORY_IMPORT_RE` shape
 *  exactly — a relative-or-bare `from '...purityScan'` specifier. Kept LOCAL
 *  to this test file (not exported from `purityScan.ts`), matching the
 *  precedent's own precision bar: the factory's import-ban regex lives in
 *  `scannedSnippetTestFactory.test.ts`, not in `scannedSnippetTestFactory.ts`. */
const PURITY_SCAN_IMPORT_RE = /from\s+['"][^'"]*purityScan['"]/;

function collectSrcSources() {
  return collectNonTestTsSources(SRC_ROOT);
}

describe('purityScan.ts — the "never imported by production" claim is mechanized, not just prose', () => {
  it('discovers purityScan.ts itself (non-vacuous file discovery)', () => {
    const files = collectSrcSources().map((f) => f.file);
    expect(files).toContain('host/purityScan.ts');
  });

  it('no non-test file under src/ imports purityScan (the real lock)', () => {
    const offenders = collectSrcSources()
      .filter((f) => PURITY_SCAN_IMPORT_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('the guard regex actually catches realistic import specifiers used by the real (test-file) consumers today (sanity check on the mechanism itself)', () => {
    expect(PURITY_SCAN_IMPORT_RE.test("import { collectNonTestTsSources } from '../purityScan';")).toBe(true);
    expect(
      PURITY_SCAN_IMPORT_RE.test(
        "import { collectNonTestTsSources, VSCODE_IMPORT_BAN, FS_IMPORT_BAN } from '../../host/purityScan';",
      ),
    ).toBe(true);
    expect(PURITY_SCAN_IMPORT_RE.test("import { collectNonTestTsSources, scanLines } from '../../host/purityScan';")).toBe(
      true,
    );

    // Unrelated imports of differently-named siblings must NOT false-positive
    // — proves the regex isn't just matching "host/*" or "*Scan*".
    expect(PURITY_SCAN_IMPORT_RE.test("import { RingBuffer } from './ringBuffer';")).toBe(false);
    expect(PURITY_SCAN_IMPORT_RE.test("import type { PuritySourceFile } from './types';")).toBe(false);
    expect(PURITY_SCAN_IMPORT_RE.test("import { secretScan } from './secretScanRunner';")).toBe(false);
  });

  /**
   * RED-first non-vacuity proof, IN-MEMORY (no disk write into `src/`
   * itself) — see this file's module doc for the concurrent-disk-probe
   * rationale. Appending a synthetic entry to the REAL, already-collected
   * `src/`-wide file list proves the recursive walk genuinely reaches every
   * subtree (discovery proven above) AND that the SAME filter the real
   * assertion uses actually flags an injected violation — zero filesystem
   * race, mirroring `contextPurity.test.ts`'s and the `session/` guard's
   * established "non-vacuous self-check" pattern.
   */
  it('RED-first proof: a hypothetical PRODUCTION import of purityScan trips the ban (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectSrcSources(),
      {
        file: 'autocomplete/backends/__hypothetical_purityScan_prod_import__.ts',
        absPath: '',
        content:
          "import { collectNonTestTsSources } from '../../host/purityScan';\n" +
          'export const leakedIntoProduction = collectNonTestTsSources;\n',
      },
    ];
    const offenders = withInjectedViolation
      .filter((f) => PURITY_SCAN_IMPORT_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).toContain('autocomplete/backends/__hypothetical_purityScan_prod_import__.ts');
  });

  it('does NOT flag an unrelated hypothetical file that merely sits near purityScan.ts (negative control — proves the check is not just "flag every file under host/")', () => {
    const withUnrelatedFile = [
      ...collectSrcSources(),
      {
        file: 'host/__hypothetical_unrelated_file__.ts',
        absPath: '',
        content: "import { something } from './unrelatedModule';\n",
      },
    ];
    const offenders = withUnrelatedFile.filter((f) => PURITY_SCAN_IMPORT_RE.test(f.content)).map((f) => f.file);

    expect(offenders).not.toContain('host/__hypothetical_unrelated_file__.ts');
  });

  it('sanity: purityScan.ts is consumed only by *.test.ts files today — the real consumers are invisible to this scan by construction (zero offenders is not vacuous)', () => {
    const allFiles = collectSrcSources().map((f) => f.file);
    // The 4 real consumer directories (per this file's module doc) contain
    // NO non-test `.ts` file collected here that imports purityScan — every
    // real importer is a `*.test.ts` file, which `collectNonTestTsSources`
    // excludes by construction. This assertion documents that the "zero
    // offenders" result above is not vacuously true for lack of ANY files in
    // those directories.
    expect(allFiles.some((f) => f.startsWith('autocomplete/backends/'))).toBe(true);
    expect(allFiles.some((f) => f.startsWith('autocomplete/context/'))).toBe(true);
    expect(allFiles.some((f) => f.startsWith('host/backend/'))).toBe(true);
    expect(allFiles.some((f) => f.startsWith('mcp/lsp/'))).toBe(true);
  });
});
