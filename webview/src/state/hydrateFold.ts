import type { HostToWebview, WebviewState } from '../protocol';
import { DEFAULT_PRESET, makeTabState, type AppState, type TabState } from '../types';
import { sessionToTab } from './tabs';

/**
 * W6-FF (3-way ARCH I-1): rebuild the ENTIRE tab model from `seed.tabs` — the
 * live host-side session list `hydrate` now carries whenever
 * `AcpBackend.listTabs()`'s registry is non-empty. VS Code's
 * `retainContextWhenHidden` is documented BEST-EFFORT
 * (`TalariaViewProvider.ts`): a memory-pressure dispose+recreate tears down
 * this webview instance and mounts a fresh one at `INITIAL_STATE` (one
 * unbound bootstrap tab) while N host `SessionController`s are still alive.
 * Without this, `sessionToTab` never learns about them and every subsequent
 * stream for them hits `foldSessionScoped`'s drop-unknown path — the orphan
 * this closes.
 *
 * NOT a parallel routing path: each seed entry is folded with the exact
 * bind shape `tab.bound`'s own fold uses (sessionId/binding/rootId on a
 * named tab, `foldTabScoped`'s posture) — so the moment this returns,
 * `sessionToTab` (every OTHER session-scoped message's FIRST step, via
 * `foldSessionScoped`) resolves every seed session to its real tab. P-1
 * isolation is therefore intact by construction: a later update for session
 * B still resolves through the SAME `sessionToTab` map this function wrote,
 * so it can only ever land on B's tab.
 *
 * A session already bound to a tab in the CURRENT (pre-hydrate) state keeps
 * that tab's live transcript/panels — only its rootId/binding are refreshed
 * (defensive: only reachable if `hydrate` fires twice on one still-live
 * webview instance, never the re-create case, which always starts from
 * `INITIAL_STATE`). Any local tab the seed doesn't name (the stale bootstrap
 * placeholder, on the common re-create path) is dropped — it owns no live
 * host session, so there is nothing to leak (mirrors `tabs.ts`'s own
 * "genuinely unbound tab dropped silently" posture, §7 B9(c)).
 *
 * H4-B8 (arch report Minor-2 — closes the accepted gap noted above): the
 * seed triple (+rootId) ALSO carries each tab's OWN
 * preset/currentModelId/activeModeId/availableCommands — sourced from that
 * SAME session's `SessionController` (`getPreset()`/`currentModelId`/
 * `activeCustomModeId`/`getAvailableCommands()`), the exact fields
 * `policy.state`/`mode.state`/`commands.available`/the model push already
 * emit for it. This is NOT a new source of truth, just exposing those
 * SAME host-owned values at hydrate time so a reconciled NON-active tab
 * shows its real display state immediately instead of `makeTabState`
 * defaults while it waits for its own next push (which, for a background
 * tab, may not come for a long time). Each seed entry's values populate
 * ONLY that entry's own tab (P-1) — an absent field falls back to
 * `makeTabState`'s own default for that field, mirroring the legacy
 * single-tab `foldHydrate` path below. `title` is deliberately untouched
 * here (paired backlog M7, carried out of this task).
 */
