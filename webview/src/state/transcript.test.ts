import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DataPanel, PanelDataMap, ThemeInfo } from '../protocol';
import { BOOTSTRAP_TAB_ID, INITIAL_STATE, createInitialState, makeTabState, type AppState, type MessageItem } from '../types';
import { must } from '../testing/must';
import { assertExhaustivePanel } from './panels';
import { reduce, reduceLocal } from './transcript';

/** One minimal-valid payload per GLOBAL DataPanel (§2f) — used to pin every
 * global panel's routing, not just `tools` (P7-N4). */
const globalPanelData: { [P in Exclude<DataPanel, 'subagents' | 'checkpoints' | 'sessions'>]: PanelDataMap[P] } = {
  tools: { toolsets: [], tools: [] },
  mcp: { servers: [] },
  skills: { skills: [], categories: [] },
  models: { providers: [], currentModelId: '' },
  settings: { sections: [] },
  // Task 8 (protocol v2, §6): minimal-valid SetupData — same "empty but
  // shape-complete" posture as its siblings above.
  setup: {
    trusted: false,
    agent: { options: [], selectedId: '', phase: 'unknown' },
    provider: { phase: 'unknown' },
    fim: {
      options: [],
      selectedId: '',
      enabled: false,
      model: '',
      endpointValue: '',
      tuning: {
        debounceMs: 0,
        maxPromptTokens: 0,
        temperature: 0,
        crossFileEnabled: false,
        prefixInjection: false,
        prefixInjectionRemote: false,
        warmUp: false,
      },
    },
    nextEdit: {
      source: 'off',
      backend: 'ollama',
      endpoint: '',
      model: '',
      dedicatedConfigured: false,
      genericSupported: false,
    },
    rag: {
      enabled: false,
      embedEndpoint: '',
      embedModel: '',
      embedModelPresent: false,
      tuning: { dims: 0, maxChunkTokens: 0, debounceMs: 0, excludeGlobs: [] },
      indexDir: '',
    },
    ollama: { running: false, models: [] },
    ready: false,
  },
};

const theme: ThemeInfo = { kind: 'dark', accent: '#14b8a6' };

/** The active tab's slice — the shape almost every assertion below cares about. */
function activeTab(state: AppState) {
  return must(state.tabs[state.activeTabId], `activeTab: no tab for activeTabId "${state.activeTabId}"`);
}

describe('transcript reducer — R-A2: error must not clear busy', () => {
  it('a non-fatal error mid-turn keeps turnActive true (only turn.end ends busy)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    expect(activeTab(state).turnActive).toBe(true);

    state = reduce(state, { type: 'error', sessionId: 's1', message: 'Failed to switch model: boom' });

    expect(activeTab(state).turnActive).toBe(true); // composer stays locked — the turn is still running
    expect(activeTab(state).error).toEqual({ message: 'Failed to switch model: boom', detail: undefined });

    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'error' });
    expect(activeTab(state).turnActive).toBe(false);
  });

  it('an error for an already-adopted session with no active turn leaves turnActive false', () => {
    // W4 P-1: an `error` is session-scoped and drop-unknown routed — unlike
    // the old flat reducer, it can only fold once the session is a KNOWN tab
    // (adopted here via turn.start/turn.end, mirroring a real "turn already
    // finished, then a late non-fatal error arrives" sequence).
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'complete' });
    expect(activeTab(state).turnActive).toBe(false);

    state = reduce(state, { type: 'error', sessionId: 's1', message: 'not started yet' });
    expect(activeTab(state).turnActive).toBe(false);
    expect(activeTab(state).error?.message).toBe('not started yet');
  });
});

describe('transcript reducer — W4 §7 B1: system.error is a GLOBAL banner, split from per-tab error', () => {
  // T3a's analog of the S0 regression guard: system.error used to share the
  // single `state.error` slot pre-split; it now owns `AppState.systemError`
  // and must NEVER touch any tab's own `error` field.
  it('a system.error sets AppState.systemError (not any tab slot)', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'system.error',
      message: 'The agent exited unexpectedly — reconnecting…',
      detail: 'child pid 4212',
    });
    expect(state.systemError).toEqual({
      message: 'The agent exited unexpectedly — reconnecting…',
      detail: 'child pid 4212',
    });
    expect(activeTab(state).error).toBeUndefined();
  });

  it('a system.error mid-turn does not clear busy and does not populate the tab error banner', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    expect(activeTab(state).turnActive).toBe(true);
    state = reduce(state, { type: 'system.error', message: 'reconnecting…' });
    expect(activeTab(state).turnActive).toBe(true); // global error is not a turn terminator
    expect(state.systemError?.message).toBe('reconnecting…');
    expect(activeTab(state).error).toBeUndefined();
  });

  it('local.dismissSystemError clears systemError only, leaving a tab error intact', () => {
    let state = reduce(INITIAL_STATE, { type: 'system.error', message: 'reconnecting…' });
    state = reduce(state, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'error', sessionId: 's1', message: 'tab-local failure' });

    state = reduceLocal(state, { type: 'local.dismissSystemError' });

    expect(state.systemError).toBeUndefined();
    expect(activeTab(state).error?.message).toBe('tab-local failure');
  });
});

describe('transcript reducer — W4 P-1: unknown-session messages are dropped, never folded', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a session-scoped message for an unregistered sessionId leaves state unchanged and dev-logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const state = reduce(INITIAL_STATE, {
      type: 'message.delta',
      turnId: 't1',
      sessionId: 'ghost-session',
      text: 'should never land anywhere',
    });

    expect(state).toBe(INITIAL_STATE); // referentially unchanged
    expect(warn).toHaveBeenCalled();
  });

  it('an approval.request for an unregistered sessionId is dropped, not fabricated into a new tab', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = reduce(INITIAL_STATE, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 'ghost-session',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: rm -rf /',
      options: [],
    });
    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
  });

  it('never throws — dropping is silent state-preservation, not an exception', () => {
    expect(() =>
      reduce(INITIAL_STATE, { type: 'tool.diff', turnId: 't1', sessionId: 'ghost', toolId: 'x', path: 'a.ts', hunks: [] }),
    ).not.toThrow();
  });

  it('a session-scoped message is dropped (not crashed) when its resolved tabId has no matching entry in state.tabs — foldSessionScoped must guard its SECOND lookup too, not just the sessionId->tabId one (P-1 drop-unknown, symmetric with foldTabScoped)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // sessionToTab (state/tabs.ts) resolves session->tab via the tab OBJECT's
    // own `.tabId` field, not the key it happens to be stored under in
    // `state.tabs`. Construct a state where those diverge — a tab stored
    // under key 'real-key' but whose `.tabId` field claims 'stale-tab-id' —
    // so the first lookup (sessionId -> tabId) succeeds but the second
    // (state.tabs[tabId]) misses.
    const staleTab = { ...makeTabState('stale-tab-id', 'Stale'), sessionId: 's1' };
    const state: AppState = {
      ...INITIAL_STATE,
      tabs: { 'real-key': staleTab },
      tabOrder: ['real-key'],
      activeTabId: 'real-key',
    };

    expect(() => reduce(state, { type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'hi' })).not.toThrow();
    const next = reduce(state, { type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'hi' });
    expect(next).toBe(state); // dropped, not folded
    expect(warn).toHaveBeenCalled();
  });
});

describe('transcript reducer — W4 P-1: two tabs bound to different sessions never bleed', () => {
  function twoBoundTabs(): AppState {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'session-A' });
    // Force a second tab bound to session-B alongside the bootstrap tab (A).
    const tabB = { ...makeTabState('tab-b', 'B'), sessionId: 'session-B', binding: 'bound' as const };
    state = { ...state, tabs: { ...state.tabs, 'tab-b': tabB }, tabOrder: [...state.tabOrder, 'tab-b'] };
    return state;
  }

  it("B's message.delta never lands in A's transcript and vice-versa", () => {
    let state = twoBoundTabs();
    state = reduce(state, { type: 'message.delta', turnId: 'tb-1', sessionId: 'session-B', text: 'hello from B' });
    state = reduce(state, { type: 'message.delta', turnId: 'ta-1', sessionId: 'session-A', text: 'hello from A' });

    const a = must(state.tabs[BOOTSTRAP_TAB_ID]);
    const b = must(state.tabs['tab-b']);
    expect(a.transcript).toHaveLength(1);
    expect(a.transcript[0]).toMatchObject({ kind: 'message', text: 'hello from A' });
    expect(b.transcript).toHaveLength(1);
    expect(b.transcript[0]).toMatchObject({ kind: 'message', text: 'hello from B' });
  });

  it('interleaved reasoning/tool/turn streams for A and B stay strictly partitioned', () => {
    let state = twoBoundTabs();
    const script: Array<Parameters<typeof reduce>[1]> = [
      { type: 'reasoning.start', turnId: 'ta-1', sessionId: 'session-A', blockId: 'ra' },
      { type: 'tool.start', turnId: 'tb-1', sessionId: 'session-B', toolId: 'tool-b', kind: 'read', title: 'read b.ts', status: 'running' },
      { type: 'reasoning.delta', sessionId: 'session-A', blockId: 'ra', turnId: 'ta-1', text: 'thinking A' },
      { type: 'tool.update', turnId: 'tb-1', sessionId: 'session-B', toolId: 'tool-b', status: 'done' },
      { type: 'reasoning.end', turnId: 'ta-1', sessionId: 'session-A', blockId: 'ra' },
      { type: 'turn.end', turnId: 'tb-1', sessionId: 'session-B', status: 'complete' },
    ];
    for (const msg of script) state = reduce(state, msg);

    const a = must(state.tabs[BOOTSTRAP_TAB_ID]);
    const b = must(state.tabs['tab-b']);

    expect(a.transcript.some((i) => i.kind === 'tool')).toBe(false);
    expect(b.transcript.some((i) => i.kind === 'reasoning')).toBe(false);
    expect(a.transcript.find((i) => i.kind === 'reasoning')).toMatchObject({ text: 'thinking A', streaming: false });
    expect(b.transcript.find((i) => i.kind === 'tool')).toMatchObject({ toolId: 'tool-b', status: 'done' });

    // Each tab's turnActive tracks its OWN turn: B ended, A is still live.
    expect(a.turnActive).toBe(true);
    expect(b.turnActive).toBe(false);
  });

  it("a per-tab `error` for B never populates A's error banner", () => {
    let state = twoBoundTabs();
    state = reduce(state, { type: 'error', sessionId: 'session-B', message: 'B failed' });

    expect(must(state.tabs['tab-b']).error?.message).toBe('B failed');
    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).error).toBeUndefined();
  });
});

