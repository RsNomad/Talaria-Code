/*
 * Host-side of the id-correlated request/response path (Part A2).
 *
 * `TalariaViewProvider` receives a webview `control.request`, runs
 * `backend.invokeControl`, and MUST always echo a `control.response` back with
 * the same `requestId` — resolving (ok:true) or rejecting (ok:false), never
 * hanging. This is the responder half of the RpcClient tested in
 * `webview/src/rpc.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { TalariaViewProvider, capSeedText, decideSeedDelivery } from './TalariaViewProvider';
import type { AgentBackend } from './backend/AgentBackend';
import type {
  ContextRef,
  EditPolicyPreset,
  HostToWebviewMessage,
  HydrateTabSeed,
  SlashCommandInfo,
  WebviewToHostMessage,
} from '../shared/protocol';

vi.mock('vscode', () => {
  return {
    window: {
      // Constructor subscribes to theme changes; return a no-op disposable.
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      activeColorTheme: { kind: 2 },
      showWarningMessage: vi.fn(),
      // CF-13/D1: the "Add provider key" masked prompt + status-only error
      // surfacing (mirrors `autocomplete/index.ts`'s `promptAndStoreApiKey`
      // posture, minus the SecretStorage store).
      showInputBox: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    commands: {
      // Resolved by default (matches real `executeCommand`'s Thenable
      // return) — F-3 (final-4way-fixes.md) overrides this per-test with
      // `mockRejectedValueOnce` to prove `openDiffPreview` handles a
      // rejection instead of leaving it unhandled.
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    Uri: {
      joinPath: (...parts: unknown[]) => ({ parts }),
      // W2 T4 (F-D): `TalariaViewProvider.diff.open` builds `talaria-diff:` URIs
      // via `Uri.from({scheme, authority, path})` — a minimal structural
      // stand-in good enough for assertions on the parts it was called with.
      from: (components: { scheme: string; authority?: string; path?: string }) => ({ ...components }),
    },
  };
});

/** A fake `AgentBackend` whose `invokeControl` is scripted per test. */
function makeFakeBackend(
  invokeControl: AgentBackend['invokeControl'] = vi.fn().mockResolvedValue(undefined),
  overrides: Partial<AgentBackend> = {},
): AgentBackend {
  return {
    kind: 'mock',
    onMessage: () => ({ dispose() {} }),
    start: () => {},
    sendPrompt: () => {},
    cancel: () => {},
    respondApproval: () => {},
    resolveDiff: () => {},
    setModel: () => {},
    openTab: async () => {},
    closeTab: () => {},
    invokeControl,
    dispose: () => {},
    ...overrides,
  };
}

/** W2-F1: a fake with the real backend's structural `setPreset`/`getPreset` seam. */
type PresetBackend = AgentBackend & {
  setPreset: (sessionId: string, p: EditPolicyPreset) => void;
  getPreset: () => EditPolicyPreset;
};
function makePresetBackend(initial: EditPolicyPreset): PresetBackend {
  let current = initial;
  return {
    ...makeFakeBackend(),
    setPreset: vi.fn((_sessionId: string, p: EditPolicyPreset) => {
      current = p;
    }),
    getPreset: () => current,
  };
}

/** W2 F-S: a fake with the real backend's structural `getAvailableCommands` seam. */
type CommandsBackend = AgentBackend & {
  getAvailableCommands: () => SlashCommandInfo[] | undefined;
};
function makeCommandsBackend(commands: SlashCommandInfo[] | undefined): CommandsBackend {
  return {
    ...makeFakeBackend(),
    getAvailableCommands: () => commands,
  };
}

/** W6-FF (3-way ARCH I-1): a fake with the real backend's structural `listTabs` seam. */
type TabsBackend = AgentBackend & { listTabs: () => HydrateTabSeed[] };
function makeTabsBackend(tabs: HydrateTabSeed[]): TabsBackend {
  return {
    ...makeFakeBackend(),
    listTabs: () => tabs,
  };
}

function makeProviderWith(backend: AgentBackend): {
  provider: TalariaViewProvider;
  posted: HostToWebviewMessage[];
} {
  const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, backend);
  const posted: HostToWebviewMessage[] = [];
  seam(provider).view = { webview: { postMessage: (m) => posted.push(m) } };
  return { provider, posted };
}

interface ProviderSeam {
  view: { webview: { postMessage: (m: HostToWebviewMessage) => void } } | undefined;
  handleWebviewMessage: (msg: WebviewToHostMessage) => void;
}

function seam(p: TalariaViewProvider): ProviderSeam {
  return p as unknown as ProviderSeam;
}

function makeProvider(invokeControl: AgentBackend['invokeControl']): {
  provider: TalariaViewProvider;
  posted: HostToWebviewMessage[];
} {
  const backend = makeFakeBackend(invokeControl);
  const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, backend);
  const posted: HostToWebviewMessage[] = [];
  seam(provider).view = { webview: { postMessage: (m) => posted.push(m) } };
  return { provider, posted };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TalariaViewProvider — control.request responder (Part A2)', () => {
  it('echoes an ok:true control.response with the invokeControl result and the same requestId', async () => {
    const invokeControl = vi.fn().mockResolvedValue({ tools: [] });
    const { provider, posted } = makeProvider(invokeControl);

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 42,
      method: 'tools.list',
      params: { panel: 'tools' },
    });
    await flush();

    expect(invokeControl).toHaveBeenCalledWith('tools.list', { panel: 'tools' });
    expect(posted).toEqual([{ type: 'control.response', requestId: 42, ok: true, result: { tools: [] } }]);
  });

  it('SEC-4 (audit-3 B-3): redacts credential-shaped fields in a config.show result before posting to the webview', async () => {
    const invokeControl = vi
      .fn()
      .mockResolvedValue({ mcp_servers: [{ name: 'x', env: { API_KEY: 'sk-secret-123' } }], theme: 'dark' });
    const { provider, posted } = makeProvider(invokeControl);

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 9,
      method: 'config.show',
      params: undefined,
    });
    await flush();

    expect(posted).toEqual([
      {
        type: 'control.response',
        requestId: 9,
        ok: true,
        result: { mcp_servers: [{ name: 'x', env: '[redacted]' }], theme: 'dark' },
      },
    ]);
  });

  it('echoes an ok:false control.response carrying the rejection message on the same requestId', async () => {
    const invokeControl = vi.fn().mockRejectedValue(new Error('The agent session is not started yet.'));
    const { provider, posted } = makeProvider(invokeControl);

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 7,
      method: 'panel.data',
      params: { panel: 'mcp' },
    });
    await flush();

    expect(posted).toEqual([
      {
        type: 'control.response',
        requestId: 7,
        ok: false,
        error: { message: 'The agent session is not started yet.' },
      },
    ]);
  });

  it('carries the correlated checkpoint.restore result back on the response (reference migration)', async () => {
    const invokeControl = vi.fn().mockResolvedValue({ restored: false, reason: 'worktree dirty' });
    const { provider, posted } = makeProvider(invokeControl);

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 3,
      method: 'checkpoint.restore',
      params: { id: 'ckpt-1' },
    });
    await flush();

    expect(invokeControl).toHaveBeenCalledWith('checkpoint.restore', { id: 'ckpt-1' });
    expect(posted).toEqual([
      { type: 'control.response', requestId: 3, ok: true, result: { restored: false, reason: 'worktree dirty' } },
    ]);
  });
});

