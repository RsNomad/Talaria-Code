import type { HostToWebview, PanelDataMap } from '../protocol';
import type { AppState } from '../types';
import {
  applyPanelTransition,
  assertExhaustivePanel,
  isRefreshFailure,
  reducePanelAction,
  setPanelSuccess,
  type PanelAction,
} from './panels';
import { success, type RemoteData } from './remoteData';
import { foldSessionScoped } from './scopedFold';

/** `panel.data` routes by scope key (§2f): subagents -> the owning tab;
 * checkpoints -> `rootPanels[rootId]`; sessions -> the shared
 * `sessionsPanel`; everything else -> `globalPanels`.
 *
 * P7-N4 (ARCH I-1): every `DataPanel` is named explicitly — no bare
 * `default:`. The old `default: -> globalPanels` fallthrough would have
 * silently routed a FUTURE session/root/cwd-scoped panel to `globalPanels`
 * too (the exact cross-tab bleed `PANEL_SCOPE` exists to prevent);
 * `assertExhaustivePanel` (`./panels`) now closes the switch, so an
 * unhandled `DataPanel` is a `npm run typecheck -w webview` failure, not a
 * silent global write. See `panels.test.ts` for the non-vacuous proof. */
export function foldPanelData(state: AppState, msg: Extract<HostToWebview, { type: 'panel.data' }>): AppState {
  // Switch on the ALIASED discriminant (not `msg.panel` directly): `panel`
  // IS the tag `PanelDataMessage`'s union is keyed on, so exhausting it
  // narrows `msg` itself to `never` inside `default` — leaving no `.panel`
  // to read there. Assigning it to a local first keeps `msg` independently
  // narrowed per case (TS's aliased-discriminant control-flow analysis)
  // while giving the `default:` branch an actual panel value to report.
  const panel = msg.panel;
  switch (panel) {
    case 'subagents':
      // AU-61: the SAME fold step that lands the fresh success also clears
      // this tab's own standing refresh-failure signal — error is
      // scopeKey(tabId)-routed (reducePanelActionScoped), success here is
      // sessionId-routed (foldSessionScoped), both land on the same
      // TabState, so a single updater keeps them lockstep.
      // exactOptional prep (arm 1): clear subagentsRefreshError by omitting
      // the key, never by writing an explicit `undefined`.
      return foldSessionScoped(state, msg.sessionId, 'panel.data:subagents', (tab) => {
        const { subagentsRefreshError: _clearedSubagentsRefreshError, ...rest } = tab;
        return { ...rest, subagents: success(msg.data) };
      });
    case 'checkpoints': {
      const rootPanels = { ...state.rootPanels, [msg.rootId]: success(msg.data) };
      // AU-61: a fresh success push is one of the two ways THIS root's
      // checkpointsRefreshError entry clears (the other is a user dismiss).
      // No-op (same `state.checkpointsRefreshError` reference) when nothing
      // was set, mirroring the global-5 case below (:559-567) — a root that
      // never had a background-refresh failure never grows a spurious empty
      // entry.
      if (!state.checkpointsRefreshError?.[msg.rootId]) return { ...state, rootPanels };
      const checkpointsRefreshError = { ...state.checkpointsRefreshError };
      delete checkpointsRefreshError[msg.rootId];
      return { ...state, rootPanels, checkpointsRefreshError };
    }
    case 'sessions': {
      const sessionsPanel = success(msg.data);
      // AU-61: same no-op-when-unset posture as checkpoints above.
      if (!state.sessionsRefreshError) return { ...state, sessionsPanel };
      // exactOptional prep (arm 1): clear sessionsRefreshError by omitting
      // the key, never by writing an explicit `undefined`.
      const { sessionsRefreshError: _clearedSessionsRefreshError, ...rest } = state;
      return { ...rest, sessionsPanel };
    }
    // TI-3 (AU-42 Part B, scope decision): 'setup' stays on the plain path —
    // see `RefreshErrorPanel`'s doc (state/panels.ts) for why it carries no
    // `refreshError` side-map entry to clear here.
    case 'setup':
      return { ...state, globalPanels: setPanelSuccess(state.globalPanels, msg.panel, msg.data) };
    case 'tools':
    case 'mcp':
    case 'skills':
    case 'models':
    case 'settings': {
      const globalPanels = setPanelSuccess(state.globalPanels, msg.panel, msg.data);
      // TI-3 (AU-42 Part B): a fresh success push is one of the two ways a
      // panel's `refreshError` clears (the other is a user dismiss — see
      // `local.refreshError.dismiss` (`localReducer.ts`)). No-op (same
      // `state.refreshError` reference) when nothing was set, so a panel
      // that never had a background-refresh failure never grows a spurious
      // empty entry.
      if (!state.refreshError?.[msg.panel]) return { ...state, globalPanels };
      const refreshError = { ...state.refreshError };
      delete refreshError[msg.panel];
      return { ...state, globalPanels, refreshError };
    }
    default:
      return assertExhaustivePanel(panel);
  }
}

/** Route a scoped-panel loading/error transition (Part X2 no-flash rule) to
 * its real scope (§2f/§7 B6): subagents -> the tab named by `action.scopeKey`
 * (drop-unknown if it no longer exists — nothing reads a removed tab's slice
 * anyway); checkpoints -> `rootPanels[action.scopeKey]` (the ROOT captured at
 * fetch-issue time, NOT re-derived from whichever tab is active now — a
 * same-root sibling tab must keep seeing this transition even if the tab
 * that ISSUED the fetch has since closed); sessions -> the shared slot;
 * else -> globalPanels. `action.scopeKey` is fixed at issue time by
 * `fetchPanel`'s caller (`App.tsx`), never re-resolved here — this is the
 * fetch-side half of B6 (the push side is already scope-keyed by T3a).
 *
 * P7-N4 (ARCH I-1): every `DataPanel` is named explicitly — no bare
 * `default:`; see `foldPanelData`'s doc above (identical rationale) and
 * `panels.test.ts` for the non-vacuous `assertExhaustivePanel` proof. */
