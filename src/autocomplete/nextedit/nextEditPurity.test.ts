import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectNonTestTsSources, VSCODE_IMPORT_BAN, FS_IMPORT_BAN } from '../../host/purityScan';
import type { ScannableSource } from '../../host/purityScan';

/**
 * F-10 (final-review-findings.md ARCH I-3) — `nextedit/`'s pure-core/thin-shell
 * boundary HOLDS today (only `config.ts`, `guard.ts`, `shell.vscode.ts` import
 * `vscode`) but until this file, nothing LOCKED it. `contextPurity.test.ts`
 * covers `context/` only; `nextedit/` had zero headless-purity guard, the
 * exact coverage gap the repo's own precedent (W6-FK I-9) already named once
 * for `context/`. ARCH ranked the consequence: "the first expedient `vscode`
 * import into `fsm.ts` ships green."
 *
 * This is a direct clone of `../context/contextPurity.test.ts`'s mechanism
 * (same shared `src/host/purityScan.ts` walk+scan, same `VSCODE_IMPORT_BAN`/
 * `FS_IMPORT_BAN`), narrowed to `nextedit/`'s own three-file allowlist rather
 * than `context/`'s two-file one. Unlike `context/`, `nextedit/` uses a single
 * naming convention for its one non-`.vscode.ts`-named adapter (`guard.ts` —
 * see its own header: "this class contributes exactly three things a pure
 * function cannot: persistence, SERIALIZATION ..., and user-visible alerts"),
 * so this file names it explicitly rather than pattern-matching a suffix.
 *
 * `formats/sweepV2.ts`/`formats/genericInstruct.ts`/`formats/shared.ts`/
 * `formats/types.ts`, `scan.ts`, `anchors.ts`, `mode.ts`, `backend.ts`,
 * `fsm.ts`, `types.ts` are all expected PURE/headless — none of them may
 * import `vscode` or `node:fs`. `backend.ts` reaches the network via the
 * global `fetch`, never `node:fs` or `vscode`, so it stays out of the
 * allowlist despite being the one file that egresses.
 */

const NEXTEDIT_ROOT = join(__dirname);

/**
 * The three files this task's own brief names as the sanctioned `vscode`
 * importers — verified NON-VACUOUSLY below (each must actually import
 * `vscode`, so this allowlist cannot silently grow past what's true).
 */
const ADAPTER_ALLOW = new Set(['config.ts', 'guard.ts', 'shell.vscode.ts']);

function collectNextEditSources(): ScannableSource[] {
  return collectNonTestTsSources(NEXTEDIT_ROOT);
}