describe('TalariaViewProvider — W2 T2d: context.searchFiles wiring', () => {
  function makeProviderWithSearch(searchFiles?: (query: string, maxResults: number) => Promise<string[]>): {
    provider: TalariaViewProvider;
    posted: HostToWebviewMessage[];
    invokeControl: AgentBackend['invokeControl'];
  } {
    const invokeControl = vi.fn().mockResolvedValue(undefined);
    const backend = makeFakeBackend(invokeControl);
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, backend, undefined, searchFiles);
    const posted: HostToWebviewMessage[] = [];
    seam(provider).view = { webview: { postMessage: (m) => posted.push(m) } };
    return { provider, posted, invokeControl };
  }

  it('answers from the injected searchFiles port, never forwarding to backend.invokeControl', async () => {
    const searchFiles = vi.fn().mockResolvedValue(['/repo/src/a.ts', '/repo/src/b.ts']);
    const { provider, posted, invokeControl } = makeProviderWithSearch(searchFiles);

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 1,
      method: 'context.searchFiles',
      params: { query: 'a', maxResults: 10 },
    });
    await flush();

    expect(searchFiles).toHaveBeenCalledWith('a', 10);
    expect(invokeControl).not.toHaveBeenCalled();
    expect(posted).toEqual([
      { type: 'control.response', requestId: 1, ok: true, result: ['/repo/src/a.ts', '/repo/src/b.ts'] },
    ]);
  });

  it('answers an honest empty list when no searchFiles port is wired (mock/untrusted path)', async () => {
    const { provider, posted, invokeControl } = makeProviderWithSearch(undefined);

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 2,
      method: 'context.searchFiles',
      params: { query: 'a' },
    });
    await flush();

    expect(invokeControl).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: 'control.response', requestId: 2, ok: true, result: [] }]);
  });

  it('setSearchFiles rewires the source at runtime (the mock→real trust-upgrade path)', async () => {
    const { provider, posted } = makeProviderWithSearch(undefined);
    const upgraded = vi.fn().mockResolvedValue(['/repo/only.ts']);

    provider.setSearchFiles(upgraded);
    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 3,
      method: 'context.searchFiles',
      params: {},
    });
    await flush();

    expect(upgraded).toHaveBeenCalledWith('', 50);
    expect(posted).toEqual([{ type: 'control.response', requestId: 3, ok: true, result: ['/repo/only.ts'] }]);
  });
});

describe('TalariaViewProvider — W2-F1 edit-policy preset routing', () => {
  it('routes policy.setPreset to a preset-capable backend', () => {
    const backend = makePresetBackend('manual');
    const { provider } = makeProviderWith(backend);

    seam(provider).handleWebviewMessage({ type: 'policy.setPreset', sessionId: 'sess-1', preset: 'strict' });

    expect(backend.setPreset).toHaveBeenCalledWith('sess-1', 'strict');
  });

  it('ignores policy.setPreset when the backend has no policy engine (mock)', () => {
    // A plain fake lacks setPreset/getPreset — routing must no-op, never throw.
    const { provider } = makeProviderWith(makeFakeBackend());
    expect(() =>
      seam(provider).handleWebviewMessage({ type: 'policy.setPreset', sessionId: 'sess-1', preset: 'normal' }),
    ).not.toThrow();
  });

  it('seeds the bootstrap hydrate state with the backend live preset (C4)', () => {
    const { provider, posted } = makeProviderWith(makePresetBackend('normal'));

    // `ready` re-seeds + posts hydrate (same seedState() used on resolveWebviewView).
    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate).toBeDefined();
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.preset).toBe('normal');
  });

  // P7-N10: the `setMode` wire message + its clamp-to-'default' handler were
  // YAGNI-deleted (a sessionId-less fan-out footgun the current webview
  // never actually sent). `WebviewToHostMessage` no longer declares this
  // shape at all, so a real stale/legacy sender is simulated with an
  // explicit cast (mirrors how it would actually arrive: untyped JSON over
  // `postMessage`, not something the CURRENT webview bundle can construct).
  it('P7-N10: a legacy setMode message (the retired wire type) is safely ignored, not routed to the backend', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());

    expect(() =>
      seam(provider).handleWebviewMessage(
        { type: 'setMode', mode: 'accept_edits' } as unknown as WebviewToHostMessage,
      ),
    ).not.toThrow();

    expect(posted).toEqual([]);
  });
});

