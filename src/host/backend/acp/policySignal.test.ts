import { describe, it, expect } from 'vitest';
import {
  extractEditPathStrings,
  extractV4aPatchPaths,
  buildCommandSignal,
  buildEditSignalFromResolved,
} from './policySignal';
import type { ResolvedEditPath } from './policySignal';
import type { AcpToolCallFields } from './types';

/**
 * W2-F1 (Zone B) + Bucket 1 F1/F2: the policy-signal helpers are pure (no
 * fs/vscode), so they are driven with plain literals. Path RESOLUTION
 * (realpath/`~`) is the fs layer's job (`pathConfine.canonicalizeEditPath`,
 * orchestrated by `AcpBackend.handleRequestPermission`); these helpers only
 * extract raw strings and package already-resolved values.
 */

describe('extractEditPathStrings', () => {
  it('extracts a write_file path from rawInput.arguments.path', () => {
    const toolCall: AcpToolCallFields = {
      toolCallId: 'e1',
      title: 'Approve edit: src/a.ts',
      kind: 'edit',
      rawInput: { tool: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } },
    };
    expect(extractEditPathStrings(toolCall)).toEqual(['src/a.ts']);
  });

  it('splits a V4A comma-joined multi-file path from the diff content', () => {
    const toolCall: AcpToolCallFields = {
      toolCallId: 'e3',
      title: 't',
      kind: 'edit',
      // V4A patch: no arguments.path — the proposal path is the comma-joined diff path.
      content: [{ type: 'diff', path: 'a.ts, sub/b.ts', oldText: null, newText: 'patch body' }],
      rawInput: { tool: 'patch', arguments: { patch: '*** Update File: a.ts' } },
    };
    expect(extractEditPathStrings(toolCall)).toEqual(['a.ts', 'sub/b.ts']);
  });

  it('yields no paths for an edit with no rawInput and no diff content (fail-closed upstream)', () => {
    const toolCall: AcpToolCallFields = { toolCallId: 'e4', title: 't', kind: 'edit' };
    expect(extractEditPathStrings(toolCall)).toEqual([]);
  });

  // Bucket 1 F2 (CWE-807): `arguments.path` must NOT short-circuit the diff
  // paths — the gated effect set is the UNION of all effect fields, so a decoy
  // `arguments.path` cannot hide a diff that touches `.git/hooks`.
  it('unions arguments.path with EVERY diff path (decoy path cannot hide a .git/hooks diff)', () => {
    const toolCall: AcpToolCallFields = {
      toolCallId: 'e5',
      title: 't',
      kind: 'edit',
      content: [
        { type: 'diff', path: 'src/app.ts', oldText: 'a', newText: 'b' },
        { type: 'diff', path: '.git/hooks/pre-commit', oldText: null, newText: 'evil' },
      ],
      rawInput: { tool: 'write_file', arguments: { path: 'src/app.ts', content: 'b' } },
    };
    expect(extractEditPathStrings(toolCall)).toEqual(['src/app.ts', '.git/hooks/pre-commit']);
  });

  it('deduplicates the union while keeping first-seen order', () => {
    const toolCall: AcpToolCallFields = {
      toolCallId: 'e6',
      title: 't',
      kind: 'edit',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }],
      rawInput: { tool: 'write_file', arguments: { path: 'src/a.ts', content: 'b' } },
    };
    expect(extractEditPathStrings(toolCall)).toEqual(['src/a.ts']);
  });
});

