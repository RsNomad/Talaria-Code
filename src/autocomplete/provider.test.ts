import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  TalariaInlineCompletionProvider,
  reponameFromWorkspace,
  clearSurfacedAutocompleteFailures,
  type FimActivityListener,
} from './provider';
import type { FimEngine } from './engine';
import type { FimContext } from './types';
import type { CrossFileContextService } from './context/contextService';
import { scannedSnippetForTest } from './context/scannedSnippetTestFactory';
import { BackendHttpError, BackendStreamError } from './backends/http';
import { InsecureTransportError } from './backends/secureTransport';
import { MissingApiKeyError } from './backends/CodestralFimBackend';
import { must } from '../testing/must';

/**
 * `vscode` isn't a real resolvable module outside the extension host (only
 * `@types/vscode` ships types, no runtime). Vitest can still mock it: the
 * factory below is intercepted before resolution, so this file's own
 * `import * as vscode from 'vscode'` above gets the same fake — letting tests
 * construct `vscode.Position`/`vscode.Range` instances that `provider.ts`'s
 * internals are directly compatible with, with no parallel type needed.
 */
vi.mock('vscode', () => {
  class Position {
    constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }
  class Range {
    constructor(
      public readonly start: Position,
      public readonly end: Position,
    ) {}
  }
  class InlineCompletionItem {
    constructor(
      public readonly insertText: string,
      public readonly range?: Range,
      // The optional THIRD argument VS Code executes on accept. Captured (it
      // used to be dropped on the floor) so the R4 accept-command tests can
      // observe whether an item carries one at all.
      public readonly command?: { command: string; title: string },
    ) {}
  }
  return {
    Position,
    Range,
    InlineCompletionItem,
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    workspace: { workspaceFolders: undefined },
    // A5: the surfacing primitive + the `Set API Key` action's invocation
    // target. `showWarningMessage` resolves to `undefined` by default
    // (matches the real Thenable's "dismissed" result) — mirrors
    // `TalariaViewProvider.test.ts`'s identical mock-default posture.
    window: { showWarningMessage: vi.fn().mockResolvedValue(undefined) },
    commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
  };
});

/** Minimal `vscode.TextDocument` stand-in: single line, plain-text offsets. */
class FakeDocument {
  readonly languageId = 'typescript';
  readonly uri: { scheme: string; path: string; toString: () => string };

  constructor(
    private readonly text: string,
    uriPath = '/a.ts',
  ) {
    this.uri = { scheme: 'file', path: uriPath, toString: () => `file://${uriPath}` };
  }

  getText(range?: vscode.Range): string {
    if (!range) return this.text;
    return this.text.slice(range.start.character, range.end.character);
  }

  offsetAt(position: vscode.Position): number {
    return position.character;
  }

  lineAt(pos: vscode.Position) {
    return {
      text: this.text,
      range: { end: new vscode.Position(pos.line, this.text.length) },
    };
  }
}

/**
 * A5: `vscode.window.showWarningMessage`/`vscode.commands.executeCommand`
 * are overloaded in `@types/vscode`; `vi.mocked()` resolves an overloaded
 * function to its LAST signature (the `MessageItem`-generic one here),
 * which rejects a plain string action like `'Set API Key'`. Cast through
 * `unknown` instead — mirrors the repo's existing precedent for this exact
 * problem (`host/backend/customModes.test.ts`'s `mockShowWarning`).
 */
const mockShowWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
const mockExecuteCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;

function fakeToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as unknown as vscode.CancellationToken;
}

class FakeEngine {
  calls: FimContext[] = [];
  respondWith: string | undefined;
  /** A5: when set, `complete` throws this instead of resolving — drives the
   *  provider's catch-block narrowing without a real backend/fetch. */
  throwError: unknown;

  async complete(ctx: FimContext, _opts: { manual: boolean }, _signal: AbortSignal) {
    this.calls.push(ctx);
    if (this.throwError !== undefined) throw this.throwError;
    return this.respondWith !== undefined ? { text: this.respondWith } : undefined;
  }
}

/** Minimal `snapshotFor`-only stand-in — the provider only ever calls this
 *  one method on its `contextService` dependency. */
class FakeContextService {
  documentsAsked: unknown[] = [];
  nextSnapshot: FimContext['snippets'] = [];

  snapshotFor(document: unknown) {
    this.documentsAsked.push(document);
    return { snippets: this.nextSnapshot };
  }
}

/** A5/F-B: the 4 failure-surfacing seams, overridable per test — plus the
 *  W5.1 next-edit observation seam. */
interface FailureSurfacingOpts {
  getBackendName?: () => string;
  getEndpointHost?: () => string;
  getModelName?: () => string;
  reportFailure?: (msg: string) => void;
  fimActivity?: FimActivityListener;
}

function makeProvider(
  engine: FakeEngine,
  contextService: FakeContextService = new FakeContextService(),
  opts: FailureSurfacingOpts = {},
): TalariaInlineCompletionProvider {
  return new TalariaInlineCompletionProvider(
    () => engine as unknown as FimEngine,
    () => true,
    () => false, // not Restricted Mode / not remote — never skip (S4.3 covered separately below)
    contextService as unknown as CrossFileContextService,
    opts.getBackendName ?? (() => 'vllm'),
    opts.getEndpointHost ?? (() => 'endpoint.example.com'),
    opts.getModelName ?? (() => 'qwen2.5-coder:1.5b-base'),
    opts.reportFailure ?? (() => {}),
    ...(opts.fimActivity === undefined ? [] : [opts.fimActivity]),
  );
}

/**
 * FIX WAVE (finding 5) — an ATTACHED next-edit registration: it advertises
 * the accept command because it also REGISTERED it. Plain functions, never
 * `vi.fn()` (Global Constraints).
 */
function attachedNextEdit(commandId: string): FimActivityListener {
  return {
    requestStarted: () => {},
    resultShown: () => {},
    accepted: () => {},
    acceptCommandId: () => commandId,
  };
}

