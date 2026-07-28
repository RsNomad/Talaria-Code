import { describe, it, expect } from 'vitest';

import { ContextResolver } from './resolver';
import type { ResolverPorts, ConfineFn } from './resolver';
import type { DiagnosticsPort, EditorPort, GitPort, TerminalPort, WorkspacePort } from './types';
import type { ContextRef } from '../../shared/protocol';

/** A headless in-memory fake for every port — the vscode-journal `InMemoryFileSystem` pattern (§2a). */
function makePorts(overrides: Partial<ResolverPorts> = {}): ResolverPorts {
  const diagnostics: DiagnosticsPort = { all: () => [] };
  const editor: EditorPort = { activeSelection: () => undefined };
  const workspace: WorkspacePort = { roots: () => ['/workspace'], findFiles: async () => [] };
  const terminal: TerminalPort = { capturedTail: () => undefined };
  const git: GitPort = {
    stagedDiff: async () => '',
    workingDiff: async () => '',
    changedPaths: async () => [],
    recentSubjects: async () => [],
    readInputBox: () => '',
    writeInputBox: () => undefined,
    commitTemplate: async () => undefined,
  };
  return { diagnostics, editor, workspace, terminal, git, ...overrides };
}

/** A pass-through fake confine: allows anything rooted at `/workspace`, denies everything else. */
const allowWorkspaceConfine: ConfineFn = async (path) => (path.startsWith('/workspace') ? path : null);

const denyConfine: ConfineFn = async () => null;

function ref(kind: ContextRef['kind'], overrides: Partial<ContextRef> = {}): ContextRef {
  return { id: overrides.id ?? `${kind}-1`, kind, ...overrides };
}

describe('ContextResolver.resolveAll — structural invariants', () => {
  it('resolves an empty ref list to an empty array', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: denyConfine });
    await expect(resolver.resolveAll([])).resolves.toEqual([]);
  });

  it('preserves input order in the output regardless of per-ref resolution timing', async () => {
    const slowGit: GitPort = {
      ...makePorts().git,
      workingDiff: () => new Promise((resolve) => setTimeout(() => resolve(''), 20)),
    };
    const resolver = new ContextResolver(makePorts({ git: slowGit }), { confine: denyConfine });
    const refs: ContextRef[] = [ref('git', { id: 'a' }), ref('problems', { id: 'b' }), ref('terminal', { id: 'c' })];

    const results = await resolver.resolveAll(refs);

    expect(results.map((r) => r.ref.id)).toEqual(['a', 'b', 'c']);
  });

  it('never throws — an unrecognized ref kind resolves to an error skip instead of rejecting the batch', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: denyConfine });
    const weirdRef = { id: 'weird', kind: 'unknown-kind' } as unknown as ContextRef;

    const results = await resolver.resolveAll([weirdRef]);

    expect(results[0]?.skipped?.reason).toBe('error');
  });

  it('turns a synchronously-throwing port into a {reason:"error"} skip without aborting the batch', async () => {
    const ports = makePorts({
      diagnostics: {
        all: () => {
          throw new Error('boom');
        },
      },
    });
    const resolver = new ContextResolver(ports, { confine: denyConfine });
    const refs: ContextRef[] = [ref('problems', { id: 'x' }), ref('terminal', { id: 'y' })];

    const results = await resolver.resolveAll(refs);

    expect(results[0]?.skipped).toEqual({ reason: 'error', detail: 'boom' });
    expect(results[1]?.skipped).toBeUndefined(); // batch survives — the terminal ref still resolves normally
  });

  it('turns a rejecting async port into a {reason:"error"} skip', async () => {
    const rejectingGit: GitPort = {
      ...makePorts().git,
      workingDiff: async () => {
        throw new Error('git failed');
      },
    };
    const resolver = new ContextResolver(makePorts({ git: rejectingGit }), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('git')]);

    expect(result?.skipped).toEqual({ reason: 'error', detail: 'git failed' });
  });

  it('yields a {reason:"error", detail:"timed out"} skip when a port hangs past deadlineMs', async () => {
    const hangingGit: GitPort = {
      ...makePorts().git,
      workingDiff: () => new Promise(() => {}), // never resolves — simulates a stalled port
    };
    const resolver = new ContextResolver(makePorts({ git: hangingGit }), { confine: denyConfine, deadlineMs: 20 });

    const [result] = await resolver.resolveAll([ref('git')]);

    expect(result?.skipped).toEqual({ reason: 'error', detail: 'timed out' });
  });

  it('constructing without an explicit confine does not throw (defaults to resolveWithinWorkspaceReal, unexercised here)', () => {
    expect(() => new ContextResolver(makePorts())).not.toThrow();
  });
});

