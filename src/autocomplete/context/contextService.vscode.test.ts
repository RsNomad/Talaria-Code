import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BackendCapabilities, FimTemplate } from '../types';

/**
 * CF-19 / W4-T3 — RED-first guard test for `contextService.vscode.ts`'s
 * keystroke-clock recording site (`textChangeSub`, ~144-146).
 *
 * `contextService.vscode.ts`'s own module doc documents this whole file as
 * "NOT unit tested directly" (a thin `vscode` shell — every real decision
 * lives in the headless `contextService.ts`). This one file is a deliberate,
 * narrow exception: the scheme guard this task adds IS a new decision this
 * shell now makes before ever touching `service.recordKeystroke()`, and
 * CF-19 exists precisely because that decision was previously missing here.
 * `crossFileEnabled: false` is used throughout so `crossFileMode(...)`
 * resolves to `'none'` and `triggerGather()` short-circuits before touching
 * `getCurrentAnchor` (i.e. `vscode.window.activeTextEditor`) — keeping the
 * fake `vscode` module's surface to exactly what this guard touches, same
 * minimal-mock discipline as `context/editTracker.test.ts` and
 * `nextedit/shell.vscode.test.ts`.
 *
 * Observability: `service.recordKeystroke()` has no externally-readable
 * return value, so the guard is proven via `vi.spyOn` on the REAL
 * `CrossFileContextService.prototype.recordKeystroke` — the same production
 * class `contextService.vscode.ts` imports and calls, not a stand-in. This
 * is a spy on real wiring, not a mock of the behavior under test.
 */

interface FakeUri {
  scheme: string;
  toString(): string;
}
interface FakeDocument {
  uri: FakeUri;
  getText(): string;
}
interface FakeChangeEvent {
  document: FakeDocument;
  contentChanges: {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    text: string;
  }[];
}

const mockState: {
  changeHandlers: ((e: FakeChangeEvent) => void)[];
  visibleTextEditors: { document: FakeDocument }[];
} = { changeHandlers: [], visibleTextEditors: [] };

vi.mock('vscode', () => ({
  window: {
    get visibleTextEditors() {
      return mockState.visibleTextEditors;
    },
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    tabGroups: {
      all: [] as unknown[],
      onDidChangeTabs: () => ({ dispose() {} }),
    },
  },
  workspace: {
    textDocuments: [] as FakeDocument[],
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: (cb: (e: FakeChangeEvent) => void) => {
      mockState.changeHandlers.push(cb);
      return { dispose() {} };
    },
    onDidCloseTextDocument: () => ({ dispose() {} }),
    asRelativePath: (uri: FakeUri) => uri.toString(),
  },
  Disposable: {
    from: (...items: { dispose(): void }[]) => ({
      dispose: () => {
        for (const item of items) item.dispose();
      },
    }),
  },
  TabInputText: class FakeTabInputText {},
}));

import { createHermesCrossFileContextService } from './contextService.vscode';
import { CrossFileContextService } from './contextService';

function makeDoc(uri: string, scheme: string): FakeDocument {
  return { uri: { scheme, toString: () => uri }, getText: () => '' };
}

function makeChangeEvent(doc: FakeDocument): FakeChangeEvent {
  return {
    document: doc,
    contentChanges: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'x' },
    ],
  };
}

const capabilities: BackendCapabilities = {
  nativeFim: true,
  assemblesCrossFileServerSide: false,
  streaming: true,
};
const template: FimTemplate = { render: () => '', stop: [] };

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  mockState.changeHandlers = [];
  mockState.visibleTextEditors = [];
  vi.restoreAllMocks();
});

describe('createHermesCrossFileContextService — CF-19 scheme guard on the keystroke-clock recording site', () => {
  it('does NOT call service.recordKeystroke() for an "output"-scheme document change', () => {
    const spy = vi.spyOn(CrossFileContextService.prototype, 'recordKeystroke');
    const { service, disposable } = createHermesCrossFileContextService({
      capabilities,
      template,
      crossFileEnabled: false,
      prefixInjection: false,
      getSkipUntrustedRemote: () => false,
      getEnabled: () => true,
    });
    cleanup = () => disposable.dispose();
    void service; // constructed, not otherwise used in this assertion

    const outputDoc = makeDoc('output:extension-output-talaria', 'output');
    for (const handler of mockState.changeHandlers) {
      handler(makeChangeEvent(outputDoc));
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it('control: DOES call service.recordKeystroke() for an ordinary "file"-scheme document change (the guard is not vacuous)', () => {
    const spy = vi.spyOn(CrossFileContextService.prototype, 'recordKeystroke');
    const { disposable } = createHermesCrossFileContextService({
      capabilities,
      template,
      crossFileEnabled: false,
      prefixInjection: false,
      getSkipUntrustedRemote: () => false,
      getEnabled: () => true,
    });
    cleanup = () => disposable.dispose();

    const fileDoc = makeDoc('file:///home/u/project/a.ts', 'file');
    for (const handler of mockState.changeHandlers) {
      handler(makeChangeEvent(fileDoc));
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('control: DOES call service.recordKeystroke() for an "untitled"-scheme document change', () => {
    const spy = vi.spyOn(CrossFileContextService.prototype, 'recordKeystroke');
    const { disposable } = createHermesCrossFileContextService({
      capabilities,
      template,
      crossFileEnabled: false,
      prefixInjection: false,
      getSkipUntrustedRemote: () => false,
      getEnabled: () => true,
    });
    cleanup = () => disposable.dispose();

    const untitledDoc = makeDoc('untitled:Untitled-1', 'untitled');
    for (const handler of mockState.changeHandlers) {
      handler(makeChangeEvent(untitledDoc));
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('denies "vscode-scm" too (GATE-4 parity)', () => {
    const spy = vi.spyOn(CrossFileContextService.prototype, 'recordKeystroke');
    const { disposable } = createHermesCrossFileContextService({
      capabilities,
      template,
      crossFileEnabled: false,
      prefixInjection: false,
      getSkipUntrustedRemote: () => false,
      getEnabled: () => true,
    });
    cleanup = () => disposable.dispose();

    const scmDoc = makeDoc('vscode-scm:1234', 'vscode-scm');
    for (const handler of mockState.changeHandlers) {
      handler(makeChangeEvent(scmDoc));
    }

    expect(spy).not.toHaveBeenCalled();
  });
});