describe('transcript reducer — W6-FE Part 1 (3-way ARCH I-3b): commands.available is session-scoped, folds per-tab (no cross-tab clobber)', () => {
  function twoBoundTabs(): AppState {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'session-A' });
    const tabB = { ...makeTabState('tab-b', 'B'), sessionId: 'session-B', binding: 'bound' as const };
    state = { ...state, tabs: { ...state.tabs, 'tab-b': tabB }, tabOrder: [...state.tabOrder, 'tab-b'] };
    return state;
  }

  it("each tab keeps its OWN available-commands catalog — session-B's push never clobbers session-A's tab (the cross-tab clobber this fix closes)", () => {
    let state = twoBoundTabs();
    state = reduce(state, {
      type: 'commands.available',
      sessionId: 'session-A',
      commands: [{ name: 'help', description: 'A help' }],
    });
    state = reduce(state, {
      type: 'commands.available',
      sessionId: 'session-B',
      commands: [{ name: 'model', description: 'B model' }],
    });

    const a = must(state.tabs[BOOTSTRAP_TAB_ID]);
    const b = must(state.tabs['tab-b']);
    // Pre-fix (unscoped wire + global App.tsx state) session-B's push would
    // have overwritten the ONE global slot — switching back to tab A would
    // then render B's commands. Scoped-and-folded, each tab keeps its own.
    expect(a.availableCommands).toEqual([{ name: 'help', description: 'A help' }]);
    expect(b.availableCommands).toEqual([{ name: 'model', description: 'B model' }]);
  });

  it('a later push for tab B does not retroactively change tab A\'s already-folded catalog', () => {
    let state = twoBoundTabs();
    state = reduce(state, {
      type: 'commands.available',
      sessionId: 'session-A',
      commands: [{ name: 'help', description: 'A help' }],
    });
    const beforeB = must(state.tabs[BOOTSTRAP_TAB_ID]).availableCommands;

    state = reduce(state, {
      type: 'commands.available',
      sessionId: 'session-B',
      commands: [{ name: 'model', description: 'B model' }],
    });

    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).availableCommands).toBe(beforeB); // referentially unchanged
  });

  it('is dropped for an unregistered session — P-1 drop-unknown, never fabricates a new tab', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = reduce(INITIAL_STATE, {
      type: 'commands.available',
      sessionId: 'ghost-session',
      commands: [{ name: 'help', description: 'x' }],
    });
    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('transcript reducer — W2 T4 F-D: approval.request carries toolId into the ApprovalItem', () => {
  it('threads msg.toolId onto the folded ApprovalItem (edit approval)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'edit',
      title: 'Edit: src/a.ts',
      toolId: 'tool-1',
      options: [],
    });

    const item = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(item).toMatchObject({ kind: 'approval', id: 'appr-1', toolId: 'tool-1' });
  });

  it('leaves toolId undefined for a command approval with none (the wire field is optional)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: npm test',
      options: [],
    });

    const item = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(item).toMatchObject({ kind: 'approval', id: 'appr-1', toolId: undefined });
  });
});

describe('transcript reducer — R-C4: hydrate must not wipe live fold state', () => {
  it('hydrate updates per-tab scalars only and PRESERVES the live transcript/plan/panels', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 's1', text: 'hello', mode: 'default' });
    state = reduce(state, { type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'world' });
    expect(activeTab(state).transcript).toHaveLength(2);

    const hydrated = reduce(state, {
      type: 'hydrate',
      state: {
        sessionId: 's2',
        theme,
        backendKind: 'mock',
        mode: 'default',
        preset: 'manual',
        currentModelId: 'm1',
        activePanel: 'chat',
      },
    });

    expect(activeTab(hydrated).transcript).toHaveLength(2); // NOT wiped by the empty seed
    expect(activeTab(hydrated).sessionId).toBe('s2');
    expect(activeTab(hydrated).currentModelId).toBe('m1');
  });
});

describe('transcript reducer — P3: a null-seeded hydrate must not overwrite a live sessionId/currentModelId', () => {
  it('a re-created view that re-hydrates WITHOUT a restart (seed sessionId/currentModelId both null) PRESERVES the live values', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'live-session' });
    state = reduceLocal(state, { type: 'local.setModel', tabId: state.activeTabId, modelId: 'live-model' });
    expect(activeTab(state).sessionId).toBe('live-session');
    expect(activeTab(state).currentModelId).toBe('live-model');

    const hydrated = reduce(state, {
      type: 'hydrate',
      state: {
        sessionId: null,
        theme,
        backendKind: 'mock',
        mode: 'default',
        preset: 'manual',
        currentModelId: null,
        activePanel: 'chat',
      },
    });

    expect(activeTab(hydrated).sessionId).toBe('live-session'); // NOT stomped to null
    expect(activeTab(hydrated).currentModelId).toBe('live-model'); // NOT stomped to null
  });

  it('a NON-null seed still wins over the live value — the seed IS real information in that case', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'live-session' });
    state = reduceLocal(state, { type: 'local.setModel', tabId: state.activeTabId, modelId: 'live-model' });

    const hydrated = reduce(state, {
      type: 'hydrate',
      state: {
        sessionId: 'seeded-session',
        theme,
        backendKind: 'mock',
        mode: 'default',
        preset: 'manual',
        currentModelId: 'seeded-model',
        activePanel: 'chat',
      },
    });

    expect(activeTab(hydrated).sessionId).toBe('seeded-session');
    expect(activeTab(hydrated).currentModelId).toBe('seeded-model');
  });
});

describe('transcript reducer — D2 (A2): mock/real backend badge', () => {
  it('hydrate carries backendKind onto AppState (single-tab boot path)', () => {
    const hydrated = reduce(INITIAL_STATE, {
      type: 'hydrate',
      state: {
        sessionId: null,
        theme,
        mode: 'default',
        preset: 'manual',
        currentModelId: null,
        activePanel: 'chat',
        backendKind: 'mock',
      },
    });

    expect(hydrated.backendKind).toBe('mock');
  });

  it('hydrate reconcile path (N live tabs) also carries backendKind onto AppState', () => {
    const hydrated = reduce(INITIAL_STATE, {
      type: 'hydrate',
      state: {
        sessionId: null,
        theme,
        mode: 'default',
        preset: 'manual',
        currentModelId: null,
        activePanel: 'chat',
        backendKind: 'acp',
        tabs: [{ tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const }],
      },
    });

    expect(hydrated.backendKind).toBe('acp');
  });

  it('a backend.state push (the trust-upgrade mock->acp swap) flips AppState.backendKind — setBackend never re-hydrates, so this scalar push is the only signal', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'hydrate',
      state: {
        sessionId: null,
        theme,
        mode: 'default',
        preset: 'manual',
        currentModelId: null,
        activePanel: 'chat',
        backendKind: 'mock',
      },
    });
    expect(state.backendKind).toBe('mock');

    state = reduce(state, { type: 'backend.state', kind: 'acp' });

    expect(state.backendKind).toBe('acp');
  });
});