describe('ContextResolver.resolveAll — file/folder', () => {
  it('resolves a confined, non-secret file ref to a link-only ResolvedContext (no text — agent reads it)', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: allowWorkspaceConfine });
    const fileRef = ref('file', { path: '/workspace/src/foo.ts' });

    const [result] = await resolver.resolveAll([fileRef]);

    expect(result).toEqual({
      ref: fileRef,
      uri: 'file:///workspace/src/foo.ts',
      title: 'foo.ts',
      linkOnly: true,
    });
  });

  it('resolves a confined, non-secret folder ref the same way as a file ref', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: allowWorkspaceConfine });
    const folderRef = ref('folder', { path: '/workspace/src' });

    const [result] = await resolver.resolveAll([folderRef]);

    expect(result).toEqual({
      ref: folderRef,
      uri: 'file:///workspace/src',
      title: 'src',
      linkOnly: true,
    });
  });

  it('skips as {reason:"error"} when confine denies the path (outside workspace)', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: denyConfine });
    const fileRef = ref('file', { path: '/etc/passwd' });

    const [result] = await resolver.resolveAll([fileRef]);

    expect(result?.skipped).toEqual({ reason: 'error', detail: 'outside workspace' });
  });

  it('skips as {reason:"secret"} when the CONFINED canonical path is secret-classified', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: allowWorkspaceConfine });
    const fileRef = ref('file', { path: '/workspace/.env' });

    const [result] = await resolver.resolveAll([fileRef]);

    expect(result?.skipped).toEqual({ reason: 'secret', detail: 'secret-classified path' });
  });

  it('ORDERING: confinement runs BEFORE the secret gate — a secret-looking path OUTSIDE the workspace skips as error, not secret', async () => {
    // '.env' would be secret-classified if it were ever checked, but confine denies it
    // first (simulating an out-of-workspace target) — the secret gate must never run.
    const resolver = new ContextResolver(makePorts(), { confine: denyConfine });
    const fileRef = ref('file', { path: '/outside/.env' });

    const [result] = await resolver.resolveAll([fileRef]);

    expect(result?.skipped?.reason).toBe('error');
    expect(result?.skipped?.reason).not.toBe('secret');
  });
});

describe('ContextResolver.resolveAll — problems', () => {
  it('formats diagnostics rows via formatDiagnostics + clampText', async () => {
    const rows = [{ path: 'a.ts', severity: 'error' as const, line: 1, message: 'boom' }];
    const resolver = new ContextResolver(makePorts({ diagnostics: { all: () => rows } }), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('problems')]);

    expect(result).toEqual({
      ref: ref('problems'),
      uri: 'diagnostics://workspace',
      title: 'Problems',
      text: 'a.ts:1 error boom',
      truncated: false,
    });
  });

  it('returns the honest "(no problems reported)" text for empty diagnostics — NOT a skip', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('problems')]);

    expect(result?.skipped).toBeUndefined();
    expect(result?.text).toBe('(no problems reported)');
  });
});

describe('ContextResolver.resolveAll — selection', () => {
  it('formats the active selection via formatSelection + clampText', async () => {
    const selection = { path: 'src/foo.ts', text: 'const x = 1;', range: { startLine: 10, endLine: 10 } };
    const resolver = new ContextResolver(makePorts({ editor: { activeSelection: () => selection } }), {
      confine: denyConfine,
    });

    const [result] = await resolver.resolveAll([ref('selection')]);

    expect(result).toEqual({
      ref: ref('selection'),
      uri: 'selection://active',
      title: 'Selection',
      text: '```src/foo.ts:10-10\nconst x = 1;\n```',
      truncated: false,
    });
  });

  it('skips as {reason:"unavailable"} when there is no active selection', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('selection')]);

    expect(result?.skipped).toEqual({ reason: 'unavailable', detail: 'no active selection' });
  });
});

