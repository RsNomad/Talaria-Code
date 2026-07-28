/*
 * Tab metadata + History-load reconciliation (W4 §2e/§7 B9).
 * ------------------------------------------------------------------
 * `sessionToTab` is the reducer's routing-key resolver (transcript.ts's FIRST
 * step for every session-scoped message). `handleSessionChange` adopts
 * Continue's shape verbatim (`tabsSlice.ts` `Tab {id,title,isActive,
 * sessionId?}` + its `handleSessionChange` reconciliation, cited §8) with the
 * four B9 race rules layered on top:
 *  (a) a `pending` tab is NON-ADOPTABLE — a second reconciliation must not
 *      steal a tab whose `tab.bound`/`tab.load` reply is still in flight;
 *  (b) the caller (transcript.ts) folds the returned `tabs` immediately, so a
 *      registration is visible to `sessionToTab` before any replay stream —
 *      there is no separate "commit" step to race;
 *  (c) a tab dropped by the dedup filter that was pending/bound (a real or
 *      in-flight host session) is reported via `closeIntents` so the CALLER
 *      (the bridge, once wired) can send `tab.close` — this module stays
 *      pure and never posts anything itself;
 *  (d) the registry is simply `sessionToTab` over `tabs`, which already
 *      includes pending opens (a pending tab's optimistically-assigned
 *      `sessionId` is a real map entry, not deferred until `bound`).
 *
 * Pure, framework-agnostic TS — no React, no bridge, no side effects beyond a
 * `console.warn` dev-log on the one documented defensive no-op path.
 */
import { makeTabState, type AppState, type TabState } from '../types';

/** The reducer's routing-key resolver: sessionId -> owning tabId. Includes
 * PENDING tabs (B9(d)) — a tab need not be host-confirmed to be registered. */
export function sessionToTab(tabs: Record<string, TabState>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const tab of Object.values(tabs)) {
    if (tab.sessionId) map[tab.sessionId] = tab.tabId;
  }
  return map;
}

export interface HandleSessionChangeInput {
  currentSessionId: string;
  currentSessionTitle: string;
  /** Case 4 (new tab) only — lets the caller pin a deterministic id (e.g. the
   * `tabId` a `tab.bound`/`tab.load` message already named) instead of a
   * randomly-minted one. */
  newTabId?: string;
  /**
   * H1-I4: case 4 (new tab) only — the title for the brand-new tab this call
   * mints. `currentSessionTitle` is the RETITLE value for cases 1/2/3 (an
   * EXISTING tab legitimately renamed to the incoming session's title); case
   * 4 must NOT reuse it for a new tab (the S0-shim bug: `turn.start` passes
   * the ACTIVE tab's own title as `currentSessionTitle`, so a case-4 mint
   * that inherited it produced two tabs named identically). Falls back to
   * `currentSessionTitle` when omitted so callers that don't supply it keep
   * their old behavior.
   */
  newTabTitle?: string;
}

export interface HandleSessionChangeResult {
  tabs: Record<string, TabState>;
  tabOrder: string[];
  activeTabId: string;
  /**
   * B9(c): tabIds the dedup filter removed that had a real or in-flight host
   * session (`binding !== 'unbound'`) — the caller must `tab.close` each one
   * so the host session doesn't leak. Empty on every non-dedup case.
   *
   * W4-T3b note (honest scope): the loop below KEEPS every tab with a
   * truthy `sessionId` unconditionally (`tab.sessionId || id ===
   * existingTabId`), so a closeIntent's tab NEVER actually has one — it is
   * always a still-`pending`, `tab.bound` not yet arrived open. The
   * consumer therefore posts `tab.close{tabId}` with no `sessionId`, which
   * is honestly a no-op host-side TODAY for the specific async race where
   * the in-flight `tab.open` resolves AFTER this dedup already dropped its
   * tabId (the host would need to track pending-open tabIds to close the
   * session the moment it mints — architecture §2e note (d), explicitly
   * flagged there as bigger than this task's scope). Consuming the intent
   * (posting SOMETHING, draining the queue) is still correct and is what
   * this task wires; closing the async-race gap fully is a follow-up.
   */
  closeIntents: string[];
}

/** Fallback random id for case 4 when the caller supplies no `newTabId`, and
 * (W4-T3b) the tab strip's "+"/local.tab.open mint. Exported so App.tsx
 * mints the SAME shape of id it hands to both the local reducer action and
 * the paired `tab.open` post — one id, one writer. */
