import { describe, it, expect } from 'vitest';
import path from 'node:path';

import { buildCandidatePaths, buildRawCodeActionEdit, classifyAllEntries, toWorkspaceRelative } from './libToolDepsPure';
import type { RawCodeActionFile } from '../../mcp/lsp/lspToolContract';

// Built relative to a resolved root so the assertions are portable across the
// POSIX target (Fedora) and the Windows dev box — same idiom as
// `pathConfine.test.ts`.
const root = path.resolve('/workspace/project');
const otherRoot = path.resolve('/workspace/other');

describe('buildCandidatePaths — pure workspace-relative -> per-root candidate builder', () => {
  it('joins the relative path against a single root', () => {
    expect(buildCandidatePaths('src/index.ts', [root])).toEqual([path.join(root, 'src/index.ts')]);
  });

  it('produces one candidate per root, in root order', () => {
    expect(buildCandidatePaths('a.ts', [root, otherRoot])).toEqual([
      path.join(root, 'a.ts'),
      path.join(otherRoot, 'a.ts'),
    ]);
  });

  it('returns an empty array for no roots', () => {
    expect(buildCandidatePaths('a.ts', [])).toEqual([]);
  });

  it('normalizes a redundant-segment relative path via path.join (e.g. "./a.ts")', () => {
    expect(buildCandidatePaths('./a.ts', [root])).toEqual([path.join(root, 'a.ts')]);
  });

  it('does not itself resolve a ../ escape — path.join only joins, containment is decided by resolveWithinWorkspaceReal downstream', () => {
    expect(buildCandidatePaths('../secret.txt', [root])).toEqual([path.join(root, '../secret.txt')]);
  });
});

describe('toWorkspaceRelative — pure, forward-slash-normalized display path', () => {
  it('computes a forward-slash relative path for a nested file', () => {
    const canonical = path.join(root, 'src', 'index.ts');
    expect(toWorkspaceRelative(root, canonical)).toBe('src/index.ts');
  });

  it('returns an empty string for the root itself', () => {
    expect(toWorkspaceRelative(root, root)).toBe('');
  });

  it('never throws for an out-of-root pair (display-only — confinement is decided elsewhere)', () => {
    expect(() => toWorkspaceRelative(root, otherRoot)).not.toThrow();
  });

  it('normalizes nested multi-segment paths to forward slashes', () => {
    const canonical = path.join(root, 'src', 'nested', 'deep', 'file.ts');
    expect(toWorkspaceRelative(root, canonical)).toBe('src/nested/deep/file.ts');
  });
});

// ---------------------------------------------------------------------------
// W3 (LIB) · T8b — classifyAllEntries / buildRawCodeActionEdit
// (the `_allEntries` fail-closed classification core, pure/headless)
// ---------------------------------------------------------------------------

function textEntry(): { _type: number } {
  return { _type: 2 };
}
function fileOpEntry(): { _type: number } {
  return { _type: 1 };
}
function snippetEntry(): { _type: number } {
  return { _type: 6 };
}
function cellReplaceEntry(): { _type: number } {
  return { _type: 5 };
}

function plainFile(uri: string, editCount: number): RawCodeActionFile {
  return {
    uri,
    edits: Array.from({ length: editCount }, () => ({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: 'x',
    })),
  };
}

describe('classifyAllEntries — the FileEditType discriminant classifier', () => {
  it('an all-Text entry list ⇒ hasNonTextEntry:false', () => {
    expect(classifyAllEntries([textEntry(), textEntry()])).toEqual({ hasNonTextEntry: false });
  });

  it('an empty entry list ⇒ hasNonTextEntry:false (vacuously)', () => {
    expect(classifyAllEntries([])).toEqual({ hasNonTextEntry: false });
  });

  it('a File(1) entry ⇒ hasNonTextEntry:true, nonTextKind:file-operations', () => {
    expect(classifyAllEntries([textEntry(), fileOpEntry()])).toEqual({
      hasNonTextEntry: true,
      nonTextKind: 'file-operations',
    });
  });

  it('a Snippet(6) entry ⇒ hasNonTextEntry:true, nonTextKind:snippet', () => {
    expect(classifyAllEntries([textEntry(), snippetEntry()])).toEqual({
      hasNonTextEntry: true,
      nonTextKind: 'snippet',
    });
  });

  it('a CellReplace(5) notebook entry fails closed to file-operations (no notebook member exists)', () => {
    expect(classifyAllEntries([cellReplaceEntry()])).toEqual({
      hasNonTextEntry: true,
      nonTextKind: 'file-operations',
    });
  });

  it('an unrecognized/missing _type fails closed to file-operations (version-drift safety)', () => {
    expect(classifyAllEntries([{ _type: 999 }])).toEqual({
      hasNonTextEntry: true,
      nonTextKind: 'file-operations',
    });
    expect(classifyAllEntries([{}])).toEqual({ hasNonTextEntry: true, nonTextKind: 'file-operations' });
  });

  it('never throws on a malformed/non-object entry', () => {
    expect(() => classifyAllEntries([null, undefined, 42, 'x'])).not.toThrow();
  });
});

describe('buildRawCodeActionEdit — the fail-closed assembly (the gate-bypass-trap core)', () => {
  it('allEntries undefined (the feature-detect found no _allEntries method) ⇒ FAILS CLOSED: allEntriesAvailable:false', () => {
    const publicFiles = [plainFile('file:///a.ts', 1)];
    expect(buildRawCodeActionEdit(undefined, publicFiles)).toEqual({
      allEntriesAvailable: false,
      hasNonTextEntry: false,
      files: [],
    });
  });

  it('a text-only, count-consistent edit ⇒ allEntriesAvailable:true, files passed through verbatim', () => {
    const publicFiles = [plainFile('file:///a.ts', 2)];
    const allEntries = [textEntry(), textEntry()];
    expect(buildRawCodeActionEdit(allEntries, publicFiles)).toEqual({
      allEntriesAvailable: true,
      hasNonTextEntry: false,
      files: publicFiles,
    });
  });

  it('a non-text entry present ⇒ hasNonTextEntry:true, files:[] (never leaks the text half)', () => {
    const publicFiles = [plainFile('file:///a.ts', 1)];
    const allEntries = [textEntry(), fileOpEntry()];
    expect(buildRawCodeActionEdit(allEntries, publicFiles)).toEqual({
      allEntriesAvailable: true,
      hasNonTextEntry: true,
      nonTextKind: 'file-operations',
      files: [],
    });
  });

  it('a count mismatch between _allEntries() and the public entries() ⇒ FAILS CLOSED (version-drift guard)', () => {
    // allEntries claims 2 Text entries, but the public entries() only carries 1
    // edit — a signal this function cannot prove safe.
    const publicFiles = [plainFile('file:///a.ts', 1)];
    const allEntries = [textEntry(), textEntry()];
    expect(buildRawCodeActionEdit(allEntries, publicFiles)).toEqual({
      allEntriesAvailable: false,
      hasNonTextEntry: false,
      files: [],
    });
  });

  it('an empty edit (0 entries both sides) ⇒ allEntriesAvailable:true, hasNonTextEntry:false, files:[]', () => {
    expect(buildRawCodeActionEdit([], [])).toEqual({
      allEntriesAvailable: true,
      hasNonTextEntry: false,
      files: [],
    });
  });

  it('never throws for any combination of malformed input', () => {
    expect(() => buildRawCodeActionEdit([{}, null, 1], [])).not.toThrow();
  });
});