describe('TalariaViewProvider — D2 (A2): mock/real backend badge', () => {
  it('seeds the bootstrap hydrate state with the backend kind', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());

    // `ready` re-seeds + posts hydrate (same seedState() used on resolveWebviewView).
    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate).toBeDefined();
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.backendKind).toBe('mock');
  });

  it('setBackend (the trust-upgrade mock->acp swap) posts a connection-global backend.state push, never a re-hydrate', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());
    seam(provider).handleWebviewMessage({ type: 'ready' });
    posted.length = 0; // only the swap's own output matters below

    const acpBackend: AgentBackend = { ...makeFakeBackend(), kind: 'acp' };
    provider.setBackend(acpBackend);

    expect(posted).toContainEqual({ type: 'backend.state', kind: 'acp' });
    // The memo/brief are explicit: re-posting `hydrate` here would yank the
    // user's panel (seedState() hardcodes activePanel:'chat') — the swap
    // must stay a scalar push, never a re-hydrate.
    expect(posted.some((m) => m.type === 'hydrate')).toBe(false);
  });
});

/** W4-T4b (SF-2): a fake with the real backend's structural `setCustomMode` seam. */
type CustomModeBackend = AgentBackend & {
  setCustomMode: (sessionId: string, modeId: string | null) => void;
};
function makeCustomModeBackend(setCustomMode = vi.fn()): CustomModeBackend {
  return { ...makeFakeBackend(), setCustomMode };
}

describe('TalariaViewProvider — SF-2 (T4b): mode.set routing', () => {
  it('routes mode.set to a custom-mode-capable backend', () => {
    const backend = makeCustomModeBackend();
    const { provider } = makeProviderWith(backend);

    seam(provider).handleWebviewMessage({ type: 'mode.set', sessionId: 'sess-1', modeId: 'docs-only' });

    expect(backend.setCustomMode).toHaveBeenCalledWith('sess-1', 'docs-only');
  });

  it('routes a mode.set clear (modeId: null) through unchanged', () => {
    const backend = makeCustomModeBackend();
    const { provider } = makeProviderWith(backend);

    seam(provider).handleWebviewMessage({ type: 'mode.set', sessionId: 'sess-1', modeId: null });

    expect(backend.setCustomMode).toHaveBeenCalledWith('sess-1', null);
  });

  it('ignores mode.set when the backend has no custom-mode engine (mock) — no-op, never throws', () => {
    // A plain fake lacks setCustomMode — routing must no-op, never throw (MockBackend has none).
    const { provider } = makeProviderWith(makeFakeBackend());
    expect(() =>
      seam(provider).handleWebviewMessage({ type: 'mode.set', sessionId: 'sess-1', modeId: 'docs-only' }),
    ).not.toThrow();
  });
});

/** W4-T5b: a fake with the real backend's structural `loadTab` seam. */
type LoadTabBackend = AgentBackend & {
  loadTab: (tabId: string, sessionId: string, cwd: string) => Promise<void>;
};
function makeLoadTabBackend(loadTab = vi.fn().mockResolvedValue(undefined)): LoadTabBackend {
  return { ...makeFakeBackend(), loadTab };
}

describe('TalariaViewProvider — W4-T5b: tab.load routing (§2d wire, not a CONTROL_METHODS entry)', () => {
  it('routes tab.load to a loadTab-capable backend with {tabId, sessionId, cwd}', () => {
    const backend = makeLoadTabBackend();
    const { provider } = makeProviderWith(backend);

    seam(provider).handleWebviewMessage({ type: 'tab.load', tabId: 'tab-2', sessionId: 'sess-9', cwd: '/ws' });

    expect(backend.loadTab).toHaveBeenCalledWith('tab-2', 'sess-9', '/ws');
  });

  it('ignores tab.load when the backend has no loadTab support (mock) — no-op, never throws', () => {
    // A plain fake lacks loadTab — routing must no-op, never throw (MockBackend has none).
    const { provider } = makeProviderWith(makeFakeBackend());
    expect(() =>
      seam(provider).handleWebviewMessage({ type: 'tab.load', tabId: 'tab-2', sessionId: 'sess-9', cwd: '/ws' }),
    ).not.toThrow();
  });

  it('a rejecting loadTab is logged, never becomes an unhandled rejection', async () => {
    const backend = makeLoadTabBackend(vi.fn().mockRejectedValue(new Error('boom')));
    const { provider } = makeProviderWith(backend);

    expect(() =>
      seam(provider).handleWebviewMessage({ type: 'tab.load', tabId: 'tab-2', sessionId: 'sess-9', cwd: '/ws' }),
    ).not.toThrow();
    await flush();
  });
});

describe('TalariaViewProvider — W2 T2c: prompt routing threads @-mentions through to the backend', () => {
  it("passes message.mentions through verbatim as sendPrompt's 4th argument", () => {
    const sendPrompt = vi.fn();
    const { provider } = makeProviderWith(makeFakeBackend(undefined, { sendPrompt }));
    const mentions: ContextRef[] = [{ id: 'ref-1', kind: 'file', path: '/repo/a.ts' }];

    seam(provider).handleWebviewMessage({ type: 'prompt', sessionId: 'sess-1', text: 'hello', mode: 'default', mentions });

    expect(sendPrompt).toHaveBeenCalledWith('sess-1', 'hello', 'default', undefined, mentions);
  });

  it('passes mentions as undefined when the webview sends none (no regression for plain prompts)', () => {
    const sendPrompt = vi.fn();
    const { provider } = makeProviderWith(makeFakeBackend(undefined, { sendPrompt }));

    seam(provider).handleWebviewMessage({ type: 'prompt', sessionId: 'sess-1', text: 'hello', mode: 'default' });

    expect(sendPrompt).toHaveBeenCalledWith('sess-1', 'hello', 'default', undefined, undefined);
  });
});

describe('TalariaViewProvider — W2 F-S: available_commands hydrate carry', () => {
  it('seeds the bootstrap hydrate state with the backend cached catalog (a re-created view gets it without an adapter replay)', () => {
    const commands: SlashCommandInfo[] = [{ name: 'help', description: 'Show help' }];
    const { provider, posted } = makeProviderWith(makeCommandsBackend(commands));

    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate).toBeDefined();
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.availableCommands).toEqual(commands);
  });

  it('omits availableCommands (undefined) when the backend has no catalog yet', () => {
    const { provider, posted } = makeProviderWith(makeCommandsBackend(undefined));

    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.availableCommands).toBeUndefined();
  });

  it('omits availableCommands when the active backend has no commands seam at all (mock)', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());

    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.availableCommands).toBeUndefined();
  });
});

