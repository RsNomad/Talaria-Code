import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { canonicalizeWorkspaceRoot, findContainingWorkspaceRoot, isPathWithin } from './rootResolution';

function detectSymlinkSupport(): boolean {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-symcap-'));
    symlinkSync(os.tmpdir(), path.join(dir, 'l'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
const CAN_SYMLINK = detectSymlinkSupport();

const A = path.resolve('/proj/a');
const CHILD = path.resolve('/proj/a/child');

describe('findContainingWorkspaceRoot — FIRST-LISTED-WINS (spec req 5 pin)', () => {
  it('a folder always contains itself', () => {
    expect(findContainingWorkspaceRoot(A, [A])).toBe(A);
  });
  it('[A/child, A]: a cwd under child resolves to A/child (listed first)', () => {
    expect(findContainingWorkspaceRoot(path.join(CHILD, 'x'), [CHILD, A])).toBe(CHILD);
  });
  it('[A, A/child]: the SAME cwd resolves to A — first-listed wins, NOT deepest/parent-wins', () => {
    expect(findContainingWorkspaceRoot(path.join(CHILD, 'x'), [A, CHILD])).toBe(A);
  });
  it('no containing folder -> falls back to the FIRST root', () => {
    expect(findContainingWorkspaceRoot(path.resolve('/elsewhere'), [A, CHILD])).toBe(A);
  });
  it('zero roots -> cwd itself is its own root', () => {
    expect(findContainingWorkspaceRoot(A, [])).toBe(A);
  });
});

describe('canonicalizeWorkspaceRoot', () => {
  it('empty input passes through untouched (never resolves to process.cwd())', () => {
    expect(canonicalizeWorkspaceRoot('')).toBe('');
  });
  it('nonexistent path -> lexical path.resolve fallback (stable key)', () => {
    const ghost = path.join(os.tmpdir(), 'hermes-no-such-dir-xyz', '..', 'hermes-no-such-dir-xyz');
    expect(canonicalizeWorkspaceRoot(ghost)).toBe(path.resolve(ghost));
  });
  it.runIf(CAN_SYMLINK)('symlinked root resolves to its canonical target', () => {
    const real = mkdtempSync(path.join(os.tmpdir(), 'hermes-real-'));
    const linkParent = mkdtempSync(path.join(os.tmpdir(), 'hermes-link-'));
    const link = path.join(linkParent, 'ws');
    symlinkSync(real, link, 'junction');
    try {
      expect(canonicalizeWorkspaceRoot(link)).toBe(canonicalizeWorkspaceRoot(real));
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('isPathWithin', () => {
  it('self, child, escape', () => {
    expect(isPathWithin(A, A)).toBe(true);
    expect(isPathWithin(path.join(A, 'x'), A)).toBe(true);
    expect(isPathWithin(path.resolve('/proj/ab'), A)).toBe(false); // prefix-string trap
  });
});

afterAll(() => { /* nothing shared to clean */ });
