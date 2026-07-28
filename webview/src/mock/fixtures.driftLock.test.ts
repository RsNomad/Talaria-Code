import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/**
 * T-19 (Tier-2 remediation architecture §12.1, C4 — drift lock): `fixtures.ts`'s
 * own module doc says it is a "MIRROR of src/shared/mockScenario.ts — the
 * SAME scripted turn + panel snapshots the host's MockBackend replays" — but
 * nothing mechanically enforced that claim. Before this task, an edit to
 * EITHER copy's `mockTurn`/`panelData`/`mockTheme`/`mockApprovalId` (e.g. a
 * changed tool-output string, an added plan step, a renamed MCP server)
 * could land in one file and not the other with zero test failure — the
 * standalone browser dev build (`fixtures.ts`) would then silently render a
 * DIFFERENT scripted turn than the real extension host's MockBackend
 * (`mockScenario.ts`), defeating the whole point of "so standalone browser
 * dev renders identically to the real extension host" (`fixtures.ts`'s own
 * doc).
 *
 * A BYTE-COMPARE lock, not a runtime import: both files happen to be
 * import-free of `vscode`, so a live `import()` of both IS technically
 * possible here — but comparing extracted SOURCE TEXT (this file's own
 * `extractValue`/`normalize` below) needs no module resolution, no bundler,
 * and stays correct even if one side ever gained a dependency the other
 * couldn't satisfy (mirrors the `MockBackend.driftLock.test.ts` lock's own
 * "byte-compare, not runtime import" reasoning for `guard.ts`, which is
 * vscode-coupled for real).
 *
 * The two files are NOT byte-identical as whole files — `mockScenario.ts`
 * carries an extra `MockScenario` interface + a trailing `mockScenario =
 * {timeline, panels}` wrapper `fixtures.ts` has no equivalent for (host-only
 * bookkeeping, never claimed to be mirrored), and the two files differ in
 * incidental formatting (single-line vs. multi-line object literals,
 * trailing commas, a couple of comments). This lock therefore extracts each
 * of the four SHARED exported bindings — `mockTurn`, `panelData`,
 * `mockTheme`, `mockApprovalId`, the things `fixtures.ts`'s doc actually
 * claims are mirrored — from both files' source text, strips comments via
 * the real TypeScript compiler (`ts.transpileModule`, which correctly
 * ignores `//`/`/* *\/` sequences that appear INSIDE string literals, unlike
 * a naive regex — `postgres://localhost/app` lives in this exact data),
 * then normalizes whitespace and trailing commas before comparing. What
 * remains after normalization is real DATA content: any changed string,
 * number, added/removed step, or reordered field fails this lock.
 */

const FIXTURES_PATH = join(__dirname, 'fixtures.ts');
const MOCK_SCENARIO_PATH = join(__dirname, '..', '..', '..', 'src', 'shared', 'mockScenario.ts');

/**
 * Extracts the VALUE text of `export const <marker's last word> = <value>;`
 * starting at `marker` (a full `export const <name>` string). Handles both
 * bracket-delimited values (`[...]`/`{...}`, depth-matched so nested
 * brackets/braces inside the value don't terminate early) and bare
 * expressions (`= SOME_IDENTIFIER;`).
 */
function extractValue(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`drift lock setup: marker not found: ${marker}`);
  const eq = source.indexOf('=', start);
  let i = eq + 1;
  while (i < source.length && /\s/.test(source[i] ?? '')) i++;
  const openCh = source[i];
  if (openCh === '[' || openCh === '{') {
    const closeCh = openCh === '[' ? ']' : '}';
    let depth = 0;
    let end = -1;
    for (let j = i; j < source.length; j++) {
      if (source[j] === openCh) depth++;
      else if (source[j] === closeCh) {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`drift lock setup: could not close value for ${marker}`);
    return source.slice(i, end);
  }
  const semi = source.indexOf(';', i);
  if (semi === -1) throw new Error(`drift lock setup: no terminating ';' for ${marker}`);
  return source.slice(i, semi).trim();
}

/** Strips comments via the real TS compiler (string-literal-aware, unlike a
 *  regex), then collapses whitespace and trailing commas — the remaining
 *  text is pure data content, insensitive to formatting style. */
function normalize(exprText: string): string {
  const { outputText } = ts.transpileModule(`const __x = ${exprText};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, removeComments: true },
  });
  return outputText.replace(/,\s*([}\]])/g, '$1').replace(/\s+/g, '');
}

function extractNormalized(source: string, marker: string): string {
  return normalize(extractValue(source, marker));
}

const MARKERS = ['export const mockTurn', 'export const panelData', 'export const mockTheme', 'export const mockApprovalId'];

describe('T-19 (C4) drift lock: webview/src/mock/fixtures.ts mirrors src/shared/mockScenario.ts', () => {
  const fixturesSource = readFileSync(FIXTURES_PATH, 'utf8');
  const mockScenarioSource = readFileSync(MOCK_SCENARIO_PATH, 'utf8');

  it('setup: both files exist and are read (non-vacuous — proves the paths above are right)', () => {
    expect(fixturesSource.length).toBeGreaterThan(0);
    expect(mockScenarioSource.length).toBeGreaterThan(0);
  });

  it('setup: all four markers are present in BOTH files and extract non-empty values', () => {
    for (const marker of MARKERS) {
      const a = extractValue(fixturesSource, marker);
      const b = extractValue(mockScenarioSource, marker);
      expect(a.length, `${marker}: fixtures.ts extracted empty`).toBeGreaterThan(0);
      expect(b.length, `${marker}: mockScenario.ts extracted empty`).toBeGreaterThan(0);
    }
  });

  it.each(MARKERS)('%s: byte-identical content in both files (comments/formatting-insensitive)', (marker) => {
    const a = extractNormalized(fixturesSource, marker);
    const b = extractNormalized(mockScenarioSource, marker);
    expect(a).toBe(b);
  });

  it('non-vacuity: normalize() actually discriminates — two genuinely different snippets do NOT compare equal', () => {
    const a = normalize(`[{ a: 1, text: 'hello' }]`);
    const b = normalize(`[{ a: 1, text: 'goodbye' }]`);
    expect(a).not.toBe(b);
  });

  it('non-vacuity: normalize() ignores formatting-only differences (whitespace, trailing commas, comments)', () => {
    const a = normalize(`[{ a: 1, text: 'hello', }]`);
    const b = normalize(`[\n  {\n    a: 1, // a comment\n    text: 'hello'\n  },\n]`);
    expect(a).toBe(b);
  });

  it('non-vacuity: normalize() does NOT strip a "//" that lives inside a string literal (the exact hazard a naive regex would hit — this data contains "postgres://localhost/app")', () => {
    const withUrl = normalize(`[{ command: 'npx -y server-postgres postgres://localhost/app', toolCount: 6 }]`);
    expect(withUrl).toContain("postgres://localhost/app");
    expect(withUrl).toContain('toolCount:6');
  });

  it('RED-first proof: a planted drift in one copy would be caught (in-memory injection, no disk write)', () => {
    const real = extractNormalized(fixturesSource, 'export const mockTheme');
    const corrupted = normalize(extractValue(fixturesSource, 'export const mockTheme').replace('dark', 'DRIFTED'));
    expect(corrupted).not.toBe(real);
  });
});