describe('TalariaViewProvider — W6-FF (3-way ARCH I-1): hydrate carries the live tab list (re-create no-orphan)', () => {
  it('seeds hydrate.state.tabs from a tabs-capable backend\'s live registry', () => {
    const seed: HydrateTabSeed[] = [
      { tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' },
      { tabId: 'tab-b', sessionId: 'sB', cwd: '/root-b', rootId: '/root-b', preset: 'strict' },
    ];
    const { provider, posted } = makeProviderWith(makeTabsBackend(seed));

    // `ready` re-seeds + posts hydrate — the SAME seedState() a webview
    // re-create's fresh `ready` triggers (R-C4).
    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate).toBeDefined();
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.tabs).toEqual(seed);
  });

  it('omits tabs (undefined) when the registry is empty — a genuine cold boot has nothing to reconcile', () => {
    const { provider, posted } = makeProviderWith(makeTabsBackend([]));

    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.tabs).toBeUndefined();
  });

  it('omits tabs when the active backend has no tab-list seam at all (mock)', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());

    seam(provider).handleWebviewMessage({ type: 'ready' });

    const hydrate = posted.find((m) => m.type === 'hydrate');
    expect(hydrate && hydrate.type === 'hydrate' && hydrate.state.tabs).toBeUndefined();
  });
});

describe('TalariaViewProvider — R-C4: ready arms the backend ONCE (no live-session replacement)', () => {
  it('a second ready does not call backend.start() again', () => {
    const start = vi.fn();
    const backend = makeFakeBackend(undefined, { start });
    const { provider } = makeProviderWith(backend);

    seam(provider).handleWebviewMessage({ type: 'ready' });
    seam(provider).handleWebviewMessage({ type: 'ready' }); // view re-created

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('newSession still restarts deliberately after ready', () => {
    const start = vi.fn();
    const backend = makeFakeBackend(undefined, { start });
    const { provider } = makeProviderWith(backend);

    seam(provider).handleWebviewMessage({ type: 'ready' });
    provider.newSession();

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a REJECTED first start clears the latch so the next ready retries', async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValue(undefined);
    const backend = makeFakeBackend(undefined, { start });
    const { provider } = makeProviderWith(backend);

    seam(provider).handleWebviewMessage({ type: 'ready' });
    await Promise.resolve(); // let the rejection settle
    await Promise.resolve();
    seam(provider).handleWebviewMessage({ type: 'ready' });

    expect(start).toHaveBeenCalledTimes(2);
  });
});

/**
 * T-1 (V-12 RESTART-STATE): `newSession()`/`setBackend()` used to post
 * `{type:'clear', sessionId:'pending-session'}` BEFORE the coming
 * `startBackend()` — `PENDING_SESSION_PLACEHOLDER`, a dead-letter the
 * webview's `foldSessionScoped` drop-unknown routing has ALWAYS discarded
 * (no tab is ever bound to the literal string `'pending-session'`), so
 * "New Session" cleared nothing and the fresh bootstrap transcript appended
 * BELOW the old conversation. The fix retires the placeholder entirely —
 * transcript honesty on restart is now the ACP backend's own job (the
 * `ConnectionSupervisor` restart fan-out), not a host-side guess emitted
 * before the backend has even chosen a new session id.
 */
describe('TalariaViewProvider — T-1 (V-12 RESTART-STATE): the retired PENDING_SESSION_PLACEHOLDER dead-letter', () => {
  it('grep-level lock: the source never mentions the retired "pending-session" placeholder id again', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'TalariaViewProvider.ts'), 'utf8');

    expect(source).not.toContain('pending-session');
  });

  it('newSession() never posts a clear carrying the dead-letter placeholder id', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());

    provider.newSession();

    expect(posted.some((m) => m.type === 'clear' && m.sessionId === 'pending-session')).toBe(false);
  });

  it('setBackend() (an already-open view) never posts a clear carrying the dead-letter placeholder id', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend()); // view already resolved via makeProviderWith's seam

    provider.setBackend(makeFakeBackend());

    expect(posted.some((m) => m.type === 'clear' && m.sessionId === 'pending-session')).toBe(false);
  });
});