describe('buildEditSignalFromResolved (pure packaging of already-canonical paths)', () => {
  const outsideSsh: ResolvedEditPath = {
    canonicalPath: '/home/user/.ssh/authorized_keys',
    relPath: null,
    insideWorkspace: false,
  };
  const insideSrc: ResolvedEditPath = {
    canonicalPath: '/ws/src/a.ts',
    relPath: 'src/a.ts',
    insideWorkspace: true,
  };

  it('packages an escaped canonical path absolute with insideWorkspace false', () => {
    expect(buildEditSignalFromResolved([outsideSsh], true)).toEqual({
      kind: 'edit',
      paths: ['/home/user/.ssh/authorized_keys'],
      insideWorkspace: false,
      turnProtected: true,
    });
  });

  it('packages a contained path workspace-relative with insideWorkspace true', () => {
    expect(buildEditSignalFromResolved([insideSrc], true)).toEqual({
      kind: 'edit',
      paths: ['src/a.ts'],
      insideWorkspace: true,
      turnProtected: true,
    });
  });

  it('insideWorkspace is true only when EVERY resolved path is contained', () => {
    const signal = buildEditSignalFromResolved([insideSrc, outsideSsh], true);
    expect(signal.insideWorkspace).toBe(false);
    expect(signal.paths).toEqual(['src/a.ts', '/home/user/.ssh/authorized_keys']);
  });

  it('no paths => insideWorkspace false (engine fails closed on the empty signal)', () => {
    expect(buildEditSignalFromResolved([], true)).toEqual({
      kind: 'edit',
      paths: [],
      insideWorkspace: false,
      turnProtected: true,
    });
  });

  it('normalizes native (backslash) canonical paths to POSIX for the classifier', () => {
    const win: ResolvedEditPath = {
      canonicalPath: 'D:\\ws\\.env',
      relPath: null,
      insideWorkspace: false,
    };
    expect(buildEditSignalFromResolved([win], true).paths).toEqual(['D:/ws/.env']);
  });

  it('threads turnProtected through unchanged', () => {
    expect(buildEditSignalFromResolved([insideSrc], false).turnProtected).toBe(false);
  });
});

/**
 * W4-T4b — SF-2's enforcement wire: `buildEditSignalFromResolved` gains an
 * optional third `modeFloor` param that `SessionController` feeds from its
 * `activeCustomMode` snapshot. Pure packaging only — no matching logic here
 * (that's `violatesModeFloor`/editPolicy.ts's job).
 */
describe('buildEditSignalFromResolved — SF-2 modeFloor threading', () => {
  const insideSrc: ResolvedEditPath = {
    canonicalPath: '/ws/src/a.ts',
    relPath: 'src/a.ts',
    insideWorkspace: true,
  };

  it('sets modeFloor on the signal when provided', () => {
    const modeFloor = { deny: ['secrets/'] };
    expect(buildEditSignalFromResolved([insideSrc], true, modeFloor)).toEqual({
      kind: 'edit',
      paths: ['src/a.ts'],
      insideWorkspace: true,
      turnProtected: true,
      modeFloor,
    });
  });

  it('omits modeFloor entirely (no key present) when not provided — existing callers are unaffected', () => {
    const signal = buildEditSignalFromResolved([insideSrc], true);
    expect('modeFloor' in signal).toBe(false);
  });

  it('threads modeFloor through the EMPTY-signal path too — the F1 allowOnly carve-out depends on this reaching the engine', () => {
    const modeFloor = { deny: [], allowOnly: ['src/'] };
    expect(buildEditSignalFromResolved([], true, modeFloor)).toEqual({
      kind: 'edit',
      paths: [],
      insideWorkspace: false,
      turnProtected: true,
      modeFloor,
    });
  });

  it('an allowOnly modeFloor threads through unchanged (reference-equal, no cloning)', () => {
    const modeFloor = { deny: ['x'], allowOnly: ['src/'] };
    expect(buildEditSignalFromResolved([insideSrc], true, modeFloor).modeFloor).toBe(modeFloor);
  });
});