describe('TalariaInlineCompletionProvider — secret-path skip (S4.1)', () => {
  it('returns null for a secret-classified document (.env) without calling the engine', async () => {
    // Full FakeDocument (getText/offsetAt/lineAt all present) so a would-be bug
    // in the secret-skip couldn't hide behind an unrelated TypeError — if the
    // skip is missing, this reaches the engine for real.
    const doc = new FakeDocument('SECRET=abc123', '/repo/.env');
    const position = new vscode.Position(0, 0);
    const engine = new FakeEngine();
    engine.respondWith = 'SHOULD_NOT_BE_USED';
    const provider = makeProvider(engine);

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(result).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  // SEC-AC S4.1 MEDIUM fix: `classifyPath` (the edit-approval taxonomy) does
  // NOT cover `.npmrc` — but a package-manager credential file is exactly the
  // kind of content that must never be POSTed to a remote inference endpoint.
  // The provider must use the broader `isSecretForCompletion` gate instead.
  // Negative assertion (not just `result === null`): the engine must NEVER be
  // invoked for this document — length 0, not merely "its output was dropped".
  it('returns null for a newly-covered secret document (.npmrc) without calling the engine', async () => {
    const doc = new FakeDocument('//registry.npmjs.org/:_authToken=abc123', '/repo/.npmrc');
    const position = new vscode.Position(0, 0);
    const engine = new FakeEngine();
    engine.respondWith = 'SHOULD_NOT_BE_USED';
    const provider = makeProvider(engine);

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(result).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  // W6-FC (final-3way-security.md IMPORTANT-1): `credentials.json` is the
  // SHARPEST vector in the finding — this is the exact real gate
  // (`isSecretForCompletion` at `provider.ts:~107`) that the active-file
  // autocomplete egress path calls SOLELY, with no content-scan backstop for
  // the file being edited. RED before the `shared/secretPaths.ts` broaden,
  // GREEN after. Fixture content only, never a real credential.
  it('returns null for a credentials.json active file without calling the engine (W6-FC)', async () => {
    const doc = new FakeDocument('{"type":"service_account","private_key":"fixture"}', '/repo/credentials.json');
    const position = new vscode.Position(0, 0);
    const engine = new FakeEngine();
    engine.respondWith = 'SHOULD_NOT_BE_USED';
    const provider = makeProvider(engine);

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(result).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });
});

describe(
  'TalariaInlineCompletionProvider — Restricted Mode remote-endpoint skip (S4.3): ' +
    'returns null in Restricted Mode when the endpoint is remote (non-loopback), ' +
    'but completes for a loopback endpoint',
  () => {
    it('returns null when getSkipUntrustedRemote() is true, without calling the engine', async () => {
      const doc = new FakeDocument('getD');
      const position = new vscode.Position(0, 4);
      const engine = new FakeEngine();
      engine.respondWith = 'ata()';
      // Restricted Mode + a remote (non-loopback) configured endpoint.
      const provider = new TalariaInlineCompletionProvider(
        () => engine as unknown as FimEngine,
        () => true,
        () => true,
        new FakeContextService() as unknown as CrossFileContextService,
        () => 'vllm',
        () => 'endpoint.example.com',
        () => 'qwen2.5-coder:1.5b-base',
        () => {},
      );

      const result = await provider.provideInlineCompletionItems(
        doc as unknown as vscode.TextDocument,
        position,
        {
          triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
          selectedCompletionInfo: undefined,
        } as unknown as vscode.InlineCompletionContext,
        fakeToken(),
      );

      expect(result).toBeNull();
      expect(engine.calls).toHaveLength(0);
    });

    it('still completes when getSkipUntrustedRemote() is false (loopback endpoint)', async () => {
      const doc = new FakeDocument('getD');
      const position = new vscode.Position(0, 4);
      const engine = new FakeEngine();
      engine.respondWith = 'ata()';
      // Restricted Mode, but the configured endpoint is loopback -> never skip.
      const provider = new TalariaInlineCompletionProvider(
        () => engine as unknown as FimEngine,
        () => true,
        () => false,
        new FakeContextService() as unknown as CrossFileContextService,
        () => 'vllm',
        () => 'endpoint.example.com',
        () => 'qwen2.5-coder:1.5b-base',
        () => {},
      );

      const result = await provider.provideInlineCompletionItems(
        doc as unknown as vscode.TextDocument,
        position,
        {
          triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
          selectedCompletionInfo: undefined,
        } as unknown as vscode.InlineCompletionContext,
        fakeToken(),
      );

      expect(result).not.toBeNull();
      expect(engine.calls).toHaveLength(1);
    });
  },
);

describe('TalariaInlineCompletionProvider — widget-open prefix/range (finding #1)', () => {
  it('splices the prefix at the widget range start, not the cursor — no duplicated typed text', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4); // cursor right after "getD"
    const wordStart = new vscode.Position(0, 0);
    const selectedCompletionInfo = {
      range: new vscode.Range(wordStart, position),
      text: 'getData',
    };
    const engine = new FakeEngine();
    engine.respondWith = 'getData()';
    const provider = makeProvider(engine);

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    // The bug: old code produced "getDgetData". Fixed: splice at wordStart.
    expect(must(engine.calls[0]).prefix).toBe('getData');
    expect(must(engine.calls[0]).suffix).toBe('');

    expect(result).not.toBeNull();
    const items = result as unknown as vscode.InlineCompletionItem[];
    expect(items).toHaveLength(1);
    expect(must(items[0]).insertText).toBe('getData()');

    // Range must replace [wordStart, cursor] (the typed "getD"), not just
    // insert at wordStart and leave "getD" behind.
    const range = must(items[0]).range as unknown as vscode.Range;
    expect(range.start.line).toBe(0);
    expect(range.start.character).toBe(0);
    expect(range.end.line).toBe(0);
    expect(range.end.character).toBe(4);
  });

  it('extends the replace range through an already-present overlapping suffix, still anchored at wordStart', async () => {
    // Line already reads "getD()" — cursor sits right after "getD", "()" follows.
    const doc = new FakeDocument('getD()');
    const position = new vscode.Position(0, 4);
    const wordStart = new vscode.Position(0, 0);
    const selectedCompletionInfo = {
      range: new vscode.Range(wordStart, position),
      text: 'getData',
    };
    const engine = new FakeEngine();
    engine.respondWith = 'getData()'; // model regenerates the parens too
    const provider = makeProvider(engine);

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(result).not.toBeNull();
    const items = result as unknown as vscode.InlineCompletionItem[];
    expect(must(items[0]).insertText).toBe('getData()');

    // Must consume the whole "getD()" (0..6), not just from the cursor (4..6),
    // or the typed "getD" is left behind alongside the new "getData()".
    const range = must(items[0]).range as unknown as vscode.Range;
    expect(range.start.character).toBe(0);
    expect(range.end.character).toBe(6);
  });

  it('leaves the non-widget path unchanged: plain cursor-collapsed insertion', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const provider = makeProvider(engine);

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(must(engine.calls[0]).prefix).toBe('getD');
    expect(must(engine.calls[0]).suffix).toBe('');

    expect(result).not.toBeNull();
    const items = result as unknown as vscode.InlineCompletionItem[];
    expect(must(items[0]).insertText).toBe('ata()');

    const range = must(items[0]).range as unknown as vscode.Range;
    expect(range.start.character).toBe(4);
    expect(range.end.character).toBe(4);

    // F-2 (A7): pins the undocumented completeBracketPairs flag the named
    // InlineCompletionItemWithUndocumentedFlags interface now sets — not in
    // the mocked InlineCompletionItem's declared shape, so read it through
    // an unknown cast (mirrors this test's `range` cast above).
    expect((items[0] as unknown as { completeBracketPairs?: boolean }).completeBracketPairs).toBe(
      true,
    );
  });
});

// ── W5-T5: reponameFromWorkspace — pure ─────────────────────────────────────
describe('reponameFromWorkspace', () => {
  it('returns the POSIX basename of the single configured workspace folder', () => {
    const result = reponameFromWorkspace('file:///repo/src/a.ts', ['file:///repo']);
    expect(result).toBe('repo');
  });

  it('prefers the CONTAINING folder (longest matching prefix) in a multi-root workspace', () => {
    const result = reponameFromWorkspace('file:///workspace/backend/src/a.ts', [
      'file:///workspace',
      'file:///workspace/backend',
    ]);
    expect(result).toBe('backend');
  });

  it('falls back to the first configured folder when the document matches none', () => {
    const result = reponameFromWorkspace('file:///elsewhere/a.ts', ['file:///repo-one', 'file:///repo-two']);
    expect(result).toBe('repo-one');
  });

  it('returns undefined when there are no workspace folders', () => {
    expect(reponameFromWorkspace('file:///a.ts', [])).toBeUndefined();
  });

  it('tolerates a trailing slash on the workspace folder URI', () => {
    const result = reponameFromWorkspace('file:///repo/a.ts', ['file:///repo/']);
    expect(result).toBe('repo');
  });

  it('handles a workspace folder name containing dashes/dots', () => {
    const result = reponameFromWorkspace('file:///home/dev/my-project.v2/a.ts', ['file:///home/dev/my-project.v2']);
    expect(result).toBe('my-project.v2');
  });
});

// ── W5-T5: the snippets seam + reponame + egressPreconditionsMet ───────────
describe('TalariaInlineCompletionProvider — cross-file wiring (W5-T5)', () => {
  afterEach(() => {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('captures contextService.snapshotFor(document).snippets ONCE into FimContext.snippets', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const contextService = new FakeContextService();
    const snippet = scannedSnippetForTest({
      uri: 'file:///repo/util.ts',
      filepath: 'util.ts',
      content: 'export function helper() {}',
      kind: 'recently-opened',
      startLine: 0,
      endLine: 1,
    });
    contextService.nextSnapshot = [snippet];
    const provider = makeProvider(engine, contextService);

    await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(must(engine.calls[0]).snippets).toEqual([snippet]);
    // snapshotFor is consulted exactly once per completion request — the
    // captured array is what this completion uses, full stop (no second
    // read that could observe a mid-request regeneration).
    expect(contextService.documentsAsked).toHaveLength(1);
  });

  it('an empty snapshot yields an empty snippets array (v1 no-egress parity when the service has nothing)', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const provider = makeProvider(engine); // default FakeContextService -> nextSnapshot: []

    await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(must(engine.calls[0]).snippets).toEqual([]);
  });

  it('sets reponame from vscode.workspace.workspaceFolders (the folder containing the document)', async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { toString: () => 'file:///repo' } },
    ];
    const doc = new FakeDocument('getD', '/repo/src/a.ts');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const provider = makeProvider(engine);

    await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(must(engine.calls[0]).reponame).toBe('repo');
  });

  it('reponame is undefined when there are no workspace folders (unchanged v1-parity default)', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const provider = makeProvider(engine);

    await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(must(engine.calls[0]).reponame).toBeUndefined();
  });

  it('egressPreconditionsMet guard parity: still returns null when untrusted-remote skip is set (refactor did not change behavior)', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'SHOULD_NOT_BE_USED';
    const provider = new TalariaInlineCompletionProvider(
      () => engine as unknown as FimEngine,
      () => true, // enabled
      () => true, // skipUntrustedRemote
      new FakeContextService() as unknown as CrossFileContextService,
      () => 'vllm',
      () => 'endpoint.example.com',
      () => 'qwen2.5-coder:1.5b-base',
      () => {},
    );

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(result).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  it('egressPreconditionsMet guard parity: still returns null when not enabled', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'SHOULD_NOT_BE_USED';
    const provider = new TalariaInlineCompletionProvider(
      () => engine as unknown as FimEngine,
      () => false, // NOT enabled
      () => false, // skipUntrustedRemote
      new FakeContextService() as unknown as CrossFileContextService,
      () => 'vllm',
      () => 'endpoint.example.com',
      () => 'qwen2.5-coder:1.5b-base',
      () => {},
    );

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(result).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });
});