describe('transcript reducer — W6-FF (3-way ARCH I-1): hydrate reconciles the tab list (no orphan on webview re-create)', () => {
  /** A fresh webview mount's hydrate seed: N live host sessions, none of
   * which this (just-booted, single-bootstrap-tab) webview instance has
   * ever seen — exactly the re-create case (`retainContextWhenHidden` is
   * best-effort; a memory-pressure dispose+recreate mounts a fresh webview
   * while the host's `SessionRegistry` still holds N live controllers). */
  const twoLiveTabsSeed = {
    sessionId: null,
    theme,
    backendKind: 'mock' as const,
    mode: 'default' as const,
    preset: 'manual' as const,
    currentModelId: null,
    activePanel: 'chat' as const,
    tabs: [
      { tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const },
      { tabId: 'tab-b', sessionId: 'sB', cwd: '/root-b', rootId: '/root-b', preset: 'manual' as const },
    ],
  };

  it('rebuilds the tab model from the seed — N seed tabs become N bound tabs with the right rootIds (RED before the fix: stays the single/empty bootstrap tab)', () => {
    const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: twoLiveTabsSeed });

    expect(Object.keys(hydrated.tabs).sort()).toEqual(['tab-a', 'tab-b']);
    expect(hydrated.tabOrder).toEqual(['tab-a', 'tab-b']);
    expect(hydrated.tabs['tab-a']).toMatchObject({ sessionId: 'sA', binding: 'bound', rootId: '/root-a' });
    expect(hydrated.tabs['tab-b']).toMatchObject({ sessionId: 'sB', binding: 'bound', rootId: '/root-b' });
  });

  it('a subsequent update for one of the N seeded sessions routes to ITS tab, not drop-unknown (RED before the fix)', () => {
    const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: twoLiveTabsSeed });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const routed = reduce(hydrated, { type: 'message.delta', turnId: 't1', sessionId: 'sB', text: 'hello' });
    expect(warn).not.toHaveBeenCalled(); // never hits foldSessionScoped's drop-unknown path
    warn.mockRestore();

    expect(must(routed.tabs['tab-b']).transcript).toHaveLength(1);
    expect(must(routed.tabs['tab-b']).transcript[0]).toMatchObject({ kind: 'message', text: 'hello' });
  });

  it('P-1 isolation is preserved post-hydrate: an update for sB can ONLY ever reach tab-b, never tab-a', () => {
    let state = reduce(INITIAL_STATE, { type: 'hydrate', state: twoLiveTabsSeed });

    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sA', text: 'from A', mode: 'default' });
    state = reduce(state, { type: 'user', turnId: 't2', sessionId: 'sB', text: 'from B', mode: 'default' });

    expect(must(state.tabs['tab-a']).transcript).toHaveLength(1);
    expect(must(state.tabs['tab-a']).transcript[0]).toMatchObject({ text: 'from A' });
    expect(must(state.tabs['tab-b']).transcript).toHaveLength(1);
    expect(must(state.tabs['tab-b']).transcript[0]).toMatchObject({ text: 'from B' });
  });

  it('an EMPTY/absent seed tabs list is NOT a reconciliation — the legacy single-active-tab scalar fold applies unchanged (cold boot, mock backend)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 's1', text: 'hi', mode: 'default' });

    const hydrated = reduce(state, {
      type: 'hydrate',
      state: { ...twoLiveTabsSeed, tabs: [] },
    });

    expect(Object.keys(hydrated.tabs)).toEqual([BOOTSTRAP_TAB_ID]); // untouched — no reconciliation triggered
    expect(activeTab(hydrated).transcript).toHaveLength(1); // NOT wiped
  });

  it('reconciling a session ALREADY bound in the current (pre-hydrate) state reuses its tab and preserves its live transcript (defensive: a second hydrate on one still-live webview instance)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sA' }); // adopts into bootstrap
    const priorTabId = state.activeTabId;
    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sA', text: 'already here', mode: 'default' });

    const reSeed = {
      ...twoLiveTabsSeed,
      tabs: [{ tabId: priorTabId, sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const }],
    };
    const hydrated = reduce(state, { type: 'hydrate', state: reSeed });

    expect(Object.keys(hydrated.tabs)).toEqual([priorTabId]);
    expect(must(hydrated.tabs[priorTabId]).transcript).toHaveLength(1); // preserved, not reset
    expect(hydrated.tabs[priorTabId]).toMatchObject({ sessionId: 'sA', binding: 'bound', rootId: '/root-a' });
  });

  /** H4-B8 (arch report Minor-2): the seed's per-tab DISPLAY fields
   * (preset/currentModelId/activeModeId/availableCommands) — sourced from
   * each `SessionController`, NOT a new source of truth — so a reconciled
   * NON-active tab shows its real display state immediately instead of
   * `makeTabState` defaults while it waits for its own next
   * `policy.state`/`mode.state`/`commands.available`/model push. RED before
   * the fix: `foldHydrateReconcile` drops these fields, so every reconciled
   * tab lands on defaults regardless of what the seed carries. */
  describe('H4-B8: per-tab display state (preset/currentModelId/activeModeId/availableCommands) carried at hydrate', () => {
    it('a seed entry carrying preset/currentModelId/activeModeId/availableCommands produces a reconciled tab with THOSE values, not defaults', () => {
      const seed = {
        ...twoLiveTabsSeed,
        tabs: [
          {
            tabId: 'tab-a',
            sessionId: 'sA',
            cwd: '/root-a',
            rootId: '/root-a',
            preset: 'plan' as const,
            currentModelId: 'm-x',
            activeModeId: 'mode-y',
            availableCommands: [{ name: 'help', description: 'Show help' }],
          },
        ],
      };

      const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: seed });

      expect(hydrated.tabs['tab-a']).toMatchObject({
        preset: 'plan',
        currentModelId: 'm-x',
        activeModeId: 'mode-y',
        availableCommands: [{ name: 'help', description: 'Show help' }],
      });
    });

    it('P-1 isolation: a MULTI-tab seed gives each tab its OWN entry\'s display values — tab A\'s preset never lands on tab B', () => {
      const seed = {
        ...twoLiveTabsSeed,
        tabs: [
          {
            tabId: 'tab-a',
            sessionId: 'sA',
            cwd: '/root-a',
            rootId: '/root-a',
            preset: 'plan' as const,
            currentModelId: 'm-a',
            activeModeId: 'mode-a',
            availableCommands: [{ name: 'a-cmd', description: 'A only' }],
          },
          {
            tabId: 'tab-b',
            sessionId: 'sB',
            cwd: '/root-b',
            rootId: '/root-b',
            preset: 'strict' as const,
            currentModelId: 'm-b',
            activeModeId: 'mode-b',
            availableCommands: [{ name: 'b-cmd', description: 'B only' }],
          },
        ],
      };

      const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: seed });

      expect(hydrated.tabs['tab-a']).toMatchObject({
        preset: 'plan',
        currentModelId: 'm-a',
        activeModeId: 'mode-a',
        availableCommands: [{ name: 'a-cmd', description: 'A only' }],
      });
      expect(hydrated.tabs['tab-b']).toMatchObject({
        preset: 'strict',
        currentModelId: 'm-b',
        activeModeId: 'mode-b',
        availableCommands: [{ name: 'b-cmd', description: 'B only' }],
      });
    });

    it('an entry with the display fields absent falls back to makeTabState\'s safe defaults (never crashes, never leaks another tab\'s value)', () => {
      const seed = {
        ...twoLiveTabsSeed,
        tabs: [{ tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const }],
      };

      const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: seed });

      expect(hydrated.tabs['tab-a']).toMatchObject({
        preset: 'manual',
        currentModelId: null,
        activeModeId: null,
        availableCommands: [],
      });
    });
  });

  /**
   * A5 (T-1 V-12 RESTART-STATE seed fold-in): `SessionController.hasLiveTurn()`
   * carried at hydrate time via `HydrateTabSeed.turnActive` — so a tab that
   * was genuinely mid-turn when the host's registry got reconciled (a
   * memory-pressure webview re-create DURING a live turn) regains its Stop
   * affordance immediately instead of showing a dead composer until its next
   * push (which, mid-turn, is exactly the `turn.end` that will never come
   * for a webview that no longer exists). RED before the fix:
   * `foldHydrateReconcile` never reads `entry.turnActive` at all, so every
   * reconciled tab lands on `makeTabState`'s `turnActive: false` default
   * regardless of what the seed carries.
   */
  describe('A5 (T-1 V-12 seed fold-in): HydrateTabSeed.turnActive', () => {
    it('a seed entry carrying turnActive:true reconciles the tab with turnActive true — the composer shows Stop, not Send', () => {
      const seed = {
        ...twoLiveTabsSeed,
        tabs: [
          { tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const, turnActive: true },
          { tabId: 'tab-b', sessionId: 'sB', cwd: '/root-b', rootId: '/root-b', preset: 'manual' as const, turnActive: false },
        ],
      };

      const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: seed });

      expect(hydrated.tabs['tab-a']).toMatchObject({ turnActive: true });
      expect(hydrated.tabs['tab-b']).toMatchObject({ turnActive: false });
    });

    it('an entry with turnActive absent falls back to false — never crashes, never leaks another tab\'s live status', () => {
      const seed = {
        ...twoLiveTabsSeed,
        tabs: [{ tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const }],
      };

      const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: seed });

      expect(hydrated.tabs['tab-a']).toMatchObject({ turnActive: false });
    });
  });
});

describe('transcript reducer — D1 (M7): AppState.restoredTitles restores per-tab titles across a webview dispose+recreate', () => {
  /** Same two-live-tabs re-create seed as the W6-FF suite above — reused here
   * to pin how `foldHydrateReconcile`'s title fallback and `nextChatNumber`
   * advance interact with a restored `getState()` snapshot. */
  const twoLiveTabsSeed = {
    sessionId: null,
    theme,
    backendKind: 'mock' as const,
    mode: 'default' as const,
    preset: 'manual' as const,
    currentModelId: null,
    activePanel: 'chat' as const,
    tabs: [
      { tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const },
      { tabId: 'tab-b', sessionId: 'sB', cwd: '/root-b', rootId: '/root-b', preset: 'manual' as const },
    ],
  };

  it('a reconciled tab with a persisted title wins over the generic "Chat N" fallback (RED before the fix: renamed to "Chat 2")', () => {
    const restored: AppState = { ...INITIAL_STATE, restoredTitles: { 'tab-b': 'Chat 7' } };
    const hydrated = reduce(restored, { type: 'hydrate', state: twoLiveTabsSeed });
    expect(must(hydrated.tabs['tab-b']).title).toBe('Chat 7');
  });

  it('a seeded tab with NO persisted title still falls back to the generic "Chat ${index + 1}"', () => {
    const restored: AppState = { ...INITIAL_STATE, restoredTitles: { 'tab-b': 'Chat 7' } };
    const hydrated = reduce(restored, { type: 'hydrate', state: twoLiveTabsSeed });
    expect(must(hydrated.tabs['tab-a']).title).toBe('Chat 1'); // index 0 -> "Chat 1", no restored entry for tab-a
  });

  it('nextChatNumber is max(restored nextChatNumber, tabOrder.length + 1) — a restored counter is never rolled back', () => {
    const restored: AppState = { ...INITIAL_STATE, restoredTitles: { 'tab-b': 'Chat 7' }, nextChatNumber: 9 };
    const hydrated = reduce(restored, { type: 'hydrate', state: twoLiveTabsSeed });
    expect(hydrated.nextChatNumber).toBe(9); // 9 > tabOrder.length(2)+1 -- restored wins
  });

  it('nextChatNumber still advances past the reconciled set when the restored counter is smaller', () => {
    const restored: AppState = { ...INITIAL_STATE, restoredTitles: {}, nextChatNumber: 1 };
    const hydrated = reduce(restored, { type: 'hydrate', state: twoLiveTabsSeed });
    expect(hydrated.nextChatNumber).toBe(3); // tabOrder.length(2)+1 > restored(1) -- reconciled set wins
  });

  it('no restoredTitles at all (plain window reload / cold boot) behaves exactly as before — every tab gets the generic fallback', () => {
    const hydrated = reduce(INITIAL_STATE, { type: 'hydrate', state: twoLiveTabsSeed });
    expect(must(hydrated.tabs['tab-a']).title).toBe('Chat 1');
    expect(must(hydrated.tabs['tab-b']).title).toBe('Chat 2');
  });
});

describe('transcript reducer — W4 §2d: policy.state folds the per-tab preset (drop-unknown routed)', () => {
  it('folds preset onto the owning tab', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'policy.state', sessionId: 's1', preset: 'strict' });
    expect(activeTab(state).preset).toBe('strict');
  });

  it('is dropped for an unregistered session', () => {
    const state = reduce(INITIAL_STATE, { type: 'policy.state', sessionId: 'ghost', preset: 'strict' });
    expect(activeTab(state).preset).toBe('manual'); // untouched boot default
  });
});

describe('transcript reducer — W4 §2e: turn.start is the (S0-shim) adoption path, not a blind overwrite', () => {
  it('the first turn.start for an unknown session adopts it into the bootstrap tab (Continue case 3)', () => {
    const state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    expect(state.activeTabId).toBe(BOOTSTRAP_TAB_ID);
    expect(activeTab(state)).toMatchObject({ sessionId: 's1', binding: 'bound' });
  });

  it('a second turn.start for the SAME session is a no-op re-adoption (Continue case 1)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'complete' });
    state = reduce(state, { type: 'turn.start', turnId: 't2', sessionId: 's1' });

    expect(Object.keys(state.tabs)).toEqual([BOOTSTRAP_TAB_ID]); // no phantom second tab
    expect(activeTab(state)).toMatchObject({ sessionId: 's1', turnActive: true });
  });
});

