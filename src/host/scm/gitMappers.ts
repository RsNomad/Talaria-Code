/**
 * Pure mappers for `gitPort.ts` (§2a T2d brief: "Extract any pure mapping
 * (Change[] → changedPaths rows) as a headless-tested helper"). Zero
 * `vscode`/`git.d.ts` import — {@link ChangeLike} is a minimal STRUCTURAL
 * shape (the vscode-journal `InMemoryFileSystem` pattern §2a favors), so the
 * real vendored `Change` (`./git.d.ts`, `uri: vscode.Uri`) satisfies it
 * without this file ever importing `vscode` or the vendored types.
 */

/** The only field this mapper reads off a git-extension `Change` — matches
 * `git.d.ts` `Change.uri: Uri` structurally (`Uri.fsPath: string`). */
export interface ChangeLike {
  uri: { fsPath: string };
}

export interface ChangedPathRow {
  path: string;
  staged: boolean;
}

/**
 * `Change[]` (one of `RepositoryState.workingTreeChanges` /
 * `.indexChanges`) → `GitPort.changedPaths()` rows, stamped with the
 * caller-supplied `staged` flag (the git extension API keeps staged/unstaged
 * as two separate arrays — see `git.d.ts` `RepositoryState` — rather than a
 * per-Change flag, so the flag has to come from WHICH array `gitPort.ts` read).
 */
export function mapChangesToRows(changes: readonly ChangeLike[], staged: boolean): ChangedPathRow[] {
  return changes.map((c) => ({ path: c.uri.fsPath, staged }));
}

/**
 * `Commit.message` (git.d.ts, may be multi-line: subject + blank + body) →
 * just the subject line, for `GitPort.recentSubjects()`. Pure string split —
 * no git.d.ts/vscode dependency.
 */
export function commitSubject(message: string): string {
  const idx = message.indexOf('\n');
  return idx === -1 ? message : message.slice(0, idx);
}
