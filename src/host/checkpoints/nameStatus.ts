/** One file's change status between two trees (or a tree and the live worktree). */
export type DiffStatus = 'added' | 'modified' | 'deleted';

/** One entry of a {@link CheckpointTracker.diff} result. */
export interface CheckpointDiffEntry {
  /** POSIX-relative path from the workspace root. */
  path: string;
  status: DiffStatus;
}

/**
 * Parse `git diff-tree --name-status -z` output. The `-z` stream is a flat run
 * of NUL-terminated tokens: `STATUS\0PATH\0` per change, except renames/copies
 * (`R###`/`C###`) which carry `STATUS\0OLDPATH\0NEWPATH\0`. Rename detection is
 * NOT enabled here (the {@link CheckpointTracker.diffTrees} call passes no
 * `-M`/`-C`), but we parse it defensively so a future `-M` can't corrupt the
 * walk (i.e. misinterpret the 3-token record as two 2-token ones).
 */
export function parseNameStatusZ(output: string): CheckpointDiffEntry[] {
  const tokens = output.split('\0');
  const entries: CheckpointDiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusCode = tokens[i];
    if (!statusCode) {
      i++;
      continue;
    }
    if (statusCode[0] === 'R' || statusCode[0] === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      // CKP-04 (WS-CK CA-M08): a rename record restores content at NEWPATH and
      // must ALSO delete OLDPATH, or an -M/-C-enabled diff would leave a stale
      // duplicate on disk that restoreInternal never removes. RENAME ONLY: for
      // a COPY the source path still exists in the target tree — emitting a
      // deletion for it would destroy a live file. (Rename detection is still
      // not enabled by any live call site; this arms the parser correctly so
      // enabling -M/-C can never silently corrupt a restore.)
      if (statusCode[0] === 'R' && oldPath !== undefined) {
        entries.push({ path: oldPath, status: 'deleted' });
      }
      if (newPath) entries.push({ path: newPath, status: 'modified' });
      i += 3;
      continue;
    }
    const filePath = tokens[i + 1];
    if (filePath === undefined) break;
    const status: DiffStatus =
      statusCode[0] === 'A' ? 'added' : statusCode[0] === 'D' ? 'deleted' : 'modified';
    entries.push({ path: filePath, status });
    i += 2;
  }
  return entries;
}