describe('buildCommandSignal', () => {
  it('reads the command from rawInput.command', () => {
    const toolCall: AcpToolCallFields = {
      toolCallId: 'c1',
      title: 'Run: rm -rf /',
      kind: 'execute',
      content: [{ content: { type: 'text', text: '$ rm -rf /' } }],
      rawInput: { command: 'rm -rf /', description: 'danger' },
    };
    expect(buildCommandSignal(toolCall)).toEqual({ kind: 'command', command: 'rm -rf /' });
  });

  it('falls back to the detail text with a leading "$ " stripped when rawInput has no command', () => {
    const toolCall: AcpToolCallFields = {
      toolCallId: 'c2',
      title: 't',
      kind: 'execute',
      content: [{ content: { type: 'text', text: '$ npm test' } }],
    };
    expect(buildCommandSignal(toolCall)).toEqual({ kind: 'command', command: 'npm test' });
  });

  it('yields an empty command when there is neither rawInput.command nor detail (=> fail-closed)', () => {
    const toolCall: AcpToolCallFields = { toolCallId: 'c3', title: 't', kind: 'execute' };
    expect(buildCommandSignal(toolCall)).toEqual({ kind: 'command', command: '' });
  });
});

describe('extractV4aPatchPaths — audit C-2: mirror the LENIENT grammar Hermes actually applies with', () => {
  it('accepts a header with NO space after the asterisks (the exact hidden-write vector)', () => {
    // patch_parser.py:110 uses `\*\*\*\s*Update\s+File:` — zero spaces is
    // legal there and the file IS written. edit_approval.py:133 uses `\s+`,
    // so this header never reached the approval list.
    expect(extractV4aPatchPaths('***Update File: src/hidden.ts\n@@\n-a\n+b\n')).toEqual([
      'src/hidden.ts',
    ]);
  });

  it('accepts the normal spaced form too', () => {
    expect(extractV4aPatchPaths('*** Update File: src/a.ts\n')).toEqual(['src/a.ts']);
  });

  it('finds EVERY header in a multi-file patch, not just the first', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/shown.ts',
      '@@',
      '-x',
      '+y',
      '***Add File: .git/hooks/pre-commit',
      '+#!/bin/sh',
      '*** End Patch',
    ].join('\n');
    expect(extractV4aPatchPaths(patch)).toEqual(['src/shown.ts', '.git/hooks/pre-commit']);
  });

  it('extracts BOTH endpoints of a Move header (edit_approval.py never did; file_tools.py:1769 does)', () => {
    expect(extractV4aPatchPaths('*** Move File: src/a.ts -> ../outside/b.ts\n')).toEqual([
      'src/a.ts',
      '../outside/b.ts',
    ]);
  });

  it('covers Add and Delete as well as Update', () => {
    const patch = ['*** Add File: n.ts', '*** Delete File: o.ts'].join('\n');
    expect(extractV4aPatchPaths(patch)).toEqual(['n.ts', 'o.ts']);
  });

  it('returns [] for a body with no headers, and never throws on garbage', () => {
    expect(extractV4aPatchPaths('')).toEqual([]);
    expect(extractV4aPatchPaths('no headers here at all')).toEqual([]);
    expect(extractV4aPatchPaths('*** Update File:\n')).toEqual([]);
  });

  // C-1 (CRITICAL, review of this same commit): JS `\s` includes `\n`, so an
  // EMPTY-path header's `\s*` after `File:` used to span the newline and
  // `(.+)$` captured the *next* line whole — the real second header was never
  // matched on its own and came out as one bogus string. `classifyPath` on
  // that bogus string never equals a `.git` segment, so the real write is
  // silently auto-allowed under `normal`. This is the reviewer's exact patch.
  it('does NOT let an empty-path header swallow the following header line (C-1)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File:',
      '***Update File: .git/hooks/pre-commit',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    expect(extractV4aPatchPaths(patch)).toEqual(['.git/hooks/pre-commit']);
  });

  it('does NOT swallow the following line for Add File: or Delete File: either (C-1)', () => {
    expect(extractV4aPatchPaths('*** Add File:\n***Add File: .git/hooks/pre-commit\n')).toEqual([
      '.git/hooks/pre-commit',
    ]);
    expect(
      extractV4aPatchPaths('*** Delete File:\n***Delete File: .git/hooks/pre-commit\n'),
    ).toEqual(['.git/hooks/pre-commit']);
  });

  it('does NOT swallow the following line when the empty header has trailing spaces (C-1)', () => {
    const patch = '*** Update File:   \n***Update File: .git/hooks/pre-commit\n';
    expect(extractV4aPatchPaths(patch)).toEqual(['.git/hooks/pre-commit']);
  });

  it('a run of empty-path headers yields ZERO paths, not one per line (C-1 ReDoS/path-explosion lane)', () => {
    // Reviewer's repro: '*** Update File:\n'.repeat(50000) used to return
    // 25,000 bogus paths (each line captured as the "path" of the line above
    // it). With horizontal-only whitespace this must stay empty throughout.
    const patch = '*** Update File:\n'.repeat(1000);
    expect(extractV4aPatchPaths(patch)).toEqual([]);
  });

  // I-1 (IMPORTANT): Python's `\s` (str patterns) is a strict superset of
  // JS's `\s` — it also matches the C0 "information separator" controls
  // \x1c-\x1f and NEL (\x85). `patch_parser.py`'s `\*\*\*\s*Update\s+File:`
  // therefore accepts `***\x1cUpdate File: X` and WRITES to `X`; our old
  // class did not, so it was invisible to this function.
  it('accepts the Python-only whitespace chars \\x1c-\\x1f and \\x85 that patch_parser.py writes with (I-1)', () => {
    expect(extractV4aPatchPaths('***\x1cUpdate File: src/hidden.ts\n')).toEqual(['src/hidden.ts']);
    expect(extractV4aPatchPaths('***\x1dUpdate File: src/hidden.ts\n')).toEqual(['src/hidden.ts']);
    expect(extractV4aPatchPaths('***\x1eUpdate File: src/hidden.ts\n')).toEqual(['src/hidden.ts']);
    expect(extractV4aPatchPaths('***\x1fUpdate File: src/hidden.ts\n')).toEqual(['src/hidden.ts']);
    expect(extractV4aPatchPaths('***\x85Update File: src/hidden.ts\n')).toEqual(['src/hidden.ts']);
    expect(extractV4aPatchPaths('*** Update\x1cFile: src/hidden.ts\n')).toEqual(['src/hidden.ts']);
  });

  // I-2 (IMPORTANT): the capture group's load-bearing property — "capture to
  // end of line, not to the next \s" — is unpinned by any existing test. No
  // test uses a path containing a space, so mutating `(.+)` -> `([^\s]+)`
  // survives the whole suite while missing a real path Hermes writes.
  it('extracts a path containing a space in full (I-2 mutation pin: (.+) not ([^\\s]+))', () => {
    expect(extractV4aPatchPaths('*** Update File: my docs/notes.txt\n')).toEqual([
      'my docs/notes.txt',
    ]);
  });
});

