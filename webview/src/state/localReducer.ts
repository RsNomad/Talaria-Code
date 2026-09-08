import type { Attachment, Panel } from '../protocol';
import { MAX_TABS } from '../protocol';
import { makeTabState, type AppState, type ApprovalItem } from '../types';
import type { PanelAction, RefreshErrorPanel } from './panels';
import { findOptionId } from './approvalOptions';
import { reducePanelActionScoped } from './panelScopeFold';
import { foldTabScoped } from './scopedFold';

/** Local UI-only mutations that never leave the webview (optimistic updates). */
export type LocalAction =
  // P7-N2N5 (ARCH I-2, the webview-half of the ambient-active-tab class the
  // host side was already forbidden from using): EXPLICIT `tabId`, captured
  // by the caller at dispatch time — never re-resolved from ambient
  // `state.activeTabId` at fold time. A host message (e.g. `turn.start`
  // adopting a new session) can move `activeTabId` between an optimistic
  // dispatch and its fold; folding via `foldTabScoped` (below) means the
  // change always lands on the tab the user actually acted on, never
  // whichever tab happens to be active when the reducer runs.
  | { type: 'local.approvalResolved'; tabId: string; id: string; optionId: string }
  | { type: 'local.diffResolved'; tabId: string; toolId: string; hunkIndex: number; action: 'accept' | 'reject' }
  | { type: 'local.setPanel'; panel: Panel }
  | { type: 'local.setModel'; tabId: string; modelId: string }
  | { type: 'local.dismissError'; tabId: string }
  | { type: 'local.dismissSystemError' }
  // W4 §2e (Deliverable 5): the tab strip's local half — the CALLER pairs
  // each with the matching WebviewToHost post (`tab.open`/`tab.close`);
  // this reducer never posts anything itself.
  | { type: 'local.tab.open'; tabId: string }
  | { type: 'local.tab.select'; tabId: string }
  | { type: 'local.tab.close'; tabId: string }
  // §7 B9(c): clears the queue once the caller has posted `tab.close` for
  // every entry `handleSessionChange`'s dedup produced.
  | { type: 'local.closeIntentsDrained' }
  // P7-N1 (Critical wrong-session-send fix, ARCH S-1): the per-tab composer
  // draft, lifted out of `Composer`'s component-local `useState` into
  // `TabState`. Each carries an EXPLICIT `tabId` captured by the caller at
  // dispatch time (never re-resolved from ambient `activeTabId` at fold
  // time — these were the FIRST N2-pattern LocalActions; P7-N2N5 above
  // migrated the remaining ambient-active ones to the same shape), folded
  // via the same `foldTabScoped` drop-unknown discipline every tab-lifecycle
  // message uses, so a draft action for tab X can only ever touch tab X, P-1).
  | { type: 'local.draft.set'; tabId: string; text: string }
  | { type: 'local.draft.attach.add'; tabId: string; attachment: Attachment }
  | { type: 'local.draft.attach.remove'; tabId: string; attachmentId: string }
  | { type: 'local.draft.clear'; tabId: string }
  // TI-1 (AU-39): the History row's committed load — dispatched by
  // `useHostActions.loadSession` the moment it posts `tab.load` (never on
  // just opening the live-turn confirm strip). See `AppState
  // .pendingSessionLoad`'s own doc for the clearing half (the `tab.bound`/
  // `tab.error` cases in `transcript.ts`'s `reduce`).
  | { type: 'local.sessionLoad.start'; tabId: string; sessionId: string }
  // UX-04b: the webview-side watchdog's own fallback timeout — DEFENSE IN
  // DEPTH over WS-R4's host-side `SESSION_ESTABLISH_DEADLINE_MS` (120s):
  // this fires (`useSessionLoadWatchdog`, `hooks/useSessionLoadWatchdog.ts`)
  // only when NO host terminal (`tab.bound`/`tab.error`) ever arrives for
  // the pending load at all. Carries no `tabId` — the hook is armed against
  // the CURRENT `pendingSessionLoad` snapshot already, so there is nothing
  // left to match; the fold below clears it unconditionally, same as
  // `local.dismissSystemError`'s single-slot clear just below.
  | { type: 'local.sessionLoad.timeout' }
  // TI-3 (AU-42 Part B): dismisses one panel's `refreshError` banner — the
  // OTHER way it clears besides that panel's next success push (see
  // `AppState.refreshError`'s own doc). `panel` is scoped to
  // {@link RefreshErrorPanel}, never a bare `DataPanel` — a dismiss for a
  // panel outside this task's scope (e.g. `'setup'`) would be meaningless
  // (no entry to clear) and this keeps that a compile-time impossibility.
  | { type: 'local.refreshError.dismiss'; panel: RefreshErrorPanel }
  // AU-61: dismisses ONE of the three re-scoped panels' own refreshError
  // signal (`AppState.sessionsRefreshError` / `.checkpointsRefreshError` /
  // `TabState.subagentsRefreshError`) — the scoped counterpart to
  // `local.refreshError.dismiss` above. A SEPARATE action, not a reuse of
  // that one, because it is TYPE-MANDATORY (Critic-1): `RefreshErrorPanel`
  // is `Exclude<GlobalPanel,'setup'>` and `GlobalPanel` derives from
  // `PANEL_SCOPE` (`protocol.ts`), where subagents/checkpoints/sessions are
  // 'session'/'root'/'cwd'-scoped, NOT members of `GlobalPanel` — they
  // cannot type-check as a `RefreshErrorPanel`. `target` carries each
  // scope's own key shape (none for sessions' single slot, `rootId` for
  // checkpoints, `tabId` for subagents) so a dismiss for the wrong shape is
  // a compile-time impossibility, same discipline `scopeKey` uses on the
  // fetch side (B6).
  | {
      type: 'local.scopedRefreshError.dismiss';
      target: { panel: 'sessions' } | { panel: 'checkpoints'; rootId: string } | { panel: 'subagents'; tabId: string };
    }
  // UX-03: Stop clicked — paired by the caller with the 'cancel' post (this reducer never posts).
  | { type: 'local.stopPending'; tabId: string }
  // UX-04a: New Session clicked — paired by the caller (App.newSession) with
  // the 'tab.newSession' post that follows (this reducer never posts).
  | { type: 'local.newSessionPending'; tabId: string }
  // Part X2: a panel's own loading/error transitions (fed by fetchPanel).
  | PanelAction;

