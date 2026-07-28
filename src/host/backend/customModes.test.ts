import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * W4-T4b — `customModes.ts` is the vscode-boundary read for SF-2 (§4.1/§4.3).
 * `vscode` isn't resolvable outside the extension host, so it's mocked here,
 * independent of `AcpBackend.test.ts`'s own mock (each test file owns its
 * module graph). The mock exposes two mutable seams mirroring VS Code's real
 * `inspect()` shape: `__workspaceValue` (what `readCustomModes` MUST read)
 * and `__folderValue` (what it MUST ignore — B10).
 */
vi.mock('vscode', () => {
  const workspace: {
    __workspaceValue: unknown;
    __folderValue: unknown;
    getConfiguration: (section?: string) => {
      inspect: (key: string) => Record<string, unknown> | undefined;
    };
  } = {
    __workspaceValue: undefined,
    __folderValue: undefined,
    getConfiguration: () => ({
      inspect: (key: string) => {
        if (key !== 'hermes.customModes') return undefined;
        return {
          workspaceValue: workspace.__workspaceValue,
          workspaceFolderValue: workspace.__folderValue,
        };
      },
    }),
  };
  const window = { showWarningMessage: vi.fn() };
  return { workspace, window };
});

import * as vscode from 'vscode';
import { readCustomModes, toCatalog, buildModeFloorSnapshot } from './customModes';

const mockWorkspace = vscode.workspace as unknown as {
  __workspaceValue: unknown;
  __folderValue: unknown;
};
const mockShowWarning = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockWorkspace.__workspaceValue = undefined;
  mockWorkspace.__folderValue = undefined;
  mockShowWarning.mockClear();
});

describe('readCustomModes — B10: reads the WORKSPACE value, never the merged/folder value', () => {
  it('returns [] when hermes.customModes has no workspace value configured', () => {
    expect(readCustomModes()).toEqual([]);
  });

  it('returns the normalized workspace-value entries', () => {
    mockWorkspace.__workspaceValue = [{ id: 'docs', name: 'Docs only', allowOnly: ['docs/'] }];
    expect(readCustomModes()).toEqual([{ id: 'docs', name: 'Docs only', allowOnly: ['docs/'] }]);
  });

  it('IGNORES a folder-level value even when the workspace value is absent (a folder override must not widen)', () => {
    mockWorkspace.__folderValue = [{ id: 'wide-open', name: 'Wide open' }]; // no deny/allowOnly = unrestricted
    expect(readCustomModes()).toEqual([]);
  });

  it('IGNORES a folder-level value that DIFFERS from the workspace value (proves inspect(), not the merged get())', () => {
    mockWorkspace.__workspaceValue = [{ id: 'docs', name: 'Docs only', allowOnly: ['docs/'] }];
    mockWorkspace.__folderValue = [{ id: 'wide-open', name: 'Wide open' }];
    expect(readCustomModes()).toEqual([{ id: 'docs', name: 'Docs only', allowOnly: ['docs/'] }]);
  });

  it('drops an entry missing id or name', () => {
    mockWorkspace.__workspaceValue = [{ name: 'no id' }, { id: 'no-name' }, { id: 'ok', name: 'OK' }];
    expect(readCustomModes()).toEqual([{ id: 'ok', name: 'OK' }]);
  });

  it('coerces deny/allowOnly to string arrays, dropping non-string entries', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['src/', 42, null, 'a.env'] }];
    expect(readCustomModes()).toEqual([{ id: 'm', name: 'M', deny: ['src/', 'a.env'] }]);
  });

  it('omits deny/allowOnly entirely when the raw value is not an array', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: 'not-an-array' }];
    expect(readCustomModes()).toEqual([{ id: 'm', name: 'M' }]);
  });

  it('a non-array workspaceValue is treated as no configs (fail-closed on malformed settings)', () => {
    mockWorkspace.__workspaceValue = { not: 'an array' };
    expect(readCustomModes()).toEqual([]);
  });

  it('drops a non-object entry inside the array', () => {
    mockWorkspace.__workspaceValue = ['not-an-object', { id: 'ok', name: 'OK' }];
    expect(readCustomModes()).toEqual([{ id: 'ok', name: 'OK' }]);
  });
});