describe('transcript reducer — W4 §2d/§7 B2: panel.data routes by scope key (§2f)', () => {
  it('subagents (sessionId) lands on the owning tab\'s subagents slice, drop-unknown otherwise', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'panel.data', panel: 'subagents', sessionId: 's1', data: { delegations: [] } });
    expect(activeTab(state).subagents).toEqual({ status: 'success', data: { delegations: [] } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unchanged = reduce(state, { type: 'panel.data', panel: 'subagents', sessionId: 'ghost', data: { delegations: [] } });
    expect(unchanged).toBe(state);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('checkpoints (rootId) lands in AppState.rootPanels, keyed by root — never per-tab', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'panel.data',
      panel: 'checkpoints',
      rootId: '/workspace/root-a',
      data: { checkpoints: [] },
    });
    expect(state.rootPanels['/workspace/root-a']).toEqual({ status: 'success', data: { checkpoints: [] } });
    expect(activeTab(state)).not.toHaveProperty('checkpoints');
  });

  it('sessions (cwd) lands in the shared AppState.sessionsPanel', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'panel.data',
      panel: 'sessions',
      cwd: '/workspace/root-a',
      data: { sessions: [] },
    });
    expect(state.sessionsPanel).toEqual({ status: 'success', data: { sessions: [] } });
  });

  it('a global panel (tools) lands in AppState.globalPanels', () => {
    const state = reduce(INITIAL_STATE, { type: 'panel.data', panel: 'tools', data: globalPanelData.tools });
    expect(state.globalPanels.tools).toEqual({ status: 'success', data: globalPanelData.tools });
  });

  it('a global panel (mcp) lands in AppState.globalPanels', () => {
    const state = reduce(INITIAL_STATE, { type: 'panel.data', panel: 'mcp', data: globalPanelData.mcp });
    expect(state.globalPanels.mcp).toEqual({ status: 'success', data: globalPanelData.mcp });
  });

  it('a global panel (skills) lands in AppState.globalPanels', () => {
    const state = reduce(INITIAL_STATE, { type: 'panel.data', panel: 'skills', data: globalPanelData.skills });
    expect(state.globalPanels.skills).toEqual({ status: 'success', data: globalPanelData.skills });
  });

  it('a global panel (models) lands in AppState.globalPanels', () => {
    const state = reduce(INITIAL_STATE, { type: 'panel.data', panel: 'models', data: globalPanelData.models });
    expect(state.globalPanels.models).toEqual({ status: 'success', data: globalPanelData.models });
  });

  it('a global panel (settings) lands in AppState.globalPanels', () => {
    const state = reduce(INITIAL_STATE, { type: 'panel.data', panel: 'settings', data: globalPanelData.settings });
    expect(state.globalPanels.settings).toEqual({ status: 'success', data: globalPanelData.settings });
  });
});

describe('transcript reducer — P7-N4 (ARCH I-1): foldPanelData/reducePanelActionScoped have no silent-global fallthrough', () => {
  it('non-vacuous proof: a DataPanel switch missing a real case (mirroring foldPanelData\'s/reducePanelActionScoped\'s exact shape) fails to close via assertExhaustivePanel — the SAME gate both real routing sites use', () => {
    // Mirrors foldPanelData's switch(msg.panel) shape but — as a stand-in for
    // "a FUTURE session/root/cwd-scoped DataPanel someone forgot a runtime
    // case for" — deliberately omits 'settings'. RED (pre-fix): the old code
    // had no `never` gate at all, so an omitted case fell through to
    // `globalPanels` silently. GREEN (this fix): omitting a case is a
    // COMPILE error at the exact line every real routing site closes with.
    function routeMirroringFoldPanelData(panel: DataPanel): 'session' | 'root' | 'cwd' | 'global' {
      switch (panel) {
        case 'subagents':
          return 'session';
        case 'checkpoints':
          return 'root';
        case 'sessions':
          return 'cwd';
        case 'tools':
        case 'mcp':
        case 'skills':
        case 'models':
          return 'global';
        default:
          // @ts-expect-error — TS2345: Argument of type '"settings"' is not
          // assignable to parameter of type 'never'. This is the EXACT
          // error `foldPanelData`/`reducePanelActionScoped`/
          // `resolvePanelRequest` raise at `npm run typecheck -w webview`
          // the moment any of them forgets a real DataPanel case.
          return assertExhaustivePanel(panel);
      }
    }
    expect(routeMirroringFoldPanelData('subagents')).toBe('session');
    expect(routeMirroringFoldPanelData('tools')).toBe('global');
  });
});

describe('transcript reducer — W4-T3b B6: panel-loading/error actions key on the SCOPE captured at fetch-issue time, not the active tab at dispatch time', () => {
  /** Two bound tabs: the bootstrap tab (session sA) and a second tab (session sB). */
  function twoBoundTabs(): { state: AppState; tabA: string; tabB: string } {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sA' }); // adopts into bootstrap (case 3)
    const tabA = state.activeTabId;
    state = reduce(state, { type: 'turn.start', turnId: 't2', sessionId: 'sB' }); // case 4: new tab (A is bound, not adoptable)
    const tabB = state.activeTabId;
    expect(tabB).not.toBe(tabA);
    return { state, tabA, tabB };
  }

  it('subagents: a fetch issued for tab A resolves into A\'s slice even after the user switches to tab B', () => {
    const { state: bound, tabA, tabB } = twoBoundTabs();
    // The fetch was issued while A was active — activeTabId is currently B
    // (the LAST reconciliation left B active); the loading action still
    // carries A's own scope key (tabA), captured at issue time.
    let state = reduceLocal(bound, { type: 'local.panelLoading', panel: 'subagents', scopeKey: tabA });
    expect(state.activeTabId).toBe(tabB); // confirms the "switched away" premise
    expect(must(state.tabs[tabA]).subagents).toEqual({ status: 'loading' });
    expect(must(state.tabs[tabB]).subagents).toEqual({ status: 'idle' }); // untouched

    // The fetch's rejection arrives even later — still keyed on A, never B.
    state = reduceLocal(state, {
      type: 'local.panelError',
      panel: 'subagents',
      scopeKey: tabA,
      message: 'not started yet',
      retryable: true,
    });
    expect(must(state.tabs[tabA]).subagents).toMatchObject({ status: 'error' });
    expect(must(state.tabs[tabB]).subagents).toEqual({ status: 'idle' });
  });

  it('checkpoints: a fetch\'s loading/error keys on the ROOT captured at issue time, not the tab active at dispatch time', () => {
    const { state: bound, tabA } = twoBoundTabs();
    // A's tab.bound carries its real root.
    let state = reduce(bound, { type: 'tab.bound', tabId: tabA, sessionId: 'sA', rootId: '/root-a' });

    state = reduceLocal(state, { type: 'local.panelLoading', panel: 'checkpoints', scopeKey: '/root-a' });
    expect(state.rootPanels['/root-a']).toEqual({ status: 'loading' });

    state = reduceLocal(state, {
      type: 'local.panelError',
      panel: 'checkpoints',
      scopeKey: '/root-a',
      message: 'lock timeout',
      retryable: true,
    });
    expect(state.rootPanels['/root-a']).toMatchObject({ status: 'error' });
  });

  it.each(['tools', 'mcp', 'skills', 'models', 'settings'] as const)(
    'a global panel ("%s", no scopeKey) still updates AppState.globalPanels normally',
    (panel) => {
      const state = reduceLocal(INITIAL_STATE, { type: 'local.panelLoading', panel });
      expect(state.globalPanels[panel]).toEqual({ status: 'loading' });
    },
  );
});

describe('transcript reducer — W4 §2d: tab.bound / tab.error fold into the NAMED tab, drop-unknown otherwise', () => {
  it('tab.bound sets sessionId/binding/title/rootId on the named tab', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 's1',
      rootId: '/workspace/root-a',
      title: 'My chat',
    });
    expect(activeTab(state)).toMatchObject({
      sessionId: 's1',
      binding: 'bound',
      title: 'My chat',
      rootId: '/workspace/root-a',
    });
  });

  it('tab.bound for an unknown tabId is dropped, dev-logged, state unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = reduce(INITIAL_STATE, {
      type: 'tab.bound',
      tabId: 'ghost-tab',
      sessionId: 's1',
      rootId: '/workspace/root-a',
    });
    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('tab.error sets the named tab\'s error banner, preserving kind for the retry affordance (§7 B8)', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      message: 'session/new rejected',
      kind: 'open-failed',
    });
    expect(activeTab(state).error).toEqual({ message: 'session/new rejected', kind: 'open-failed' });
  });
});

describe('transcript reducer — W4-T3b D1: the checkpoints eternal-spinner fix (App-read <-> push-key consistency)', () => {
  it('fetch-loading -> tab.bound{rootId} -> checkpoints push{rootId} resolves the ACTIVE tab\'s rootPanels slice to success, not a stuck idle/loading', () => {
    // 1. The panel is opened BEFORE the tab is bound — a `local.panelLoading`
    //    write lands under the tab's default '' rootId key (mirrors
    //    App.tsx's `requestPanel('checkpoints')` racing the bind).
    let state = reduceLocal(INITIAL_STATE, { type: 'local.panelLoading', panel: 'checkpoints' });
    expect(activeTab(state).rootId).toBe('');
    expect(state.rootPanels['']).toEqual({ status: 'loading' });

    // 2. The host binds the tab to a real session AND its real root.
    state = reduce(state, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 's1',
      rootId: '/workspace/root-a',
    });
    expect(activeTab(state).rootId).toBe('/workspace/root-a');

    // 3. The host pushes the checkpoints snapshot keyed by the REAL rootId —
    //    exactly what `AcpBackend.buildPanelDataMessage` sends.
    state = reduce(state, {
      type: 'panel.data',
      panel: 'checkpoints',
      rootId: '/workspace/root-a',
      data: { checkpoints: [] },
    });

    // 4. The App-level read (`state.rootPanels[tab.rootId]`, `App.tsx`'s
    //    `checkpointsRemote`) must resolve to success — the SAME key the
    //    push landed under — never the stale '' key the pre-bind fetch
    //    loaded into (the eternal-spinner class this test locks shut).
    const tab = activeTab(state);
    expect(state.rootPanels[tab.rootId]).toEqual({ status: 'success', data: { checkpoints: [] } });
  });
});