describe('capSeedText — pure 64 KB seed-text cap (§2e)', () => {
  it('passes short text through unchanged', () => {
    expect(capSeedText('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('leaves text exactly AT the byte cap unchanged', () => {
    const text = 'a'.repeat(10);
    expect(capSeedText(text, 10)).toEqual({ text, truncated: false });
  });

  it('truncates text over the cap and marks truncated:true', () => {
    const text = 'a'.repeat(20);
    const result = capSeedText(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('a'.repeat(10))).toBe(true);
  });

  it('appends a human-readable truncation notice', () => {
    const result = capSeedText('a'.repeat(20), 10);
    expect(result.text).toMatch(/truncated/i);
  });

  it('measures bytes, not JS string length (multi-byte UTF-8 chars)', () => {
    // Each '€' is 3 UTF-8 bytes — 5 chars = 15 bytes, over a 10-byte cap.
    const text = '€'.repeat(5);
    const result = capSeedText(text, 10);
    expect(result.truncated).toBe(true);
  });

  it('defaults the cap to 64 KB when unspecified', () => {
    const justUnder = 'a'.repeat(64 * 1024);
    const justOver = 'a'.repeat(64 * 1024 + 1);
    expect(capSeedText(justUnder).truncated).toBe(false);
    expect(capSeedText(justOver).truncated).toBe(true);
  });
});

describe('decideSeedDelivery — pure pending-seed latch decision (§2e)', () => {
  it('posts immediately when the webview is live', () => {
    expect(decideSeedDelivery(true)).toBe('post');
  });

  it('latches when the webview is not live yet', () => {
    expect(decideSeedDelivery(false)).toBe('latch');
  });
});

describe('TalariaViewProvider — W2 T3: seedComposer (§2e pending-seed latch)', () => {
  function composerSeedMessages(posted: HostToWebviewMessage[]): HostToWebviewMessage[] {
    return posted.filter((m) => m.type === 'composer.seed');
  }

  it('posts composer.seed IMMEDIATELY when the webview is already live (ready already received)', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());
    seam(provider).handleWebviewMessage({ type: 'ready' });

    provider.seedComposer({ text: 'Explain this.', mentions: [] });

    expect(composerSeedMessages(posted)).toEqual([
      { type: 'composer.seed', text: 'Explain this.', mentions: [] },
    ]);
  });

  it('LATCHES the seed when the view exists but ready has not fired yet, delivering it once ready arrives', () => {
    const { provider, posted } = makeProviderWith(makeFakeBackend());

    provider.seedComposer({ text: 'Improve this.' });
    expect(composerSeedMessages(posted)).toEqual([]); // not delivered yet — latched

    seam(provider).handleWebviewMessage({ type: 'ready' });
    expect(composerSeedMessages(posted)).toEqual([
      { type: 'composer.seed', text: 'Improve this.', mentions: undefined },
    ]);
  });

  it('cold-activation race: with NO view at all, latches + reveals via the view-focus command, delivering once the view attaches and sends ready', () => {
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();
    const backend = makeFakeBackend();
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, backend);
    // Deliberately NOT attaching a view — simulates the command firing before
    // the panel has ever been opened/resolved this session.

    provider.seedComposer({ text: 'Add this.' });

    expect(executeCommand).toHaveBeenCalledWith(`${TalariaViewProvider.viewId}.focus`);

    // The view now resolves (user's panel opens) and the webview announces ready.
    const posted: HostToWebviewMessage[] = [];
    seam(provider).view = { webview: { postMessage: (m) => posted.push(m) } };
    seam(provider).handleWebviewMessage({ type: 'ready' });

    expect(composerSeedMessages(posted)).toEqual([
      { type: 'composer.seed', text: 'Add this.', mentions: undefined },
    ]);
  });

  it('never triggers backend.sendPrompt — a seed only ever posts composer.seed (review-first: no auto-submit)', () => {
    const sendPrompt = vi.fn();
    const { provider, posted } = makeProviderWith(makeFakeBackend(undefined, { sendPrompt }));
    seam(provider).handleWebviewMessage({ type: 'ready' });

    provider.seedComposer({ text: 'Add this.' });

    // `posted` only ever carries HostToWebviewMessage — `prompt` is a
    // webview->host message and can never appear here by construction; the
    // real lock is that seedComposer's ONLY effect is a `composer.seed` push
    // and it never reaches into `backend.sendPrompt`.
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(composerSeedMessages(posted)).toHaveLength(1);
  });

  it('caps an oversized seed at 64 KB and warns the user', () => {
    const showWarningMessage = vi.mocked(vscode.window.showWarningMessage);
    showWarningMessage.mockClear();
    const { provider, posted } = makeProviderWith(makeFakeBackend());
    seam(provider).handleWebviewMessage({ type: 'ready' });

    provider.seedComposer({ text: 'a'.repeat(64 * 1024 + 100) });

    const [seedMsg] = composerSeedMessages(posted);
    expect(seedMsg && seedMsg.type === 'composer.seed' && seedMsg.text.length).toBeLessThan(64 * 1024 + 100);
    expect(showWarningMessage).toHaveBeenCalled();
  });

  it('reveals an already-resolved view via show(true) rather than the focus command', () => {
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();
    const show = vi.fn();
    const { provider } = makeProviderWith(makeFakeBackend());
    seam(provider).handleWebviewMessage({ type: 'ready' });
    (seam(provider) as unknown as { view: { show: typeof show } }).view.show = show;

    provider.seedComposer({ text: 'Add this.' });

    expect(show).toHaveBeenCalledWith(true);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe('TalariaViewProvider — W2 T4 F-D: diff.open routing', () => {
  it('opens both talaria-diff: virtual sides via vscode.diff, titled as a pending-approval preview', () => {
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();
    const { provider } = makeProviderWith(makeFakeBackend());

    seam(provider).handleWebviewMessage({
      type: 'diff.open',
      sessionId: 'session-1',
      toolId: 'tool-1',
      path: 'src/a.ts',
    });

    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ scheme: 'talaria-diff', authority: 'before', path: '/session-1/tool-1/src/a.ts' }),
      expect.objectContaining({ scheme: 'talaria-diff', authority: 'after', path: '/session-1/tool-1/src/a.ts' }),
      'a.ts (proposed by Talaria — pending approval)',
      { preview: true },
    );
  });

  it('titles the diff with the basename only, even for a deeply nested path', () => {
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();
    const { provider } = makeProviderWith(makeFakeBackend());

    seam(provider).handleWebviewMessage({
      type: 'diff.open',
      sessionId: 'session-1',
      toolId: 'tool-2',
      path: 'src/deep/nested/file.ts',
    });

    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ path: '/session-1/tool-2/src/deep/nested/file.ts' }),
      expect.objectContaining({ path: '/session-1/tool-2/src/deep/nested/file.ts' }),
      'file.ts (proposed by Talaria — pending approval)',
      { preview: true },
    );
  });

  it('F-3 (final-4way-fixes.md): a rejected vscode.diff is logged via the same [tag] appendLine pattern every other command dispatch in this file uses, instead of becoming an unhandled rejection', async () => {
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();
    executeCommand.mockRejectedValueOnce(new Error('no diff content provider registered'));
    const logger = { appendLine: vi.fn() } as unknown as vscode.OutputChannel;
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, makeFakeBackend(), logger);
    seam(provider).view = { webview: { postMessage: () => {} } };

    seam(provider).handleWebviewMessage({
      type: 'diff.open',
      sessionId: 'session-1',
      toolId: 'tool-1',
      path: 'src/a.ts',
    });
    await flush();

    expect(logger.appendLine).toHaveBeenCalledWith(
      '[diff.open] Error: no diff content provider registered',
    );
  });
});

