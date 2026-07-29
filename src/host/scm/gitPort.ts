/**
 * `GitPort` (`context/types.ts`) over the built-in Git extension API
 * (vendored minimal typing: `./git.d.ts`). NEVER spawns a `git` process
 * (§3.1 — POSIX/credential rationale; the extension API drives the SAME git
 * binary the Git extension already manages, so no `.exe`/PATH/shell-quoting
 * concerns on the Fedora target). Every method is best-effort and NEVER
 * throws — no git extension, a disabled git extension, or no open
 * repository all degrade to the port's documented safe-empty
 * (`''`/`[]`/`undefined`), matching `context/types.ts` `GitPort`'s contract
 * (T2b's resolver has its own try/catch+deadline backstop, but a
 * well-behaved port shouldn't need it).
 *
 * Grounded at write-time: the git extension's public surface is vendored
 * in `./git.d.ts` (see that file's header for the exact grounding — fetched
 * raw from `microsoft/vscode` at write-time, cross-checked against a prior
 * Context7 grounding of the SAME activation sequence — `Extension.isActive` /
 * `.activate()` / `GitExtension.enabled` BEFORE `getAPI(1)`, since `getAPI`
 * throws when the extension is disabled; never `!`-assert `getExtension`'s
 * result). `vscode.extensions.getExtension`/`Extension<T>.isActive`/
 * `.exports`/`.activate()` are themselves Context7-confirmed
 * (`/microsoft/vscode-docs`, session) and independently verified against
 * the installed `@types/vscode@1.125.0` (`getExtension<T>(extensionId:
 * string): Extension<T> | undefined`; `T`'s upstream default is the unsafe
 * `any` — one more reason the no-`!`-assert rule above matters).
 */
import * as vscode from 'vscode';

import type { GitPort } from '../context/types';
import { commitSubject, mapChangesToRows } from './gitMappers';
import type { API, GitExtension, Repository } from './git';

const GIT_EXTENSION_ID = 'vscode.git';

/**
 * W6-FG (3-way ARCH I-2 fix): the ONE extra capability the one-shot cwd
 * threading needs — the resolved repository's root filesystem path — kept
 * OUTSIDE the pure `GitPort` contract (`context/types.ts`) deliberately: the
 * headless `generateCommitCommand.ts` orchestrator (and its test fakes)
 * never needs it, only the `.vscode.ts` glue that binds `AcpBackend.oneShot`'s
 * now-EXPLICIT `cwd` parameter. Widening the return type of
 * {@link createGitPort} (rather than the `GitPort` interface itself) keeps
 * the headless port's shape frozen while still giving the ONE real consumer
 * that needs it a typed, non-cast path to it.
 */
export interface GitPortWithRepoRoot extends GitPort {
  /** The first open repository's root filesystem path, or `undefined` when
   * no git extension / no repository is available — mirrors every other
   * `GitPort` method's safe-empty-on-failure contract. NEVER throws. */
  repositoryRoot(): Promise<string | undefined>;
}

export function createGitPort(): GitPortWithRepoRoot {
  return new VscodeGitPort();
}

class VscodeGitPort implements GitPortWithRepoRoot {
  async repositoryRoot(): Promise<string | undefined> {
    const repo = await this.getRepository();
    return repo?.rootUri.fsPath;
  }

  async stagedDiff(): Promise<string> {
    const repo = await this.getRepository();
    if (!repo) return '';
    try {
      return await repo.diff(true);
    } catch {
      return '';
    }
  }

  async workingDiff(): Promise<string> {
    const repo = await this.getRepository();
    if (!repo) return '';
    try {
      return await repo.diff(false);
    } catch {
      return '';
    }
  }

  async changedPaths(): Promise<{ path: string; staged: boolean }[]> {
    const repo = await this.getRepository();
    if (!repo) return [];
    try {
      return [
        ...mapChangesToRows(repo.state.workingTreeChanges, false),
        ...mapChangesToRows(repo.state.indexChanges, true),
      ];
    } catch {
      return [];
    }
  }

  async recentSubjects(n: number, author?: 'user'): Promise<string[]> {
    const repo = await this.getRepository();
    if (!repo) return [];
    try {
      let authorPattern: string | undefined;
      if (author === 'user') {
        authorPattern = await this.resolveUserEmail(repo);
        // Can't determine "the user" ⇒ honest empty rather than silently
        // mislabeling every repo author's subjects as the user's own.
        if (!authorPattern) return [];
      }
      const commits = await repo.log({ maxEntries: n, author: authorPattern });
      return commits.map((c) => commitSubject(c.message));
    } catch {
      return [];
    }
  }

  /**
   * Synchronous by the `GitPort` contract (`readInputBox(): string`) — the
   * commit-message box is meant to be read/written from an already-live
   * SCM context (`scm/title` only fires `when: scmProvider == git`, so the
   * git extension is necessarily already active by then), so this resolves
   * the repository WITHOUT force-activating the extension (can't `await`
   * here); an inactive extension or no repo yields the documented safe-empty.
   */
  readInputBox(): string {
    return this.getRepositorySync()?.inputBox.value ?? '';
  }

  writeInputBox(text: string): void {
    const repo = this.getRepositorySync();
    if (repo) repo.inputBox.value = text;
  }

  async commitTemplate(): Promise<string | undefined> {
    const repo = await this.getRepository();
    if (!repo) return undefined;
    try {
      const template = await repo.getConfig('commit.template');
      return template || undefined;
    } catch {
      return undefined;
    }
  }

  private async getRepository(): Promise<Repository | undefined> {
    const api = await this.getApi();
    return api?.repositories[0];
  }

  private getRepositorySync(): Repository | undefined {
    return this.getApiSync()?.repositories[0];
  }

  /** Resolve the git extension's API, activating it if needed. Never throws. */
  private async getApi(): Promise<API | undefined> {
    try {
      const ext = vscode.extensions.getExtension<GitExtension>(GIT_EXTENSION_ID);
      if (!ext) return undefined; // git extension not installed/present
      const gitExtension = ext.isActive ? ext.exports : await ext.activate();
      if (!gitExtension.enabled) return undefined; // git.enabled: false
      return gitExtension.getAPI(1);
    } catch {
      return undefined;
    }
  }

  /** Same resolution, but never activates (no `await` available to callers
   * of the synchronous `GitPort` methods). Never throws. */
  private getApiSync(): API | undefined {
    try {
      const ext = vscode.extensions.getExtension<GitExtension>(GIT_EXTENSION_ID);
      if (!ext?.isActive || !ext.exports.enabled) return undefined;
      return ext.exports.getAPI(1);
    } catch {
      return undefined;
    }
  }

  private async resolveUserEmail(repo: Repository): Promise<string | undefined> {
    try {
      const email = await repo.getConfig('user.email');
      return email || undefined;
    } catch {
      return undefined;
    }
  }
}
