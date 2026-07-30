/**
 * W2 T3 (F-A code actions, §3.3) — `shouldOfferFix`, the PURE predicate
 * behind `TalariaCodeActionProvider.provideCodeActions`: the QuickFix "Fix
 * with Hermes" action is offered ONLY when the range has at least one
 * diagnostic (no always-on lightbulb, doc 03 §5.1).
 */
import { describe, it, expect, vi } from 'vitest';
import { must } from '../../testing/must';

// Minimal `vscode` mock — only the surface TalariaCodeActionProvider.ts
// touches (same posture as TalariaViewProvider.test.ts's mock).
vi.mock('vscode', () => {
  class CodeAction {
    title: string;
    kind: unknown;
    isPreferred?: boolean;
    command?: unknown;
    constructor(title: string, kind: unknown) {
      this.title = title;
      this.kind = kind;
    }
  }
  return {
    CodeActionKind: { QuickFix: 'quickfix' },
    CodeAction,
  };
});

const { shouldOfferFix, TalariaCodeActionProvider } = await import('./TalariaCodeActionProvider');

describe('shouldOfferFix — QuickFix gate (only when diagnostics are present)', () => {
  it('offers the fix when there is at least one diagnostic', () => {
    expect(shouldOfferFix(1)).toBe(true);
  });

  it('offers the fix when there are several diagnostics', () => {
    expect(shouldOfferFix(4)).toBe(true);
  });

  it('does NOT offer the fix with zero diagnostics (no always-on lightbulb)', () => {
    expect(shouldOfferFix(0)).toBe(false);
  });
});

describe('TalariaCodeActionProvider.provideCodeActions', () => {
  const provider = new TalariaCodeActionProvider();

  it('returns no actions when the range has zero diagnostics (no always-on lightbulb)', () => {
    const actions = provider.provideCodeActions({} as never, {} as never, { diagnostics: [] } as never);
    expect(actions).toEqual([]);
  });

  it('returns exactly one "Fix with Hermes" QuickFix action, not preferred, bound to talaria.fixCode', () => {
    const diagnostics = [{ message: 'boom' }];
    const actions = provider.provideCodeActions({} as never, {} as never, { diagnostics } as never);

    expect(actions).toHaveLength(1);
    const action = must(actions[0]);
    expect(action.title).toBe('Fix with Talaria');
    expect(action.kind).toBe('quickfix');
    expect(action.isPreferred).toBe(false);
    expect(action.command).toEqual({
      command: 'talaria.fixCode',
      title: 'Fix with Talaria',
      arguments: [diagnostics],
    });
  });

  it('forwards the EXACT context.diagnostics array reference as the command argument (no re-query)', () => {
    const diagnostics = [{ message: 'a' }, { message: 'b' }];
    const actions = provider.provideCodeActions({} as never, {} as never, { diagnostics } as never);

    const command = actions[0]?.command as { arguments: unknown[] } | undefined;
    expect(command?.arguments[0]).toBe(diagnostics);
  });
});
