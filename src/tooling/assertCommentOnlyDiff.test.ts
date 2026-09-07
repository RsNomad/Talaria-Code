import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * W0-0 (round-2 DEFER close-out program pre-flight) — self-test for
 * `scripts/assert-comment-only-diff.mjs`, the gate a LATER workstream
 * (WS-F13, FI-01 comment-archaeology retirement) will run on every
 * comment-only commit before it lands.
 *
 * The script's core claim is "printer-equality": parse both revisions of a
 * file with `ts.createSourceFile`, reprint each with
 * `ts.createPrinter({ removeComments: true })`, and require the two printed
 * strings to be byte-equal. That is a strictly stronger check than a
 * `git diff -U0` regex gate — it is immune to whitespace/formatting churn
 * inside comments AND to a rewritten comment that happens to mention a
 * changed-code marker word (case ii below is exactly the shape that fools a
 * line-based regex: a real code token changes, but the enclosing string
 * still contains "no longer" both before and after — `AcpBackend.ts` has two
 * such literals in production, see the finding's brief).
 *
 * Printer-equality alone has one known blind spot (critic finding I-11):
 * `removeComments: true` strips EVERY comment before comparing, including a
 * newly-added `@ts-ignore`/`@ts-nocheck`/etc. pragma — a comment that changes
 * compiler or tooling BEHAVIOUR, not just prose. This repo has no ESLint to
 * catch that separately, so the script ALSO diffs the multiset of
 * pragma-bearing comments per file and fails on any change (case iii below).
 *
 * All three cases run the script in its `--files <a> <b>` self-test mode
 * (comparing two files written to a temp dir) so this test needs no git
 * fixtures or a real commit pair.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const scriptPath = path.join(repoRoot, 'scripts', 'assert-comment-only-diff.mjs');

function runFilesMode(textA: string, textB: string): number | null {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'talaria-comment-only-diff-'));
  try {
    const aPath = path.join(dir, 'a.ts');
    const bPath = path.join(dir, 'b.ts');
    writeFileSync(aPath, textA, 'utf8');
    writeFileSync(bPath, textB, 'utf8');
    const result = spawnSync(process.execPath, [scriptPath, '--files', aPath, bPath], {
      encoding: 'utf8',
    });
    return result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('assert-comment-only-diff.mjs --files (W0-0)', () => {
  it('(i) exits 0 when the two sources differ ONLY in comment text', () => {
    const a = `export function add(x: number, y: number): number {\n  // old comment\n  return x + y;\n}\n`;
    const b = `export function add(x: number, y: number): number {\n  // NEW comment, rewritten entirely\n  return x + y;\n}\n`;

    expect(runFilesMode(a, b)).toBe(0);
  });

  it('(ii) exits 1 when a real token changes inside a string literal that still contains "no longer" both before and after', () => {
    const a = `export const s = 'this is no longer true';\n`;
    const b = `export const s = 'this is no longer FALSE';\n`;

    expect(runFilesMode(a, b)).toBe(1);
  });

  it('(iii) exits 1 when the only change is an added "// @ts-ignore" line — printer-equality alone would say 0, the pragma-multiset diff catches it', () => {
    const a = `export function risky(): number {\n  return 1;\n}\n`;
    const b = `export function risky(): number {\n  // @ts-ignore\n  return 1;\n}\n`;

    expect(runFilesMode(a, b)).toBe(1);
  });
});
