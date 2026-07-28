import { describe, it, expect } from 'vitest';
import { LSP_READ_COMMANDS, assertAllowlistedCommand } from './lspCommandAllowlist';

/**
 * W3 (LIB) · T4 tests — the pure allowlist + fail-closed guard. This is one
 * of the two RED anchors for this task (research doc §5.3, T4 brief): the
 * gateway's ENTIRE security guarantee rests on this set being exactly the 6
 * `execute*Provider` IDs (T8b added `executeCodeActionProvider`) and on the
 * guard throwing for anything else, unconditionally.
 */

const ALLOWED_IDS = [
  'vscode.executeDefinitionProvider',
  'vscode.executeReferenceProvider',
  'vscode.executeDocumentSymbolProvider',
  'vscode.executeWorkspaceSymbolProvider',
  'vscode.executeHoverProvider',
  'vscode.executeCodeActionProvider',
] as const;

describe('LSP_READ_COMMANDS', () => {
  it('contains exactly the 6 allowlisted execute*Provider IDs', () => {
    expect(LSP_READ_COMMANDS.size).toBe(6);
    for (const id of ALLOWED_IDS) {
      expect(LSP_READ_COMMANDS.has(id)).toBe(true);
    }
  });

  it('does NOT include getDiagnostics (a direct API call, not an executeCommand ID)', () => {
    expect(LSP_READ_COMMANDS.has('vscode.languages.getDiagnostics')).toBe(false);
  });

  it('does NOT include resolveCodeAction (a separate resolve-then-run-capable API — T8 never uses it; resolution is itemResolveCount on executeCodeActionProvider itself)', () => {
    expect(LSP_READ_COMMANDS.has('vscode.resolveCodeAction')).toBe(false);
  });
});

describe('assertAllowlistedCommand — accept path', () => {
  for (const id of ALLOWED_IDS) {
    it(`does not throw for ${id}`, () => {
      expect(() => assertAllowlistedCommand(id)).not.toThrow();
    });
  }
});

describe('assertAllowlistedCommand — fail-closed reject path', () => {
  const rejected = [
    'vscode.executeWorkspaceEdit',
    'vscode.resolveCodeAction', // permanently banned — T8 never resolves via this path
    'workbench.action.files.save',
    '',
    'some.arbitrary.command',
  ];

  for (const id of rejected) {
    it(`throws for ${JSON.stringify(id)}`, () => {
      expect(() => assertAllowlistedCommand(id)).toThrow();
    });
  }

  it('throws an Error whose message names the offending id', () => {
    expect(() => assertAllowlistedCommand('workbench.action.files.save')).toThrow(
      /workbench\.action\.files\.save/,
    );
  });
});