export function reduceLocal(state: AppState, action: LocalAction): AppState {
  switch (action.type) {
    case 'local.setModel':
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({ ...tab, currentModelId: action.modelId }));
    case 'local.approvalResolved':
      // T-A1 (V-6) authority guard: an item the host (or a prior reject-fold)
      // has already settledOutcome-ed can never be overwritten by an
      // optimistic click — authoritative always wins.
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({
        ...tab,
        transcript: tab.transcript.map((i) =>
          i.kind === 'approval' && i.id === action.id && i.settledOutcome === undefined
            ? { ...i, resolvedOptionId: action.optionId }
            : i,
        ),
      }));
    case 'local.diffResolved':
      return foldTabScoped(state, action.tabId, action.type, (tab) => {
        const approval = tab.transcript.find(
          (i): i is ApprovalItem => i.kind === 'approval' && i.toolId === action.toolId,
        );
        // T-A1 (V-6) authority guard — same rule as local.approvalResolved.
        if (approval?.settledOutcome !== undefined) return tab;

        if (action.action === 'reject') {
          // T-A1 (V-7): a hunk reject denies the WHOLE edit (mirrors the
          // host's own `resolveDiff` reject — SessionController.ts — which
          // denies every remaining hunk, not just the one clicked). Every
          // sibling hunk without its own explicit resolution is locked
          // (`hunksLocked`), kept DISTINCT from an explicit per-hunk
          // `'reject'` entry; the approval is optimistically resolved to its
          // deny option, later reconfirmed by the host's own
          // `approval.settle` echo.
          const denyOptionId = approval ? findOptionId(approval.options, 'deny') : undefined;
          return {
            ...tab,
            transcript: tab.transcript.map((i) => {
              if (i.kind === 'tool' && i.toolId === action.toolId) {
                return {
                  ...i,
                  resolvedHunks: { ...(i.resolvedHunks ?? {}), [action.hunkIndex]: 'reject' },
                  hunksLocked: true,
                };
              }
              if (i.kind === 'approval' && i.toolId === action.toolId && denyOptionId !== undefined) {
                return { ...i, resolvedOptionId: denyOptionId, settledOutcome: 'selected' as const };
              }
              return i;
            }),
          };
        }

        return {
          ...tab,
          transcript: tab.transcript.map((i) =>
            i.kind === 'tool' && i.toolId === action.toolId
              ? { ...i, resolvedHunks: { ...(i.resolvedHunks ?? {}), [action.hunkIndex]: action.action } }
              : i,
          ),
        };
      });
    case 'local.setPanel':
      return { ...state, activePanel: action.panel };
    case 'local.dismissError':
      // exactOptional prep (arm 1): clear `error` by omitting the key.
      return foldTabScoped(state, action.tabId, action.type, (tab) => {
        const { error: _clearedError, ...rest } = tab;
        return rest;
      });
    case 'local.sessionLoad.start':
      return { ...state, pendingSessionLoad: { tabId: action.tabId, sessionId: action.sessionId } };
    case 'local.sessionLoad.timeout': {
      // UX-04b: clears `pendingSessionLoad` by key omission — the same
      // exactOptional discipline `clearResolvedSessionLoad` (above) already
      // uses for the host-terminal half; this is the webview watchdog's own
      // fallback half. Nothing else in state changes.
      const { pendingSessionLoad: _clearedPendingSessionLoadOnTimeout, ...rest } = state;
      return rest;
    }
    case 'local.dismissSystemError': {
      // exactOptional prep (arm 1): clear by omitting the key.
      const { systemError: _clearedSystemError, ...rest } = state;
      return rest;
    }
    case 'local.panelLoading':
    case 'local.panelError':
      return reducePanelActionScoped(state, action);

    case 'local.refreshError.dismiss': {
      if (!state.refreshError?.[action.panel]) return state; // nothing to clear
      const refreshError = { ...state.refreshError };
      delete refreshError[action.panel];
      return { ...state, refreshError };
    }

    // AU-61: the scoped counterpart above — see `LocalAction`'s doc for why
    // this is a separate, discriminated action.
    case 'local.scopedRefreshError.dismiss': {
      const { target } = action;
      switch (target.panel) {
        case 'sessions': {
          if (!state.sessionsRefreshError) return state; // nothing to clear
          // exactOptional prep (arm 1): clear by omitting the key.
          const { sessionsRefreshError: _clearedSessionsRefreshError, ...rest } = state;
          return rest;
        }
        case 'checkpoints': {
          if (!state.checkpointsRefreshError?.[target.rootId]) return state; // nothing to clear
          const checkpointsRefreshError = { ...state.checkpointsRefreshError };
          delete checkpointsRefreshError[target.rootId];
          return { ...state, checkpointsRefreshError };
        }
        case 'subagents':
          // foldTabScoped's own drop-unknown discipline (dev-log + unchanged
          // state) covers the "unknown tab" case for free — same posture the
          // design doc calls for (mirrors transcript.ts's subagents
          // drop-unknown path).
          // exactOptional prep (arm 1): clear by omitting the key.
          return foldTabScoped(state, target.tabId, action.type, (tab) => {
            const { subagentsRefreshError: _clearedSubagentsRefreshError, ...rest } = tab;
            return rest;
          });
      }
    }

    case 'local.tab.open': {
      // MAX_TABS is primarily a UI admission check (the tab strip's "+"
      // disables at the cap) — this is the defensive backstop so a stray
      // dispatch past the cap can never corrupt state.
      if (state.tabs[action.tabId] || state.tabOrder.length >= MAX_TABS) return state;
      // H1-A1: `Chat ${nextChatNumber}`, NOT `tabOrder.length + 1` — the
      // count-based scheme collides after a middle tab closes (a freed `N`
      // gets re-minted by the next open, producing a duplicate title).
      // `nextChatNumber` only ever increments, never reused/decremented.
      const created = { ...makeTabState(action.tabId, `Chat ${state.nextChatNumber}`), binding: 'pending' as const };
      return {
        ...state,
        tabs: { ...state.tabs, [action.tabId]: created },
        tabOrder: [...state.tabOrder, action.tabId],
        activeTabId: action.tabId,
        nextChatNumber: state.nextChatNumber + 1,
      };
    }

    case 'local.tab.select': {
      if (!state.tabs[action.tabId]) {
        console.warn(`transcript: local.tab.select — unknown tab "${action.tabId}"`);
        return state;
      }
      return { ...state, activeTabId: action.tabId };
    }

    case 'local.tab.close': {
      const removed = state.tabs[action.tabId];
      if (!removed) return state;
      if (state.tabOrder.length <= 1) {
        // The UI already gates this (TabStrip's "x" only renders past one
        // tab) — this is a defensive backstop, never leaving zero tabs.
        console.warn('transcript: local.tab.close — refusing to close the last remaining tab');
        return state;
      }
      const tabs = Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== action.tabId));
      const tabOrder = state.tabOrder.filter((id) => id !== action.tabId);
      // H1-M6: closing the ACTIVE tab activates the editor-convention
      // neighbor — the right neighbor (whatever now sits at the closed tab's
      // former index), or the left neighbor (the new last) when the closed
      // tab was last. Only applies when the CLOSED tab was active; closing a
      // non-active tab leaves activeTabId untouched (existing behavior kept).
      let activeTabId = state.activeTabId;
      if (state.activeTabId === action.tabId) {
        const closedIdx = state.tabOrder.indexOf(action.tabId);
        activeTabId = tabOrder[Math.min(closedIdx, tabOrder.length - 1)] ?? tabOrder[0] ?? state.activeTabId;
      }
      return { ...state, tabs, tabOrder, activeTabId };
    }

    case 'local.closeIntentsDrained':
      return { ...state, closeIntents: [] };

    // P7-N1: the four draft.* actions — see the LocalAction union doc above
    // for why each carries an explicit tabId and folds through foldTabScoped.
    case 'local.draft.set':
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({ ...tab, draft: action.text }));

    case 'local.draft.attach.add':
      // Additive at the reducer (not "set the whole array"): addFiles'
      // FileReader.onload resolves ASYNCHRONOUSLY — a whole-array controlled
      // write from the component could capture a stale `draftAttachments`
      // prop and drop a sibling file when two readers resolve close
      // together. This append is atomic per dispatch.
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({
        ...tab,
        draftAttachments: [...tab.draftAttachments, action.attachment],
      }));

    case 'local.draft.attach.remove':
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({
        ...tab,
        draftAttachments: tab.draftAttachments.filter((a) => a.id !== action.attachmentId),
      }));

    case 'local.draft.clear':
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({ ...tab, draft: '', draftAttachments: [] }));

    case 'local.stopPending':
      // UX-03: only meaningful while a turn is live — a stray dispatch on an
      // idle tab must not paint a "Stopping…" nothing will ever clear.
      return foldTabScoped(state, action.tabId, action.type, (tab) =>
        tab.turnActive ? { ...tab, stopPending: true } : tab,
      );

    case 'local.newSessionPending':
      // UX-04a: unlike stopPending, unconditional — New Session is legal on
      // any tab (bound or not, idle or live-turn; Composer's own Task-11
      // confirm gate is what asks first while busy, not this fold). Cleared
      // by `tab.bound`/`tab.error` below (exhaustive terminals for the
      // `tab.newSession` post App.newSession issues right after this).
      // WS-UX P2 M1 (deliberate non-fix): this fold does NOT touch
      // `sessionLost`/`sessionLostReason`/`openFailed`. Those are host-owned
      // truth with exactly two retirers (`tab.bound`, `tab.clear`) — a local
      // optimistic action must never become a third writer, or a lost
      // `tab.newSession` post would strand the tab with its recovery
      // affordances stripped and no way to rebuild them. While the request
      // is in flight, App.tsx GATES the two standing recovery rows on this
      // flag instead (render priority, not state mutation).
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({ ...tab, newSessionPending: true }));

    default:
      return state;
  }
}