export function reducePanelActionScoped(state: AppState, action: PanelAction): AppState {
  switch (action.panel) {
    case 'subagents': {
      const tabId = action.scopeKey;
      if (!tabId) {
        console.warn('transcript: dropping subagents panel action with no scopeKey');
        return state;
      }
      const tab = state.tabs[tabId];
      if (!tab) {
        console.warn(`transcript: dropping subagents panel action for unknown tab "${tabId}"`);
        return state;
      }
      // AU-61: captured BEFORE the fold below — the same pre-fold `wasSuccess`
      // capture the global-5 case makes below (this function, the
      // tools/mcp/skills/models/settings case) — tells whether this tab's
      // subagents were already `success` (a background refresh) as opposed
      // to a first load (idle/loading/error), which never writes the signal
      // (AU-10: a first-load failure gets the visible error card instead).
      // FI-16: the `action.type === 'local.panelError' && wasSuccess` truth
      // value itself is single-sourced as `isRefreshFailure` (panels.ts) —
      // this scope (like checkpoints/sessions/global-5 below) still owns its
      // own `wasSuccess` capture, transition call, side-map shape, and
      // return assembly inline; only the guard predicate is shared.
      const wasSuccess = tab.subagents.status === 'success';
      const subagents = applyPanelTransition(tab.subagents, action);
      if (isRefreshFailure(action, wasSuccess)) {
        return { ...state, tabs: { ...state.tabs, [tabId]: { ...tab, subagents, subagentsRefreshError: action.message } } };
      }
      // CF-10: an honest empty landing (unbound-tab short-circuit) also
      // retires a standing signal — a stale "couldn't refresh" banner over a
      // fresh empty SUCCESS would lie (see `PanelAction.emptyData`'s doc).
      if (action.type === 'local.panelLoading' && action.emptyData !== undefined) {
        // exactOptional prep (arm 1): clear subagentsRefreshError by
        // omitting the key, never by writing an explicit `undefined`.
        const { subagentsRefreshError: _clearedSubagentsRefreshError, ...tabRest } = tab;
        return { ...state, tabs: { ...state.tabs, [tabId]: { ...tabRest, subagents } } };
      }
      // A plain `local.panelLoading` (background refetch in flight) does NOT
      // clear a standing signal — it survives until success or dismiss,
      // byte-consistent with the global-5 case's early return below.
      return { ...state, tabs: { ...state.tabs, [tabId]: { ...tab, subagents } } };
    }
    case 'checkpoints': {
      const rootId = action.scopeKey ?? '';
      const current: RemoteData<PanelDataMap['checkpoints']> = state.rootPanels[rootId] ?? { status: 'idle' };
      // AU-61: same pre-fold `wasSuccess` capture as the subagents/global-5
      // cases — see that case's doc.
      const wasSuccess = current.status === 'success';
      const next = applyPanelTransition(current, action);
      if (isRefreshFailure(action, wasSuccess)) {
        return {
          ...state,
          rootPanels: { ...state.rootPanels, [rootId]: next },
          checkpointsRefreshError: { ...state.checkpointsRefreshError, [rootId]: action.message },
        };
      }
      return { ...state, rootPanels: { ...state.rootPanels, [rootId]: next } };
    }
    case 'sessions': {
      // AU-61: same pre-fold `wasSuccess` capture as the subagents/
      // checkpoints/global-5 cases — see the subagents case's doc.
      const wasSuccess = state.sessionsPanel.status === 'success';
      const sessionsPanel = applyPanelTransition(state.sessionsPanel, action);
      if (isRefreshFailure(action, wasSuccess)) {
        return { ...state, sessionsPanel, sessionsRefreshError: action.message };
      }
      return { ...state, sessionsPanel };
    }
    // TI-3 (AU-42 Part B, scope decision): 'setup' stays on the plain path —
    // `reducePanelAction` above already applies the keep-data rule to it
    // (panel-agnostic), it just never gains a `refreshError` side-map entry.
    // See `RefreshErrorPanel`'s doc (state/panels.ts).
    case 'setup':
      return { ...state, globalPanels: reducePanelAction(state.globalPanels, action) };
    case 'tools':
    case 'mcp':
    case 'skills':
    case 'models':
    case 'settings': {
      // Captured BEFORE the fold below — this is what tells whether the
      // panel was already `success` (a background refresh) as opposed to a
      // first load (idle/loading/error), the same distinction
      // `reducePanelAction`'s own keep-data rule makes.
      const wasSuccess = state.globalPanels[action.panel]?.status === 'success';
      const globalPanels = reducePanelAction(state.globalPanels, action);
      if (!isRefreshFailure(action, wasSuccess)) {
        return { ...state, globalPanels };
      }
      // TI-3 (AU-42 Part B): the SAME fold step that just kept the
      // RemoteData (above) records the refresh-failure MESSAGE in the
      // side-map — mirrors BF-A's `sessionsLoadMoreError` (App.tsx), kept
      // OUTSIDE RemoteData so a background refresh failure never wipes the
      // loaded list, just surfaces a dismissible banner over it.
      return {
        ...state,
        globalPanels,
        refreshError: { ...state.refreshError, [action.panel]: action.message },
      };
    }
    default:
      return assertExhaustivePanel(action.panel);
  }
}
