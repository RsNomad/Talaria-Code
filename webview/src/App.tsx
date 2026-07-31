/*
 * App root. Subscribes to the bridge, folds SHARED host messages into AppState
 * via the reducer, and renders the Priority+ tab strip + the active surface
 * (chat or a side panel). The native VS Code view title bar owns the "TALARIA
 * CODE" title + gear, so the webview draws no top chrome of its own. User actions post
 * typed webview->host messages through the bridge; optimistic UI updates are
 * applied locally. Only the composer height is persisted via vscode.setState
 * (H9-M9: trimmed from a wider {activePanel, sessionId, composerHeight}
 * snapshot down to the one field ever read back); the transcript is NOT
 * persisted — a recreated view starts with an empty chat (honest per L2
 * R-C4), and retainContextWhenHidden covers the ordinary hide/show case.
 *
 * W4 §2e: the state machinery underneath is PER-TAB (`state.tabs[state.
 * activeTabId]`) — T3b adds the real chat-session TAB STRIP (`TabStrip`, not
 * `PriorityTabs` — that switches side PANELS), the per-tab composer latch,
 * and the panel-source re-scoping (§2f/§7 B6/B11). Every read below is
 * deliberately pointed at the ACTIVE tab, but which tab is active is now a
 * genuine user choice, not a T3a fiction.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { bridge } from './bridge';
import type {
  CheckpointRestoreResult,
  ControlMethod,
  DataPanel,
  HostToWebview,
  NextEditToggleSource,
  Panel,
  ThemeKind,
} from './protocol';
import { MAX_TABS } from './protocol';
import { reduce, reduceLocal, type LocalAction } from './state/transcript';
import { buildDraftSnapshot } from './state/persist';
import { mintTabId } from './state/tabs';
import { errorMessage, fetchPanel, panelData, resolvePanelRequest } from './state/panels';
import { idle } from './state/remoteData';
import { createInitialState, type AppState, type TabState } from './types';
import type { ComposerSeed } from './composer/applySeed';
import { useHostActions } from './hooks/useHostActions';

import { PriorityTabs, panelTabDomId, panelTabpanelId } from './components/PriorityTabs';
import { TabStrip, tabDomId, CHAT_TABPANEL_ID } from './components/TabStrip';
import { Composer } from './components/Composer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ChatView } from './components/chat/ChatView';
import { RemotePanel } from './panels/PanelShell';
import { ToolsPanel } from './panels/ToolsPanel';
import { McpPanel } from './panels/McpPanel';
import { SkillsPanel } from './panels/SkillsPanel';
import { CheckpointsPanel } from './panels/CheckpointsPanel';
import { SubagentsPanel } from './panels/SubagentsPanel';
import { SessionsPanel } from './panels/SessionsPanel';
import { ModelsPanel } from './panels/ModelsPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { ErrorBanner } from './components/ErrorBanner';
import { MockNotice } from './components/MockNotice';
import { Icon } from './components/Icon';

type Action = { host: HostToWebview } | { local: LocalAction };

/**
 * W4 §2d: every session-scoped `WebviewToHost` message now carries a
 * required `sessionId`. T3a still has exactly ONE real tab in practice — the
 * webview learns its sessionId the same way the wire spec says a multi-tab
 * client will (`turn.start`/`tab.bound`, folded per-tab by the reducer) and
 * echoes it straight back. Before the first turn ever starts, the active
 * tab's `sessionId` is `undefined`; this placeholder is provably inert for
 * that window because `AcpBackend`'s own admission guards (`!this.client ||
 * !this.sessionId`) short-circuit BEFORE reading the caller-supplied value
 * whenever no session is live yet.
 */
const UNBOUND_SESSION_PLACEHOLDER = '';

function rootReducer(state: AppState, action: Action): AppState {
  if ('host' in action) return reduce(state, action.host);
  return reduceLocal(state, action.local);
}

/** The ACTIVE tab's slice — T3a renders exactly this one tab. The reducers
 * (see `state/tabs.ts`'s own defensive guard on `handleSessionChange`)
 * maintain the invariant that `activeTabId` always names a live entry in
 * `tabs`; this throws instead of silently propagating `undefined` if that
 * invariant is ever violated — a loud, located failure beats a `TypeError`
 * on whichever downstream property read happens to be first. */
function activeTab(state: AppState): TabState {
  const tab = state.tabs[state.activeTabId];
  if (tab === undefined) {
    throw new Error(`activeTab: no tab for activeTabId "${state.activeTabId}"`);
  }
  return tab;
}

// In the real webview, VS Code stamps .vscode-dark/-light/-high-contrast on
// <body> itself. Standalone (no host) we set it from theme messages so the
// token layer resolves.
function applyStandaloneTheme(kind: ThemeKind) {
  if (bridge.isHosted) return;
  const cls =
    kind === 'light'
      ? 'vscode-light'
      : kind === 'high-contrast'
        ? 'vscode-high-contrast'
        : 'vscode-dark';
  document.body.className = cls;
}

/** Resolve a friendly label for the active tab's model from the cached models panel. */
function modelLabel(state: AppState): string {
  const id = activeTab(state).currentModelId;
  if (!id) return 'Model';
  const found = panelData(state.globalPanels, 'models')
    ?.providers.flatMap((p) => p.models)
    .find((m) => m.id === id);
  return found?.label ?? id;
}