describe('transcript reducer — W4-T3b Deliverable 5: local tab lifecycle actions', () => {
  it('local.tab.open mints a pending tab, appends to tabOrder, and activates it', () => {
    const state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-2' });
    expect(state.tabOrder).toEqual([BOOTSTRAP_TAB_ID, 'tab-2']);
    expect(state.activeTabId).toBe('tab-2');
    expect(state.tabs['tab-2']).toMatchObject({ binding: 'pending', sessionId: undefined });
  });

  it('local.tab.select switches the active tab', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-2' });
    state = reduceLocal(state, { type: 'local.tab.select', tabId: BOOTSTRAP_TAB_ID });
    expect(state.activeTabId).toBe(BOOTSTRAP_TAB_ID);
  });

  it('local.tab.select is a no-op for an unknown tabId (dev-logged, never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = reduceLocal(INITIAL_STATE, { type: 'local.tab.select', tabId: 'ghost' });
    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('local.tab.close removes the tab and re-activates a sibling', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-2' });
    state = reduceLocal(state, { type: 'local.tab.close', tabId: 'tab-2' });
    expect(state.tabOrder).toEqual([BOOTSTRAP_TAB_ID]);
    expect(state.activeTabId).toBe(BOOTSTRAP_TAB_ID);
    expect(state.tabs['tab-2']).toBeUndefined();
  });

  it('local.tab.close refuses to close the LAST remaining tab (the UI already gates this; the reducer is a defensive backstop)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = reduceLocal(INITIAL_STATE, { type: 'local.tab.close', tabId: BOOTSTRAP_TAB_ID });
    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('local.closeIntentsDrained clears the B9(c) queue', () => {
    const seeded: AppState = { ...INITIAL_STATE, closeIntents: ['tab-x', 'tab-y'] };
    const state = reduceLocal(seeded, { type: 'local.closeIntentsDrained' });
    expect(state.closeIntents).toEqual([]);
  });

  it('turn.start\'s reconciliation THREADS handleSessionChange\'s closeIntents into AppState.closeIntents (§7 B9(c) wiring)', () => {
    // Case 2 (the dedup that actually PRODUCES a closeIntent) is provably
    // unreachable through turn.start's shim specifically: foldTurnStart only
    // calls handleSessionChange when `sessionToTab` does NOT already know
    // the incoming session — but that is EXACTLY case 2's own precondition
    // (another tab already owns it), so by the time handleSessionChange
    // would run, its own existingTabId search is guaranteed empty. Real
    // dedup only fires via T5's `tab.load` reconciliation (out of T3b's
    // scope) — but the WIRING (append whatever handleSessionChange returns
    // onto state.closeIntents, never drop it) must be correct regardless of
    // which caller eventually exercises it. Case 3 (plain adoption, THIS
    // test's path) always returns closeIntents:[] — so this proves the
    // append is a genuine append (starting from a non-empty queue), not an
    // overwrite that would silently lose an unrelated pending intent.
    const seeded: AppState = { ...INITIAL_STATE, closeIntents: ['stale-intent'] };
    const state = reduce(seeded, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    expect(state.closeIntents).toEqual(['stale-intent']); // preserved, not clobbered
  });
});

describe('transcript reducer — H1/A1: nextChatNumber is monotonic, never reused or decremented', () => {
  it('closing a MIDDLE tab then opening a new one never mints a duplicate title (RED before the fix: mints a duplicate "Chat 4")', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-2' });
    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-3' });
    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-4' });
    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).title).toBe('Chat 1');
    expect(must(state.tabs['tab-2']).title).toBe('Chat 2');
    expect(must(state.tabs['tab-3']).title).toBe('Chat 3');
    expect(must(state.tabs['tab-4']).title).toBe('Chat 4');

    // Close a MIDDLE tab (tab-3) — the old `tabOrder.length + 1` scheme would
    // now see a length-3 tabOrder and mint "Chat 4" again on the next open.
    state = reduceLocal(state, { type: 'local.tab.close', tabId: 'tab-3' });
    expect(state.tabs['tab-3']).toBeUndefined();

    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-5' });

    const titles = state.tabOrder.map((id) => state.tabs[id]?.title);
    expect(new Set(titles).size).toBe(titles.length); // no duplicate titles anywhere
    expect(must(state.tabs['tab-5']).title).toBe('Chat 5'); // monotonic continuation, not a reused number
  });

  it('foldHydrateReconcile advances nextChatNumber past the reconciled set so a subsequent tab.open cannot collide', () => {
    const twoLiveTabsSeed = {
      sessionId: null,
      theme,
      backendKind: 'mock' as const,
      mode: 'default' as const,
      preset: 'manual' as const,
      currentModelId: null,
      activePanel: 'chat' as const,
      tabs: [
        { tabId: 'tab-a', sessionId: 'sA', cwd: '/root-a', rootId: '/root-a', preset: 'manual' as const },
        { tabId: 'tab-b', sessionId: 'sB', cwd: '/root-b', rootId: '/root-b', preset: 'manual' as const },
      ],
    };
    let state = reduce(INITIAL_STATE, { type: 'hydrate', state: twoLiveTabsSeed });
    expect(state.tabOrder).toEqual(['tab-a', 'tab-b']);

    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-c' });

    const titles = state.tabOrder.map((id) => state.tabs[id]?.title);
    expect(new Set(titles).size).toBe(titles.length); // no collision with the reconciled "Chat 1"/"Chat 2"
  });
});

describe('transcript reducer — H1/M6: closing the ACTIVE tab activates the neighbor, not always the last tab', () => {
  it('closing an active MIDDLE tab activates the RIGHT neighbor (RED before the fix: jumps to the rightmost tab)', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-2' });
    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-3' });
    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-4' });
    expect(state.tabOrder).toEqual([BOOTSTRAP_TAB_ID, 'tab-2', 'tab-3', 'tab-4']);

    state = reduceLocal(state, { type: 'local.tab.select', tabId: 'tab-2' });
    expect(state.activeTabId).toBe('tab-2');

    state = reduceLocal(state, { type: 'local.tab.close', tabId: 'tab-2' });

    expect(state.tabOrder).toEqual([BOOTSTRAP_TAB_ID, 'tab-3', 'tab-4']);
    expect(state.activeTabId).toBe('tab-3'); // former right neighbor of the closed middle tab
  });

  it('closing the active LAST tab activates the new last (left neighbor)', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-2' });
    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-3' });
    expect(state.activeTabId).toBe('tab-3'); // last opened, active

    state = reduceLocal(state, { type: 'local.tab.close', tabId: 'tab-3' });

    expect(state.tabOrder).toEqual([BOOTSTRAP_TAB_ID, 'tab-2']);
    expect(state.activeTabId).toBe('tab-2'); // new last == former left neighbor
  });

  it('closing a NON-active tab leaves activeTabId unchanged', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-2' });
    state = reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-3' });
    // Active is tab-3; switch focus back to the bootstrap tab, then close tab-2 (not active).
    state = reduceLocal(state, { type: 'local.tab.select', tabId: BOOTSTRAP_TAB_ID });

    state = reduceLocal(state, { type: 'local.tab.close', tabId: 'tab-2' });

    expect(state.activeTabId).toBe(BOOTSTRAP_TAB_ID); // untouched — the closed tab wasn't active
  });
});

describe('transcript reducer — P7-N1: per-tab composer draft/attachments (fixes the wrong-session-send Critical)', () => {
  it('local.draft.set folds into the named tab ONLY; the sibling and transcript identity are preserved', () => {
    const state0 = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-b' });
    const tabATranscript = must(state0.tabs[BOOTSTRAP_TAB_ID]).transcript;
    const tabBBefore = state0.tabs['tab-b'];

    const state = reduceLocal(state0, { type: 'local.draft.set', tabId: BOOTSTRAP_TAB_ID, text: 'hello' });

    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).draft).toBe('hello');
    expect(must(state.tabs['tab-b']).draft).toBe('');
    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).transcript).toBe(tabATranscript); // identity preserved
    expect(state.tabs['tab-b']).toBe(tabBBefore); // untouched sibling, same object
  });

  it('the N1 repro: a draft typed on A is NOT visible after switching to B, and reappears switching back to A', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-b' }); // activates tab-b
    state = reduceLocal(state, { type: 'local.tab.select', tabId: BOOTSTRAP_TAB_ID }); // back to A

    state = reduceLocal(state, { type: 'local.draft.set', tabId: BOOTSTRAP_TAB_ID, text: 'hello' });

    state = reduceLocal(state, { type: 'local.tab.select', tabId: 'tab-b' });
    expect(activeTab(state).draft).toBe(''); // B's own, empty — never A's leftover

    state = reduceLocal(state, { type: 'local.tab.select', tabId: BOOTSTRAP_TAB_ID });
    expect(activeTab(state).draft).toBe('hello'); // A's draft survived the round trip
  });

  it('local.draft.attach.add appends sequentially (models async FileReader resolution order); local.draft.attach.remove removes by id only', () => {
    let state = reduceLocal(INITIAL_STATE, {
      type: 'local.draft.attach.add',
      tabId: BOOTSTRAP_TAB_ID,
      attachment: { id: 'a1', name: 'a.txt', kind: 'file' },
    });
    state = reduceLocal(state, {
      type: 'local.draft.attach.add',
      tabId: BOOTSTRAP_TAB_ID,
      attachment: { id: 'a2', name: 'b.txt', kind: 'file' },
    });
    expect(activeTab(state).draftAttachments.map((a) => a.id)).toEqual(['a1', 'a2']);

    state = reduceLocal(state, { type: 'local.draft.attach.remove', tabId: BOOTSTRAP_TAB_ID, attachmentId: 'a1' });
    expect(activeTab(state).draftAttachments.map((a) => a.id)).toEqual(['a2']);
  });

  it('local.draft.clear empties draft + draftAttachments on the named tab ONLY', () => {
    let state = reduceLocal(INITIAL_STATE, { type: 'local.tab.open', tabId: 'tab-b' });
    state = reduceLocal(state, { type: 'local.draft.set', tabId: BOOTSTRAP_TAB_ID, text: 'hello' });
    state = reduceLocal(state, {
      type: 'local.draft.attach.add',
      tabId: BOOTSTRAP_TAB_ID,
      attachment: { id: 'a1', name: 'a.txt', kind: 'file' },
    });
    state = reduceLocal(state, { type: 'local.draft.set', tabId: 'tab-b', text: 'other tab draft' });

    state = reduceLocal(state, { type: 'local.draft.clear', tabId: BOOTSTRAP_TAB_ID });

    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).draft).toBe('');
    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).draftAttachments).toEqual([]);
    expect(must(state.tabs['tab-b']).draft).toBe('other tab draft'); // sibling untouched
  });

  it('a draft.* action for an unknown tabId leaves state referentially unchanged and dev-logs (P-1 drop-unknown)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const state = reduceLocal(INITIAL_STATE, { type: 'local.draft.set', tabId: 'ghost', text: 'hello' });

    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('makeTabState defaults draft to "" and draftAttachments to []', () => {
    const tab = makeTabState('fresh-tab', 'Chat Fresh');
    expect(tab.draft).toBe('');
    expect(tab.draftAttachments).toEqual([]);
  });
});

