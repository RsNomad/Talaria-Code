/**
 * Minimal vendored typing of the built-in Git extension's public API — ONLY
 * the surface `gitPort.ts` uses (§2a: "vendored copy of microsoft/vscode
 * extensions/git/src/api/git.d.ts", trimmed per the T2d brief: "do not
 * vendor the entire upstream file"). Types only — no runtime import, no
 * value exports; every use site is `import type`.
 *
 * Grounded at write-time by fetching the upstream source directly
 * (`https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/src/api/git.d.ts`,
 * `main` branch) and quoting the exact interfaces below — NOT written from
 * memory, per the T2d brief's mandatory grounding requirement. This is the
 * same Context7 grounding already performed elsewhere in this repo for the
 * same activation sequence; that grounding is reused here, not re-derived.
 *
 * The full upstream file also declares many methods/interfaces this
 * extension never calls (branches, remotes, staging, merge, worktrees,
 * stash, …) — deliberately NOT vendored, per the brief's "minimal" scope.
 * `readonly` throughout mirrors the upstream file (the git extension's own
 * objects are not meant to be mutated through this API, except
 * `InputBox.value`, which upstream itself declares mutable).
 */
import type { Event, Uri } from 'vscode';

/** `git.d.ts` `GitExtension` — what
 * `vscode.extensions.getExtension<GitExtension>('vscode.git')` resolves to. */
export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;

  /**
   * Returns a specific API version.
   *
   * Throws error if git extension is disabled. You can listen to the
   * `GitExtension.onDidChangeEnablement` event to know when the extension
   * becomes enabled/disabled.
   *
   * (Upstream doc comment, quoted verbatim — the "throws" behavior is why
   * `gitPort.ts` checks {@link GitExtension.enabled} BEFORE ever calling this.)
   */
  getAPI(version: 1): API;
}

export interface API {
  readonly repositories: Repository[];
  getRepository(uri: Uri): Repository | null;
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

export interface Change {
  /**
   * Returns either `originalUri` or `renameUri`, depending on whether this
   * change is a rename change. When in doubt always use `uri` over the
   * other two alternatives. (Upstream doc comment, quoted verbatim.)
   */
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  // `status` (upstream's `Status` enum) intentionally NOT vendored: no
  // consumer here reads it (`gitPort.ts`/`gitMappers.ts` use `Change.uri`
  // only), and a prior hand-rolled copy had ordinals that diverged from
  // upstream. Vendor the CORRECT enum, grounded against upstream at that
  // time, when a real consumer (e.g. T5/commit-gen) needs `Change.status`.
}

export interface RepositoryState {
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly onDidChange: Event<void>;
}

export interface InputBox {
  value: string;
}

export interface LogOptions {
  /** Max number of log entries to retrieve. If not specified, the default
   * is 32. (Upstream doc comment.) */
  readonly maxEntries?: number;
  readonly range?: string;
  readonly sortByAuthorDate?: boolean;
  readonly shortStats?: boolean;
  readonly author?: string;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;

  getConfig(key: string): Promise<string>;
  getGlobalConfig(key: string): Promise<string>;

  /** Refresh `state` from disk before reading it (upstream: "status(): Promise<void>"). */
  status(): Promise<void>;

  /** `cached === true` ⇒ `git diff --cached` (staged) semantics; `false`/omitted ⇒ working-tree diff. */
  diff(cached?: boolean): Promise<string>;

  log(options?: LogOptions): Promise<Commit[]>;
}
