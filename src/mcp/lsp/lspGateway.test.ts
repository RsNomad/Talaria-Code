import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LspGateway } from './lspGateway';
import type * as vscode from 'vscode';

/**
 * Audit B-1. `lspGateway.ts`'s `assertAllowlistedCommand(commandId)` call
 * inside the private `run()` helper (currently line 104) is the ONLY runtime
 * control that keeps LIB read-only. At audit time, replacing that call with
 * `void assertAllowlistedCommand;` left the whole suite at the audit-era
 * baseline — 179 files / 3312 passed / 7 skipped, unmoved.
 * `lspInvariant.test.ts` scans SOURCE TEXT for forbidden verbs; nothing there
 * observes the CALL itself.
 *
 * Task 8 fix wave (independent review, `task-8-review.md`) rewrote this
 * file's names and comments to say only what is actually proven — see that
 * review's Important-2 for the three false claims the original version
 * shipped (a "forged command id" that was never constructed; "every real
 * verb" driven by a test that drove three of six). What THIS file proves now:
 *
 *  - Test 1 (below) documents — does NOT newly prove — that every id the
 *    real gateway executes is a member of `LSP_READ_COMMANDS`. This is true
 *    BY CONSTRUCTION: every verb's command-ID is a hardcoded literal already
 *    in the allowlist, so there is no path through the public `LspGateway`
 *    interface that makes an illegal id reach `run()` today. This test
 *    passes identically whether or not the guard call is even present
 *    (verified: planting `void assertAllowlistedCommand;` at
 *    `lspGateway.ts:104` leaves this test GREEN) — it is outcome-checking,
 *    not call-observing.
 *  - Test 2 (below) is what actually observes the CALL: it wraps the real
 *    `assertAllowlistedCommand` and the mocked `executeCommand` so both
 *    write to one shared, order-sensitive log, then asserts — for ALL SIX
 *    `run()`-routed verbs, including `getCodeActions` (`lspGateway.ts`'s own
 *    doc comment calls it "the gate-bypass-trap verb") — that the guard is
 *    called, with the right id, BEFORE the command executes.
 *
 * What NEITHER test can prove, by construction of black-box unit testing
 * (no forged id can reach `run()`, and Vitest's own process environment
 * makes an env-gated guard indistinguishable from a real one to any test in
 * this suite): that a verb bypasses `run()` entirely, that the guard is
 * silently disabled outside the test runner, or that the guard's throw is
 * swallowed. Those three are closed by a source-TEXT ban scan instead —
 * see `lspInvariant.test.ts`'s "guard-call integrity" describe block, which
 * is the mechanism this programme uses for exactly this class of defect
 * (`suppressionCommentBan.test.ts`'s header names the same polarity rule).
 */
const executed: { command: string; args: unknown[] }[] = [];
// Order-sensitive log shared by BOTH mocks below (the 'vscode' executeCommand
// stub and the lspCommandAllowlist guard stub). This is what lets a test
// distinguish "the guard ran, in order, before the command" from "the guard
// never ran" — 'exec:<id>' entries alone (from `executed`, or from
// `lspInvariant.test.ts`'s static text scan) cannot: every existing verb's
// commandId literal is ALREADY allowlisted, so removing the guard call never
// changes which id reaches `executeCommand` for any of the six real verbs.
// Only observing the CALL itself (not its outcome) can catch that.
const callSequence: string[] = [];

// M-5 (task-8-review.md): the two `vi.mock` factories immediately below are
// HOISTED by Vitest above this whole module's body, including the `const
// executed`/`const callSequence` declarations above. This file only works
// because every real import of `./lspGateway` / `./lspCommandAllowlist` is
// DYNAMIC (`await import(...)`) and lives inside a test body, which runs
// long after both consts are initialized. A future top-level
// `import { createLspGateway } from './lspGateway';` would force the mocked
// module's evaluation during the hoisted-factory window, before `executed`/
// `callSequence` exist — a TDZ `ReferenceError`, thrown loudly at import
// time, not a silent pass. Keep every import into this file dynamic.
vi.mock('vscode', () => ({
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => {
      // Plain function pushing into an array — NOT vi.fn(), which swallows
      // unhandled rejections (Global Constraint, test hygiene).
      executed.push({ command, args });
      callSequence.push(`exec:${command}`);
      return Promise.resolve(undefined);
    },
  },
  languages: { getDiagnostics: () => [] },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  Position: class {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
}));

