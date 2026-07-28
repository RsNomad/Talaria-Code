import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectNonTestTsSources, VSCODE_IMPORT_BAN, FS_IMPORT_BAN } from '../../host/purityScan';

/**
 * W6-FK (final-3way-arch.md I-9) — `src/autocomplete/context/` was NOT
 * scanned by any headless-purity guard before this task (a real coverage
 * gap: `policyAcpPurity.test.ts` only ever covered `src/host/backend/`'s
 * `policy/`+`acp/`, `lspInvariant.test.ts` only `src/mcp/lsp/`+
 * `src/host/lib/`). This is that guard for `context/`, using the shared
 * `src/host/purityScan.ts` walk+scan mechanism from day one (unlike
 * `policyAcpPurity.test.ts`/`lspInvariant.test.ts`, which pre-date the
 * unification and were refactored onto it; this file is NEW, so there is no
 * pre-existing behavior to preserve here — only the honest three-tier grade
 * to apply correctly from the start).
 *
 * `context/` mixes exactly the three tiers the vocabulary distinguishes:
 *  - `pure`     — `secretScanner.ts`, `ringBuffer.ts`, `snapshotPolicy.ts`,
 *                 `snippetBudgeter.ts`, `editTracker.ts`, `mode.ts`,
 *                 `hash.ts` (imports `node:crypto` for a DETERMINISTIC
 *                 `sha256` — not banned; the ban is on non-determinism,
 *                 `Date.now`/`Math.random`, not on every Node builtin),
 *                 `types.ts`, `assertAllScanned.ts`,
 *                 `scannedSnippetTestFactory.ts`.
 *  - `headless` — `contextService.ts` (I-9's named example: defaults its
 *                 injectable `now` param to `Date.now`; genuinely vscode-
 *                 free and unit-tested with zero mocking, but NOT
 *                 deterministic-pure — see that file's own tier note).
 *  - `adapter`  — `contextService.vscode.ts` (`.vscode.ts` convention) AND
 *                 `editTrackerAdapter.ts` (`*Adapter.ts` — the naming-
 *                 convention outlier `src/host/purityScan.ts`'s backlog note
 *                 documents; DEFERRED rename, not this task). Both
 *                 legitimately import `vscode`; this file's mechanical
 *                 exemption list names BOTH spellings explicitly rather than
 *                 pattern-matching only `.vscode.ts` and silently missing
 *                 the `*Adapter.ts` one.
 *
 * The MECHANICAL ban this scan runs is deliberately just vscode+fs (the
 * SAME dimension every other purity guard in this repo checks) — not a
 * `Date.now()`/`Math.random()` non-determinism ban. A blunt text scan for
 * those terms would false-positive on this very directory's OWN doc
 * comments: `ringBuffer.ts`/`snapshotPolicy.ts`/`snippetBudgeter.ts`/
 * `editTracker.ts` each carry a `"Pure: no vscode, no Date.now()/
 * Math.random()"`-shaped JSDoc line, i.e. they document their OWN
 * determinism by NAMING the banned terms in prose. A scanner that cannot
 * distinguish a comment from code (by design — see
 * `lspInvariant.test.ts`'s module doc on why that tradeoff is accepted
 * elsewhere) would wrongly flag those genuinely-pure files as violations of
 * their own ban. Honest tier grading here is therefore enforced as: (a) a
 * MECHANICAL vscode/fs ban (this file), verified true for every module,
 * regardless of pure/headless tier, and (b) explicit, targeted assertions
 * below proving the headless files are genuinely non-deterministic (not
 * vacuously graded) without relying on a prose-fragile blanket regex.
 */

const CONTEXT_ROOT = join(__dirname);

/**
 * Both spellings this repo currently uses for "the thin vscode shell around
 * a headless/pure core" — see this file's module doc + `purityScan.ts`'s
 * naming-convention backlog note.
 */
const ADAPTER_ALLOW = new Set(['contextService.vscode.ts', 'editTrackerAdapter.ts']);

function collectContextSources() {
  return collectNonTestTsSources(CONTEXT_ROOT);
}

