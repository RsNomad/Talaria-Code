import type { GitResult } from './gitProcess';

/**
 * The minimal `git` runner {@link missingObjects} needs: run `git <args>` (with
 * an optional stdin `input` and `allowFailure`) and resolve the exit code +
 * stdout. A narrow, injectable seam so every branch is vitest-fakeable WITHOUT a
 * real repo. Production binds this to {@link ./gitProcess.runGit} with the shadow
 * repo's cwd/env (see `CheckpointTracker.shadowGit`).
 */
export type RunGit = (
  args: string[],
  opts?: { input?: string; allowFailure?: boolean },
) => Promise<Pick<GitResult, 'code' | 'stdout'>>;

/**
 * OIDs referenced by `tree` (the tree object itself included) that are MISSING
 * from the object store the `git` runner points at. An empty array means the
 * tree's full object closure is present → it is safely restorable. A non-empty
 * array means at least one object cannot be read: a leaf blob pruned by an
 * external `gc --prune`, or — when a whole sub-tree is gone — `[tree]` itself.
 *
 * This is the F1 data-safety guard: `restoreInternal`'s old R1 pre-check
 * (`cat-file -e <tree>^{tree}`) validated ONLY the top tree object, so a pruned
 * *leaf* blob slipped past it and the apply loop then mutated the worktree
 * per-path until `git show <tree>:<path>` died mid-loop — a half-restored tree
 * with a stale baseline. Checking the whole closure up front converts that
 * partial-mutation-then-throw into a clean refusal.
 *
 * Never throws for a missing-object condition (a missing object is data, not an
 * error); only a runner-level failure of the `cat-file` batch propagates.
 *
 * Plumbing behaviours this relies on (verified empirically, git 2.54):
 *  - `ls-tree -r -t` lists entries WITHOUT reading their blobs (so a pruned leaf
 *    blob does NOT fail it) but EXITS NON-ZERO when a referenced SUB-tree object
 *    is missing (it cannot recurse) → we treat that as "closure broken" and
 *    return `[tree]` (the exact culprit OID is unknowable and unneeded).
 *  - `cat-file --batch-check` exits 0 even when an input OID is missing, printing
 *    `<oid> missing` for it → parse the output, never the exit code.
 *  - `-z` is MANDATORY: tree paths may contain newlines; NUL-delimited entries
 *    keep the OID (which precedes the TAB) unambiguous.
 */
export async function missingObjects(tree: string, git: RunGit): Promise<string[]> {
  // 1. Enumerate the closure. A missing SUB-tree makes `ls-tree` exit non-zero
  //    (it cannot recurse) — the whole closure is unusable, return `[tree]`.
  const listed = await git(['ls-tree', '-z', '-r', '-t', tree], { allowFailure: true });
  if (listed.code !== 0) return [tree];

  const oids = new Set<string>([tree]);
  for (const entry of listed.stdout.split('\0')) {
    if (entry === '') continue;
    // `<mode> SP <type> SP <oid> TAB <path>` — the OID is the third
    // whitespace-separated field of the part BEFORE the tab (paths, which
    // follow the tab, may contain any byte incl. spaces/newlines).
    const tab = entry.indexOf('\t');
    const meta = tab === -1 ? entry : entry.slice(0, tab);
    const oid = meta.split(/\s+/)[2];
    if (oid) oids.add(oid);
  }

  // 2. Batch-check every OID at once. Missing ones print `<oid> missing` at
  //    exit 0. No `allowFailure`: a non-zero exit here is a genuine runner
  //    failure (not a missing object) and must propagate.
  const check = await git(['cat-file', '--batch-check'], {
    input: [...oids].join('\n') + '\n',
  });
  const missing: string[] = [];
  for (const line of check.stdout.split('\n')) {
    const m = /^([0-9a-f]+) missing$/.exec(line.trim());
    const oid = m?.[1];
    if (oid !== undefined) missing.push(oid);
  }
  return missing;
}