describe('readCustomModes — rule-ingest validation warns on a slashless deny rule (closes the T4a Minor)', () => {
  it('warns naming the mode + rule when a deny rule has no trailing "/", no leading "*", and no "."', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'My Mode', deny: ['src'] }];
    readCustomModes();
    expect(mockShowWarning).toHaveBeenCalledTimes(1);
    const [message] = mockShowWarning.mock.calls[0] as [string];
    expect(message).toContain('My Mode');
    expect(message).toContain("'src'");
  });

  it('keeps the rule AS-AUTHORED — never auto-rewrites it', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['src'] }];
    expect(readCustomModes()).toEqual([{ id: 'm', name: 'M', deny: ['src'] }]);
  });

  it('does NOT warn for a directory-prefix rule (trailing /)', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['src/'] }];
    readCustomModes();
    expect(mockShowWarning).not.toHaveBeenCalled();
  });

  it('does NOT warn for a basename-suffix rule (leading *)', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['*.env'] }];
    readCustomModes();
    expect(mockShowWarning).not.toHaveBeenCalled();
  });

  it('does NOT warn for an exact-filename rule that contains a dot', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['README.md'] }];
    readCustomModes();
    expect(mockShowWarning).not.toHaveBeenCalled();
  });

  it('does NOT warn for a slashless allowOnly rule (fail-CLOSED/over-restrictive direction — warn-optional)', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', allowOnly: ['src'] }];
    readCustomModes();
    expect(mockShowWarning).not.toHaveBeenCalled();
  });

  it('warns once per offending rule across multiple modes', () => {
    mockWorkspace.__workspaceValue = [
      { id: 'm1', name: 'One', deny: ['src', 'lib/'] },
      { id: 'm2', name: 'Two', deny: ['docs'] },
    ];
    readCustomModes();
    expect(mockShowWarning).toHaveBeenCalledTimes(2);
  });
});

describe('readCustomModes — rule hygiene (T4b Opus review Important: broaden the fail-open coverage)', () => {
  it('trims whitespace so a trailing space cannot silently turn a dir-prefix into a dead exact-match (fail-open)', () => {
    // '"config/ "' does NOT end in "/", so the engine treats it as an EXACT match
    // against the literal string "config/ " — it blocks NOTHING under config/.
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['config/ ', '  src/'] }];
    expect(readCustomModes()).toEqual([{ id: 'm', name: 'M', deny: ['config/', 'src/'] }]);
  });

  it('drops a whitespace-only rule (an empty rule matches nothing and is a mistake)', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['   ', 'secrets/'] }];
    expect(readCustomModes()).toEqual([{ id: 'm', name: 'M', deny: ['secrets/'] }]);
  });

  it('warns that an allowOnly rule of "*" disables the restriction — it matches every file (silent widen)', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'Docs', allowOnly: ['*'] }];
    readCustomModes();
    expect(mockShowWarning).toHaveBeenCalledTimes(1);
    const [message] = mockShowWarning.mock.calls[0] as [string];
    expect(message).toContain('Docs');
    expect(message).toContain('disables');
  });

  it('warns that a rule beginning with "/" matches nothing (paths are workspace-relative)', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', deny: ['/config/'] }];
    readCustomModes();
    expect(mockShowWarning).toHaveBeenCalledTimes(1);
    const [message] = mockShowWarning.mock.calls[0] as [string];
    expect(message).toContain("'/config/'");
  });

  it('does NOT warn for a well-formed allowOnly rule', () => {
    mockWorkspace.__workspaceValue = [{ id: 'm', name: 'M', allowOnly: ['docs/', '*.md'] }];
    readCustomModes();
    expect(mockShowWarning).not.toHaveBeenCalled();
  });
});

describe('toCatalog', () => {
  it('reduces configs to {id,name} only — never leaks deny/allowOnly to the wire', () => {
    expect(
      toCatalog([
        { id: 'a', name: 'A', deny: ['x/'] },
        { id: 'b', name: 'B', allowOnly: ['y/'] },
      ]),
    ).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
  });

  it('empty input yields an empty catalog', () => {
    expect(toCatalog([])).toEqual([]);
  });
});

describe('buildModeFloorSnapshot — §4.3 mitigation 3: implicit self-protection deny ALWAYS present', () => {
  it('appends the self-protection rules to a deny-only mode', () => {
    expect(buildModeFloorSnapshot({ id: 'm', name: 'M', deny: ['secrets/'] })).toEqual({
      deny: ['secrets/', '.vscode/settings.json', '*.code-workspace'],
    });
  });

  it('appends the self-protection rules to an allowOnly mode too — never conditional on deny-only', () => {
    expect(buildModeFloorSnapshot({ id: 'm', name: 'M', allowOnly: ['docs/'] })).toEqual({
      deny: ['.vscode/settings.json', '*.code-workspace'],
      allowOnly: ['docs/'],
    });
  });

  it('a mode with neither deny nor allowOnly still gets the self-protection deny', () => {
    expect(buildModeFloorSnapshot({ id: 'm', name: 'M' })).toEqual({
      deny: ['.vscode/settings.json', '*.code-workspace'],
    });
  });

  it('a mode with BOTH deny and allowOnly gets the self-protection rules appended to deny, allowOnly untouched', () => {
    expect(
      buildModeFloorSnapshot({ id: 'm', name: 'M', deny: ['secrets/'], allowOnly: ['src/'] }),
    ).toEqual({
      deny: ['secrets/', '.vscode/settings.json', '*.code-workspace'],
      allowOnly: ['src/'],
    });
  });
});