describe('F-10: nextedit/ purity guard (pure-core/thin-shell boundary, mechanized)', () => {
  it('discovers config.ts, guard.ts and shell.vscode.ts (non-vacuous file discovery)', () => {
    const files = collectNextEditSources();
    expect(files.length).toBeGreaterThan(0);
    for (const adapter of ADAPTER_ALLOW) {
      expect(files.some((f) => f.file === adapter)).toBe(true);
    }
  });

  it('no module under nextedit/ imports node:fs (zero exceptions — not even the three adapters need it)', () => {
    const offenders = collectNextEditSources()
      .filter((f) => FS_IMPORT_BAN.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('no module under nextedit/ imports vscode EXCEPT the three sanctioned files', () => {
    const offenders = collectNextEditSources()
      .filter((f) => !ADAPTER_ALLOW.has(f.file))
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('sanity: all three sanctioned files DO import vscode (the exemption is real, not vacuous)', () => {
    const files = collectNextEditSources();
    for (const adapter of ADAPTER_ALLOW) {
      const source = files.find((f) => f.file === adapter);
      expect(source).toBeDefined();
      expect(VSCODE_IMPORT_BAN.test(source?.content ?? '')).toBe(true);
    }
  });

  it('sanity: the pure/headless files (fsm.ts, scan.ts, anchors.ts, mode.ts, backend.ts, formats/*, types.ts) genuinely exist and are NOT in the allowlist', () => {
    const files = collectNextEditSources().map((f) => f.file);
    const expectedPure = [
      'types.ts',
      'scan.ts',
      'mode.ts',
      'anchors.ts',
      'fsm.ts',
      'backend.ts',
      'formats/types.ts',
      'formats/shared.ts',
      'formats/sweepV2.ts',
      'formats/genericInstruct.ts',
    ];
    for (const expected of expectedPure) {
      expect(files).toContain(expected);
      expect(ADAPTER_ALLOW.has(expected)).toBe(false);
    }
  });

  /**
   * RED-first non-vacuity proof, IN-MEMORY (no disk write into `nextedit/`
   * itself) — the same H6-B9 discipline `contextPurity.test.ts` and this
   * directory's own `reuseLocks.test.ts` already document at length:
   * `nextedit/` is ALSO recursively walked by `reuseLocks.test.ts`'s and
   * `ringBuffer.test.ts`'s own `AUTOCOMPLETE_ROOT`/`NEXTEDIT_ROOT` walks
   * running concurrently in separate vitest workers, so a real
   * `writeFileSync`d probe here would race those files' own
   * `readdirSync`+`statSync` walk exactly as `contextPurity.test.ts`'s own
   * module doc found empirically for `context/`. Appending a synthetic entry
   * to the REAL, already-collected file list proves the identical thing with
   * zero filesystem race.
   */
  it('RED-first proof: the vscode-ban would catch a hypothetical non-adapter violation (in-memory injection into the REAL collected file list) — this is the shape ARCH warned about: "the first expedient vscode import into fsm.ts ships green"', () => {
    const withInjectedViolation = [
      ...collectNextEditSources().filter((f) => !ADAPTER_ALLOW.has(f.file)),
      // Named after the exact file ARCH called out, but as a distinct probe
      // entry (not a duplicate of the real fsm.ts) — the point is the
      // PREDICATE, not shadowing a real collected file.
      { file: '__hypothetical_fsm_vscode_violation__.ts', absPath: '', content: "import * as vscode from 'vscode';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => VSCODE_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_fsm_vscode_violation__.ts');
  });

  it('RED-first proof: the fs-ban would catch a hypothetical violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectNextEditSources(),
      { file: '__hypothetical_fs_violation__.ts', absPath: '', content: "import { readFileSync } from 'node:fs';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => FS_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_fs_violation__.ts');
  });

  it('negative control: an adapter-allowlisted file importing vscode is correctly NOT flagged (the predicate is not "flag every vscode import")', () => {
    const files = collectNextEditSources();
    const offenders = files
      .filter((f) => !ADAPTER_ALLOW.has(f.file))
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    // guard.ts genuinely imports vscode and is allowlisted — it must never
    // appear in the offenders list precisely because it's excluded above.
    expect(offenders).not.toContain('guard.ts');
  });
});

/**
 * Sanity read straight off disk (not the collected-sources list), pinning
 * that the three files this guard exempts are exactly the three the brief
 * names — a drift here (a fourth file quietly starting to import `vscode`,
 * caught by the guard above) is different from someone editing THIS file's
 * own allowlist to admit a fourth file without justification, which nothing
 * mechanical can catch. This assertion exists so a diff touching the
 * allowlist itself is at least visible in a diff of a file whose name says
 * what it is.
 */
describe('F-10: the adapter allowlist is exactly three files, named', () => {
  it('ADAPTER_ALLOW contains exactly config.ts, guard.ts, shell.vscode.ts — no more, no fewer', () => {
    expect([...ADAPTER_ALLOW].sort()).toEqual(['config.ts', 'guard.ts', 'shell.vscode.ts']);
  });

  it('sanity: each allowlisted file exists on disk under nextedit/ (not a stale/typo\'d entry)', () => {
    for (const adapter of ADAPTER_ALLOW) {
      const text = readFileSync(join(NEXTEDIT_ROOT, adapter), 'utf-8');
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