describe('ContextResolver.resolveAll — terminal', () => {
  it('formats a captured tail via formatTerminal + clampText', async () => {
    const tail = { name: 'bash', text: '$ npm test\nok' };
    const resolver = new ContextResolver(makePorts({ terminal: { capturedTail: () => tail } }), {
      confine: denyConfine,
    });

    const [result] = await resolver.resolveAll([ref('terminal')]);

    expect(result).toEqual({
      ref: ref('terminal'),
      uri: 'terminal://capture',
      title: 'Terminal',
      text: 'Terminal: bash\n$ npm test\nok',
      truncated: false,
    });
  });

  it('falls back to the honest-empty note (NOT a skip) when no terminal capture exists yet', async () => {
    const resolver = new ContextResolver(makePorts(), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('terminal')]);

    expect(result?.skipped).toBeUndefined();
    expect(result?.text).toBe(
      '(no terminal output captured — shell integration inactive or nothing run since activation)',
    );
  });
});

describe('ContextResolver.resolveAll — git', () => {
  it('formats the working diff + short status via formatGit + clampText', async () => {
    const git: GitPort = {
      ...makePorts().git,
      workingDiff: async () => '--- a/x\n+++ b/x',
      changedPaths: async () => [{ path: 'x.ts', staged: true }],
    };
    const resolver = new ContextResolver(makePorts({ git }), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('git')]);

    expect(result?.uri).toBe('git://working-tree');
    expect(result?.title).toBe('Git');
    expect(result?.text).toBe('staged  x.ts\n\n--- a/x\n+++ b/x');
    expect(result?.truncated).toBe(false);
  });

  it('drops secret-classified paths from the @git status list and withholds the diff body', async () => {
    const git: GitPort = {
      ...makePorts().git,
      workingDiff: async () => '',
      changedPaths: async () => [
        { path: 'src/ok.ts', staged: false },
        { path: '.env', staged: false },
      ],
    };
    const resolver = new ContextResolver(makePorts({ git }), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('git')]);

    expect(result?.text).toContain('unstaged  src/ok.ts');
    expect(result?.text).not.toContain('.env');
    expect(result?.text).toContain('Working-tree diff withheld: 1 secret-classified file present in the changes');
  });

  it('fail-closed: withholds the ENTIRE diff body (not just the secret path status entry) when any changed path is secret-classified', async () => {
    const git: GitPort = {
      ...makePorts().git,
      workingDiff: async () => '--- a/.env\n+++ b/.env\n+API_KEY=sk-secret\n--- a/src/a.ts\n+++ b/src/a.ts\n+console.log(1);',
      changedPaths: async () => [
        { path: '.env', staged: false },
        { path: 'src/a.ts', staged: true },
      ],
    };
    const resolver = new ContextResolver(makePorts({ git }), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('git')]);

    // The secret line must never reach the LLM, no matter where in the shared diff blob it lands.
    expect(result?.text).not.toContain('API_KEY=sk-secret');
    expect(result?.text).not.toContain('.env');
    // The note must be honest — it withholds the diff, not "excludes" secrets from one still shown.
    expect(result?.text).toContain('Working-tree diff withheld: 1 secret-classified file present in the changes');
    expect(result?.text).not.toMatch(/excluded/i);
    // Only the non-secret changed file is listed.
    expect(result?.text).toContain('staged  src/a.ts');
  });

  it('no-secret path: the diff body is included unchanged (non-regression)', async () => {
    const git: GitPort = {
      ...makePorts().git,
      workingDiff: async () => '--- a/x\n+++ b/x\n+console.log(1);',
      changedPaths: async () => [{ path: 'src/a.ts', staged: true }],
    };
    const resolver = new ContextResolver(makePorts({ git }), { confine: denyConfine });

    const [result] = await resolver.resolveAll([ref('git')]);

    expect(result?.text).toBe('staged  src/a.ts\n\n--- a/x\n+++ b/x\n+console.log(1);');
    expect(result?.text).not.toContain('withheld');
  });
});