describe('W6-FK (I-9): context/ purity guard', () => {
  it('discovers contextService.ts and the two adapters (non-vacuous file discovery)', () => {
    const files = collectContextSources();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.file === 'contextService.ts')).toBe(true);
    for (const adapter of ADAPTER_ALLOW) {
      expect(files.some((f) => f.file === adapter)).toBe(true);
    }
  });

  it('no module under context/ imports node:fs (zero exceptions — not even the adapters need it)', () => {
    const offenders = collectContextSources()
      .filter((f) => FS_IMPORT_BAN.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('no module under context/ imports vscode EXCEPT the two sanctioned adapters', () => {
    const offenders = collectContextSources()
      .filter((f) => !ADAPTER_ALLOW.has(f.file))
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('sanity: both adapters DO import vscode (the exemption is real, not vacuous)', () => {
    const files = collectContextSources();
    for (const adapter of ADAPTER_ALLOW) {
      const source = files.find((f) => f.file === adapter);
      expect(source).toBeDefined();
      expect(VSCODE_IMPORT_BAN.test(source?.content ?? '')).toBe(true);
    }
  });

  /**
   * RED-first non-vacuity proofs, IN-MEMORY (no disk write into `context/`
   * itself) — deliberately NOT the temp-file-on-disk pattern
   * `ringBuffer.test.ts`'s I-5 probes use for `backends/`. `context/` is
   * ALSO recursively walked by two OTHER, already-existing test files
   * running concurrently in separate vitest workers
   * (`ringBuffer.test.ts`'s and `scannedSnippetTestFactory.test.ts`'s own
   * `AUTOCOMPLETE_ROOT` walks, which include `context/` as a subdirectory)
   * — writing a real temp file directly into `context/` here raced with
   * those files' OWN concurrent `readdirSync`+`statSync` walks (caught
   * empirically: an ENOENT in `scannedSnippetTestFactory.test.ts` when this
   * probe's `finally` block deleted the file between that OTHER file's
   * `readdirSync` listing and its `statSync` of the same now-gone entry).
   * Appending a synthetic entry to the REAL, already-collected file list
   * (real recursive walk — proves discovery reaches `context/` — plus an
   * in-memory injected violation — proves the SAME filter this file's real
   * assertions use actually flags it) proves the identical thing with zero
   * filesystem race, mirroring `lspInvariant.test.ts`'s own established
   * "non-vacuous self-check" section (synthetic in-memory `SourceFile[]`,
   * never written to disk).
   */
  it('RED-first proof: the vscode-ban would catch a hypothetical non-adapter violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectContextSources().filter((f) => !ADAPTER_ALLOW.has(f.file)),
      { file: '__hypothetical_vscode_violation__.ts', absPath: '', content: "import * as vscode from 'vscode';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => VSCODE_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_vscode_violation__.ts');
  });

  it('RED-first proof: the fs-ban would catch a hypothetical violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectContextSources(),
      { file: '__hypothetical_fs_violation__.ts', absPath: '', content: "import { readFileSync } from 'node:fs';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => FS_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_fs_violation__.ts');
  });
});

/**
 * Honest grading (I-9's core fix): `contextService.ts` is HEADLESS, not
 * pure — it passes the vscode/fs ban above (true), but it is NOT
 * deterministic: its constructor defaults the injectable `now` dependency
 * to the real `Date.now`. This is intentional, load-bearing (the class must
 * observe real wall-clock time in production; tests inject a fake `now`)
 * and NOT something this task rips out — the fix is grading it `headless`
 * honestly, not forcing it to `pure` by deleting the default.
 */
describe('W6-FK (I-9): contextService.ts honest grading — HEADLESS, not pure', () => {
  function contextServiceSource() {
    const source = collectContextSources().find((f) => f.file === 'contextService.ts');
    expect(source).toBeDefined();
    return source?.content ?? '';
  }

  it('passes the headless bar: no vscode, no fs (the grade this task DOES claim)', () => {
    const text = contextServiceSource();
    expect(VSCODE_IMPORT_BAN.test(text)).toBe(false);
    expect(FS_IMPORT_BAN.test(text)).toBe(false);
  });

  it('sanity: genuinely defaults to Date.now — the "not pure" half of the grade is not vacuous either', () => {
    const text = contextServiceSource();
    expect(text.includes('Date.now')).toBe(true);
  });
});
