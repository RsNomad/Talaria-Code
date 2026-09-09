import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import { isWithin } from '../backend/acp/pathConfine';

/**
 * W4-T2 / L2-CA-24: the canonical containment check, re-exported under its
 * historical name here — this IS `pathConfine.ts`'s own `isWithin` (now
 * exported), not a local copy any more (the last byte-twin is gone).
 * `resolveRootCoordinator` only ever uses it to pick WHICH already-open
 * workspace folder a cwd belongs to.
 */
export { isWithin as isPathWithin };

/** The open workspace folder that CONTAINS `cwd`, or the first folder / `cwd` itself when none contains it (no workspace open — a bare cwd is its own root). */
export function findContainingWorkspaceRoot(cwd: string, roots: readonly string[]): string {
  const firstRoot = roots[0];
  if (roots.length === 0 || firstRoot === undefined) return cwd;
  const resolved = path.resolve(cwd || firstRoot);
  for (const root of roots) {
    if (isWithin(resolved, path.resolve(root))) return root;
  }
  return firstRoot;
}

/**
 * Realpath a workspace root to its canonical form (sync — this keeps
 * {@link buildSessionPort}/{@link resolveRootCoordinator} synchronous,
 * matching `tryAcquireTurnLease`'s own synchronous-admission discipline;
 * called rarely — once per genuinely NEW root, not per-turn). Falls back
 * to the lexical form on any FS error (a not-yet-existing/unreadable root
 * still needs a STABLE key). An empty/falsy `root` is returned AS-IS —
 * never realpath'd — so a degenerate no-cwd caller (headless tests) never
 * silently resolves to `process.cwd()` via `path.resolve('')`.
 */
export function canonicalizeWorkspaceRoot(root: string): string {
  if (!root) return root;
  try {
    return realpathSync(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}