function foldHydrateReconcile(state: AppState, seed: WebviewState): AppState {
  const seedTabs = seed.tabs ?? [];
  const priorTabForSession = sessionToTab(state.tabs);
  const tabs: Record<string, TabState> = {};
  const tabOrder: string[] = [];

  seedTabs.forEach((entry, index) => {
    const priorTabId = priorTabForSession[entry.sessionId];
    const rawBase =
      (priorTabId ? state.tabs[priorTabId] : undefined) ??
      state.tabs[entry.tabId] ??
      makeTabState(entry.tabId, state.restoredTitles?.[entry.tabId] ?? `Chat ${index + 1}`);
    // UX-04a (261faba lesson, mirrors `stopPending: false` below): unlike
    // `stopPending` (a real boolean), `newSessionPending` is exactOptional
    // (`?: true`) — cleared by KEY OMISSION so a second hydrate on a
    // still-live webview can never leak a stale "Starting a new session…"
    // through `...base` (its own `tab.bound`/`tab.error` terminal already
    // resolved it if that flow completed; if it hasn't yet, this very
    // reconcile IS the fresh bind, so the flag is moot either way).
    const { newSessionPending: _clearedNewSessionPending, ...base } = rawBase;
    tabs[entry.tabId] = {
      ...base,
      tabId: entry.tabId,
      sessionId: entry.sessionId,
      binding: 'bound',
      rootId: entry.rootId,
      preset: entry.preset ?? DEFAULT_PRESET,
      currentModelId: entry.currentModelId ?? null,
      activeModeId: entry.activeModeId ?? null,
      availableCommands: entry.availableCommands ?? [],
      // A5 (T-1 V-12 seed fold-in): this tab's OWN live-turn status —
      // absent falls back to makeTabState's `false` default, same posture
      // as every other optional display field above.
      turnActive: entry.turnActive ?? false,
      // T10 Opus review fix: `stopPending` is deliberately NOT hydrate-carried
      // (no `HydrateTabSeed.stopPending` field exists) — reset it here
      // structurally, symmetric with `turnActive` above, so `...base` can
      // never leak a still-live tab's in-flight-Stop flag through a second
      // hydrate on a still-live webview (its `turn.end` already landed
      // `turnActive: false` via the fold above; without this line
      // `stopPending: true` alone would ride `...base` and paint a
      // "Stopping…" that outlives its turn).
      stopPending: false,
      // AUDIT-5 UI M-2: a LIVE draft on `base` (already spread in above) always
      // wins — `restoredDrafts` only fills a freshly-minted `makeTabState` base
      // (draft: ''), giving an unsent Composer draft back after a
      // memory-pressure webview dispose+recreate. Never restores
      // `draftAttachments` (see `persist.ts`).
      draft: base.draft || state.restoredDrafts?.[entry.tabId] || '',
    };
    tabOrder.push(entry.tabId);
  });

  const firstTabId = tabOrder[0];
  const activeTabId =
    firstTabId === undefined ? state.activeTabId : tabOrder.includes(state.activeTabId) ? state.activeTabId : firstTabId;

  // H1-A1 + D1 (M7): a subsequent `tab.open`'s `nextChatNumber` must not
  // collide with a reconciled `Chat N` title, so seed it to a safe monotonic
  // continuation past the reconciled set. D1 widens this to `Math.max` with
  // `state.nextChatNumber` (already on `state` via `createInitialState`'s
  // restore, when `getState()` persisted one before this recreate) — a
  // restored counter is NEVER rolled back below the reconciled set, so a
  // post-recreate mint can never collide with a restored `Chat N` title
  // either (the pure `tabOrder.length + 1` floor alone only protects against
  // the freshly-generated fallback titles, not a HIGHER restored counter).
  const nextChatNumber = Math.max(state.nextChatNumber, tabOrder.length + 1);

  return {
    ...state,
    theme: seed.theme,
    backendKind: seed.backendKind,
    activePanel: seed.activePanel,
    tabs,
    tabOrder,
    activeTabId,
    nextChatNumber,
  };
}

/** `hydrate` rehydrates the ACTIVE tab's per-tab scalars (sessionId, preset,
 * modelId, availableCommands) — NOT transcripts (R-C4's honest single-session
 * stance kept). P3: a `null`/absent seed for sessionId/currentModelId/
 * availableCommands means "no information — keep the live value" (the host
 * keeps no persisted transcript-adjacent value to send today); a real seed
 * IS information and wins. W6-FE Part 1 (3-way ARCH I-3b): `availableCommands`
 * moved here from App.tsx's old GLOBAL `useState` — now folded onto the
 * ACTIVE tab exactly like `preset`/`currentModelId`, closing the same
 * cross-tab-clobber class this task's `commands.available` fix closes.
 *
 * W6-FF (3-way ARCH I-1): a NON-EMPTY `seed.tabs` means the host registry has
 * live sessions to reconcile (the webview re-create case) — delegates to
 * {@link foldHydrateReconcile} instead of this single-active-tab scalar
 * fold. An absent/empty `seed.tabs` (genuine cold boot, or a backend with no
 * multi-tab registry) leaves this legacy path — and every existing R-C4/P3
 * guarantee it makes — completely unchanged. */
export function foldHydrate(state: AppState, s: HostToWebview & { type: 'hydrate' }): AppState {
  const seed = s.state;
  if (seed.tabs && seed.tabs.length > 0) {
    return foldHydrateReconcile(state, seed);
  }
  const activeTab = state.tabs[state.activeTabId];
  if (!activeTab) {
    console.warn(`transcript: hydrate — unknown active tab "${state.activeTabId}"`);
    return { ...state, theme: seed.theme, backendKind: seed.backendKind, activePanel: seed.activePanel };
  }
  return {
    ...state,
    theme: seed.theme,
    backendKind: seed.backendKind,
    activePanel: seed.activePanel,
    tabs: {
      ...state.tabs,
      [state.activeTabId]: {
        ...activeTab,
        currentModelId: seed.currentModelId ?? activeTab.currentModelId,
        preset: seed.preset,
        availableCommands: seed.availableCommands ?? activeTab.availableCommands,
        // exactOptional prep (arm 1): only overwrite `sessionId` when the
        // seed actually carries one (`WebviewState.sessionId` is `string |
        // null`, never absent — `null` means "no information", per this
        // function's own doc) — when it's `null`, `...activeTab` above
        // already preserves the existing value (present or absent) exactly
        // as the old `seed.sessionId ?? activeTab.sessionId` fallback did.
        ...(seed.sessionId !== null ? { sessionId: seed.sessionId } : {}),
      },
    },
  };
}