describe('transcript reducer — P7-N2N5: optimistic actions carry an explicit tabId, folding via foldTabScoped (fixes the ambient-activeTab race, ARCH I-2)', () => {
  /** Two tabs: BOOTSTRAP_TAB_ID (A) and 'tab-b' (B), with B left ACTIVE — the
   * exact race shape ARCH I-2 describes: a host message can move
   * `activeTabId` between an optimistic action's dispatch and its fold, so
   * the action must never trust `state.activeTabId` at fold time. */
  function openAndActivateTabB(state: AppState): AppState {
    return reduceLocal(state, { type: 'local.tab.open', tabId: 'tab-b' });
  }

  it('local.setModel{tabId:A} lands on A even though B is the ambient-active tab at fold time (RED before the fix: lands on B)', () => {
    const state0 = openAndActivateTabB(INITIAL_STATE);
    expect(state0.activeTabId).toBe('tab-b'); // confirms the race premise

    const state = reduceLocal(state0, { type: 'local.setModel', tabId: BOOTSTRAP_TAB_ID, modelId: 'model-x' });

    expect(must(state.tabs[BOOTSTRAP_TAB_ID]).currentModelId).toBe('model-x'); // the INTENDED tab
    expect(must(state.tabs['tab-b']).currentModelId).toBeNull(); // ambient-active tab, untouched
  });

  it('local.approvalResolved{tabId:A} resolves A\'s approval card even though B is ambient-active (RED before the fix: no-op on A)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'session-A' });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 'session-A',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: npm test',
      options: [],
    });
    const tabA = state.activeTabId;
    state = openAndActivateTabB(state);
    expect(state.activeTabId).toBe('tab-b');

    state = reduceLocal(state, { type: 'local.approvalResolved', tabId: tabA, id: 'appr-1', optionId: 'allow' });

    const resolved = must(state.tabs[tabA]).transcript.find((i) => i.kind === 'approval');
    expect(resolved).toMatchObject({ id: 'appr-1', resolvedOptionId: 'allow' });
  });

  it('local.diffResolved{tabId:A} resolves A\'s hunk even though B is ambient-active (RED before the fix: no-op on A)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'session-A' });
    state = reduce(state, {
      type: 'tool.start',
      turnId: 't1',
      sessionId: 'session-A',
      toolId: 'tool-1',
      kind: 'read',
      title: 'read a.ts',
      status: 'running',
    });
    const tabA = state.activeTabId;
    state = openAndActivateTabB(state);
    expect(state.activeTabId).toBe('tab-b');

    state = reduceLocal(state, {
      type: 'local.diffResolved',
      tabId: tabA,
      toolId: 'tool-1',
      hunkIndex: 0,
      action: 'accept',
    });

    const item = must(state.tabs[tabA]).transcript.find((i) => i.kind === 'tool');
    expect(item).toMatchObject({ toolId: 'tool-1', resolvedHunks: { 0: 'accept' } });
  });

  it('local.dismissError{tabId:A} clears A\'s error even though B is ambient-active (RED before the fix: no-op on A)', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      message: 'session/new rejected',
      kind: 'open-failed',
    });
    const tabA = state.activeTabId;
    state = openAndActivateTabB(state);
    expect(state.activeTabId).toBe('tab-b');

    state = reduceLocal(state, { type: 'local.dismissError', tabId: tabA });

    expect(must(state.tabs[tabA]).error).toBeUndefined();
  });

  it('P-1 drop-unknown: local.setModel for an unknown tabId leaves state referentially unchanged and dev-logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = reduceLocal(INITIAL_STATE, { type: 'local.setModel', tabId: 'ghost', modelId: 'model-x' });
    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('P-1 drop-unknown: local.dismissError for an unknown tabId leaves state referentially unchanged and dev-logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = reduceLocal(INITIAL_STATE, { type: 'local.dismissError', tabId: 'ghost' });
    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('transcript reducer — W4-T3b SF-2: mode.state folds the picker UI shell\'s data (T4 owns the engine)', () => {
  it('folds activeModeId/availableModes onto the owning tab', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'mode.state',
      sessionId: 's1',
      modeId: 'docs-only',
      available: [{ id: 'docs-only', name: 'Docs only' }],
    });
    expect(activeTab(state).activeModeId).toBe('docs-only');
    expect(activeTab(state).availableModes).toEqual([{ id: 'docs-only', name: 'Docs only' }]);
  });

  it('is dropped for an unregistered session', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'mode.state',
      sessionId: 'ghost',
      modeId: 'docs-only',
      available: [],
    });
    expect(state).toBe(INITIAL_STATE);
  });
});

describe('AppState.mode is dropped (§2e) — reduceLocal has no local.setMode action', () => {
  it('reduceLocal only recognizes the documented LocalAction types', () => {
    // Compile-time proof lives in the type system (LocalAction no longer has
    // a 'local.setMode' member); this runtime check guards the exhaustive
    // switch's default branch stays a safe no-op for anything unrecognized.
    const before = INITIAL_STATE;
    // @ts-expect-error — 'local.setMode' is intentionally not a member of LocalAction anymore.
    const after = reduceLocal(before, { type: 'local.setMode', mode: 'default' });
    expect(after).toBe(before);
  });
});

describe('transcript reducer — G-9: a tab that failed to open keeps a route back after the error is dismissed', () => {
  it('tab.error with kind open-failed marks the tab as openFailed', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      message: 'nope',
      kind: 'open-failed',
    });
    expect(state.tabs[BOOTSTRAP_TAB_ID]?.openFailed).toBe(true);
  });

  it('dismissing the error clears the banner but NOT the openFailed marker', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      message: 'nope',
      kind: 'open-failed',
    });
    state = reduceLocal(state, { type: 'local.dismissError', tabId: BOOTSTRAP_TAB_ID });

    expect(state.tabs[BOOTSTRAP_TAB_ID]?.error).toBeUndefined();
    // Before this fix the ONLY Retry button lived inside the dismissed banner,
    // so the tab stayed binding:'pending' forever with nothing on screen to
    // explain it or undo it.
    expect(state.tabs[BOOTSTRAP_TAB_ID]?.openFailed).toBe(true);
  });

  it('a successful bind clears the marker', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      message: 'nope',
      kind: 'open-failed',
    });
    state = reduce(state, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 's1',
      rootId: 'r1',
    });

    expect(state.tabs[BOOTSTRAP_TAB_ID]?.openFailed).toBe(false);
    expect(state.tabs[BOOTSTRAP_TAB_ID]?.binding).toBe('bound');
  });

  it('a non-open failure (session-lost) does NOT set the marker', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      message: 'session lost',
      kind: 'session-lost',
    });
    expect(state.tabs[BOOTSTRAP_TAB_ID]?.openFailed).toBeFalsy();
  });
});

describe('transcript reducer — W5.1 Task 13 (R5): the nextEdit.state push', () => {
  it('folds the Guard-ratified toggles onto the CONNECTION-GLOBAL slice (there is one toggle store per extension, never one per chat tab)', () => {
    const state = reduce(INITIAL_STATE, { type: 'nextEdit.state', state: { next: true, generic: false } });

    expect(state.nextEditToggles).toEqual({ next: true, generic: false });
  });

  it('a later push wins (the Guard is the ONLY authority — the panel keeps no webview-side persistence of its own)', () => {
    let state = reduce(INITIAL_STATE, { type: 'nextEdit.state', state: { next: true, generic: false } });
    state = reduce(state, { type: 'nextEdit.state', state: { next: false, generic: true } });

    expect(state.nextEditToggles).toEqual({ next: false, generic: true });
  });

  it('boots both-off before any push — an unhydrated panel must never render a guessed ON', () => {
    expect(INITIAL_STATE.nextEditToggles).toEqual({ next: false, generic: false });
  });
});

describe('transcript reducer — ARCH-1 (final review): model.state is the authoritative overwrite of the optimistic pick', () => {
  it('model.state overwrites the optimistic currentModelId set by local.setModel', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    state = reduceLocal(state, { type: 'local.setModel', tabId: state.activeTabId, modelId: 'B' });
    expect(activeTab(state).currentModelId).toBe('B'); // optimistic write lands first

    state = reduce(state, { type: 'model.state', sessionId: 'sess1', modelId: null });

    expect(activeTab(state).currentModelId).toBeNull(); // corrective snap-back wins over optimism
  });

  it('model.state assigns currentModelId with no prior optimistic write (fresh confirm)', () => {
    const state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    expect(activeTab(state).currentModelId).toBeNull(); // nothing picked yet

    const confirmed = reduce(state, { type: 'model.state', sessionId: 'sess1', modelId: 'B' });

    expect(activeTab(confirmed).currentModelId).toBe('B');
  });

  it('is dropped for an unregistered session and dev-logs (P-1 isolation)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const state = reduce(INITIAL_STATE, { type: 'model.state', sessionId: 'ghost', modelId: 'x' });

    expect(state).toBe(INITIAL_STATE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('model.state'));
    warn.mockRestore();
  });
});

describe('transcript reducer — ARCH-1 (final review) / Q2: system.recovered retires the connection-global outage banner', () => {
  it('system.recovered clears AppState.systemError', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'system.error',
      message: 'The agent exited unexpectedly — reconnecting…',
    });
    expect(state.systemError?.message).toBe('The agent exited unexpectedly — reconnecting…');

    state = reduce(state, { type: 'system.recovered' });

    expect(state.systemError).toBeUndefined();
  });

  it('system.recovered with no standing banner is a harmless no-op on that field', () => {
    const state = reduce(INITIAL_STATE, { type: 'system.recovered' });
    expect(state.systemError).toBeUndefined();
  });

  it('system.recovered does not touch any tab state', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    state = reduce(state, { type: 'error', sessionId: 'sess1', message: 'tab-local failure' });
    state = reduce(state, { type: 'system.error', message: 'reconnecting…' });

    state = reduce(state, { type: 'system.recovered' });

    expect(state.systemError).toBeUndefined();
    expect(activeTab(state).error?.message).toBe('tab-local failure'); // untouched
  });
});