export function mintTabId(): string {
  return `tab-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Continue's `handleSessionChange` reconciliation, verbatim semantics (Q-5),
 * generalized to our split `tabs`/`tabOrder`/`activeTabId` shape:
 *  1. the active tab already owns `currentSessionId` -> retitle only;
 *  2. another tab already owns it -> activate that tab, retitle it, and drop
 *     every OTHER unassigned tab (Continue's blank-tab cleanup) — B9(c) pairs
 *     each dropped pending/bound tab with a close intent;
 *  3. the active tab is free to adopt (B9(a): `binding === 'unbound'`, not
 *     merely `!sessionId`) -> adopt `currentSessionId` into it, `pending`;
 *  4. otherwise (the active tab owns a different session, OR is itself
 *     pending/non-adoptable) -> open a new tab for this session, `pending`.
 */
export function handleSessionChange(
  state: Pick<AppState, 'tabs' | 'tabOrder' | 'activeTabId'>,
  input: HandleSessionChangeInput,
): HandleSessionChangeResult {
  const { tabs, tabOrder, activeTabId } = state;
  const { currentSessionId, currentSessionTitle, newTabId, newTabTitle } = input;
  const activeTab = tabs[activeTabId];

  if (!activeTab) {
    console.warn(`tabs: handleSessionChange — unknown active tab "${activeTabId}", ignoring`);
    return { tabs, tabOrder, activeTabId, closeIntents: [] };
  }

  // Case 1: the active tab already owns this session.
  if (activeTab.sessionId === currentSessionId) {
    return {
      tabs: { ...tabs, [activeTabId]: { ...activeTab, title: currentSessionTitle } },
      tabOrder,
      activeTabId,
      closeIntents: [],
    };
  }

  // Case 2: another tab already owns this session.
  const existingTabId = tabOrder.find((id) => tabs[id]?.sessionId === currentSessionId);
  if (existingTabId) {
    const nextTabs: Record<string, TabState> = {};
    const closeIntents: string[] = []; // see the doc above: always sessionId-less by construction
    for (const id of tabOrder) {
      const tab = tabs[id];
      if (!tab) continue;
      if (tab.sessionId || id === existingTabId) {
        nextTabs[id] = id === existingTabId ? { ...tab, title: currentSessionTitle } : tab;
      } else if (tab.binding !== 'unbound') {
        // B9(c): a pending/bound tab dropped here has a real or in-flight
        // host session — tell the caller to close it so it doesn't leak.
        closeIntents.push(id);
      }
      // A genuinely unbound tab (never opened host-side) is dropped silently
      // — there is nothing to leak.
    }
    return {
      tabs: nextTabs,
      tabOrder: tabOrder.filter((id) => id in nextTabs),
      activeTabId: existingTabId,
      closeIntents,
    };
  }

  // Case 3 (B9(a)): only a genuinely unbound active tab may adopt — a
  // `pending` tab already has an in-flight host request; adopting a SECOND
  // session into it would let that request's eventual `tab.bound` clobber
  // this binding and silently orphan the newly-adopted session.
  if (!activeTab.sessionId && activeTab.binding === 'unbound') {
    return {
      tabs: {
        ...tabs,
        [activeTabId]: {
          ...activeTab,
          sessionId: currentSessionId,
          binding: 'pending',
          title: currentSessionTitle,
        },
      },
      tabOrder,
      activeTabId,
      closeIntents: [],
    };
  }

  // Case 4: not adoptable — open a new tab for this session. H1-I4: the new
  // tab gets a FRESH title (`newTabTitle`), never `currentSessionTitle` — that
  // value is the case-1/2/3 RETITLE-an-EXISTING-tab value, and reusing it
  // here for a brand-new tab is exactly the S0-shim bug that named two tabs
  // identically. Falls back to `currentSessionTitle` only when the caller
  // supplies no `newTabTitle` (old callers unbroken).
  const id = newTabId ?? mintTabId();
  const created = makeTabState(id, newTabTitle ?? currentSessionTitle);
  const tab: TabState = { ...created, sessionId: currentSessionId, binding: 'pending' };
  return {
    tabs: { ...tabs, [id]: tab },
    tabOrder: [...tabOrder, id],
    activeTabId: id,
    closeIntents: [],
  };
}