/** A minimal fake `vscode.WebviewView` — enough surface for
 * `resolveWebviewView` to run end to end (options/html/onDidReceiveMessage/
 * onDidDispose), with `fireDispose()` exposed so a test can simulate VS
 * Code's memory-pressure dispose without a reopen. */
function makeFakeWebviewView(posted: HostToWebviewMessage[]): {
  view: {
    webview: {
      options?: unknown;
      html?: string;
      cspSource: string;
      asWebviewUri: (uri: unknown) => unknown;
      onDidReceiveMessage: (cb: (msg: WebviewToHostMessage) => void) => { dispose(): void };
      postMessage: (m: HostToWebviewMessage) => void;
    };
    onDidDispose: (cb: () => void) => { dispose(): void };
  };
  fireDispose: () => void;
} {
  let disposeCb: (() => void) | undefined;
  const view = {
    webview: {
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (m: HostToWebviewMessage) => {
        posted.push(m);
      },
    },
    onDidDispose: (cb: () => void) => {
      disposeCb = cb;
      return { dispose() {} };
    },
  };
  return { view, fireDispose: () => disposeCb?.() };
}

describe('TalariaViewProvider — T3 review Minor (deliverable 8): onDidDispose latches instead of leaving a stale live view', () => {
  it('a memory-pressure dispose (no reopen) clears view + isWebviewLive; a seedComposer that arrives in that window LATCHES and is delivered once a fresh view is resolved and ready', () => {
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, makeFakeBackend());

    const posted1: HostToWebviewMessage[] = [];
    const { view: view1, fireDispose } = makeFakeWebviewView(posted1);
    provider.resolveWebviewView(view1 as never, {} as never, {} as never);
    seam(provider).handleWebviewMessage({ type: 'ready' }); // isWebviewLive -> true
    posted1.length = 0;

    fireDispose(); // BEFORE the fix: this left `view`/`isWebviewLive` stale.

    provider.seedComposer({ text: 'seeded while the view was dead' });

    // The (correctly) cleared view means nothing was posted to the dead view1
    // — a stuck-true isWebviewLive would have posted straight into it instead
    // of latching (the exact silent-drop class T3's latch exists to prevent).
    expect(posted1.some((m) => m.type === 'composer.seed')).toBe(false);

    // VS Code eventually re-resolves a fresh view; its webview re-announces ready.
    const posted2: HostToWebviewMessage[] = [];
    const { view: view2 } = makeFakeWebviewView(posted2);
    provider.resolveWebviewView(view2 as never, {} as never, {} as never);
    seam(provider).handleWebviewMessage({ type: 'ready' });

    const seedMsg = posted2.find((m) => m.type === 'composer.seed');
    expect(seedMsg).toMatchObject({ type: 'composer.seed', text: 'seeded while the view was dead' });
  });
});

/*
 * ── W5.1 Task 13 (R5): the host-internal `nextEdit.toggle` correlated request ──
 *
 * The NEXT/Generic toggles are EXTENSION state (the Guard's `globalState`
 * store), not Hermes config — so `nextEdit.toggle` is special-cased in this
 * router BEFORE backend dispatch (the `'panel.data'`/`'context.searchFiles'`
 * precedent) and must NEVER reach `AgentBackend.invokeControl`. Forwarding it
 * would ask the agent to persist a setting it does not own and cannot know
 * about.
 *
 * `invokeControl` here is a PLAIN recording function, not a `vi.fn()`: the
 * "never forwarded" claim is asserted against a real call log (the
 * `AcpBackend.test.ts` `dispatchCalls` idiom), so the assertion cannot be
 * vacuous.
 */

/** The Guard's frozen refusal copy (`nextedit/guard.ts` REFUSAL_MESSAGES). */
const REFUSE_GENERIC = 'Next Edit: turn off NEXT first — the two sources are mutually exclusive.';

interface RecordedInvoke {
  calls: Array<{ method: string; params: unknown }>;
  invokeControl: AgentBackend['invokeControl'];
}

function recordingInvokeControl(): RecordedInvoke {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    invokeControl: ((method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(undefined);
    }) as AgentBackend['invokeControl'],
  };
}

/**
 * A stand-in for the real port (`requestNextEditToggle` over the hydrated
 * Guard): mutually-exclusive accept/refuse, notify-then-resolve ordering, and
 * a rejection carrying the Guard's warning string verbatim — the three
 * behaviours the router is wired against.
 */
function makeFakeTogglePort(initial: { next: boolean; generic: boolean }) {
  let state = initial;
  const listeners = new Set<(s: { next: boolean; generic: boolean }) => void>();
  const requests: Array<{ source: string; on: boolean }> = [];
  return {
    requests,
    current: () => state,
    port: {
      request(source: 'next' | 'generic', on: boolean) {
        requests.push({ source, on });
        const conflict = source === 'next' ? state.generic : state.next;
        if (on && conflict) return Promise.reject(new Error(REFUSE_GENERIC));
        state = source === 'next' ? { next: on, generic: state.generic } : { next: state.next, generic: on };
        // The Guard notifies BEFORE resolving (`applyOne`: notify(); return).
        for (const l of [...listeners]) l(state);
        return Promise.resolve(state);
      },
      getState: () => state,
      onDidChange(l: (s: { next: boolean; generic: boolean }) => void) {
        listeners.add(l);
        return { dispose: () => { listeners.delete(l); } };
      },
    },
  };
}

function makeProviderWithTogglePort(initial: { next: boolean; generic: boolean }) {
  const { calls, invokeControl } = recordingInvokeControl();
  const backend = makeFakeBackend(invokeControl);
  const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, backend);
  const posted: HostToWebviewMessage[] = [];
  seam(provider).view = { webview: { postMessage: (m) => posted.push(m) } };
  const fake = makeFakeTogglePort(initial);
  provider.setNextEditToggles(fake.port);
  return { provider, posted, calls, fake };
}