// Wraps the REAL assertAllowlistedCommand (via importOriginal) so it keeps
// its real throw/pass behavior for every test in this file — this is
// instrumentation, not a fake. It records that the guard was invoked, and
// with what id, before delegating. This is what proves the CALL happens,
// independent of whether the id it's called with would have thrown anyway.
vi.mock('./lspCommandAllowlist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lspCommandAllowlist')>();
  return {
    ...actual,
    assertAllowlistedCommand: (id: string) => {
      callSequence.push(`guard:${id}`);
      return actual.assertAllowlistedCommand(id);
    },
  };
});

beforeEach(() => {
  executed.length = 0;
  callSequence.length = 0;
});

// Inert stubs for the gateway's parameter types — cast `as unknown as
// vscode.<Type>` (M-3, task-8-review.md), not `as never`: `never` silences
// BOTH shape and arity, `unknown` only silences shape. `vscode` is
// module-mocked (above) so no real `vscode.Uri`/`Position`/`Range`
// constructor is available to build genuine instances; the mocked
// `executeCommand` never inspects these values, it only forwards them.
const fakeUri = { toString: () => 'file:///a.ts' } as unknown as vscode.Uri;
const fakePosition = { line: 0, character: 0 } as unknown as vscode.Position;
const fakeRange = { start: fakePosition, end: fakePosition } as unknown as vscode.Range;

/**
 * The six `run()`-routed verbs (research doc §5.3 / `lspGateway.ts`'s own
 * interface doc), each with its expected allowlisted command id and a
 * closure that drives it through the real gateway with the inert stubs
 * above. A data table, not six copy-pasted test bodies, so a future 7th
 * verb is one array entry away — and so Test 2 below can honestly claim
 * "every real verb" because it is generated from the same list a reviewer
 * can check against `lspGateway.ts`'s interface declaration directly.
 */
interface RunRoutedVerbCase {
  readonly verbName: string;
  readonly expectedId: string;
  readonly invoke: (gateway: LspGateway) => Promise<unknown>;
}

const RUN_ROUTED_VERBS: readonly RunRoutedVerbCase[] = [
  {
    verbName: 'getDefinition',
    expectedId: 'vscode.executeDefinitionProvider',
    invoke: (gateway) => gateway.getDefinition(fakeUri, fakePosition),
  },
  {
    verbName: 'getReferences',
    expectedId: 'vscode.executeReferenceProvider',
    invoke: (gateway) => gateway.getReferences(fakeUri, fakePosition),
  },
  {
    verbName: 'getDocumentSymbols',
    expectedId: 'vscode.executeDocumentSymbolProvider',
    invoke: (gateway) => gateway.getDocumentSymbols(fakeUri),
  },
  {
    verbName: 'getWorkspaceSymbols',
    expectedId: 'vscode.executeWorkspaceSymbolProvider',
    invoke: (gateway) => gateway.getWorkspaceSymbols('query'),
  },
  {
    verbName: 'getHover',
    expectedId: 'vscode.executeHoverProvider',
    invoke: (gateway) => gateway.getHover(fakeUri, fakePosition),
  },
  {
    verbName: 'getCodeActions',
    expectedId: 'vscode.executeCodeActionProvider',
    invoke: (gateway) => gateway.getCodeActions(fakeUri, fakeRange, undefined, 0),
  },
];

describe('B-1: the LIB gateway refuses any command outside the read-only allowlist', () => {
  it('every id the real gateway executes is a member of LSP_READ_COMMANDS (true by construction today — does NOT observe whether the guard ran; see the next test for that)', async () => {
    const { createLspGateway } = await import('./lspGateway');
    const gateway = createLspGateway();
    await gateway.getDefinition(fakeUri, fakePosition).catch(() => undefined);
    const { LSP_READ_COMMANDS } = await import('./lspCommandAllowlist');
    for (const call of executed) {
      expect(LSP_READ_COMMANDS).toContain(call.command);
    }
    expect(executed.length).toBeGreaterThan(0);
  });

  it('the gateway actually CALLS assertAllowlistedCommand, in order, before executeCommand — for every one of the 6 run()-routed verbs, including getCodeActions (the gate-bypass-trap verb)', async () => {
    const { createLspGateway } = await import('./lspGateway');
    const gateway = createLspGateway();

    for (const { verbName, expectedId, invoke } of RUN_ROUTED_VERBS) {
      callSequence.length = 0;
      await invoke(gateway).catch(() => undefined);
      expect(callSequence, `verb: ${verbName}`).toEqual([`guard:${expectedId}`, `exec:${expectedId}`]);
    }
  });
});
