/*
 * F-2 (final-4way-fixes.md): `VscodeGitPort.changedPaths()` was the one
 * sibling method that accessed `repo.state` (a getter on the git
 * extension's `Repository`) with no try/catch — every other method
 * (`stagedDiff`/`workingDiff`/`recentSubjects`/`commitTemplate`) wraps its
 * `repo` access and degrades to an honest empty result on throw, matching
 * `GitPort`'s documented "NEVER throws" contract (gitPort.ts's header
 * comment). If the git extension's `repo.state` getter throws (a real
 * failure mode — it lazily recomputes from disk), `changedPaths()` used to
 * reject instead of resolving to `[]`, degrading the whole `@git` context
 * ref to an error skip instead of an empty list.
 *
 * Drives the REAL `VscodeGitPort` (via `createGitPort`) against a minimal
 * mocked `vscode` module — this file's sibling tests (`gitMappers.test.ts`,
 * `context/resolver.test.ts`) only ever exercise the pure `GitPort`
 * interface via hand-rolled fakes, never `gitPort.ts`'s own
 * `vscode.extensions.getExtension` resolution path, so this is the first
 * test to actually cover that class.
 */
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { createGitPort } from './gitPort';
import type { API, GitExtension, Repository } from './git';

vi.mock('vscode', () => ({
  extensions: { getExtension: vi.fn() },
}));

/** Wire the mocked `vscode.extensions.getExtension` to resolve an already-
 * active, enabled git extension whose `getAPI(1)` returns `api` — mirrors
 * `gitPort.ts`'s `getApi()` happy path (`ext.isActive ? ext.exports : …`). */
function mockGitExtension(api: API): void {
  const fakeExtension = {
    isActive: true,
    exports: { enabled: true, getAPI: () => api } as unknown as GitExtension,
  };
  vi.mocked(vscode.extensions.getExtension).mockReturnValue(
    fakeExtension as unknown as vscode.Extension<GitExtension>,
  );
}

describe('VscodeGitPort.changedPaths — F-2: degrades to [] instead of rejecting', () => {
  it('resolves to [] when repo.state throws (matches every sibling method\'s try/catch-to-empty contract)', async () => {
    const repo = {
      get state(): never {
        throw new Error('repo.state recompute failed');
      },
    } as unknown as Repository;
    mockGitExtension({ repositories: [repo] } as unknown as API);

    const port = createGitPort();

    await expect(port.changedPaths()).resolves.toEqual([]);
  });

  it('non-regression: still maps working-tree + index changes to rows on the happy path', async () => {
    const repo = {
      state: {
        workingTreeChanges: [{ uri: { fsPath: '/repo/a.ts' } }],
        indexChanges: [{ uri: { fsPath: '/repo/b.ts' } }],
      },
    } as unknown as Repository;
    mockGitExtension({ repositories: [repo] } as unknown as API);

    const port = createGitPort();

    await expect(port.changedPaths()).resolves.toEqual([
      { path: '/repo/a.ts', staged: false },
      { path: '/repo/b.ts', staged: true },
    ]);
  });

  it('no repository open: resolves to [] (existing guard, unaffected by this fix)', async () => {
    mockGitExtension({ repositories: [] } as unknown as API);

    const port = createGitPort();

    await expect(port.changedPaths()).resolves.toEqual([]);
  });
});