describe('TalariaViewProvider — nextEdit.toggle is HOST-INTERNAL (R5, Task 13)', () => {
  it('an accepted toggle answers ok:true with the NEW state and never forwards to backend.invokeControl', async () => {
    const { provider, posted, calls, fake } = makeProviderWithTogglePort({ next: false, generic: false });
    posted.length = 0;

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 11,
      method: 'nextEdit.toggle',
      params: { source: 'next', on: true },
    } as never);
    await flush();

    expect(fake.requests).toEqual([{ source: 'next', on: true }]);
    // THE assertion this test exists for: the toggles are extension state,
    // so the agent must never have been asked about them.
    expect(calls).toEqual([]);
    expect(posted).toContainEqual({
      type: 'control.response',
      requestId: 11,
      ok: true,
      result: { next: true, generic: false },
    });
  });

  it('every ACCEPTED toggle is followed by a nextEdit.state push carrying the ratified state', async () => {
    const { provider, posted } = makeProviderWithTogglePort({ next: false, generic: false });
    posted.length = 0;

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 12,
      method: 'nextEdit.toggle',
      params: { source: 'generic', on: true },
    } as never);
    await flush();

    expect(posted).toContainEqual({ type: 'nextEdit.state', state: { next: false, generic: true } });
  });

  it('a REFUSAL answers ok:false with the Guard warning verbatim, pushes no state, and still never reaches the backend', async () => {
    const { provider, posted, calls } = makeProviderWithTogglePort({ next: true, generic: false });
    posted.length = 0;

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 13,
      method: 'nextEdit.toggle',
      params: { source: 'generic', on: true },
    } as never);
    await flush();

    expect(calls).toEqual([]);
    expect(posted).toEqual([
      { type: 'control.response', requestId: 13, ok: false, error: { message: REFUSE_GENERIC } },
    ]);
  });

  it('pushes nextEdit.state on webview mount (ready), so a (re)mounted panel never renders a guessed toggle', () => {
    const { provider, posted } = makeProviderWithTogglePort({ next: false, generic: true });
    posted.length = 0;

    seam(provider).handleWebviewMessage({ type: 'ready' });

    expect(posted).toContainEqual({ type: 'nextEdit.state', state: { next: false, generic: true } });
  });

  it('fails CLOSED on malformed params (a compromised webview can send any shape) — no toggle attempted, nothing forwarded', async () => {
    const { provider, posted, calls, fake } = makeProviderWithTogglePort({ next: false, generic: false });
    posted.length = 0;

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 14,
      method: 'nextEdit.toggle',
      params: { source: 'both', on: 'yes' },
    } as never);
    await flush();

    expect(fake.requests).toEqual([]);
    expect(calls).toEqual([]);
    const reply = posted.find((m) => m.type === 'control.response');
    expect(reply).toMatchObject({ requestId: 14, ok: false });
  });

  it('answers honestly (ok:false) when no toggle port is wired yet — never forwards the orphan request to the agent', async () => {
    const { calls, invokeControl } = recordingInvokeControl();
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, makeFakeBackend(invokeControl));
    const posted: HostToWebviewMessage[] = [];
    seam(provider).view = { webview: { postMessage: (m) => posted.push(m) } };

    seam(provider).handleWebviewMessage({
      type: 'control.request',
      requestId: 15,
      method: 'nextEdit.toggle',
      params: { source: 'next', on: true },
    } as never);
    await flush();

    expect(calls).toEqual([]);
    expect(posted.find((m) => m.type === 'control.response')).toMatchObject({ requestId: 15, ok: false });
  });
});

/*
 * ── F11: ErrorBoundary Reload → host-driven `webview.html` re-assign ──
 *
 * The webview's ErrorBoundary fallback used to call `window.location.reload()`
 * directly — unverified/unreliable inside a VS Code webview iframe. The
 * documented recovery instead posts a `webviewToHost` `reload` message; this
 * provider re-assigns `webview.html` through the SAME `buildHtml` path
 * `resolveWebviewView` itself uses (fresh CSPRNG nonce, same CSP policy, same
 * script/style URIs) — never a weaker/ad hoc rebuild.
 *
 * `makeFakeWebviewView` (below) is the ONLY fake in this file whose `webview`
 * carries `asWebviewUri`/`cspSource`, i.e. enough surface for `buildHtml` to
 * actually run — the plain `{ postMessage }` stub `seam(...).view = ...` uses
 * everywhere else is NOT enough here, deliberately: proving re-assignment
 * requires observing a real `buildHtml()` output, not just that some field
 * changed.
 */
describe('TalariaViewProvider — F11 ErrorBoundary Reload (host-driven webview.html re-assign)', () => {
  it('re-assigns webview.html via the same nonce/html-builder path as the initial resolveWebviewView', () => {
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, makeFakeBackend());
    const posted: HostToWebviewMessage[] = [];
    const { view } = makeFakeWebviewView(posted);
    provider.resolveWebviewView(view as never, {} as never, {} as never);

    const htmlAfterInitialResolve = view.webview.html;
    expect(htmlAfterInitialResolve).toBeTruthy();

    seam(provider).handleWebviewMessage({ type: 'reload' });

    // getNonce() is a 128-bit CSPRNG (node:crypto randomBytes) minted fresh on
    // every buildHtml() call — a genuine re-assignment through the SAME
    // builder therefore produces a DIFFERENT html string. Equal html here
    // would mean the message was ignored (fell through to the unhandled-
    // message default), not that recovery happened.
    expect(view.webview.html).toBeTruthy();
    expect(view.webview.html).not.toBe(htmlAfterInitialResolve);
    // Sanity: still the real CSP-guarded document, not some other payload.
    expect(view.webview.html).toContain('Content-Security-Policy');
    expect(view.webview.html).toContain("script-src 'nonce-");
  });

  it('is a no-op — never throws — when no view is currently resolved (view torn down between fallback render and message arrival)', () => {
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, makeFakeBackend());

    expect(() => seam(provider).handleWebviewMessage({ type: 'reload' })).not.toThrow();
  });

  it('re-closes the isWebviewLive latch (MINOR-1): a seedComposer arriving in the reload window LATCHES instead of posting into the mid-reload webview', () => {
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, makeFakeBackend());
    const posted: HostToWebviewMessage[] = [];
    const { view } = makeFakeWebviewView(posted);
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    seam(provider).handleWebviewMessage({ type: 'ready' }); // isWebviewLive -> true
    posted.length = 0;

    seam(provider).handleWebviewMessage({ type: 'reload' }); // re-closes the latch
    provider.seedComposer({ text: 'seeded during reload' });

    // The reload re-closed isWebviewLive, so the seed LATCHES for the next
    // `ready` rather than posting straight into the mid-reload (dropping)
    // webview — the same silent-drop class the dispose-window test guards.
    // (Without the `isWebviewLive = false` in reloadWebview this posts here.)
    expect(posted.some((m) => m.type === 'composer.seed')).toBe(false);

    // Once the re-mounted tree re-announces ready, the latched seed flushes.
    seam(provider).handleWebviewMessage({ type: 'ready' });
    expect(posted.some((m) => m.type === 'composer.seed')).toBe(true);
  });
});