describe('transcript reducer — ARCH-1 (final review, UI I-3): draft survives a refusal; a lost session regresses binding', () => {
  it('a refused send keeps the draft: the ONLY thing a refusal produces today (an error message) never touches it', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    state = reduceLocal(state, { type: 'local.draft.set', tabId: state.activeTabId, text: 'my long prompt' });

    state = reduce(state, { type: 'error', sessionId: 'sess1', message: 'A turn is already running…' });

    expect(activeTab(state).draft).toBe('my long prompt');
  });

  it('the user admission echo clears the draft on an exact match (ARCH-1: the host, not the optimistic post, clears it)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    state = reduceLocal(state, { type: 'local.draft.set', tabId: state.activeTabId, text: 'hello' });

    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sess1', text: 'hello', mode: 'default' });

    expect(activeTab(state).draft).toBe('');
    expect(activeTab(state).draftAttachments).toEqual([]);
  });

  it('the user echo does NOT clear a draft the user already retyped while the echo was in flight (exact-match guard)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    // The user retyped AFTER sending — the draft now holds NEW text, distinct
    // from what was actually sent ('the sent text').
    state = reduceLocal(state, {
      type: 'local.draft.set',
      tabId: state.activeTabId,
      text: 'new text typed after send',
    });

    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sess1', text: 'the sent text', mode: 'default' });

    expect(activeTab(state).draft).toBe('new text typed after send');
  });

  it('CF-03: a whitespace-padded draft clears (+ its attachment chips) on the trimmed echo (Composer sends draft.trim())', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    // The composer sends `draft.trim()` as the prompt text — the RAW draft
    // still carries the trailing space the user typed.
    state = reduceLocal(state, { type: 'local.draft.set', tabId: state.activeTabId, text: 'fix bug ' });
    state = reduceLocal(state, {
      type: 'local.draft.attach.add',
      tabId: state.activeTabId,
      attachment: { id: 'a1', name: 'a.txt', kind: 'file' },
    });

    // The host echoes back the TRIMMED text it actually admitted.
    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sess1', text: 'fix bug', mode: 'default' });

    expect(activeTab(state).draft).toBe('');
    expect(activeTab(state).draftAttachments).toEqual([]);
  });

  it('CF-03: a genuinely-different retyped draft is still preserved even though its trim would collide on whitespace alone', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    // The user retyped a NEW draft (not just re-padded the sent one) while
    // the echo was in flight — trimmed, it's still a different string from
    // what was sent, so the guard must not clobber it.
    state = reduceLocal(state, { type: 'local.draft.set', tabId: state.activeTabId, text: '  a new draft  ' });

    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sess1', text: 'fix bug', mode: 'default' });

    expect(activeTab(state).draft).toBe('  a new draft  ');
  });

  it('tab.error{kind:session-lost} regresses binding to unbound and sets the standing sessionLost marker; tab.bound clears it', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'sess1',
      rootId: '/workspace/root-a',
    });
    expect(activeTab(state).binding).toBe('bound');

    state = reduce(state, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      kind: 'session-lost',
      message: 'the session is gone',
    });

    expect(activeTab(state).binding).toBe('unbound');
    expect(activeTab(state).sessionLost).toBe(true);

    state = reduce(state, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'sess2',
      rootId: '/workspace/root-a',
    });

    expect(activeTab(state).sessionLost).toBe(false);
  });

  it('tab.error{kind:open-failed} does NOT regress binding or set sessionLost (only session-lost does)', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'sess1',
      rootId: '/workspace/root-a',
    });

    state = reduce(state, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      kind: 'open-failed',
      message: 'could not open',
    });

    expect(activeTab(state).binding).toBe('bound');
    // `tab.bound` above already set `sessionLost: false` (the marker-clear
    // half of its own fold) — open-failed must not FLIP that to true.
    expect(activeTab(state).sessionLost).toBe(false);
  });
});

describe('transcript reducer — IMP-2 (W3-T6 3-lens review, CF-11): tab.clear is tabId-scoped + unconditional', () => {
  /** Build a tab that was bound, held a real turn, and then went session-lost
   * — a dead transcript still standing, plus the standing "Session lost"
   * banner markers. `getByTabId` would find NOTHING for this tab anymore (no
   * live occupant at all) — proving `tab.clear` needs no session->tab
   * mapping, unlike the generic `clear`. */
  function sessionLostStateWithDeadTranscript(): AppState {
    let state = reduce(INITIAL_STATE, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'sess-dead',
      rootId: '/root',
    });
    state = reduce(state, { type: 'turn.start', turnId: 't1', sessionId: 'sess-dead' });
    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sess-dead', text: 'hello', mode: 'default' });
    state = reduce(state, {
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      kind: 'session-lost',
      message: 'the session is gone',
    });
    return state;
  }

  it('a session-LOST tab (dead transcript + standing banner) gets a CLEAN slate from tab.clear{tabId} alone', () => {
    const lost = sessionLostStateWithDeadTranscript();
    // Precondition: the dead transcript + standing banner really are there.
    expect(activeTab(lost).transcript.length).toBeGreaterThan(0);
    expect(activeTab(lost).sessionLost).toBe(true);
    expect(activeTab(lost).binding).toBe('unbound');

    const cleared = reduce(lost, { type: 'tab.clear', tabId: BOOTSTRAP_TAB_ID });

    expect(cleared.tabs[BOOTSTRAP_TAB_ID]?.transcript).toEqual([]);
    expect(cleared.tabs[BOOTSTRAP_TAB_ID]?.plan).toEqual([]);
    expect(cleared.tabs[BOOTSTRAP_TAB_ID]?.error).toBeUndefined();
    expect(cleared.tabs[BOOTSTRAP_TAB_ID]?.sessionLost).toBe(false);
    expect(cleared.tabs[BOOTSTRAP_TAB_ID]?.openFailed).toBe(false);
  });

  it('the clean slate lands BEFORE the fresh tab.bound that follows — no concatenation, no stale banner', () => {
    const lost = sessionLostStateWithDeadTranscript();

    let state = reduce(lost, { type: 'tab.clear', tabId: BOOTSTRAP_TAB_ID });
    state = reduce(state, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'sess-fresh',
      rootId: '/root',
    });

    expect(activeTab(state).transcript).toEqual([]);
    expect(activeTab(state).binding).toBe('bound');
    expect(activeTab(state).sessionId).toBe('sess-fresh');
    expect(activeTab(state).sessionLost).toBe(false);
  });

  it('the normal (session STILL present) rebind path also clears via tab.clear', () => {
    let state = reduce(INITIAL_STATE, {
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'sess1',
      rootId: '/root',
    });
    state = reduce(state, { type: 'turn.start', turnId: 't1', sessionId: 'sess1' });
    state = reduce(state, { type: 'user', turnId: 't1', sessionId: 'sess1', text: 'hi', mode: 'default' });
    expect(activeTab(state).transcript.length).toBeGreaterThan(0);

    state = reduce(state, { type: 'tab.clear', tabId: BOOTSTRAP_TAB_ID });

    expect(activeTab(state).transcript).toEqual([]);
  });

  it('tab.clear for an unknown tabId is dropped (dev-log), never throws', () => {
    expect(() => reduce(INITIAL_STATE, { type: 'tab.clear', tabId: 'no-such-tab' })).not.toThrow();
  });
});

describe('transcript reducer — T-A1 (audit-2 Cluster A, M3): webview authoritative fold', () => {
  it('V-5 RED: turn.end{status !== "complete"} folds a still-open tool to interrupted and an unsettled approval to settledOutcome:cancelled', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'tool.start',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'tool-1',
      kind: 'execute',
      title: 'run: npm test',
      status: 'running',
    });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: npm test',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
    });

    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'cancelled' });

    const tool = activeTab(state).transcript.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ toolId: 'tool-1', status: 'interrupted' });
    const approval = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(approval).toMatchObject({ id: 'appr-1', settledOutcome: 'cancelled' });
  });

  it('turn.end{status: "complete"} leaves an open tool/approval alone (owner fork: a running card after a complete turn is a host bug left visible, never papered over)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'tool.start',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'tool-1',
      kind: 'execute',
      title: 'run: npm test',
      status: 'running',
    });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: npm test',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
    });

    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'complete' });

    const tool = activeTab(state).transcript.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ toolId: 'tool-1', status: 'running' });
    const approval = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(approval?.settledOutcome).toBeUndefined();
  });

  it('V-6 RED: approval.settle{outcome:"expired"} beats an optimistic resolvedOptionId, and a later local.approvalResolved is a no-op', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: rm -rf tmp',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
    });
    // The 59.9s click race: the user's optimistic click lands just before the
    // host's 60s deadline fires.
    state = reduceLocal(state, { type: 'local.approvalResolved', tabId: state.activeTabId, id: 'appr-1', optionId: 'allow' });
    expect(activeTab(state).transcript.find((i) => i.kind === 'approval')).toMatchObject({ resolvedOptionId: 'allow' });

    // The host's authoritative settle arrives after (network race) — it MUST win.
    state = reduce(state, { type: 'approval.settle', sessionId: 's1', turnId: 't1', id: 'appr-1', outcome: 'expired' });

    const settled = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(settled).toMatchObject({ id: 'appr-1', settledOutcome: 'expired' });

    // A subsequent optimistic write for the SAME approval must now be a no-op —
    // proven non-vacuously by dispatching the OTHER option ('deny') than the
    // one already standing: reusing the SAME optionId ('allow') would make
    // this assertion pass even with the guard removed, since re-writing an
    // identical value is a structural no-op regardless (audit-2 review
    // finding — the pre-fix version of this test did exactly that).
    const before = activeTab(state).transcript.find((i) => i.kind === 'approval');
    state = reduceLocal(state, { type: 'local.approvalResolved', tabId: state.activeTabId, id: 'appr-1', optionId: 'deny' });
    const after = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(after).toEqual(before);
  });

  it('approval.settle on a non-"selected" outcome CLEARS a stale optimistic resolvedOptionId (audit-2 review finding 2): a cancel/expire/superseded settlement must never coexist with a leftover "consent" field from an earlier optimistic click', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: rm -rf tmp',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
    });
    // Optimistic click lands first (same race as V-6).
    state = reduceLocal(state, { type: 'local.approvalResolved', tabId: state.activeTabId, id: 'appr-1', optionId: 'allow' });
    expect(activeTab(state).transcript.find((i) => i.kind === 'approval')).toMatchObject({ resolvedOptionId: 'allow' });

    // The host's authoritative settle arrives with a NON-'selected' outcome —
    // the optimistic 'allow' consent must be cleared, not left dangling next
    // to a cancel/expire.
    state = reduce(state, { type: 'approval.settle', sessionId: 's1', turnId: 't1', id: 'appr-1', outcome: 'expired' });

    const settled = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(settled).toMatchObject({ id: 'appr-1', settledOutcome: 'expired' });
    // Checked separately (not via toMatchObject): the fix REMOVES the key
    // rather than setting it to a literal `undefined` (matches the file's
    // no-`undefined`-assignment style), and `toMatchObject` treats an absent
    // key as distinct from an explicit `undefined` in its expected object —
    // `?.` access is the correct way to assert "no stale value either way".
    expect(settled?.resolvedOptionId).toBeUndefined();
  });

  it('V-7 RED: local.diffResolved{reject} on hunk 0 of a 3-hunk tool locks siblings 1-2 (distinct from an explicit reject) and resolves the approval to deny', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'tool.start',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'tool-1',
      kind: 'edit',
      title: 'edit a.ts',
      status: 'running',
    });
    state = reduce(state, {
      type: 'tool.diff',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'tool-1',
      path: 'a.ts',
      hunks: [
        { header: '@@ -1,1 +1,1 @@', lines: [{ sign: '+', text: 'a' }] },
        { header: '@@ -2,1 +2,1 @@', lines: [{ sign: '+', text: 'b' }] },
        { header: '@@ -3,1 +3,1 @@', lines: [{ sign: '+', text: 'c' }] },
      ],
    });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      toolId: 'tool-1',
      kind: 'edit',
      title: 'Apply edit to a.ts',
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    });

    state = reduceLocal(state, {
      type: 'local.diffResolved',
      tabId: state.activeTabId,
      toolId: 'tool-1',
      hunkIndex: 0,
      action: 'reject',
    });

    const tool = activeTab(state).transcript.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ toolId: 'tool-1', hunksLocked: true, resolvedHunks: { 0: 'reject' } });
    expect(tool?.kind === 'tool' ? tool.resolvedHunks?.[1] : undefined).toBeUndefined();
    expect(tool?.kind === 'tool' ? tool.resolvedHunks?.[2] : undefined).toBeUndefined();

    const approval = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(approval).toMatchObject({ id: 'appr-1', resolvedOptionId: 'deny', settledOutcome: 'selected' });
  });

  it('a settled approval also blocks a later local.diffResolved (audit-2 review finding 1 companion: same V-6 authority guard, exercised on the diff path — this guard had ZERO test coverage before this fix)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'tool.start',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'tool-1',
      kind: 'edit',
      title: 'edit a.ts',
      status: 'running',
    });
    state = reduce(state, {
      type: 'tool.diff',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'tool-1',
      path: 'a.ts',
      hunks: [
        { header: '@@ -1,1 +1,1 @@', lines: [{ sign: '+', text: 'a' }] },
        { header: '@@ -2,1 +2,1 @@', lines: [{ sign: '+', text: 'b' }] },
      ],
    });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      toolId: 'tool-1',
      kind: 'edit',
      title: 'Apply edit to a.ts',
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    });

    // The host settles authoritatively (e.g. a 60s auto-deny) BEFORE any
    // local hunk click lands — same race as V-6, exercised on the diff path.
    state = reduce(state, { type: 'approval.settle', sessionId: 's1', turnId: 't1', id: 'appr-1', outcome: 'expired' });

    const before = activeTab(state);
    state = reduceLocal(state, {
      type: 'local.diffResolved',
      tabId: state.activeTabId,
      toolId: 'tool-1',
      hunkIndex: 0,
      action: 'reject',
    });
    const after = activeTab(state);
    // Non-vacuous: if the settledOutcome guard at the top of the
    // local.diffResolved case were ever removed, this dispatch would lock
    // sibling hunks and flip the approval to resolvedOptionId:'deny' —
    // caught by this deep-equality comparison against the pre-dispatch tab.
    expect(after).toEqual(before);
  });

  it('approval.request folds the wire timeoutMs onto the ApprovalItem (no webview file read it before T-A1)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: npm test',
      options: [],
      timeoutMs: 60_000,
    });

    const approval = activeTab(state).transcript.find((i) => i.kind === 'approval');
    expect(approval).toMatchObject({ id: 'appr-1', timeoutMs: 60_000 });
  });
});

