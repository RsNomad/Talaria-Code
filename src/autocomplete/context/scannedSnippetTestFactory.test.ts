import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectNonTestTsSources } from '../../host/purityScan';
import type { ScannableSource } from '../../host/purityScan';

/**
 * W6-FD (final-3way-arch.md I-5) — mechanizes the factory-import ban that,
 * before this task, was PROSE-only (`scannedSnippetTestFactory.ts`'s own
 * header comment: "NEVER import this from production code (only
 * *.test.ts)"). `scannedSnippetForTest` performs the one OTHER sanctioned
 * `as ScannedSnippet` cast (alongside `ringBuffer.ts`'s mint) — it exists
 * purely so unit tests can build a `ScannedSnippet` fixture without running
 * a real scan. If production code ever imported it, that import would be a
 * THIRD, unaudited mint site with none of `ringBuffer.ingest`'s
 * scan-first discipline — a silent bypass of the whole W5 security spine
 * that neither the `CAST_RE` nor `SPREAD_RE` guards (`ringBuffer.test.ts`)
 * can see, because the cast lives INSIDE the factory module, not at the
 * call site the guards scan.
 *
 * Scan root matches the widened I-5 guard in `ringBuffer.test.ts`: ALL of
 * `src/autocomplete/`, RECURSIVE — the factory is legitimately imported
 * today from `backends/*.test.ts`, `context/*.test.ts`, and the
 * autocomplete-root `*.test.ts` files, so a hypothetical production
 * consumer could show up anywhere in the tree, not just alongside it.
 */
const AUTOCOMPLETE_ROOT = join(__dirname, '..');
const FACTORY_IMPORT_RE = /from\s+['"][^'"]*scannedSnippetTestFactory['"]/;

/**
 * P7-N8 (final-3way-2-arch.md I-6a): the file-walk used to be a hand-rolled
 * `readdirSync`/`statSync` recursion HERE (independently of the near-identical
 * one `ringBuffer.test.ts` also hand-rolled) — now delegates to the shared
 * `src/host/purityScan.ts` helper. Behavior-preserving: same recursive walk,
 * same `.ts`/non-`.test.ts` filter, same POSIX-relative `file` paths.
 */
function collectSources(): ScannableSource[] {
  return collectNonTestTsSources(AUTOCOMPLETE_ROOT);
}

describe('scannedSnippetForTest — the factory-import ban is mechanized, not just prose', () => {
  it('no non-test file under src/autocomplete/ imports scannedSnippetTestFactory', () => {
    const offenders = collectSources()
      .filter((f) => FACTORY_IMPORT_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('the guard regex actually catches realistic import specifiers (sanity check on the mechanism itself)', () => {
    expect(
      FACTORY_IMPORT_RE.test(
        "import { scannedSnippetForTest } from '../context/scannedSnippetTestFactory';",
      ),
    ).toBe(true);
    expect(
      FACTORY_IMPORT_RE.test("import { scannedSnippetForTest } from './scannedSnippetTestFactory';"),
    ).toBe(true);

    // An unrelated import of a differently-named sibling module must NOT
    // false-positive — proves the regex isn't just matching "context/*".
    expect(FACTORY_IMPORT_RE.test("import { RingBuffer } from './ringBuffer';")).toBe(false);
    expect(
      FACTORY_IMPORT_RE.test("import type { ScannedSnippet } from './types';"),
    ).toBe(false);
  });

  /**
   * H6-B9: converted from a `writeFileSync`-into-`backends/` probe to
   * race-free in-memory injection — same fix already applied to
   * `assertAllScannedLock.test.ts` (N7) and `purityScan.test.ts` (N8) for
   * the identical parallel-scan disk race (backlog B9: a concurrent test
   * file's recursive `readdirSync` walk of `backends/` could observe this
   * probe's `writeFileSync`d file and then race its `finally`-block
   * `unlinkSync`, throwing ENOENT out of an UNRELATED test). The original
   * single disk-write test proved two things at once — split into two
   * race-free assertions carrying the SAME proof:
   *  (A) reach — the real, already-on-disk recursive walk genuinely
   *      descends into the sibling `backends/` directory (read-only);
   *  (B) predicate — the SAME `FACTORY_IMPORT_RE` filter this suite's real
   *      assertion uses flags a synthetic in-memory offender shaped exactly
   *      like a collected source, with zero filesystem I/O.
   */
  it('reach proof: the recursive walk reaches the sibling backends/ directory (read-only, real on-disk file list, no probe write)', () => {
    // Planted in backends/ — a real, non-test production location this
    // factory has no business being imported from (mirrors the I-5 widening
    // probes in ringBuffer.test.ts). This proves the widened scan actually
    // reaches into a sibling directory, purely by observing the real
    // committed tree.
    const files = collectSources().map((f) => f.file);
    expect(files.some((f) => f.includes('backends/'))).toBe(true);
  });

  it('predicate proof: a hypothetical PRODUCTION import of the factory trips the ban (in-memory injection into the REAL collected file list, zero disk I/O)', () => {
    const withInjectedViolation: ScannableSource[] = [
      ...collectSources(),
      {
        file: 'backends/__factory_import_probe__.ts',
        content:
          "import { scannedSnippetForTest } from '../context/scannedSnippetTestFactory';\n" +
          'export const forgedInProduction = scannedSnippetForTest;\n',
      },
    ];
    const offenders = withInjectedViolation.filter((f) => FACTORY_IMPORT_RE.test(f.content)).map((f) => f.file);

    expect(offenders).toContain('backends/__factory_import_probe__.ts');
  });

  it('does NOT flag the same synthetic backends/ entry once it stops importing the factory (negative control — proves the check is not just "flag every injected file")', () => {
    const withCleanEntry: ScannableSource[] = [
      ...collectSources(),
      {
        file: 'backends/__factory_import_probe__.ts',
        content: "import { RingBuffer } from '../context/ringBuffer';\nexport const clean = RingBuffer;\n",
      },
    ];
    const offenders = withCleanEntry.filter((f) => FACTORY_IMPORT_RE.test(f.content)).map((f) => f.file);

    expect(offenders).not.toContain('backends/__factory_import_probe__.ts');
  });
});