/**
 * CF-13/D1: the "Add provider key" wiring. The webview posts ONLY
 * `{type:'model.addKey', slug}` (no key) — the host prompts for the key
 * directly (masked) and dispatches `model.save_key({slug, api_key})`.
 * SECRET DISCIPLINE is load-bearing here: the entered key must never be
 * logged and never stored by the extension (the harness owns it,
 * persisting to `~/.hermes/.env` — no SecretStorage, no connect re-assert).
 */
describe('TalariaViewProvider — CF-13/D1: model.addKey ("Add provider key")', () => {
  const mockShowInputBox = vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>;
  const mockShowWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
  const mockShowErrorMessage = vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockShowInputBox.mockReset();
    mockShowWarningMessage.mockClear();
    mockShowErrorMessage.mockClear();
  });

  it('a cancelled prompt (showInputBox resolves undefined) is a no-op — never dispatches model.save_key', async () => {
    mockShowInputBox.mockResolvedValueOnce(undefined);
    const invokeControl = vi.fn().mockResolvedValue({ provider: {} });
    const { provider } = makeProviderWith(makeFakeBackend(invokeControl));

    seam(provider).handleWebviewMessage({ type: 'model.addKey', slug: 'deepseek' });
    await flush();

    expect(invokeControl).not.toHaveBeenCalled();
  });

  it('a blank/whitespace-only entry is a no-op — never dispatches model.save_key', async () => {
    mockShowInputBox.mockResolvedValueOnce('   ');
    const invokeControl = vi.fn().mockResolvedValue({ provider: {} });
    const { provider } = makeProviderWith(makeFakeBackend(invokeControl));

    seam(provider).handleWebviewMessage({ type: 'model.addKey', slug: 'deepseek' });
    await flush();

    expect(invokeControl).not.toHaveBeenCalled();
  });

  it('a non-empty entry dispatches model.save_key({slug, api_key}) through a MASKED prompt', async () => {
    mockShowInputBox.mockResolvedValueOnce('sk-super-secret-value');
    const invokeControl = vi.fn().mockResolvedValue({ provider: { id: 'deepseek' } });
    const { provider } = makeProviderWith(makeFakeBackend(invokeControl));

    seam(provider).handleWebviewMessage({ type: 'model.addKey', slug: 'deepseek' });
    await flush();

    expect(mockShowInputBox).toHaveBeenCalledWith(expect.objectContaining({ password: true }));
    expect(invokeControl).toHaveBeenCalledWith('model.save_key', {
      slug: 'deepseek',
      api_key: 'sk-super-secret-value',
    });
  });

  it('SECRET DISCIPLINE: the entered key is never logged, on success or on failure', async () => {
    mockShowInputBox.mockResolvedValueOnce('sk-super-secret-value');
    const invokeControl = vi
      .fn()
      .mockRejectedValue(new Error('model.save_key failed [4002]: unknown provider'));
    const logged: string[] = [];
    const logger = { appendLine: (line: string) => logged.push(line) } as unknown as vscode.OutputChannel;
    const provider = new TalariaViewProvider({ fsPath: '/ext' } as never, makeFakeBackend(invokeControl), logger);
    seam(provider).view = { webview: { postMessage: () => {} } };

    seam(provider).handleWebviewMessage({ type: 'model.addKey', slug: 'deepseek' });
    await flush();

    expect(logged.some((line) => line.includes('sk-super-secret-value'))).toBe(false);
    // and never surfaced back to the user either
    expect(mockShowErrorMessage.mock.calls.flat().join(' ')).not.toContain('sk-super-secret-value');
    expect(mockShowWarningMessage.mock.calls.flat().join(' ')).not.toContain('sk-super-secret-value');
  });

  it('a 4006 (managed install) failure surfaces a STATUS-ONLY read-only message — never the key', async () => {
    mockShowInputBox.mockResolvedValueOnce('sk-super-secret-value');
    const invokeControl = vi
      .fn()
      .mockRejectedValue(new Error('model.save_key failed [4006]: credentials are managed and read-only'));
    const { provider } = makeProviderWith(makeFakeBackend(invokeControl));

    seam(provider).handleWebviewMessage({ type: 'model.addKey', slug: 'deepseek' });
    await flush();

    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = mockShowWarningMessage.mock.calls[0] as [string];
    expect(message.toLowerCase()).toContain('read-only');
    expect(message).not.toContain('sk-super-secret-value');
    expect(mockShowErrorMessage).not.toHaveBeenCalled();
  });

  it('a non-4006 failure (e.g. 4002 unknown provider) surfaces a generic status-only error — never the key', async () => {
    mockShowInputBox.mockResolvedValueOnce('sk-super-secret-value');
    const invokeControl = vi
      .fn()
      .mockRejectedValue(new Error('model.save_key failed [4002]: unknown provider'));
    const { provider } = makeProviderWith(makeFakeBackend(invokeControl));

    seam(provider).handleWebviewMessage({ type: 'model.addKey', slug: 'deepseek' });
    await flush();

    expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
    const [message] = mockShowErrorMessage.mock.calls[0] as [string];
    expect(message).not.toContain('sk-super-secret-value');
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });
});
