import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * T6 (final-review remediation §4, ARCH-2) — a MECHANIZED TRIPWIRE, not the
 * real proof. The real proof that invariant #3 ("status + statusText ONLY,
 * never a response body") holds is the BEHAVIORAL tests in
 * `HermesDashboardClient.test.ts` ("error shape (T6, invariant #3 / ARCH-2)")
 * and `OllamaFimBackend.test.ts` ("mid-stream {error} chunk (T6, invariant #3
 * / ARCH-2)"), which drive the real code paths end-to-end and assert the
 * thrown message excludes a planted body secret. This file is a SECOND,
 * cheaper layer on top: a blunt, regex-based source-TEXT scan (no AST/
 * semantic analysis — same bluntness every purity/invariant lock in this repo
 * already accepts, e.g. `authGuardLock.test.ts`'s documented caveat) over the
 * files the §4 adopter table enumerates, that catches a FUTURE regression
 * mechanically instead of relying on someone remembering to write a
 * behavioral test for it.
 *
 * ## What the scan actually checks
 * A `.text()` call and a `throw new Error(` are treated as "the same
 * error-handling unit" when they land within {@link WINDOW} lines of each
 * other in the same file — an approximation of "the same statement" loose
 * enough to also catch the REAL historical UI I-5 shape (the body was read
 * into an intermediate `detail` variable a few lines before the throw, not
 * literally inlined into the `throw new Error(...)` argument list — see the
 * RED-first proof below, which reproduces that exact shape). A `.text()`
 * call is EXEMPTED when its own line carries the literal marker
 * `httpFailure-tripwire-allow` — the one legitimate case in this codebase is
 * `HermesDashboardClient.ts`'s non-2xx handler, which reads the body ONLY to
 * hand it to the injected `Logger`, never to the throw (verified inline,
 * below, not assumed).
 *
 * ## The marker does not blind-trust itself (T6 review hardening)
 * The marker is NOT an unconditional suppressor. It only exempts the one
 * shape it was written for — a `const`/`let`/`var` declaration that captures
 * the `.text()` result into a named identifier, e.g. `const body = (await
 * res.text())...`. When that shape is present, the scan captures the
 * identifier (`body`) and additionally asserts it does NOT appear inside any
 * `throw new Error(...)` within {@link WINDOW} lines — if it does, the
 * marker is overridden and the violation still fires (a future dev cannot
 * paste the marker onto a real leak and have the backstop go quiet). A
 * marked `.text()` call that is NOT captured into a named identifier (a bare
 * inline call, a reassignment to a pre-declared name, destructuring) gets NO
 * exemption at all and falls straight into the ordinary proximity scan, same
 * as an unmarked call — see the "bare, unassigned .text() … even when
 * marked" RED-first test below. What this still cannot catch: the
 * identifier check is itself a same-window, per-line regex match, not
 * dataflow analysis — renaming (`const raw = body; throw
 * new Error(raw)`) or destructuring the captured value defeats it. Not
 * observed in this codebase's one real marker usage today (verified inline,
 * below, not assumed).
 *
 * ## Known false-positive risk, and how it's closed
 * `src/rag/embedder.ts:138` has a doc COMMENT that literally contains the
 * substring `await res.text()` (Audit C-5's own note explaining why that
 * call was removed) sitting 3 lines from a real `throw new Error(...)` — a
 * naive scan would flag its own historical fix. Comment-only lines (trimmed
 * text starting with `//`, `/*`, or `*`) are blanked before scanning, closing
 * this without blinding the scan to a REAL `.text()` call that merely sits
 * near an unrelated comment (see the "comment-blanking does not blind the
 * scan to real code" RED-first test below).
 *
 * ## Documented, accepted limits (same bar as this repo's sibling locks)
 * - Line-window proximity, not true statement/AST boundaries: a `.text()`
 *   read and an unrelated `throw new Error(` that happen to land within
 *   {@link WINDOW} lines of each other in the same function would be a false
 *   positive. Not observed in the 7 enumerated files today.
 * - Only catches the `.text()`-into-throw shape (UI I-5's exact defect
 *   class). It does NOT catch a body leaked via `.json()` parsing into a
 *   thrown field (M6's `chunk.error` shape) — that path has no textual
 *   signature to scan for generically; M6 is enforced ONLY by its own
 *   behavioral test, honestly, not by this file.
 * - Trailing same-line `// comment` after real code is NOT stripped (only
 *   whole comment-only lines are blanked). Not observed to matter in any of
 *   the 7 files today.
 * - The marker's identifier-flows-into-throw check (above) is also a
 *   same-window, per-line regex match: it recognizes only a direct
 *   `const`/`let`/`var IDENT = ` capture, and checks each throw's own source
 *   line for that exact identifier token. Renaming the captured value
 *   (`const raw = body;`), destructuring it, or spreading the throw's
 *   template literal across multiple lines from the identifier can defeat
 *   it. Not observed in this codebase's one real marker usage today.
 */

const WINDOW = 10;
const TEXT_CALL = /\.text\s*\(\s*\)/;
const THROW_NEW_ERROR = /throw new Error\(/;
const ALLOW_MARKER = /httpFailure-tripwire-allow/;
const COMMENT_ONLY_LINE = /^\s*(\/\/|\/\*|\*)/;
// The ONLY shape the allowlist marker is trusted to exempt: a `const`/`let`/
// `var` declaration that captures the `.text()` result into a named
// identifier (e.g. `const body = (await res.text())...`). Anything else
// (reassignment to a pre-declared name, destructuring, a bare inline
// `.text()` call) gets NO exemption — see `findViolations` below.
const ASSIGNED_IDENTIFIER = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

interface Violation {
  readonly file: string;
  readonly throwLine: number;
  readonly textLine: number;
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The scan itself — exported implicitly via the `it` blocks below (kept
 * local to this file, not `httpFailure.ts`, since it is test infrastructure,
 * never shipped code — same posture as `src/host/purityScan.ts`).
 */
function findViolations(file: string, content: string): Violation[] {
  const rawLines = content.split('\n');
  const codeLines = rawLines.map((line) => (COMMENT_ONLY_LINE.test(line) ? '' : line));

  const throwLines: number[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    if (THROW_NEW_ERROR.test(codeLines[i] ?? '')) throwLines.push(i);
  }

  // Marked `.text()` reads whose captured identifier is PROVEN, on this
  // pass, to appear inside a nearby throw's arguments — the marker does not
  // get to suppress these (T6 review: "the tripwire's own allowlist marker
  // unconditionally suppresses detection" hardening).
  const unmaskedMarkedViolations: Violation[] = [];
  const textLines: number[] = [];

  for (let i = 0; i < codeLines.length; i++) {
    const codeLine = codeLines[i] ?? '';
    if (!TEXT_CALL.test(codeLine)) continue;

    if (!ALLOW_MARKER.test(rawLines[i] ?? '')) {
      textLines.push(i);
      continue;
    }

    const identifier = ASSIGNED_IDENTIFIER.exec(codeLine)?.[1];
    if (!identifier) {
      // Marked, but not the trusted assignment shape (e.g. a bare `.text()`
      // inlined directly into a throw's arguments, with the marker slapped
      // on the same line). No exemption — falls through to the same
      // proximity scan an unmarked call gets, which already catches the
      // inline-into-throw shape.
      textLines.push(i);
      continue;
    }

    const identifierUsed = new RegExp(`\\b${escapeForRegExp(identifier)}\\b`);
    for (const throwLine of throwLines) {
      if (Math.abs(throwLine - i) <= WINDOW && identifierUsed.test(codeLines[throwLine] ?? '')) {
        unmaskedMarkedViolations.push({ file, throwLine: throwLine + 1, textLine: i + 1 });
      }
    }
    // Identifier captured but never seen inside a nearby throw: the marker's
    // exemption holds — this line is deliberately NOT added to `textLines`.
  }

  const violations: Violation[] = [...unmaskedMarkedViolations];
  for (const throwLine of throwLines) {
    for (const textLine of textLines) {
      if (Math.abs(throwLine - textLine) <= WINDOW) {
        violations.push({ file, throwLine: throwLine + 1, textLine: textLine + 1 });
      }
    }
  }
  return violations;
}

/**
 * The §4 adopter table's enumerated HTTP-path files, read fresh off disk on
 * every run (paths relative to this file, `src/shared/`).
 */
const TARGET_FILES: readonly string[] = [
  '../host/dashboard/HermesDashboardClient.ts',
  '../autocomplete/backends/OllamaFimBackend.ts',
  '../autocomplete/backends/VllmFimBackend.ts',
  '../autocomplete/backends/LlamaCppInfillBackend.ts',
  '../autocomplete/backends/CodestralFimBackend.ts',
  '../autocomplete/backends/OpenAICompatFimBackend.ts',
  '../rag/embedder.ts',
];

function loadTargetFiles(): { file: string; content: string }[] {
  return TARGET_FILES.map((rel) => ({
    file: rel,
    content: readFileSync(join(__dirname, rel), 'utf-8'),
  }));
}

describe('httpFailure.invariant — enumerated HTTP-path files carry no body-into-throw leak', () => {
  it('discovers all 7 enumerated files (non-vacuous file discovery)', () => {
    const files = loadTargetFiles();
    expect(files).toHaveLength(7);
    for (const f of files) {
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

  it('HermesDashboardClient.ts really does call .text() and really does carry the allow marker (grounds the allowlist decision, not assumed)', () => {
    const f = loadTargetFiles().find((x) => x.file.endsWith('HermesDashboardClient.ts'));
    expect(f).toBeDefined();
    expect(f?.content).toMatch(TEXT_CALL);
    expect(f?.content).toMatch(ALLOW_MARKER);
  });

  it('embedder.ts really does mention .text() in a comment near a throw (grounds the documented false-positive risk, not hypothetical)', () => {
    const f = loadTargetFiles().find((x) => x.file.endsWith('embedder.ts'));
    expect(f).toBeDefined();
    expect(f?.content).toMatch(/await res\.text\(\)/);
    expect(f?.content).toMatch(THROW_NEW_ERROR);
  });

  it('the 5 backends with no HTTP body reads at all pass vacuously (sanity: no .text() token present)', () => {
    const files = loadTargetFiles();
    for (const name of [
      'OllamaFimBackend.ts',
      'VllmFimBackend.ts',
      'LlamaCppInfillBackend.ts',
      'CodestralFimBackend.ts',
      'OpenAICompatFimBackend.ts',
    ]) {
      const f = files.find((x) => x.file.endsWith(name));
      expect(f).toBeDefined();
      expect(TEXT_CALL.test(f?.content ?? '')).toBe(false);
    }
  });

  it('zero violations across the real enumerated files today — the actual enforcement', () => {
    const files = loadTargetFiles();
    const violations = files.flatMap((f) => findViolations(f.file, f.content));
    expect(violations).toEqual([]);
  });
});

/**
 * RED-first non-vacuous proof (in-memory injection, no disk write — the same
 * technique `authGuardLock.test.ts`'s own "RED-first non-vacuous proof"
 * block uses, for the same reason: proving the mechanism CAN fail is the
 * point, and injecting real files into `backends/`/`dashboard/` from a test
 * risks colliding with other suites' concurrent temp-file probes in this
 * repo (documented at `purityScan.ts:116-137`).
 */
describe('httpFailure.invariant — RED-first non-vacuous proof (in-memory injection)', () => {
  it('flags a hypothetical backend that inlines the response body directly into the throw (the naive future violation)', () => {
    const injected = [
      'if (!res.ok) {',
      '  throw new Error(`op failed: ${await res.text()}`);',
      '}',
    ].join('\n');
    expect(findViolations('__hypothetical__.ts', injected).length).toBeGreaterThan(0);
  });

  it('flags a hypothetical backend that reads the body into a variable a few lines before throwing — the ACTUAL historical UI I-5 shape, reproduced', () => {
    const injected = [
      'if (!res.ok) {',
      '  let detail = "";',
      '  try {',
      '    detail = (await res.text()).slice(0, 500);',
      '  } catch {',
      '    /* body unreadable */',
      '  }',
      '  throw new Error(`dashboard failed: ${res.status}${detail ? `: ${detail}` : ""}`);',
      '}',
    ].join('\n');
    const violations = findViolations('__hypothetical__.ts', injected);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('does NOT flag a fixed, body-free throw with no nearby .text() at all (negative control)', () => {
    const injected = [
      'if (!res.ok) {',
      '  throw new Error(httpFailureMessage("op", res.status, res.statusText));',
      '}',
    ].join('\n');
    expect(findViolations('__hypothetical__.ts', injected)).toEqual([]);
  });

  it('does NOT flag a .text() call carrying the explicit allowlist marker (the dashboard-logger escape hatch, exercised synthetically)', () => {
    const injected = [
      'if (!res.ok) {',
      '  const body = (await res.text()).slice(0, 500); // httpFailure-tripwire-allow: logged only, never thrown',
      '  if (body) logger.append(body);',
      '  throw new Error(httpFailureMessage("op", res.status, res.statusText));',
      '}',
    ].join('\n');
    expect(findViolations('__hypothetical__.ts', injected)).toEqual([]);
  });

  it('does NOT flag a .text() call that only appears inside a // comment (the embedder.ts false-positive risk, reproduced synthetically)', () => {
    const injected = [
      '// audit note: this used to interpolate await res.text() here',
      'throw new Error(`op failed: ${res.status}`);',
    ].join('\n');
    expect(findViolations('__hypothetical__.ts', injected)).toEqual([]);
  });

  it('DOES still flag a genuine violation elsewhere in a file that also has a .text()-mentioning comment (comment-blanking does not create a blind spot for real code)', () => {
    const injected = [
      '// audit note: this used to interpolate await res.text() here',
      'throw new Error(`op failed: ${await res.text()}`);',
    ].join('\n');
    expect(findViolations('__hypothetical__.ts', injected).length).toBeGreaterThan(0);
  });

  it('a throw with no .text() anywhere in the file passes, even a large file (window boundary sanity: distance > WINDOW does not flag)', () => {
    const paddingBefore = Array.from({ length: WINDOW + 5 }, (_, i) => `// padding line ${i}`).join('\n');
    const injected = [
      'const body = (await res.text()).slice(0, 500);',
      paddingBefore,
      'throw new Error(httpFailureMessage("op", res.status, res.statusText));',
    ].join('\n');
    expect(findViolations('__hypothetical__.ts', injected)).toEqual([]);
  });

  // --- T6-review hardening: the allowlist marker must not blind-trust a
  // `.text()` read whose captured value actually reaches a throw. ---

  it('DOES flag a .text() call carrying the allowlist marker when its captured identifier actually flows into a nearby throw (T6 review: marker no longer blind-trusts .text()-into-throw)', () => {
    const injected = [
      'if (!res.ok) {',
      '  const body = (await res.text()).slice(0, 500); // httpFailure-tripwire-allow: logged only, never thrown',
      '  throw new Error(`dashboard failed: ${res.status}: ${body}`);',
      '}',
    ].join('\n');
    const violations = findViolations('__hypothetical__.ts', injected);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('DOES flag a bare, unassigned .text() call inlined straight into a throw even when marked (the marker only ever exempted the log-shape assignment, never arbitrary inlining)', () => {
    const injected = [
      'if (!res.ok) {',
      '  throw new Error(`op failed: ${await res.text()}`); // httpFailure-tripwire-allow: not actually log-only',
      '}',
    ].join('\n');
    const violations = findViolations('__hypothetical__.ts', injected);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('still does NOT flag the legitimate marker usage when the captured identifier is used ONLY for logging, never for the throw (negative control, re-affirmed post-hardening)', () => {
    const injected = [
      'if (!res.ok) {',
      '  const body = (await res.text()).slice(0, 500); // httpFailure-tripwire-allow: logged only, never thrown',
      '  if (body) logger.append(body);',
      '  throw new Error(httpFailureMessage("op", res.status, res.statusText));',
      '}',
    ].join('\n');
    expect(findViolations('__hypothetical__.ts', injected)).toEqual([]);
  });
});