describe('extractEditPathStrings — audit C-2: the patch body joins the union', () => {
  it('surfaces a no-space header that arguments.path and the diff content both hide', () => {
    const toolCall = {
      rawInput: {
        arguments: {
          path: 'src/shown.ts',
          patch: '*** Update File: src/shown.ts\n***Update File: src/hidden.ts\n',
        },
      },
      content: [],
    } as unknown as AcpToolCallFields;

    // M-2: exact, not subset — this wave's standing constraint (Task 3's pins
    // passed `toContain` while a field was silently renamed and two added).
    const paths = extractEditPathStrings(toolCall);
    // Before this fix the human approved a card that said "Edit: src/shown.ts"
    // and Hermes wrote BOTH files.
    expect(paths).toEqual(['src/shown.ts', 'src/hidden.ts']);
  });

  it('still de-duplicates first-seen (arguments.path never short-circuits the other sources)', () => {
    const toolCall = {
      rawInput: { arguments: { path: 'a.ts', patch: '*** Update File: a.ts\n*** Add File: b.ts\n' } },
      content: [],
    } as unknown as AcpToolCallFields;
    expect(extractEditPathStrings(toolCall)).toEqual(['a.ts', 'b.ts']);
  });

  it('is inert for a non-V4A tool call (no patch argument)', () => {
    const toolCall = {
      rawInput: { arguments: { path: 'a.ts' } },
      content: [],
    } as unknown as AcpToolCallFields;
    expect(extractEditPathStrings(toolCall)).toEqual(['a.ts']);
  });
});
