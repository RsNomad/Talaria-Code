/*
 * F-4 (final-4way-fixes.md, SECURITY-invariant mechanization) — automated
 * byte-freeze lock for `classifyPath` (`./secretPaths.ts`).
 *
 * `classifyPath` is FROZEN at Hermes core `edit_approval.py` byte-parity
 * (locked user decision 2026-07-15 — see `secretPaths.ts`'s own header
 * comment and this directory's `secretPaths.test.ts` "UNCHANGED by the
 * isSecretForCompletion broaden" suites, which already pin the freeze
 * BEHAVIOURALLY). Until this file, that freeze was enforced ONLY
 * behaviourally, via the classifier's own input/output tests — a
 * behavior-preserving REFORMAT (rename a local variable, rewrap a line,
 * reorder a boolean clause without changing its truth table) would pass
 * every existing behavioural test while silently breaking BYTE parity with
 * the Hermes core origin, which `edit_approval.py`-audit-diffability
 * depends on.
 *
 * This test hashes the EXACT source bytes of the `classifyPath` function —
 * extracted via STABLE TEXT MARKERS (never line numbers, so an edit
 * anywhere else in the file can never shift what's hashed) — and pins the
 * sha256 as a golden constant. `classifyPath` is verified byte-frozen as of
 * THIS commit; pinning its current bytes IS the freeze, so this test's only
 * job from here on is to fail the moment a FUTURE edit changes so much as
 * one byte of the function.
 *
 * Changing `classifyPath` requires a DELIBERATE golden update PLUS
 * re-verification against the Hermes core `edit_approval.py` origin —
 * NEVER a silent "just update the hash to make the test pass".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SECRET_PATHS_PATH = join(__dirname, 'secretPaths.ts');

const START_MARKER = 'export function classifyPath';
const CLOSE_MARKER = '\n}\n';

/**
 * Extract the exact source span of `classifyPath` from `source`: from the
 * index of `export function classifyPath` through the first `\n}\n` after
 * it (inclusive of that closing brace + newline) — the STABLE-MARKER
 * algorithm the brief mandates. Deliberately marker-based, never line-
 * number-based, so edits to OTHER functions/doc comments in the file (which
 * shift line numbers freely) can never change what gets hashed here.
 */
function extractClassifyPathSpan(source: string): string {
  const start = source.indexOf(START_MARKER);
  if (start === -1) {
    throw new Error(
      `"${START_MARKER}" marker not found in secretPaths.ts — has classifyPath been renamed or removed?`,
    );
  }
  const closeIdx = source.indexOf(CLOSE_MARKER, start);
  if (closeIdx === -1) {
    throw new Error('no closing `\\n}\\n` found after classifyPath — malformed extraction span');
  }
  return source.slice(start, closeIdx + CLOSE_MARKER.length);
}

/**
 * GOLDEN — the sha256 (hex) of `classifyPath`'s exact extracted source
 * bytes, computed and pinned 2026-07-16 (this commit, final-4way-fixes F-4).
 * This is `classifyPath` exactly as the 2026-07-15 byte-parity lock left
 * it. See this file's header for what changing it requires.
 */
const GOLDEN_SHA256 = '3e7a0b3e6805415b4ad24c520c141bb0b578598bd2b574fcb65dc69cfec79bf2';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('classifyPath — F-4: automated byte-freeze lock (edit_approval.py audit-parity)', () => {
  it('the extracted span\'s sha256 matches the pinned golden — not one byte has changed since the freeze', () => {
    const source = readFileSync(SECRET_PATHS_PATH, 'utf-8');
    const span = extractClassifyPathSpan(source);
    expect(sha256Hex(span)).toBe(GOLDEN_SHA256);
  });

  it('sanity: the extracted span is really classifyPath (starts with its signature, ends with the closing brace, contains its body)', () => {
    const source = readFileSync(SECRET_PATHS_PATH, 'utf-8');
    const span = extractClassifyPathSpan(source);
    expect(span.startsWith('export function classifyPath(posixPath: string)')).toBe(true);
    expect(span.endsWith('\n}\n')).toBe(true);
    expect(span).toContain("basename === '.env'");
    // The span must stop at classifyPath's OWN closing brace — it must not
    // swallow the next function (isSecretForCompletion never appears here).
    expect(span).not.toContain('isSecretForCompletion');
  });

  it('the extraction is isolated to classifyPath: edits elsewhere in the file leave the hashed span (and hash) unchanged', () => {
    const source = readFileSync(SECRET_PATHS_PATH, 'utf-8');
    // Simulate an edit to a doc comment / a sibling function — content added
    // both before and after the real file, deliberately NOT containing
    // another "export function classifyPath" marker.
    const decorated = `/* pretend an unrelated doc-comment edit landed here */\n${source}\n// pretend an unrelated trailing edit landed here\n`;
    const realSpan = extractClassifyPathSpan(source);
    const decoratedSpan = extractClassifyPathSpan(decorated);
    expect(decoratedSpan).toBe(realSpan);
    expect(sha256Hex(decoratedSpan)).toBe(GOLDEN_SHA256);
  });

  /*
   * RED-first planted-violation proof (non-vacuity): mutate exactly one
   * byte-affecting substring of the REAL extracted span and prove the
   * resulting hash does NOT match the golden — demonstrating this lock
   * would actually catch a real drift, not just always pass by
   * construction. This is the "second test" the brief requires, in the same
   * spirit as this repo's other invariant locks' non-vacuous self-checks
   * (e.g. `contextPurity.test.ts`'s "RED-first proof" injections).
   */
  it('RED-first proof: a single planted mutation (secret -> secretX) changes the hash — the lock is non-vacuous', () => {
    const source = readFileSync(SECRET_PATHS_PATH, 'utf-8');
    const span = extractClassifyPathSpan(source);
    const mutated = span.replace('secret', 'secretX');

    expect(mutated).not.toBe(span); // sanity: the replace actually changed something
    expect(sha256Hex(mutated)).not.toBe(GOLDEN_SHA256);
  });
});