/** D1 (M7): the shape `vscode.setState`/`getState` persist across a webview
 * dispose+recreate — widened from the H9-M9 `{ composerHeight }`-only
 * snapshot to also carry per-tab `tabTitles` (keyed by tabId) and
 * `nextChatNumber`, so a recreated view can hand both to `createInitialState`
 * and give a reconciled tab back its real `Chat N` identity instead of a
 * renumbered generic fallback (see `foldHydrateReconcile`). AUDIT-5 UI M-2
 * widens this again with `drafts` (also keyed by tabId) so an unsent Composer
 * draft survives the same dispose+recreate instead of being silently dropped
 * (see `state/persist.ts`'s `buildDraftSnapshot`). Every field here is
 * OPTIONAL and additively versioned — a snapshot persisted by an older build
 * (missing `drafts`, or missing everything) must restore without crashing;
 * `createInitialState` and the callers below all treat every field as
 * possibly absent. */
interface PersistedState {
  composerHeight?: number;
  tabTitles?: Record<string, string>;
  nextChatNumber?: number;
  drafts?: Record<string, string>;
}

export function App() {
  // Restore whatever `getState()` carried BEFORE `useReducer` needs it — this
  // read happens once (useMemo, empty deps) and only its value at first
  // render is ever consulted by `useReducer`'s initial-state argument.
  const persisted = useMemo(() => bridge.getState<PersistedState>() ?? {}, []);
  const [state, dispatch] = useReducer(rootReducer, createInitialState(persisted));
  const tab = activeTab(state);

  // P7-N2N5: `dispatch` from `useReducer` has a STABLE identity (React docs:
  // "The dispatch function has a stable identity"), so this wrapper is
  // itself stable across every render — safe to list as a `useHostActions`
  // internal `useCallback` dependency with zero perf cost (ARCH Minor-11
  // parity: it never forces those callbacks to regenerate).
  const dispatchLocal = useCallback((action: LocalAction) => dispatch({ local: action }), [dispatch]);
  // P7-N2N5: the app action funnel (see hooks/useHostActions.ts) — owns
  // every (optimistic dispatch, bound host post) pair. `tab`/`state.
  // activePanel` are threaded in fresh every render; the hook itself never
  // reaches into `AppState`, so it can never fall back to an ambient
  // "active tab".
  const hostActions = useHostActions(dispatchLocal, tab, state.activePanel);

  // Restore the persisted composer height (falls back to a comfortable default).
  const [composerHeight, setComposerHeight] = useState<number>(persisted.composerHeight ?? 96);

  // A#7: whether a Sessions "Load more" correlated request is in flight (drives
  // the button's spinner/disabled state).
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  // BF-A: a "Load more" failure, kept OUT of `state.sessionsPanel`'s
  // RemoteData — same posture as `sessionsLoadingMore` above — so a failed
  // append surfaces its own error affordance WITHOUT replacing the
  // already-loaded list (see `loadMoreFooterState`, state/panels.ts).
  const [sessionsLoadMoreError, setSessionsLoadMoreError] = useState<string | undefined>(undefined);

  // C4: every session id currently bound to an open tab — a History row for
  // one of these already has a live tab somewhere, so it gets a bound marker
  // (SessionsPanel §boundSessionIds). Unbound tabs (`sessionId` still
  // `undefined` — TabState:128) contribute nothing.
  const boundSessionIds = useMemo(
    () =>
      new Set(
        Object.values(state.tabs)
          .map((t) => t.sessionId)
          .filter((id): id is string => id !== undefined),
      ),
    [state.tabs],
  );

  // W2 T3 (F-A code actions, §2e/§3.3): the most recent `composer.seed` push
  // from an editor action, threaded down to the Composer as a plain prop —
  // App.tsx does not touch the draft itself (Composer owns `text`, T2e); it
  // only hands the seed down for `applySeed` to apply. A FRESH object per
  // incoming message (never reused) is what lets Composer's effect key on
  // identity, so a genuinely NEW push still applies even if byte-identical to
  // the last one. Audit C-3: this is cleared to `null` via `onSeedApplied`
  // (below) the moment Composer consumes it — it does NOT stay set across a
  // Composer remount, and it is tagged with the tab it was minted for so a
  // tab switch in between can never deliver it to the wrong conversation.
  const [pendingSeed, setPendingSeed] = useState<ComposerSeed | null>(null);

  // The message subscription below is installed once (deps `[]`), so it
  // cannot close over `state.activeTabId`. A ref updated every render gives
  // it the CURRENT value without re-subscribing (which would drop messages).
  const activeTabIdRef = useRef(state.activeTabId);
  activeTabIdRef.current = state.activeTabId;

  // Subscribe to host messages + announce readiness once.
  useEffect(() => {
    const off = bridge.onMessage((msg) => {
      // preset/sessionId/currentModelId/availableCommands are all folded
      // per-tab by the reducer itself (see state/transcript.ts's `hydrate`
      // and `commands.available` cases — W6-FE Part 1 moved
      // `availableCommands` off a global `useState` onto the owning tab).
      if (msg.type === 'composer.seed') {
        // Reveal the chat surface (a seed from Fix/Explain/etc. is only
        // meaningful there) and hand the seed down — SEED ONLY, never a
        // `prompt`; Composer applies it to the draft and the user reviews +
        // sends it themselves (review-first, doc §3.3).
        dispatch({ local: { type: 'local.setPanel', panel: 'chat' } });
        // Capture the ACTIVE tab id at ARRIVAL time. The user may switch tabs
        // before the Composer mounts and applies it (audit C-3).
        setPendingSeed({ tabId: activeTabIdRef.current, text: msg.text, mentions: msg.mentions });
      }
      dispatch({ host: msg });
    });
    bridge.post({ type: 'ready' });
    return off;
  }, []);

  // Persist a compact snapshot for cheap rebuild after disposal. H9-M9
  // trimmed this to only the field ever read back (`composerHeight`);
  // D1 (M7) re-widens it to also carry `tabTitles`/`nextChatNumber` — the
  // ONLY channel that survives the exact dispose+recreate that fires
  // `hydrate` (Context7-confirmed: `getState`/`setState` are VS Code's own
  // prescribed alternative to `retainContextWhenHidden` for this case).
  // `tabTitles` is derived FRESH from `state.tabs`/`state.tabOrder` on every
  // write — only LIVE tabIds are included, so a closed tab's stale title is
  // pruned automatically on the very next write (no separate cleanup path
  // needed). Title ownership stays webview-side (the host deliberately does
  // not own a tab title); this is a read-only snapshot, never a second
  // source of truth for `TabState.title` itself.
  useEffect(() => {
    // F-5 (final-4way-fixes.md, defensive): guard-consistent with the
    // TabStrip render below (`.filter((t): t is TabState => t !== undefined)`)
    // — under `noUncheckedIndexedAccess`, `state.tabs[id]` is `TabState |
    // undefined`; a stale id in `tabOrder` with no matching `tabs` entry
    // (unreachable today given how the effect derives its ids, hence
    // Minor/defensive) must skip that id rather than throw on `.title`.
    const tabTitles = Object.fromEntries(
      state.tabOrder
        .map((id) => state.tabs[id])
        .filter((t): t is TabState => t !== undefined)
        .map((t) => [t.tabId, t.title]),
    );
    bridge.setState({
      composerHeight,
      tabTitles,
      nextChatNumber: state.nextChatNumber,
      // AUDIT-5 UI M-2: same per-write-derived-fresh posture as `tabTitles`
      // above — a closed tab's stale draft is pruned automatically on the
      // very next write, no separate cleanup path needed.
      drafts: buildDraftSnapshot(state),
    });
  }, [composerHeight, state.tabs, state.tabOrder, state.nextChatNumber]);

  // §7 B9(c): drain any tabIds `handleSessionChange`'s dedup queued for
  // closing — post `tab.close` for each so the host session doesn't leak
  // (see `tabs.ts`'s `HandleSessionChangeResult` doc for the honest scope
  // note: this is always sessionId-less today), then clear the queue.
  useEffect(() => {
    if (state.closeIntents.length === 0) return;
    for (const tabId of state.closeIntents) {
      bridge.post({ type: 'tab.close', tabId });
    }
    dispatch({ local: { type: 'local.closeIntentsDrained' } });
  }, [state.closeIntents]);

  // §7 B11: switching the ACTIVE tab re-fetches only the currently-open
  // scope-coupled panel (never all three) — preserving the lazy
  // fetch-on-open discipline. A plain panel switch (selectPanel) already
  // fetches on its own; this only covers "the panel stayed open, the tab
  // changed underneath it".
  useEffect(() => {
    const panel = state.activePanel;
    if (panel === 'subagents' || panel === 'checkpoints' || panel === 'sessions') {
      requestPanel(panel);
    }
    // W4-T3b review M-1: also re-fetch when the active tab's `rootId` arrives
    // (a `tab.bound` after the panel was opened flips rootId '' → the real
    // root; without this dep the open checkpoints panel would keep reading the
    // stale `rootPanels['']` slice and never pick up the real-root push).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTabId, state.tabs[state.activeTabId]?.rootId]);

  useEffect(() => {
    applyStandaloneTheme(state.theme.kind);
  }, [state.theme.kind]);

  // CF-13/D1: the Models panel's "Add key" affordance — posts ONLY the
  // provider slug. The host prompts for the key directly (masked) and
  // dispatches `model.save_key`; the key never enters the webview.
  const onAddProviderKey = (slug: string) => bridge.post({ type: 'model.addKey', slug });

  // W4 §7 B6: the correlated panel fetch carries an EXPLICIT scope key,
  // captured HERE at issue time from the tab that's active RIGHT NOW —
  // never re-resolved from `state.activeTabId` when the promise later
  // settles (the ambient-active-session pattern B6 exists to kill). Every
  // request is also TAGGED with the issuing tab's id (Deliverable 5) so a
  // tab close can reject exactly its own in-flight requests.
  //
  // Correlated panel fetch (Part A2/X2): drives the panel's RemoteData
  // (loading → success via push / error via rejection). Also the Retry
  // handler. P7-N4 (ARCH I-1): the scope key / request params are resolved
  // by the exhaustive, unit-tested `resolvePanelRequest` (`state/panels.ts`)
  // — the if-chain this replaced fell through to the global shape for ANY
  // unrecognized panel, which would have silently under-scoped a FUTURE
  // session/root/cwd-scoped panel's fetch too.
  const requestPanel = (panel: DataPanel) => {
    const scopeTab = tab;
    const { scopeKey, rejectTag, params } = resolvePanelRequest(panel, scopeTab);
    void fetchPanel(
      panel,
      {
        request: (method, p) => bridge.request(method, p, rejectTag),
        dispatch: (action) => dispatch({ local: action }),
      },
      { scopeKey, req: { method: 'panel.data', params } },
    );
  };

  // Correlated toggle (W1.5): the Skills/Tools switches persist through the
  // dashboard REST channel and need the resolved/rejected result so the panel
  // can do optimistic write-through with rollback-on-error. Returns the
  // promise. F-1 (final-4way-fixes.md): Tools/Skills toggles are connection-
  // global (`tools`/`skills` own no single tab, per the panel-scope
  // taxonomy) — UNTAGGED, so closing an unrelated tab can never reject this
  // in-flight write and trigger a false optimistic-rollback.
  const toggle = (method: ControlMethod, params: Record<string, unknown>) =>
    bridge.request(method, params);

  // Correlated `checkpoint.restore` (Part A2 reference migration): resolves with
  // the tracker's result so the panel can honor the dirty-worktree guard.
  // W4 §2d (sync-4/B4-control): carries an EXPLICIT `rootId` — resolving via
  // an ambient active-session pointer would race `tab.activate` (restore
  // against the wrong worktree); a mismatch REFUSES host-side, never restores.
  const restoreCheckpoint = async (
    id: string,
    force?: boolean,
  ): Promise<CheckpointRestoreResult | undefined> => {
    const params: Record<string, unknown> = { id, rootId: tab.rootId };
    if (force) params.force = true;
    const result = await bridge.request('checkpoint.restore', params, tab.tabId);
    return result as CheckpointRestoreResult | undefined;
  };

  // CF-12 review fix (W3-T7): correlated `checkpoint.redo`/`checkpoint.redoAll`
  // — the panel's Redo/Redo-all callback props, wired the SAME way as
  // `restoreCheckpoint` immediately above (explicit `rootId` in params +
  // `tab.tabId` as the request tag). This replaced an earlier draft where
  // the panel fired these directly over a dynamically-imported `bridge`: that
  // draft omitted the tag entirely (so `bridge.rejectTab` on tab close could
  // never reject an in-flight redo — it hung until RPC timeout, then
  // resolved against whatever was on screen) and omitted `rootId` (accepted
  // only by the host's single-root convenience fallback). No checkpoint
  // `id`, unlike restore: redo/redoAll step/jump the tracker's own stored
  // cursor toward its anchor, never a panel-picked row.
  const redoCheckpoint = async (force?: boolean): Promise<CheckpointRestoreResult | undefined> => {
    const params: Record<string, unknown> = { rootId: tab.rootId };
    if (force) params.force = true;
    const result = await bridge.request('checkpoint.redo', params, tab.tabId);
    return result as CheckpointRestoreResult | undefined;
  };

  const redoAllCheckpoint = async (force?: boolean): Promise<CheckpointRestoreResult | undefined> => {
    const params: Record<string, unknown> = { rootId: tab.rootId };
    if (force) params.force = true;
    const result = await bridge.request('checkpoint.redoAll', params, tab.tabId);
    return result as CheckpointRestoreResult | undefined;
  };

  // A#5: MCP "Reload servers" over the CORRELATED path so the gateway's result
  // (`{status, message?}`) — or a failure — becomes visible in the panel,
  // instead of the old fire-and-forget that dropped both. The host still
  // re-fetches + re-pushes the server list when the reload actually
  // confirmed. F-1: `mcp` is connection-global (owns no tab) — UNTAGGED.
  const reloadMcp = () => bridge.request('reload.mcp', { confirm: true });

  // D3/N13: SettingsPanel's `config.set` over the CORRELATED path (the same
  // `toggle` pattern above) so a rejected/failed write resolves/rejects and
  // the row can roll back instead of lying — replaces the old fire-and-
  // forget `invoke('config.set', …)`, whose effect was only ever observable
  // through a server-initiated `panel.data` push that doesn't exist today.
  // F-1 (the Important finding this fix brief exists for): `settings` is
  // connection-global — this MUST be UNTAGGED. Tagging it with `tab.tabId`
  // (the pre-fix bug) meant closing tab A while a `config.set` issued from
  // tab A was still in flight rejected the promise via `rejectByTag`, even
  // though the host went on to persist the write — SettingsPanel then ran
  // its rollback and showed "Not saved" for a value that WAS saved.
  const setConfig = (key: string, value: string | number | boolean) =>
    bridge.request('config.set', { key, value });

  // R5 (Task 13): the «Next Edit Suggestions» toggles, over the HOST-INTERNAL
  // correlated `nextEdit.toggle` request — special-cased in the host router
  // before backend dispatch, so this never reaches Hermes (the toggles are
  // extension state, not agent config). Resolves with the newly ratified
  // state; REJECTS with the Guard's refusal message, which is what makes the
  // row's `rollbackField` snap the switch back and show the reason.
  //
  // F-1: the toggle store is CONNECTION-GLOBAL (one per extension, owned by
  // no chat tab) — this MUST be UNTAGGED, exactly like `setConfig` above. A
  // `tab.tabId` tag here would let an unrelated tab close reject a legitimate
  // in-flight toggle via `rejectByTag`, and the row would then show a refusal
  // for a toggle the Guard actually ratified. Locked in `rpc.test.ts`.
  const setNextEditToggle = (source: NextEditToggleSource, on: boolean) =>
    bridge.request('nextEdit.toggle', { source, on });

  // A#7/BF-A: Sessions "Load more" over the CORRELATED path (shows a loading
  // state + surfaces failure), replacing the old silent fire-and-forget
  // `session.list` that defeated X2. F-1: `sessions` is the one shared slice
  // across every tab (per the panel-scope taxonomy) — UNTAGGED, so this
  // in-flight pagination request survives an unrelated tab close.
  //
  // BF-A: this deliberately does NOT route through `fetchPanel` (which owns
  // `state.sessionsPanel`'s RemoteData) — a failed APPEND is scoped to the
  // increment, not the whole collection (mirrors TanStack
  // `useInfiniteQuery`'s `data.pages` staying intact on a failed
  // `fetchNextPage`, with `error`/`isFetchingNextPage` as separate signals).
  // Success still arrives via the server's `panel.data` PUSH (`foldPanelData`
  // 'sessions' -> `success(msg.data)`), so the request's resolve here is just
  // an ack; only the rejection needs handling, into `sessionsLoadMoreError`,
  // leaving `sessionsPanel` untouched.
  const loadMoreSessions = (cursor: string) => {
    setSessionsLoadingMore(true);
    setSessionsLoadMoreError(undefined); // clear any prior error when (re)trying
    const scopeTab = tab;
    const params: Record<string, unknown> = { cursor };
    if (scopeTab.sessionId) params.sessionId = scopeTab.sessionId;
    // Connection-global (a shared slice) → UNTAGGED per F-1, so a tab close
    // can't spuriously reject this pagination request.
    void bridge
      .request('session.list', params)
      .then(
        () => { /* the full list arrives via the panel.data push; nothing to store here */ },
        (err) => setSessionsLoadMoreError(errorMessage(err)),
      )
      .finally(() => setSessionsLoadingMore(false));
  };

  // W2 T2e (§2e/§3.1): the `@file`/`@folder` submenu's file source, threaded
  // into the Composer as a plain injected function — same posture as
  // `restoreCheckpoint`/`reloadMcp` above (a narrow, typed wrapper over the
  // correlated `bridge.request`, never the raw bridge/rpc client itself).
  // The host's response crosses `postMessage` as `unknown`; validated (not
  // blindly cast) before use, same as every other control-response payload.
  const searchFiles = async (query: string, maxResults?: number): Promise<string[]> => {
    const result = await bridge.request('context.searchFiles', { query, maxResults }, tab.tabId);
    return Array.isArray(result) ? result.filter((p): p is string => typeof p === 'string') : [];
  };

  const newSession = () => {
    dispatch({ local: { type: 'local.setPanel', panel: 'chat' } });
    // P7-N1 parity: today's clear-on-new-session behavior, now routed through
    // the reducer (the draft used to live in Composer's own useState, which
    // `newSession`'s local handler cleared directly — that state is gone now).
    dispatch({ local: { type: 'local.draft.clear', tabId: tab.tabId } });
    // W3-T6 (CF-11/D2): rebind ONLY this tab — leaves every sibling tab's
    // live turn untouched (the old `{type:'newSession'}` restarted the WHOLE
    // connection, ending every tab). `tab.sessionId` is a hint only; the
    // host always re-reads this tab's ACTUAL occupant before acting on it.
    bridge.post({ type: 'tab.newSession', tabId: tab.tabId, sessionId: tab.sessionId });
  };

  // Renamed from `selectTab` (W4): this switches a side PANEL, not a
  // chat-session tab — `PriorityTabs`/`selectPanel` vs `TabStrip`/`selectTab`
  // below (the naming collision the S0 `switchTab`->`switchPanel` rename
  // was pinned to kill).
  const selectPanel = (panel: Panel) => {
    dispatch({ local: { type: 'local.setPanel', panel } });
    // Fetch the panel's data over the correlated request path so a failure is
    // caught and shown as Error+Retry instead of an eternal spinner (Part X2).
    if (panel !== 'chat') requestPanel(panel);
  };

  // ---- chat-session tab lifecycle (W4 §2d/§2e Deliverable 2/5) ----

  // The tab strip's "+": mint a tabId client-side (one writer — App.tsx —
  // for both the optimistic local slice and the paired host post), add a
  // PENDING tab locally, then ask the host to actually open a session for
  // it. `tab.bound`/`tab.error` (already wired, D1/§7 B8) resolve it.
  const openTab = () => {
    if (state.tabOrder.length >= MAX_TABS) return;
    const tabId = mintTabId();
    dispatch({ local: { type: 'local.tab.open', tabId } });
    bridge.post({ type: 'tab.open', tabId });
  };

  // Switch the active CHAT tab (never confuse with `selectPanel` above).
  // §7 B11: also tells the host (`tab.activate`) — today a no-op host-side
  // (B6: panels re-scope via the EXPLICIT fetch scope, never ambient "active
  // tab" bookkeeping) but rides the wire for protocol completeness. The
  // re-fetch-only-the-open-panel half of B11 is the effect below, keyed off
  // `state.activeTabId`.
  const selectTab = (tabId: string) => {
    const target = state.tabs[tabId];
    dispatch({ local: { type: 'local.tab.select', tabId } });
    bridge.post({ type: 'tab.activate', tabId, sessionId: target?.sessionId });
  };

  // Close a chat tab: reject its in-flight RPCs (Deliverable 5 — a per-tab
  // sibling of `pagehide`'s whole-webview `rejectAll`), remove the local
  // slice, and tell the host to tear down its session (a no-op host-side if
  // the tab never bound one).
  const closeTab = (tabId: string) => {
    const target = state.tabs[tabId];
    bridge.rejectTab(tabId, 'Tab was closed.');
    dispatch({ local: { type: 'local.tab.close', tabId } });
    bridge.post({ type: 'tab.close', tabId, sessionId: target?.sessionId });
  };

  // W2 T4 (F-D): open the read-only, both-virtual editor diff preview for a
  // still-pending proposed edit. No local/optimistic state — the preview is
  // entirely host-owned (EditPreviewRegistry); this is fire-and-forget.
  const openDiff = useCallback(
    (toolId: string, path: string) => {
      bridge.post({ type: 'diff.open', sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER, toolId, path });
    },
    [tab.sessionId],
  );

  const globalPanels = state.globalPanels;
  // §2f: checkpoints/sessions are NOT per-tab — checkpoints share one
  // timeline per workspace root (keyed by the active tab's `rootId`);
  // sessions share one cwd-filtered slice across every tab.
  const checkpointsRemote = state.rootPanels[tab.rootId] ?? idle;

  return (
    <>
      <TabStrip
        tabs={state.tabOrder.map((id) => state.tabs[id]).filter((t): t is TabState => t !== undefined)}
        activeTabId={state.activeTabId}
        maxTabs={MAX_TABS}
        onSelect={selectTab}
        onClose={closeTab}
        onOpen={openTab}
        backendKind={state.backendKind}
        // W4-T6 (UI#14): the shared chat tabpanel (`CHAT_TABPANEL_ID`) is
        // only ever mounted while the chat side-panel itself is the active
        // one (see the `state.activePanel === 'chat'` wrapper below) — every
        // OTHER side panel unmounts it. TabStrip needs this to know when its
        // tabs' `aria-controls` would otherwise be a dangling IDREF.
        chatPanelMounted={state.activePanel === 'chat'}
      />

      {/* Audit-3 I-2 (Task A-3): persistent, non-dismissible mock-mode
          disclosure — driven by the same connection-global backendKind the
          pill above already reads; see MockNotice.tsx for the fork F-2(A)
          rationale. Deliberately NOT gated on hydration — the pre-hydrate
          'mock' boot default showing this notice is the documented honest-
          boot decision (types.ts D2/A2), self-correcting the instant
          hydrate/backend.state lands. */}
      {state.backendKind === 'mock' && <MockNotice />}

      <PriorityTabs active={state.activePanel} onSelect={selectPanel} />

      {/* Audit G-6 (WCAG 2.2 SC 4.1.2): both dismiss buttons contained only
          an <Icon>, so a screen reader announced "button" and nothing else.
          `SettingsPanel.tsx` already had the right pattern (Toggle's own
          `aria-label`) — these two banners just hadn't followed it. */}
      {state.systemError && (
        <ErrorBanner
          message={state.systemError.message}
          detail={state.systemError.detail}
          dismissLabel="Dismiss this message"
          onDismiss={() => dispatch({ local: { type: 'local.dismissSystemError' } })}
        />
      )}

      {tab.error && (
        <ErrorBanner
          message={tab.error.message}
          detail={tab.error.detail}
          dismissLabel="Dismiss this error"
          onDismiss={() => dispatch({ local: { type: 'local.dismissError', tabId: tab.tabId } })}
          // §7 B8: the never-resolves-composer killer — a rejected tab.open
          // gets a retry that re-attempts the SAME tabId (never mints a new
          // one). session-lost (a previously-bound/now-dead tab) gets NO
          // retry here — a re-attempt would just fail again since the
          // session itself is gone, not the connection; ARCH-1 (UI I-3)
          // routes it to the standing History row below instead.
          retry={
            tab.error.kind === 'open-failed'
              ? {
                  label: 'Retry',
                  onClick: () => {
                    dispatch({ local: { type: 'local.dismissError', tabId: tab.tabId } });
                    bridge.post({ type: 'tab.open', tabId: tab.tabId });
                  },
                }
              : undefined
          }
        />
      )}

      {/* Audit G-9: the standing route back. The banner above is dismissible;
          this row is not, and it survives the dismissal, so a tab that failed
          to open can always be retried instead of being silently dead. */}
      {!tab.error && tab.openFailed === true && tab.binding !== 'bound' && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-2xs text-muted">
          <Icon name="warning" size={12} className="flex-none text-warn" />
          <span className="min-w-0 flex-1">This chat never connected to the agent.</span>
          <button
            type="button"
            onClick={() => bridge.post({ type: 'tab.open', tabId: tab.tabId })}
            className="flex-none rounded border border-border px-1.5 py-0.5 text-2xs text-fg hover:bg-overlay"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* ARCH-1 (final review, UI I-3): the session-lost sibling of the G-9
          row above — same non-dismissible posture, but a lost session has no
          connection to retry (Reconnect would just fail again), so this
          routes to the real recovery surface instead of offering a fake
          retry. */}
      {!tab.error && tab.sessionLost === true && tab.binding !== 'bound' && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-2xs text-muted">
          <Icon name="warning" size={12} className="flex-none text-warn" />
          <span className="min-w-0 flex-1">This chat's session was lost when the agent restarted.</span>
          <button
            type="button"
            onClick={() => dispatch({ local: { type: 'local.setPanel', panel: 'sessions' } })}
            className="flex-none rounded border border-border px-1.5 py-0.5 text-2xs text-fg hover:bg-overlay"
          >
            History
          </button>
        </div>
      )}

      {state.activePanel === 'chat' && (
        <ErrorBoundary region="the chat view">
          {/* B2 item 4 (path doc §4 B2, "aria-controls trio"): the ChatView
              wrapper is the tabpanel side of the APG tabs association — TabStrip
              points every tab's `aria-controls` at `CHAT_TABPANEL_ID`, and this
              `aria-labelledby` resolves to the DOM id of whichever tab is
              currently active (`tabDomId`, shared with TabStrip.tsx so the two
              can never drift onto different literal strings). `role="tabpanel"`
              lives HERE, on this OUTER wrapper — B1's `role="log"` scroll
              container (ChatView.tsx) is a SEPARATE INNER element and is
              untouched; a tabpanel containing a log region is valid. The flex
              classes reproduce exactly what the wrapped content (ChatView's log
              div / Hero) already assumed of its parent (a `flex flex-col`
              ancestor sized via `flex-1`/`min-h-0`) — added here only so
              inserting this wrapper does not silently break that sizing. */}
          <div
            id={CHAT_TABPANEL_ID}
            role="tabpanel"
            aria-labelledby={tabDomId(state.activeTabId)}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* H3 M2: key by tabId so ChatView remounts on a tab SWITCH, resetting
                its internal scroll `pinnedRef` to true (a tab you enter lands on
                its newest item). A draft keystroke keeps the same tabId → same key
                → no remount, so P7-N1's `memo` still skips it. */}
            <ChatView
              key={tab.tabId}
              transcript={tab.transcript}
              onApproval={hostActions.respondApproval}
              onDiff={hostActions.resolveDiff}
              onOpenDiff={openDiff}
              onStarter={hostActions.sendPrompt}
              /* M1: same bound flag the Composer below is gated on (line ~454)
                 — a starter chip posts a prompt just like the composer, so a
                 pending/unbound tab (no session yet) must grey it out the same
                 way instead of dropping the click silently. */
              starterDisabled={tab.binding !== 'bound'}
            />
          </div>
          <Composer
            tabId={tab.tabId}
            draft={tab.draft}
            draftAttachments={tab.draftAttachments}
            onDraftChange={(text) => dispatch({ local: { type: 'local.draft.set', tabId: tab.tabId, text } })}
            onAttachAdd={(attachment) =>
              dispatch({ local: { type: 'local.draft.attach.add', tabId: tab.tabId, attachment } })
            }
            onAttachRemove={(attachmentId) =>
              dispatch({ local: { type: 'local.draft.attach.remove', tabId: tab.tabId, attachmentId } })
            }
            preset={tab.preset}
            modelLabel={modelLabel(state)}
            busy={tab.turnActive}
            disabled={tab.binding !== 'bound'}
            // ARCH-1 (final review, UI I-3): honest copy for a lost session —
            // "Connecting…" (the default) would be a lie here; nothing is
            // connecting, the route back is the History row above / New Chat.
            disabledPlaceholder={
              tab.sessionLost
                ? 'Session lost — load it again from History or start a new chat'
                : undefined
            }
            activeModeId={tab.activeModeId}
            availableModes={tab.availableModes}
            onSetMode={hostActions.setMode}
            initialHeight={composerHeight}
            onHeightChange={setComposerHeight}
            onSubmit={hostActions.sendDraft}
            onCancel={() => bridge.post({ type: 'cancel', sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER })}
            onSetPreset={hostActions.setPreset}
            onPickModel={() => selectPanel('models')}
            onNewSession={newSession}
            availableCommands={tab.availableCommands}
            searchFiles={searchFiles}
            pendingSeed={pendingSeed}
            onSeedApplied={() => setPendingSeed(null)}
          />
        </ErrorBoundary>
      )}

      {/* T-16 F9 (Tier-2 §12.1): each side panel below gets the SAME
          `role="tabpanel"` wrapper pattern the chat panel already has
          (ChatView's wrapper further down) — mirrored here rather than
          reused, since `chat`'s wrapper is already claimed by TabStrip's own
          chat-session tabs (see `panelTabpanelId`'s doc comment in
          PriorityTabs.tsx for why `chat` is the one exception that needs NO
          new wrapper). The wrapper sits OUTSIDE `ErrorBoundary`/`RemotePanel`
          so the tabpanel region exists — and is announced — in every state
          (loading/error/success), not only once data resolves. `flex min-h-0
          flex-1 flex-col` reproduces exactly what each panel's own
          `PanelShell` root already assumes of its parent (a flex-column
          ancestor sized via `flex-1`/`min-h-0`) — same classes ChatView's
          wrapper uses — so nesting one more level here does not change any
          panel's rendered size. */}
      {state.activePanel === 'tools' && (
        <div
          id={panelTabpanelId('tools')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('tools')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the Tools panel">
            <RemotePanel remote={globalPanels.tools} loadingHint="Loading tools…" onRetry={() => requestPanel('tools')}>
              {(data) => (
                <ToolsPanel
                  data={data}
                  onToggle={(name, enabled) => toggle('toolsets.toggle', { name, enabled })}
                />
              )}
            </RemotePanel>
          </ErrorBoundary>
        </div>
      )}
      {state.activePanel === 'mcp' && (
        <div
          id={panelTabpanelId('mcp')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('mcp')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the MCP panel">
            <RemotePanel remote={globalPanels.mcp} loadingHint="Loading servers…" onRetry={() => requestPanel('mcp')}>
              {(data) => <McpPanel data={data} onReload={reloadMcp} />}
            </RemotePanel>
          </ErrorBoundary>
        </div>
      )}
      {state.activePanel === 'skills' && (
        <div
          id={panelTabpanelId('skills')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('skills')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the Skills panel">
            <RemotePanel remote={globalPanels.skills} loadingHint="Loading skills…" onRetry={() => requestPanel('skills')}>
              {(data) => (
                <SkillsPanel
                  data={data}
                  onToggle={(name, enabled) => toggle('skills.toggle', { name, enabled })}
                  onRefresh={() => requestPanel('skills')}
                />
              )}
            </RemotePanel>
          </ErrorBoundary>
        </div>
      )}
      {state.activePanel === 'checkpoints' && (
        <div
          id={panelTabpanelId('checkpoints')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('checkpoints')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the Checkpoints panel">
            <RemotePanel
              remote={checkpointsRemote}
              loadingHint="Loading checkpoints…"
              onRetry={() => requestPanel('checkpoints')}
            >
              {(data) => (
                <CheckpointsPanel
                  data={data}
                  onRestore={restoreCheckpoint}
                  onRedo={redoCheckpoint}
                  onRedoAll={redoAllCheckpoint}
                />
              )}
            </RemotePanel>
          </ErrorBoundary>
        </div>
      )}
      {state.activePanel === 'subagents' && (
        <div
          id={panelTabpanelId('subagents')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('subagents')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the Subagents panel">
            <RemotePanel
              remote={tab.subagents}
              loadingHint="Loading subagents…"
              onRetry={() => requestPanel('subagents')}
            >
              {(data) => <SubagentsPanel data={data} />}
            </RemotePanel>
          </ErrorBoundary>
        </div>
      )}
      {state.activePanel === 'sessions' && (
        <div
          id={panelTabpanelId('sessions')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('sessions')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the Sessions panel">
            <RemotePanel
              remote={state.sessionsPanel}
              loadingHint="Loading sessions…"
              onRetry={() => requestPanel('sessions')}
            >
              {(data) => (
                <SessionsPanel
                  data={data}
                  activeTabId={state.activeTabId}
                  boundSessionIds={boundSessionIds}
                  activeTabHasLiveTurn={tab.turnActive}
                  onLoad={hostActions.loadSession}
                  onLoadMore={loadMoreSessions}
                  loadingMore={sessionsLoadingMore}
                  loadMoreError={sessionsLoadMoreError}
                />
              )}
            </RemotePanel>
          </ErrorBoundary>
        </div>
      )}
      {state.activePanel === 'models' && (
        <div
          id={panelTabpanelId('models')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('models')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the Models panel">
            <RemotePanel remote={globalPanels.models} loadingHint="Loading models…" onRetry={() => requestPanel('models')}>
              {(data) => (
                <ModelsPanel
                  data={data}
                  activeModelId={tab.currentModelId}
                  onSetModel={hostActions.setModel}
                  onAddProviderKey={onAddProviderKey}
                />
              )}
            </RemotePanel>
          </ErrorBoundary>
        </div>
      )}
      {/* F-7: Settings is the ONE panel not wrapped in a `RemotePanel` here,
          and deliberately so — it carries two sources with different owners.
          The «Next Edit Suggestions» toggles are extension `globalState`
          pushed over `nextEdit.state` and need no agent; the config.yaml
          sections come from the agent-backed `panel.data` fetch. Wrapping the
          whole panel gated BOTH on the agent, so a Hermes CLI that failed to
          start left the user with no way to turn Generic off (and these are
          not `settings.json` settings, by design).

          So `SettingsPanel` takes the RemoteData itself and applies the gate
          to the config half only. It is typed to require the un-narrowed
          union precisely so re-wrapping it here cannot typecheck; the
          structure is locked in `panels/SettingsPanel.test.ts`. */}
      {state.activePanel === 'settings' && (
        <div
          id={panelTabpanelId('settings')}
          role="tabpanel"
          aria-labelledby={panelTabDomId('settings')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ErrorBoundary region="the Settings panel">
            <SettingsPanel
              config={globalPanels.settings}
              onRetryConfig={() => requestPanel('settings')}
              onSetConfig={setConfig}
              nextEdit={state.nextEditToggles}
              onToggleNextEdit={setNextEditToggle}
            />
          </ErrorBoundary>
        </div>
      )}
    </>
  );
}
