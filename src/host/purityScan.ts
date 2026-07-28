import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * W6-FK (final-3way-arch.md I-9) — the ONE shared file-walk + pattern-scan
 * mechanism behind every headless-purity guard in this repo
 * (`src/host/backend/policyAcpPurity.test.ts`, `src/mcp/lsp/lspInvariant.test.ts`,
 * and the new `src/autocomplete/context/contextPurity.test.ts`). Before this
 * task, each of those files hand-rolled its OWN `readdirSync`/`readFileSync`
 * walker + its OWN line-scan loop — near-identical code duplicated three
 * times, so a future hardening (e.g. "also skip `.d.ts`", "also normalize
 * CRLF") would have had to be applied N times, with N independent chances to
 * apply it inconsistently. This module is that mechanism, extracted ONCE.
 *
 * Deliberately test-infrastructure, not a shipped module: it is never
 * imported by production code (only `*.test.ts` files), so it is never
 * bundled into the extension (same posture as
 * `src/autocomplete/context/scannedSnippetTestFactory.ts`, whose own
 * production-import ban is mechanized in `scannedSnippetTestFactory.test.ts`
 * — the analogous "test helper that must never leak into prod" precedent
 * this file follows). It imports `node:fs` itself (reading source text off
 * disk IS its job), which is fine for the same reason: test infra is exempt
 * from the very headless-purity bans it enforces on shipped code.
 *
 * A REGEX-based scan over source TEXT is deliberately crude (no AST/semantic
 * analysis) — this is a blunt, hard-to-fool mechanical lock, not a style
 * linter, matching the design already documented at length in
 * `lspInvariant.test.ts`'s module doc. Because it is a blunt text scan, a
 * caller's OWN doc comments must never casually mention a banned term in
 * prose if that file is subject to the ban being checked — same accepted
 * caveat every existing scan already carries.
 *
 * ---------------------------------------------------------------------
 * The three-tier purity vocabulary (I-9's honest-grading fix)
 * ---------------------------------------------------------------------
 * Every module in this codebase's headless-core falls into exactly one of:
 *
 *  - `pure`     — no `vscode`, no `fs`, no `Date.now()`/`new Date()`, no
 *                 `Math.random()`. Deterministic and fully build-blind:
 *                 the SAME inputs always produce the SAME outputs, with
 *                 zero dependence on wall-clock time or the OS environment.
 *                 e.g. `src/autocomplete/context/ringBuffer.ts`,
 *                 `snapshotPolicy.ts`, `snippetBudgeter.ts`.
 *
 *  - `headless` — no `vscode`, no `fs` module (vscode-free, unit-testable
 *                 with zero mocking) — BUT may legitimately call
 *                 `Date.now()`/`os.homedir()`/read env vars. Vscode-free is
 *                 NOT the same guarantee as deterministic; conflating the
 *                 two under one "pure" label is exactly the I-9 dishonesty
 *                 this vocabulary closes. e.g.
 *                 `src/autocomplete/context/contextService.ts` (defaults
 *                 its injectable `now` to `Date.now`),
 *                 `src/host/backend/session/SessionController.ts` (calls
 *                 `Date.now()` for turn timing, `homedir()` for path
 *                 canonicalization).
 *
 *  - `adapter`  — (conventionally named `*.vscode.ts`, though this repo
 *                 also has a pre-existing `*Adapter.ts` naming outlier —
 *                 see the backlog note below) `vscode` is allowed. Still
 *                 subject to any narrower security lock that applies
 *                 regardless of tier (e.g. the LSP mutation bans in
 *                 `lspInvariant.test.ts` apply to `libToolDeps.vscode.ts`
 *                 even though it's tier `adapter`).
 *
 * Naming-convention backlog (I-9, deliberately DEFERRED — not this task):
 * the repo mixes `<name>.vscode.ts` (`contextService.vscode.ts`,
 * `ports.vscode.ts`, `diffDecision.vscode.ts`, `libToolDeps.vscode.ts`) and
 * `<name>Adapter.ts` (`editTrackerAdapter.ts`) for the exact same "vscode
 * shell around a headless core" role. Unifying the NAME would require
 * renaming files + updating every importer across the tree — real churn for
 * a cosmetic win, explicitly out of scope for this (last) task of the wave.
 * `contextPurity.test.ts`'s adapter allowlist documents both spellings
 * inline rather than silently special-casing one.
 */

/**
 * The minimal shape {@link scanLines} needs — deliberately narrower than
 * {@link PuritySourceFile} (no `absPath`) so callers' own pre-existing local
 * `{ file, content }`-shaped types (e.g. `lspInvariant.test.ts`'s `SourceFile`,
 * used for ~20 synthetic self-check fixtures that never carry an `absPath`)
 * satisfy it structurally with zero changes to those call sites.
 */
export interface ScannableSource {
  readonly file: string;
  readonly content: string;
}

export interface PuritySourceFile extends ScannableSource {
  /** POSIX-relative path from the scanned root (`/`-joined regardless of
   *  host OS — stable across the Windows dev box and the Fedora/Linux
   *  target this repo builds for). */
  readonly file: string;
  readonly absPath: string;
  readonly content: string;
}

export interface PurityMatch {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Recursively collects every non-test `.ts` file under `root` — RECURSIVE
 * by construction (`readdirSync(root, { recursive: true })`, the same API
 * `lspInvariant.test.ts` already used pre-unification), so a future file
 * added inside a not-yet-existing subdirectory is picked up automatically,
 * with zero edits to any caller. For every root this helper is used against
 * today (`policy/`, `acp/`, `session/`, `context/`, `mcp/lsp/`,
 * `host/lib/`) the directory is currently flat, so recursive vs. non-
 * recursive collection produces IDENTICAL results — this is what makes the
 * refactor of the two pre-existing flat-walk callers (`policyAcpPurity.test.ts`
 * previously walked non-recursively) behavior-preserving: same files in,
 * same files out, just forward-covering now.
 *
 * P7-N8 (final-3way-2-arch.md I-6b follow-up): bounded ENOENT retry around
 * the walk. `src/autocomplete/backends/` and `src/autocomplete/context/` are
 * roots some callers scan (`assertAllScannedLock.test.ts`,
 * `ringBuffer.test.ts`'s own I-5 widening probes) where OTHER,
 * already-existing test files concurrently `writeFileSync`/`unlinkSync` real
 * temp probe files, from a DIFFERENT vitest worker, inside their own
 * try/finally blocks. This function's walk is two syscalls per file
 * (`readdirSync` snapshot, then a separate `readFileSync`) — if a probe is
 * deleted in the window between those two calls, the bare `readFileSync`
 * used to throw ENOENT straight out of this shared helper, breaking EVERY
 * caller that happens to scan a root touched by such a probe (empirically
 * reproduced: `assertAllScannedLock.test.ts`'s `loadBackendSources()` and a
 * new `src/`-wide scan added by this same task both observed it). Since this
 * helper is "extracted ONCE" specifically so a fix like this applies to every
 * caller with zero edits elsewhere, the fix belongs HERE, not duplicated as
 * a retry wrapper in each of N callers — the exact anti-pattern this module
 * exists to close. A transient ENOENT is retried (bounded, no backoff needed
 * — the racing writer's own try/finally window is a handful of synchronous
 * fs calls, sub-millisecond); any other error, or exhausting the attempt
 * budget, still propagates unchanged. Mirrors this codebase's own
 * established `isErrno` convention (`host/checkpoints/shadowLock.ts`,
 * `host/backend/acp/pathConfine.ts`).
 */
export function collectNonTestTsSources(root: string): PuritySourceFile[] {
  return collectWithRetry(root, (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'));
}

/**
 * Task 6.2 fix wave (review finding C-1) — the test-INCLUSIVE sibling of
 * {@link collectNonTestTsSources}. Every purity/import ban in this file
 * existed to police PRODUCTION code, so excluding `*.test.ts` was correct
 * for them: a banned pattern inside a test file couldn't ship. A
 * suppression-comment ban (`suppressionCommentBan.test.ts`) is different —
 * its whole target IS a test file, `src/host/backend/acp/types.test-d.ts`
 * (C-1: `// @ts-nocheck` as that file's line 1 kills every one of its
 * counted locks at once, count-neutrally, with zero drop in either gate
 * command). Excluding
 * `.test.ts`/`.test-d.ts` from THIS scan would make it structurally blind to
 * the exact defect it exists to catch. Collects every `.ts` file, test or
 * not — same retry-hardened walk, same recursive `readdirSync`, same
 * `/`-normalized relative paths, just without the test-file filter.
 */
export function collectAllTsSources(root: string): PuritySourceFile[] {
  return collectWithRetry(root, (entry) => entry.endsWith('.ts'));
}

/**
 * Same walk as {@link collectAllTsSources} but ALSO collecting `.tsx` —
 * needed by scans whose banned pattern is just as expressible in webview
 * JSX modules (32 such files at the time of adding; `anyIntroductionBan.
 * test.ts` is the first consumer). Kept separate rather than widening
 * `collectAllTsSources` so the existing scans' scopes do not change
 * behind their backs.
 */
export function collectAllTsAndTsxSources(root: string): PuritySourceFile[] {
  return collectWithRetry(root, (entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'));
}

function collectWithRetry(root: string, include: (entry: string) => boolean): PuritySourceFile[] {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return collectOnce(root, include);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isEnoent(err)) throw err;
    }
  }
}

function collectOnce(root: string, include: (entry: string) => boolean): PuritySourceFile[] {
  const files: PuritySourceFile[] = [];
  for (const entry of readdirSync(root, { encoding: 'utf8', recursive: true })) {
    if (!include(entry)) continue;
    const file = entry.split(sep).join('/');
    const absPath = join(root, entry);
    files.push({ file, absPath, content: readFileSync(absPath, 'utf-8') });
  }
  return files;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Line-by-line scan for `pattern` across every file in `files`, returning a
 * `PurityMatch` per matching line (file + 1-based line number + trimmed
 * snippet — enough for a human to find a future RED immediately). `pattern`
 * must NOT carry the `g`/`y` flag: `RegExp.prototype.test` retains
 * `lastIndex` across calls for those flags, which would silently skip
 * matches on later lines/files (the exact caveat `lspInvariant.test.ts`
 * already documented; preserved here verbatim since this is that same
 * scan loop, just centralized).
 */
export function scanLines(files: readonly ScannableSource[], pattern: RegExp): PurityMatch[] {
  const matches: PurityMatch[] = [];
  for (const source of files) {
    const lines = source.content.split('\n');
    for (const [index, lineText] of lines.entries()) {
      if (pattern.test(lineText)) {
        matches.push({ file: source.file, line: index + 1, snippet: lineText.trim() });
      }
    }
  }
  return matches;
}

/**
 * Canonical `vscode` import ban — matches both `import ... from 'vscode'`
 * and a bare side-effect `import 'vscode'`, plus a `require('vscode')` call.
 * Used by NEW scans this task adds (`contextPurity.test.ts`, the `session/`
 * extension in `policyAcpPurity.test.ts`). Pre-existing scans keep their own
 * independently-authored equivalents unchanged (behavior-preserving —
 * swapping a pre-existing scan's regex, even for an equivalent-looking
 * pattern, is exactly the kind of change this task's "catch EXACTLY what
 * they caught before" constraint rules out).
 */
export const VSCODE_IMPORT_BAN = /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\)/;

/**
 * Canonical `node:fs` import ban (incl. `fs/promises`) — see
 * {@link VSCODE_IMPORT_BAN}'s doc for the same "new scans only" scoping
 * rationale.
 */
export const FS_IMPORT_BAN = /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"]fs['"]\)/;