// ── W5.1: next-edit shape-lock (rewrites the W5-T5 absence guard) ─────────────────────────
describe('next-edit contributions shape-lock', () => {
  const REQUIRED_GUARDS = [
    'editorTextFocus', '!editorReadonly', '!suggestWidgetVisible',
    '!inlineSuggestionVisible', '!inlineEditIsVisible', '!inSnippetMode', '!editorTabMovesFocus',
  ] as const;

  it('every next-edit TAB keybinding carries the full negative-guard when-clause; dismiss carries its own gate', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { contributes?: { keybindings?: { command: string; when?: string }[] } };
    const all = pkg.contributes?.keybindings ?? [];
    // The full negative-guard set binds the TAB owners (jump/accept) — Tab is the contended key (R3).
    const tabBindings = all.filter((k) =>
      k.command === 'talaria.nextEdit.jump' || k.command === 'talaria.nextEdit.accept',
    );
    for (const binding of tabBindings) {
      for (const guard of REQUIRED_GUARDS) {
        expect(binding.when ?? '', `${binding.command} must gate on ${guard}`).toContain(guard);
      }
      expect(binding.when ?? '').toContain('talaria.nextEdit.jumpVisible');
    }
    // FIX WAVE 2 (F-6). This used to read "Esc is not contended the way Tab is — core closes
    // widgets first by weight". That was BACKWARDS: `keybindingService.ts::_asCommandRule` gives
    // package.json bindings `KeybindingWeight.ExternalExtension` (400) while core's
    // `hideSuggestWidget` is `EditorContrib` (100), and the resolver takes the HIGHEST-weight
    // match — so our Esc outranked every built-in Esc handler. With IntelliSense open over a live
    // proposal, Esc dismissed the proposal and left the widget up.
    //
    // Esc now yields to the four TRANSIENT overlays that own Esc while they are up. It does NOT
    // take `!editorReadonly` (a persistent document property — gating dismiss on it would make a
    // visible proposal undismissable) or `!editorTabMovesFocus` (pure Tab semantics). The exact
    // clause is pinned byte-for-byte in `nextedit/coexistence.lock.test.ts`'s R3 table.
    const DISMISS_YIELDS_TO = [
      '!suggestWidgetVisible', '!inlineSuggestionVisible', '!inlineEditIsVisible', '!inSnippetMode',
    ] as const;
    const dismissBindings = all.filter((k) => k.command === 'talaria.nextEdit.dismiss');
    expect(dismissBindings.length, 'reach: package.json must declare talaria.nextEdit.dismiss').toBeGreaterThan(0);
    for (const binding of dismissBindings) {
      expect(binding.when ?? '').toContain('talaria.nextEdit.jumpVisible');
      expect(binding.when ?? '').toContain('editorTextFocus');
      for (const guard of DISMISS_YIELDS_TO) {
        expect(binding.when ?? '', `dismiss must yield Esc to ${guard.slice(1)} while it is up`).toContain(guard);
      }
      // The two Tab guards dismiss deliberately does NOT carry — asserted as ABSENCES so a later
      // "make it match Tab" edit is caught rather than silently making Esc unreachable.
      expect(
        binding.when ?? '',
        'dismiss must NOT gate on !editorReadonly — a visible proposal must stay dismissable in a read-only editor',
      ).not.toContain('editorReadonly');
      expect(
        binding.when ?? '',
        'dismiss must NOT gate on !editorTabMovesFocus — that is a Tab-semantics setting and says nothing about Escape',
      ).not.toContain('editorTabMovesFocus');
    }
  });

  it('provider.ts registers no next-edit command inline (commands register once, in the shell)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(__dirname, 'provider.ts'), 'utf8');
    expect(source).not.toMatch(/registerCommand\(\s*['"]talaria\.nextEdit/);
  });

  it('R5: the toggles are NOT settings — no enabled/generic contribution exists, and every nextEdit data key is machine-scoped', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { contributes?: { configuration?: { properties?: Record<string, { scope?: string }> } } };
    const props = pkg.contributes?.configuration?.properties ?? {};
    expect(props['talaria.nextEdit.enabled']).toBeUndefined();   // the toggle lives in the Guard's store
    expect(props['talaria.nextEdit.generic']).toBeUndefined();   // (owner: settings carry DATA, not state)
    for (const [key, def] of Object.entries(props)) {
      if (key.startsWith('talaria.nextEdit.')) {
        expect(def.scope, `${key} must be machine-scoped (config.ts:71-74 precedent)`).toBe('machine');
      }
    }
  });

  /*
   * FIX WAVE 2 (S-3). `talaria.nextEdit.endpoint` is the next-edit twin of
   * `talaria.autocomplete.endpoint` — the destination editor text egresses to,
   * i.e. the wave-1 exfil vector. Its FIM counterpart is listed under
   * `capabilities.untrustedWorkspaces.restrictedConfigurations`; this one was
   * not.
   *
   * The security lens graded this a CONSISTENCY GAP, not a hole: `scope:
   * "machine"` (asserted above) already stops a repo `.vscode/settings.json`
   * from overriding it, so the setting was never actually reachable by an
   * untrusted workspace. Both belts are declared anyway — the two mechanisms
   * are independent, and a future scope relaxation must not silently be the
   * only thing standing between a checked-in settings file and an
   * attacker-chosen endpoint.
   *
   * Deliberately endpoint-only, mirroring FIM exactly: `talaria.autocomplete.
   * model` is not listed either (a model NAME picks no destination), and
   * next-edit has no apiKey setting at all.
   *
   * (Review I-1: this is a statement about THIS list —
   * `restrictedConfigurations`, the workspace-TRUST gate — not about
   * `scope`. `talaria.autocomplete.model` IS `scope: "machine"`, for an
   * unrelated reason: not trust, but workspace-OVERRIDE — a workspace
   * cannot silently swap which model serves completions. See
   * `configScope.test.ts`'s `MODEL_INTEGRITY_PATTERN` lock and `config.ts`'s
   * comment on `DEFAULT_ENDPOINTS`, which now keeps the two rationales
   * apart explicitly.)
   */
  it('S-3: talaria.nextEdit.endpoint is trust-restricted, exactly like its FIM counterpart (the egress destination)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { capabilities?: { untrustedWorkspaces?: { restrictedConfigurations?: string[] } } };
    const restricted = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];

    expect(
      restricted,
      'reach: an empty restrictedConfigurations list would rubber-stamp every assertion here',
    ).toContain('talaria.autocomplete.endpoint');
    expect(
      restricted,
      'S-3: talaria.nextEdit.endpoint must be trust-restricted — it is the next-edit egress destination, the exact role talaria.autocomplete.endpoint plays for FIM',
    ).toContain('talaria.nextEdit.endpoint');
  });

  /**
   * Review I-1. `talaria.autocomplete.backend` is the endpoint SELECTOR this
   * whole task exists to lock down (`config.ts`'s `DEFAULT_ENDPOINTS`) — it
   * was added to `restrictedConfigurations` alongside `.endpoint`/`.apiKey`
   * for the same reason S-3 gives above (both belts, independent
   * mechanisms): `scope: "machine"` already stops a checked-in
   * `.vscode/settings.json` from overriding it, but a future scope
   * relaxation must not silently be the only thing standing between such a
   * file and an attacker-chosen endpoint.
   */
  it('review I-1: talaria.autocomplete.backend is trust-restricted too — it SELECTS the egress destination via DEFAULT_ENDPOINTS', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { capabilities?: { untrustedWorkspaces?: { restrictedConfigurations?: string[] } } };
    const restricted = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];

    expect(
      restricted,
      'reach: an empty restrictedConfigurations list would rubber-stamp this assertion',
    ).toContain('talaria.autocomplete.endpoint');
    expect(
      restricted,
      'I-1: talaria.autocomplete.backend selects the endpoint (audit C-4\'s root cause) and must be trust-restricted like the endpoint itself',
    ).toContain('talaria.autocomplete.backend');
  });
});

