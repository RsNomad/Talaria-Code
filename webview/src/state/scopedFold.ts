import type { AppState, TabState } from '../types';
import { sessionToTab } from './tabs';

/** Resolve `sessionId` to a known tab and fold `updater` into it; DROP
 * (dev-log, unchanged state) when the session is not registered to any tab —
 * the P-1 isolation guarantee. Never `!`/`as` past the missing-tab case. */
export function foldSessionScoped(
  state: AppState,
  sessionId: string,
  msgType: string,
  updater: (tab: TabState) => TabState,
): AppState {
  const tabId = sessionToTab(state.tabs)[sessionId];
  if (!tabId) {
    console.warn(`transcript: dropping "${msgType}" for unknown session "${sessionId}"`);
    return state;
  }
  const tab = state.tabs[tabId];
  if (!tab) {
    // sessionToTab resolves via the tab OBJECT's own `.tabId` field, not the
    // map key it happens to be stored under — this second guard is the one
    // that actually protects the invariant if those ever diverge (defensive;
    // never `!`/`as` past a missing tab, symmetric with foldTabScoped below).
    console.warn(`transcript: dropping "${msgType}" for session "${sessionId}" — resolved tabId "${tabId}" is not a live tab`);
    return state;
  }
  return { ...state, tabs: { ...state.tabs, [tabId]: updater(tab) } };
}

/** Resolve a tabId directly (tab-lifecycle messages that already name their
 * target) and fold `updater` into it; drop-unknown otherwise. */
export function foldTabScoped(
  state: AppState,
  tabId: string,
  msgType: string,
  updater: (tab: TabState) => TabState,
): AppState {
  const tab = state.tabs[tabId];
  if (!tab) {
    console.warn(`transcript: dropping "${msgType}" for unknown tab "${tabId}"`);
    return state;
  }
  return { ...state, tabs: { ...state.tabs, [tabId]: updater(tab) } };
}