describe('transcript reducer — CF-06 / R2: settleOpenItems — settling every open/streaming kind is DERIVED in one place, not enumerated per-kind', () => {
  it('RED: turn.end{status:"error"} settles a still-streaming reasoning block (pre-fix: closeOpenMessages only settles "message", and the turn.end fold only mapped tool/approval — a streaming reasoning block fell through both and stayed streaming:true forever, the eternal "Thinking" spinner)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'reasoning.start', turnId: 't1', sessionId: 's1', blockId: 'r1' });
    expect(activeTab(state).transcript.find((i) => i.kind === 'reasoning')).toMatchObject({ streaming: true });

    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'error' });

    const reasoning = activeTab(state).transcript.find((i) => i.kind === 'reasoning');
    expect(reasoning).toMatchObject({ blockId: 'r1', streaming: false });
  });

  it('RED (AUDIT-5 UI I-1 / F-3): turn.end{status:"cancelled"} folds an "active" plan step to the webview-only "interrupted" — no spinner survives a dead turn', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, {
      type: 'plan.update',
      turnId: 't1',
      sessionId: 's1',
      items: [
        { text: 'step one', status: 'done' },
        { text: 'step two', status: 'active' },
        { text: 'step three', status: 'pending' },
      ],
    });
    const before = activeTab(state).transcript.find((i) => i.kind === 'plan');
    expect(before?.kind === 'plan' ? before.items[1]?.status : 'wrong-kind').toBe('active');

    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'cancelled' });

    const plan = activeTab(state).transcript.find((i) => i.kind === 'plan');
    expect(plan?.kind === 'plan' ? plan.items.map((s) => s.status) : []).toEqual(['done', 'interrupted', 'pending']);
    // The tab.plan mirror must not keep a live-looking step either.
    expect(activeTab(state).plan.map((s) => s.status)).toEqual(['done', 'interrupted', 'pending']);
    // A 'done'/'pending' step is NOT rewritten — only 'active' is folded.
  });

  it('trip-wire: an abnormal turn.end with one OPEN item of every streaming/settleable kind (message, reasoning, tool, approval, plan) leaves NONE streaming/open — a future streaming kind that forgets to plug into settleOpenItems fails HERE, not in a per-kind test nobody wrote', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    // Order matters: each of tool.start/approval.request/reasoning.start
    // closes any PRIOR open message block (closeOpenMessages' mid-turn role,
    // deliberately kept) — so the message block is opened LAST, after every
    // other kind, to land all four open simultaneously.
    state = reduce(state, {
      type: 'tool.start',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'tool-1',
      kind: 'execute',
      title: 'run: npm test',
      status: 'running',
    });
    state = reduce(state, {
      type: 'approval.request',
      turnId: 't1',
      sessionId: 's1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run: npm test',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
    });
    state = reduce(state, {
      type: 'plan.update',
      turnId: 't1',
      sessionId: 's1',
      items: [{ text: 'in-flight step', status: 'active' }],
    });
    state = reduce(state, { type: 'reasoning.start', turnId: 't1', sessionId: 's1', blockId: 'r1' });
    state = reduce(state, { type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'partial answer' });

    // Confirm the precondition non-vacuously: all five ARE open before turn.end.
    const before = activeTab(state).transcript;
    expect(before).toHaveLength(5);
    const beforeApproval = before.find((i) => i.kind === 'approval');
    expect(before.find((i) => i.kind === 'tool')).toMatchObject({ status: 'running' });
    expect(beforeApproval?.kind === 'approval' ? beforeApproval.settledOutcome : 'wrong-kind').toBeUndefined();
    expect(before.find((i) => i.kind === 'reasoning')).toMatchObject({ streaming: true });
    expect(before.find((i) => i.kind === 'message')).toMatchObject({ streaming: true });
    const beforePlan = before.find((i) => i.kind === 'plan');
    expect(beforePlan?.kind === 'plan' ? beforePlan.items[0]?.status : 'wrong-kind').toBe('active');

    state = reduce(state, { type: 'turn.end', turnId: 't1', sessionId: 's1', status: 'error' });

    const after = activeTab(state).transcript;
    expect(after).toHaveLength(5);
    for (const item of after) {
      if (item.kind === 'message' || item.kind === 'reasoning') {
        expect(item.streaming).toBe(false);
      }
      if (item.kind === 'tool') {
        expect(item.status).not.toBe('pending');
        expect(item.status).not.toBe('running');
      }
      if (item.kind === 'approval') {
        expect(item.settledOutcome).not.toBeUndefined();
      }
      if (item.kind === 'plan') {
        expect(item.items.some((s) => s.status === 'active')).toBe(false);
        expect(item.items[0]?.status).toBe('interrupted'); // F-3: the honest webview-only fold target
      }
    }
  });
});

describe('transcript reducer — audit-3 Code Important: message.end must not duplicate pre-tool text on an interleaved (say→tool→say) turn', () => {
  /** Host contract (turnTranslator.ts:39-49, pinned by turnTranslator.test.ts):
   * ONE message.end per turn, carrying the FULL accumulated turn buffer. On a
   * delta→tool→delta turn the deltas already built TWO message blocks (the
   * pre-tool block is closed by closeOpenMessages when the tool card
   * interleaves). Reconciling message.end by overwriting the LAST block with
   * the whole-turn buffer duplicates the pre-tool text into it. */
  it('delta → tool.start → delta → message.end settles streaming without duplicating the pre-tool block\'s text', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'Found it. ' });
    state = reduce(state, {
      type: 'tool.start',
      turnId: 't1',
      sessionId: 's1',
      toolId: 'x',
      kind: 'execute',
      title: 'run',
      status: 'running',
    });
    state = reduce(state, { type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'Done.' });
    state = reduce(state, { type: 'message.end', turnId: 't1', sessionId: 's1', text: 'Found it. Done.' });

    const msgs = activeTab(state).transcript.filter((i): i is MessageItem => i.kind === 'message');
    // Pre-fix: ['Found it. ', 'Found it. Done.'] — the reducer overwrote the
    // LAST block with the whole-turn buffer, duplicating the pre-tool text.
    expect(msgs.map((m) => m.text)).toEqual(['Found it. ', 'Done.']);
    expect(msgs.every((m) => m.streaming === false)).toBe(true);
  });

  it('message.end on a single-block turn still reconciles text to the authoritative buffer (guards the pre-existing reconcile path — must NOT regress)', () => {
    let state = reduce(INITIAL_STATE, { type: 'turn.start', turnId: 't1', sessionId: 's1' });
    state = reduce(state, { type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'Hi' });
    state = reduce(state, { type: 'message.end', turnId: 't1', sessionId: 's1', text: 'Hi there' });

    const msgs = activeTab(state).transcript.filter((i): i is MessageItem => i.kind === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toBe('Hi there');
    expect(msgs[0]?.streaming).toBe(false);
  });
});

describe('AUDIT-5 UI M-2: restored drafts survive a webview dispose+recreate', () => {
  it('RED: a hydrate-reconciled tab picks up its restored draft', () => {
    const boot = createInitialState({ drafts: { 't-new': 'my unsent prompt' } });
    const state = reduce(boot, {
      type: 'hydrate',
      state: {
        sessionId: 's1',
        theme,
        backendKind: 'mock',
        mode: 'default',
        preset: 'manual',
        currentModelId: null,
        activePanel: 'chat',
        tabs: [{ tabId: 't-new', sessionId: 's1', cwd: '/root-a', rootId: 'r1', preset: 'manual' as const }],
      },
    });
    expect(state.tabs['t-new']?.draft).toBe('my unsent prompt');
  });

  it('a LIVE draft is never overwritten by a stale restored one', () => {
    const boot = createInitialState({ drafts: { [BOOTSTRAP_TAB_ID]: 'stale restored text' } });
    const bootTab = boot.tabs[BOOTSTRAP_TAB_ID];
    if (!bootTab) throw new Error('bootstrap tab missing');
    const withLiveDraft = {
      ...boot,
      tabs: { [BOOTSTRAP_TAB_ID]: { ...bootTab, draft: 'live text the user just typed' } },
    };
    const state = reduce(withLiveDraft, {
      type: 'hydrate',
      state: {
        sessionId: 's1',
        theme,
        backendKind: 'mock',
        mode: 'default',
        preset: 'manual',
        currentModelId: null,
        activePanel: 'chat',
        tabs: [{ tabId: BOOTSTRAP_TAB_ID, sessionId: 's1', cwd: '/root-a', rootId: 'r1', preset: 'manual' as const }],
      },
    });
    expect(state.tabs[BOOTSTRAP_TAB_ID]?.draft).toBe('live text the user just typed');
  });
});