// ── FIX WAVE (finding 5): the R4 accept command must never be advertised
//    by an item while nothing has registered it ──────────────────────────────
describe('the R4 accept command is advertised only by an ATTACHED next-edit registration', () => {
  const ACCEPT_COMMAND = 'talaria.nextEdit.onFimAccept';

  async function completeOnce(
    provider: TalariaInlineCompletionProvider,
  ): Promise<vscode.InlineCompletionItem[]> {
    const doc = new FakeDocument('const ');
    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      new vscode.Position(0, 6),
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );
    return result as vscode.InlineCompletionItem[];
  }

  it('next-edit UNATTACHED (the state a REJECTED hydrate leaves behind): the item carries no command at all', async () => {
    const engine = new FakeEngine();
    engine.respondWith = 'x = 1;';
    // `index.ts` registers `talaria.nextEdit.onFimAccept` only inside
    // `NextEditGuard.hydrate().then(...)`, and its rejection handler merely
    // logs — so a failed hydration leaves the seam a no-op forever. An item
    // that still carried the command id would make EVERY FIM accept execute
    // an unregistered command. FIM must not degrade because next-edit
    // failed to come up.
    const provider = makeProvider(engine);

    const items = await completeOnce(provider);

    expect(items).toHaveLength(1);
    expect(must(items[0]).command).toBeUndefined();
  });

  it('next-edit ATTACHED: the item carries exactly the command that registration advertises', async () => {
    const engine = new FakeEngine();
    engine.respondWith = 'x = 1;';
    const provider = makeProvider(engine, new FakeContextService(), {
      fimActivity: attachedNextEdit(ACCEPT_COMMAND),
    });

    const items = await completeOnce(provider);

    expect(items).toHaveLength(1);
    expect(must(items[0]).command).toEqual({ command: ACCEPT_COMMAND, title: '' });
  });
});

// ── A5: narrowed catch — surface the 3 actionable failures, once each ──────
describe('TalariaInlineCompletionProvider — failure surfacing (A5)', () => {
  beforeEach(() => {
    clearSurfacedAutocompleteFailures();
    mockShowWarningMessage.mockClear();
    mockShowWarningMessage.mockResolvedValue(undefined);
    mockExecuteCommand.mockClear();
  });

  /** Drives a single `provideInlineCompletionItems` call through the
   *  catch block — the document/position/context shape is irrelevant to
   *  these tests, only `engine.complete`'s outcome (set via
   *  `engine.throwError`) matters. */
  async function complete(
    provider: TalariaInlineCompletionProvider,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    return provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );
  }

  it('a 401 BackendHttpError surfaces a warning exactly once; the identical second failure is silent (anti-spam)', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine);

    const first = await complete(provider);
    expect(first).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);

    // Second identical failure (same backend/host/statusClass): must NOT
    // call showWarningMessage again — this is the spam-risk assertion the
    // whole task exists for.
    const second = await complete(provider);
    expect(second).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('rebuild re-arms: clearSurfacedAutocompleteFailures makes the same 401 surface again', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine);

    await complete(provider);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    await complete(provider);
    expect(showWarningMessage).toHaveBeenCalledTimes(1); // still silent

    clearSurfacedAutocompleteFailures();

    await complete(provider);
    expect(showWarningMessage).toHaveBeenCalledTimes(2); // re-armed
  });

  it('a 403 BackendHttpError behaves like 401: surfaced with the Set API Key action, naming the status + statusText, covering BOTH "missing" and "incorrect" (F-C Minor-2/Minor-3)', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 403 Forbidden', 403, 'Forbidden');
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine, undefined, { getBackendName: () => 'vllm' });

    await complete(provider);

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message, ...items] = must(showWarningMessage.mock.calls[0]);
    // F-C Minor-2: "Set the API key" told a user who DID set one to do the
    // thing they already did — the copy must cover both "missing" and
    // "incorrect". F-C Minor-3: statusText ("Forbidden"), not a bare code,
    // and "the vllm server", not raw "vllm" as the grammatical subject.
    expect(message).toBe(
      'Talaria autocomplete: the vllm server rejected the request (403 Forbidden) — the API key is missing or incorrect.',
    );
    expect(items).toContain('Set API Key');
  });

  it('a 400 BackendHttpError surfaces the endpoint-dialect hint (mentions talaria.autocomplete.backend) as a hedged likely cause, not an assertion of fact (F-C Minor-1), with no action button', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 400 Bad Request', 400, 'Bad Request');
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine, undefined, { getBackendName: () => 'vllm' });

    await complete(provider);

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message, ...items] = must(showWarningMessage.mock.calls[0]);
    expect(message).toContain('talaria.autocomplete.backend');
    expect(message).toContain('400 Bad Request');
    // F-C Minor-1: vLLM also 400s on context-length overflow, not just a
    // dialect mismatch — a user with maxPromptTokens set higher than the
    // server's max-model-len would be told to check a setting that IS
    // correct. The copy must hedge ("usually"/"likely"), never assert.
    expect(message).toMatch(/usually|likely/i);
    expect(items).toHaveLength(0);
  });

  // F-B (final fix wave): vLLM's check_model returns 404 for an unserved
  // model name (grounded via Context7,
  // vllm/entrypoints/openai/models/serving) — a common, actionable
  // misconfiguration that previously fell through every arm to the silent
  // `return null`. This is the DEFAULT vLLM path: config.ts's DEFAULT_MODEL
  // is an Ollama tag format vLLM can never serve, so a user who authenticates
  // correctly and never touches talaria.autocomplete.model gets pure silence.
  it('a 404 BackendHttpError surfaces a warning exactly once, naming the configured model; the identical second failure is silent', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 404 Not Found', 404, 'Not Found');
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine, undefined, {
      getBackendName: () => 'vllm',
      getModelName: () => 'qwen2.5-coder:1.5b-base',
    });

    const first = await complete(provider);
    expect(first).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = must(showWarningMessage.mock.calls[0]);
    expect(message).toContain('qwen2.5-coder:1.5b-base');
    expect(message).toContain('404');
    expect(message).toContain('talaria.autocomplete.model');

    // Same anti-spam discipline as the other three arms.
    const second = await complete(provider);
    expect(second).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('an InsecureTransportError is always surfaced (a config/security refusal is always actionable)', async () => {
    const engine = new FakeEngine();
    engine.throwError = new InsecureTransportError(
      'Refusing to send the autocomplete API key over cleartext http to a remote host (CWE-319). Use https, or a loopback endpoint.',
    );
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine);

    const result = await complete(provider);

    expect(result).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  // F-C Minor-4 (also security M-3): this was the one arm that echoed a raw
  // `err.message` to BOTH the toast and the output channel — showing a
  // non-expert user "(CWE-319)". Rebuild the toast text the way the other
  // arms do; keep the developer-facing detail (the throw-site's own message)
  // confined to the output channel via reportFailure.
  it('rebuilds the InsecureTransportError toast text (no raw err.message/CWE echoed to the user); the developer detail still reaches the output channel', async () => {
    const engine = new FakeEngine();
    engine.throwError = new InsecureTransportError(
      'Refusing to send the autocomplete API key over cleartext http to a remote host (CWE-319). Use https, or a loopback endpoint.',
    );
    const showWarningMessage = mockShowWarningMessage;
    const reportFailure = vi.fn();
    const provider = makeProvider(engine, undefined, { reportFailure });

    await complete(provider);

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [toastMessage] = must(showWarningMessage.mock.calls[0]);
    expect(toastMessage).not.toContain('CWE-319');
    expect(toastMessage).toMatch(/https|loopback/i);

    // The developer detail (still no key, no response body) reaches the
    // channel — this is the ONE reportFailure call for this surfaced event.
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(expect.stringContaining('CWE-319'));
  });

  /**
   * Review C-1 fix. `CodestralFimBackend.streamFim` throws this BEFORE any
   * fetch when the configured backend has no key — the refusal moved off
   * `createBackend` (construction, which must never throw — see
   * `backendFactory.test.ts`) onto this request path instead. The provider
   * must surface it through the SAME actionable-failure path as
   * InsecureTransportError, with the `Set API Key` action and anti-spam
   * dedup, so the user gets a real signal instead of a silently-null
   * completion.
   */
  it('a MissingApiKeyError is always surfaced with the Set API Key action, and never carries a key value', async () => {
    const engine = new FakeEngine();
    engine.throwError = new MissingApiKeyError(
      'talaria.autocomplete.backend=codestral requires an API key. Run "Talaria: Set Autocomplete API Key", or choose a local backend.',
    );
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine, undefined, { getBackendName: () => 'codestral' });

    const first = await complete(provider);
    expect(first).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message, ...items] = must(showWarningMessage.mock.calls[0]);
    expect(message).toContain('codestral');
    expect(message).not.toMatch(/sk-|Bearer/);
    expect(items).toContain('Set API Key');

    // Same anti-spam discipline as the other actionable arms.
    const second = await complete(provider);
    expect(second).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('a bare TypeError (or any other error) returns null silently — no warning, unchanged v1 behavior (narrowed, not widened)', async () => {
    const engine = new FakeEngine();
    engine.throwError = new TypeError('fetch failed');
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine);

    const result = await complete(provider);

    expect(result).toBeNull();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  // F-E (final fix wave) originally pinned here: "a 500 BackendHttpError
  // (not user-actionable) stays silent — no toast, no reportFailure line —
  // while a 404 (F-B) is surfaced." T-D1 (closes V-15) intentionally
  // OVERTURNS that contract: the audit found that every unlisted/≥500
  // status (crucially llama.cpp's 501 "Infill is not supported by this
  // model" — the classic non-FIM-GGUF misconfiguration) fell through every
  // arm into the silent `return null`, leaving autocomplete permanently and
  // undiagnosably dead. A once-per-status toast is the intended fix — the
  // existing `surfaceIfFirst` per-`backend|host|statusClass` dedup (still
  // exercised by every test below) is what keeps this from becoming
  // per-keystroke spam. The three tests below replace the old silent-500
  // pin with the new contract; a bare `TypeError`/non-`BackendHttpError`
  // failure (the test above) is UNCHANGED and still silent — only HTTP
  // failures reach the catch-all.
  it('a 501 BackendHttpError surfaces the FIM-model hint exactly once, never leaking the response body, and returns null; the identical second failure is silent (anti-spam)', async () => {
    // Planted marker stands in for real runner detail (a response body /
    // internal error text) that must NEVER reach the surfaced toast —
    // invariant 5. The catch-all only ever reads `.status`/`.statusText`,
    // never `.message`, so this proves that structurally, not by luck.
    const bodyMarker = 'BODY_MARKER_never_surfaced_9f3a1c';
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError(
      `llama.cpp /infill failed: 501 Not Implemented — ${bodyMarker}`,
      501,
      'Not Implemented',
    );
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine, undefined, { getBackendName: () => 'llamacpp' });

    const first = await complete(provider);
    expect(first).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = must(showWarningMessage.mock.calls[0]);
    expect(message).toMatch(/501 Not Implemented/);
    expect(message).toMatch(/fill-in-the-middle/i);
    expect(message).not.toContain(bodyMarker);

    // Same anti-spam discipline as every other arm.
    const second = await complete(provider);
    expect(second).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('a 500 BackendHttpError surfaces via the generic catch-all exactly once, with no FIM hint (that hint is 501-only)', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError(
      'vLLM /v1/completions failed: 500 Internal Server Error',
      500,
      'Internal Server Error',
    );
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine);

    const first = await complete(provider);
    expect(first).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = must(showWarningMessage.mock.calls[0]);
    expect(message).toMatch(/500 Internal Server Error/);
    expect(message).not.toMatch(/fill-in-the-middle/i);

    const second = await complete(provider);
    expect(second).toBeNull();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('a 503 BackendHttpError (no dedicated arm — not 500/501/401/403/400/404) still surfaces via the catch-all, and reportFailure receives the same body-free line: every unhandled status is covered, not an enumerated few', async () => {
    const reportFailure = vi.fn();
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError(
      'vLLM /v1/completions failed: 503 Service Unavailable',
      503,
      'Service Unavailable',
    );
    const provider = makeProvider(engine, undefined, { reportFailure });

    const result = await complete(provider);

    expect(result).toBeNull();
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    const [message] = must(mockShowWarningMessage.mock.calls[0]);
    expect(message).toContain('503');
  });

  /**
   * V-14 (FIM-SSE-ERROR): a mid-stream SSE error frame — a real backend
   * failure the runner reports on an otherwise-200 stream (root cause:
   * vLLM `serving.py:491-497`). Surfaced the same way any other actionable
   * FIM failure is (once per backend|host|class, `surfaceIfFirst`'s
   * anti-spam dedup) — composes with D1's `BackendHttpError` arms above
   * (a disjoint class, no overlap in the if/else-if chain). Body-free by
   * construction on BOTH ends: `BackendStreamError` never carries the
   * frame's own message text (proven in `http.test.ts`), and this toast is
   * a FIXED template that never reads `err.message` at all — planting a
   * marker in the thrown error's own message proves the toast is
   * structurally independent of it, not just accidentally clean today.
   */
  it('a BackendStreamError surfaces a warning exactly once, body-free, and returns null; the identical second failure is silent (anti-spam)', async () => {
    const bodyMarker = 'RUNNER_FRAME_DETAIL_never_surfaced_5a1f';
    const engine = new FakeEngine();
    engine.throwError = new BackendStreamError(`vLLM reported an error mid-stream: ${bodyMarker}`);
    const provider = makeProvider(engine, undefined, { getBackendName: () => 'vllm' });

    const first = await complete(provider);
    expect(first).toBeNull();
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = must(mockShowWarningMessage.mock.calls[0]);
    expect(message).toContain('vllm');
    expect(message).toMatch(/mid-stream/i);
    expect(message).not.toContain(bodyMarker);

    // Same anti-spam discipline as every other arm.
    const second = await complete(provider);
    expect(second).toBeNull();
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('the Set API Key action invokes talaria.setAutocompleteApiKey', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    mockShowWarningMessage.mockResolvedValueOnce('Set API Key');
    const executeCommand = mockExecuteCommand;
    const provider = makeProvider(engine);

    await complete(provider);
    // Flush the showWarningMessage Thenable's `.then` microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(executeCommand).toHaveBeenCalledWith('talaria.setAutocompleteApiKey');
  });

  it('dismissing the warning (undefined result) does not throw and does not invoke the command', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    mockShowWarningMessage.mockResolvedValueOnce(undefined);
    const executeCommand = mockExecuteCommand;
    const provider = makeProvider(engine);

    await expect(complete(provider)).resolves.toBeNull();
    await Promise.resolve();
    await Promise.resolve();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reportFailure receives exactly one line per surfaced event, and zero lines for the silent arm', async () => {
    const reportFailure = vi.fn();

    const surfacingEngine = new FakeEngine();
    surfacingEngine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    const surfacingProvider = makeProvider(surfacingEngine, undefined, { reportFailure });
    await complete(surfacingProvider);
    expect(reportFailure).toHaveBeenCalledTimes(1);

    reportFailure.mockClear();
    const silentEngine = new FakeEngine();
    silentEngine.throwError = new TypeError('connection refused');
    const silentProvider = makeProvider(silentEngine, undefined, {
      reportFailure,
      getBackendName: () => 'ollama',
      getEndpointHost: () => 'other.example.com',
    });
    await complete(silentProvider);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('different (backend, host, statusClass) keys surface independently — the Set key actually discriminates', async () => {
    const showWarningMessage = mockShowWarningMessage;

    const engineHostA = new FakeEngine();
    engineHostA.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    const providerHostA = makeProvider(engineHostA, undefined, {
      getBackendName: () => 'vllm',
      getEndpointHost: () => 'host-a.example.com',
    });
    await complete(providerHostA);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);

    // Different host, same backend/statusClass -> independent key, surfaces again.
    const engineHostB = new FakeEngine();
    engineHostB.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    const providerHostB = makeProvider(engineHostB, undefined, {
      getBackendName: () => 'vllm',
      getEndpointHost: () => 'host-b.example.com',
    });
    await complete(providerHostB);
    expect(showWarningMessage).toHaveBeenCalledTimes(2);

    // Same backend/host as A, but a different statusClass (400 vs 401) -> independent key.
    const engineDialect = new FakeEngine();
    engineDialect.throwError = new BackendHttpError('vLLM /v1/completions failed: 400 Bad Request', 400, 'Bad Request');
    const providerDialect = makeProvider(engineDialect, undefined, {
      getBackendName: () => 'vllm',
      getEndpointHost: () => 'host-a.example.com',
    });
    await complete(providerDialect);
    expect(showWarningMessage).toHaveBeenCalledTimes(3);
  });

  it('all pre-existing provider.test.ts behavior stays green alongside the new catch (smoke: a successful completion is untouched)', async () => {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const showWarningMessage = mockShowWarningMessage;
    const provider = makeProvider(engine);

    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );

    expect(result).not.toBeNull();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });
});

// ── Task 16 (08 §11, ADR-010): unknown-model one-shot warning / vllm refusal ──
describe('TalariaInlineCompletionProvider — unknown-model warning / refusal (Task 16)', () => {
  beforeEach(() => {
    clearSurfacedAutocompleteFailures();
    mockShowWarningMessage.mockClear();
    mockShowWarningMessage.mockResolvedValue(undefined);
  });

  // The cut-model names the Global Constraints forbid in shipped code are
  // deliberately NOT used as fixtures here, test files included.
  // 'granite-code' proves the same unrecognized-model behavior without
  // planting a forbidden string.
  const UNKNOWN_MODEL = 'granite-code';
  const KNOWN_MODEL = 'qwen2.5-coder:7b';

  async function complete(
    provider: TalariaInlineCompletionProvider,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    return provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );
  }

  it('unknown model + vllm backend (nativeFim:false self-render path): REFUSE_MSG surfaced once, ZERO engine calls, returns null; second identical request stays silent', async () => {
    const engine = new FakeEngine();
    engine.respondWith = 'SHOULD_NOT_BE_CALLED';
    const provider = makeProvider(engine, undefined, {
      getBackendName: () => 'vllm',
      getModelName: () => UNKNOWN_MODEL,
    });

    const first = await complete(provider);
    expect(first).toBeNull();
    expect(engine.calls).toHaveLength(0);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = must(mockShowWarningMessage.mock.calls[0]);
    // REFUSE_MSG — FROZEN owner-approved copy (08 §11 / 09:89), verbatim,
    // T7 (final-review remediation): example tag is the BASE build, never
    // the bare instruct tag (F §6.3, owner-ratified).
    expect(message).toBe(
      `Talaria autocomplete is paused: unrecognized model "${UNKNOWN_MODEL}". The vllm backend needs Talaria to build the model-specific FIM prompt itself, and guessing the format would produce silently wrong completions. Set "talaria.autocomplete.model" to a supported model (for example "qwen2.5-coder:7b-base").`,
    );
    // T7: assert BOTH polarities explicitly (not just the `toBe` pin above),
    // so a future loosening of the exact-match pin cannot silently reopen
    // I-1. Quote-boundary regex avoids the `7b` substring-of-`7b-base` trap.
    expect(message).toContain('"qwen2.5-coder:7b-base"');
    expect(message).not.toMatch(/"qwen2\.5-coder:7b"/);

    // Second identical request: the one-shot Set keeps this silent.
    const second = await complete(provider);
    expect(second).toBeNull();
    expect(engine.calls).toHaveLength(0);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('unknown model + ollama backend (nativeFim:true, server-side templates): WARN_MSG surfaced once, engine IS called, completion proceeds', async () => {
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const provider = makeProvider(engine, undefined, {
      getBackendName: () => 'ollama',
      getModelName: () => UNKNOWN_MODEL,
    });

    const first = await complete(provider);
    expect(engine.calls).toHaveLength(1);
    expect(first).not.toBeNull();
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = must(mockShowWarningMessage.mock.calls[0]);
    // WARN_MSG — FROZEN owner-approved copy (08 §11 / 09:88), verbatim,
    // T7 (final-review remediation): example tag is the BASE build, never
    // the bare instruct tag (F §6.3, owner-ratified).
    expect(message).toBe(
      `Talaria autocomplete: unrecognized model "${UNKNOWN_MODEL}". Talaria has no prompt template for this model and will fall back to a generic FIM format — completions may be malformed or silently wrong. Officially supported: qwen2.5-coder (for example "qwen2.5-coder:7b-base").`,
    );
    // T7: assert BOTH polarities explicitly (not just the `toBe` pin above),
    // so a future loosening of the exact-match pin cannot silently reopen
    // I-1. Quote-boundary regex avoids the `7b` substring-of-`7b-base` trap.
    expect(message).toContain('"qwen2.5-coder:7b-base"');
    expect(message).not.toMatch(/"qwen2\.5-coder:7b"/);

    // Second identical request: engine keeps being called (WARN proceeds,
    // unlike REFUSE), but the one-shot Set keeps the warning itself silent.
    const second = await complete(provider);
    expect(engine.calls).toHaveLength(2);
    expect(second).not.toBeNull();
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('known model: zero unknown-model warnings, on either backend', async () => {
    const vllmEngine = new FakeEngine();
    vllmEngine.respondWith = 'ata()';
    const vllmProvider = makeProvider(vllmEngine, undefined, {
      getBackendName: () => 'vllm',
      getModelName: () => KNOWN_MODEL,
    });
    await complete(vllmProvider);
    expect(vllmEngine.calls).toHaveLength(1);

    const ollamaEngine = new FakeEngine();
    ollamaEngine.respondWith = 'ata()';
    const ollamaProvider = makeProvider(ollamaEngine, undefined, {
      getBackendName: () => 'ollama',
      getModelName: () => KNOWN_MODEL,
    });
    await complete(ollamaProvider);
    expect(ollamaEngine.calls).toHaveLength(1);

    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it('clearSurfacedAutocompleteFailures() re-arms the unknown-model warning (vllm refusal)', async () => {
    const engine = new FakeEngine();
    const provider = makeProvider(engine, undefined, {
      getBackendName: () => 'vllm',
      getModelName: () => UNKNOWN_MODEL,
    });

    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1); // still silent

    clearSurfacedAutocompleteFailures();

    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(2); // re-armed
  });

  it('clearSurfacedAutocompleteFailures() re-arms the unknown-model warning (ollama warn-and-proceed)', async () => {
    const engine = new FakeEngine();
    engine.respondWith = 'ata()';
    const provider = makeProvider(engine, undefined, {
      getBackendName: () => 'ollama',
      getModelName: () => UNKNOWN_MODEL,
    });

    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1); // still silent

    clearSurfacedAutocompleteFailures();

    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(2); // re-armed
  });
});

// ── M3 (A7, pulled forward from A5's review): on a keyring-less Fedora box
// (our actual ship target), `talaria.setAutocompleteApiKey` — invoked from
// the `Set API Key` action — can reject the `showWarningMessage` Thenable.
// Precedent: `TalariaViewProvider.ts`'s `openDiffPreview` routes an identical
// shape to its logger via two-argument `.then(undefined, ...)` — `Thenable`
// (unlike a real Promise) has no `.catch`.
describe('TalariaInlineCompletionProvider — M3: showWarningMessage rejection is routed to reportFailure, never unhandled', () => {
  beforeEach(() => {
    clearSurfacedAutocompleteFailures();
    mockShowWarningMessage.mockClear();
    mockExecuteCommand.mockClear();
  });

  it('a rejected showWarningMessage Thenable is reported via reportFailure instead of escaping as an unhandled rejection', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    const reportFailure = vi.fn();
    mockShowWarningMessage.mockRejectedValueOnce(new Error('no UI available on this Fedora box'));
    const provider = makeProvider(engine, undefined, { reportFailure });
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);

    await expect(
      provider.provideInlineCompletionItems(
        doc as unknown as vscode.TextDocument,
        position,
        {
          triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
          selectedCompletionInfo: undefined,
        } as unknown as vscode.InlineCompletionContext,
        fakeToken(),
      ),
    ).resolves.toBeNull();
    // Flush the rejected Thenable's rejection-handler microtask.
    await Promise.resolve();
    await Promise.resolve();

    // reportFailure is called once already for the surfaced 401 warning
    // (`this.reportFailure(message)`) — this asserts a SECOND call carrying
    // the rejection, proving it was routed here rather than lost.
    expect(reportFailure).toHaveBeenCalledWith(
      expect.stringContaining('no UI available on this Fedora box'),
    );
  });
});

// ── F-A (final fix wave): M3 only ever attached a rejection handler to
// `showWarningMessage` itself — the SEPARATE `talaria.setAutocompleteApiKey`
// command promise invoked from inside `onFulfilled` was still `void`-discarded,
// so on a keyring-less Fedora box (the scenario M3's own doc comment names)
// `secrets.store` rejecting vanished silently: no error shown, the key never
// saved, and — because `rebuild()` never re-runs — the Set stays armed and
// every later 401 goes silent forever. This drives the REAL click path
// (`showWarningMessage` resolves to `'Set API Key'` -> `executeCommand`
// rejects) rather than M3's mock (`showWarningMessage` itself rejecting),
// which is the exact distinction the final security review's probe proved.
describe('TalariaInlineCompletionProvider — F-A: a rejected talaria.setAutocompleteApiKey command must reach reportFailure and re-arm the Set', () => {
  beforeEach(() => {
    clearSurfacedAutocompleteFailures();
    mockShowWarningMessage.mockClear();
    mockExecuteCommand.mockClear();
  });

  async function complete(
    provider: TalariaInlineCompletionProvider,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
    const doc = new FakeDocument('getD');
    const position = new vscode.Position(0, 4);
    return provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
      } as unknown as vscode.InlineCompletionContext,
      fakeToken(),
    );
  }

  it('a rejected talaria.setAutocompleteApiKey command (e.g. no keyring on Fedora) is reported via reportFailure instead of vanishing as a discarded `void` promise', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    const reportFailure = vi.fn();
    mockShowWarningMessage.mockResolvedValueOnce('Set API Key');
    mockExecuteCommand.mockRejectedValueOnce(new Error('no keyring available on this Fedora box'));
    const provider = makeProvider(engine, undefined, { reportFailure });

    await expect(complete(provider)).resolves.toBeNull();
    // Flush: showWarningMessage resolves -> onFulfilled calls executeCommand
    // -> executeCommand's promise rejects -> its own rejection handler runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // reportFailure already received one call for the surfaced 401 warning
    // itself — this asserts a SECOND call carrying the command's rejection.
    expect(reportFailure).toHaveBeenCalledWith(
      expect.stringContaining('no keyring available on this Fedora box'),
    );
  });

  it('re-arms the failed key after a failed Set API Key attempt: the SAME 401 surfaces again on the very next completion, not staying silent forever', async () => {
    const engine = new FakeEngine();
    engine.throwError = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    mockShowWarningMessage.mockResolvedValueOnce('Set API Key');
    mockExecuteCommand.mockRejectedValueOnce(new Error('no keyring'));
    const provider = makeProvider(engine);

    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // No explicit clearSurfacedAutocompleteFailures() call here (that only
    // happens on the next config rebuild) — the failed remediation attempt
    // itself must re-arm THIS key, or the user is stranded in permanent
    // silence exactly as the F-A brief's failure scenario describes.
    mockShowWarningMessage.mockResolvedValueOnce(undefined);
    await complete(provider);
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(2);
  });
});
