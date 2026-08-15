/*
 * P7-N2N5: the app action funnel — owns each (optimistic dispatch, bound
 * host post) pair so:
 *   (a) every post is correctly BOUND (N2) — `App.tsx:552` used to pass the
 *       raw `bridge.post` method reference straight into `SessionsPanel`'s
 *       `onLoad` prop; `Bridge.post` reads `this.vscode`/`this.mockHandler`,
 *       so a detached call threw `TypeError: Cannot read properties of
 *       undefined` the moment a History row was clicked (`bridge.test.ts`
 *       locks the exact crash shape). Every export below is either a bound
 *       arrow closure or reads no `this` at all.
 *   (b) every optimistic `LocalAction` carries the EXPLICIT `tabId` this
 *       hook was called with — captured fresh on every render — never
 *       re-resolved from ambient `state.activeTabId` at fold time (N5, ARCH
 *       I-2): a host message (e.g. `turn.start` adopting a new session)
 *       can move `activeTabId` between an optimistic dispatch and its
 *       fold; `foldTabScoped` (state/transcript.ts) means the change always
 *       lands on the tab the user actually acted on. Same shape P7-N1's
 *       `local.draft.*` actions established.
 *
 * Deliberately thin, same posture as `composer/useFileSearch.ts` /
 * `composer/useSuggest.ts`: this repo's vitest has no jsdom/RTL, so
 * rendering this hook is build-blind. Its correctness follows from (1) the
 * exhaustively reducer-tested `LocalAction` shapes it dispatches
 * (`state/transcript.test.ts`'s P7-N2N5 suite), (2) the `bridge.test.ts`
 * lock that a bound wrapper never loses `this`, and (3) `npm run build` +
 * `check-types` + read-review of the JSX call sites in `App.tsx`.
 */
import { useCallback } from 'react';
import { bridge } from '../bridge';
import type { Attachment, ContextRef, EditPolicyPreset, Panel, WebviewToHost } from '../protocol';
import type { LocalAction } from '../state/transcript';
import type { TabState } from '../types';

/**
 * W4 §2d: every session-scoped `WebviewToHost` message carries a required
 * `sessionId`. Before a tab's first turn starts, its `sessionId` is
 * `undefined`; this placeholder is provably inert for that window because
 * `AcpBackend`'s own admission guards (`!this.client || !this.sessionId`)
 * short-circuit BEFORE reading the caller-supplied value whenever no
 * session is live yet (see `App.tsx`'s identical constant + fuller doc —
 * duplicated deliberately: a one-line literal, not a contract that needs a
 * single shared source of truth).
 */
const UNBOUND_SESSION_PLACEHOLDER = '';

export interface HostActions {
  /** Plain send (ChatView's empty-transcript Hero starter) — no optimistic draft-clear. */
  sendPrompt: (text: string, attachments?: Attachment[], mentions?: ContextRef[]) => void;
  /** P7-N1, housed here per the funnel plan: the Composer's real submit —
   * posts the prompt. ARCH-1 (final review, UI I-3): no optimistic draft
   * clear here (that used to destroy the user's text on a refused send) —
   * the HOST's `user` admission echo clears the draft, exact-match guarded
   * (`transcript.ts`'s `user` fold), only once it is actually admitted. */
  sendDraft: (text: string, attachments?: Attachment[], mentions?: ContextRef[]) => void;
  /** Optimistically reflect the model choice on THIS tab, then post. */
  setModel: (modelId: string) => void;
  /** Fire-and-forget — the host confirms via an authoritative `policy.state` push (never reflected locally first). */
  setPreset: (preset: EditPolicyPreset) => void;
  /** Fire-and-forget — the host confirms via an authoritative `mode.state` push (never reflected locally first). */
  setMode: (modeId: string | null) => void;
  /** Optimistically resolve THIS tab's approval card, then post. */
  respondApproval: (id: string, optionId: string) => void;
  /** Optimistically resolve THIS tab's diff hunk, then post. */
  resolveDiff: (toolId: string, hunkIndex: number, action: 'accept' | 'reject') => void;
  /** N2 fix: the History row's `tab.load` post — a bound wrapper around
   * `bridge.post`, never the raw method reference. */
  loadSession: (message: Extract<WebviewToHost, { type: 'tab.load' }>) => void;
}

/**
 * `dispatchLocal`/`tab`/`activePanel` are read fresh every render (App.tsx
 * passes `state.tabs[state.activeTabId]` and `state.activePanel` straight
 * through) — this hook never reaches into `AppState` itself, so it can
 * never fall back to an ambient "ACTIVE tab" the way `updateActiveTab`
 * (retired by this change) used to.
 */
export function useHostActions(
  dispatchLocal: (action: LocalAction) => void,
  tab: TabState,
  activePanel: Panel,
): HostActions {
  // Perf (ARCH Minor-11 parity, ported from App.tsx unchanged): stable
  // identity across a draft keystroke — deps are activePanel/tab.sessionId
  // (+ the always-stable dispatchLocal), none of which a draft edit
  // touches — so `React.memo(ChatView)` keeps skipping re-renders on typing.
  const sendPrompt = useCallback(
    (text: string, attachments?: Attachment[], mentions?: ContextRef[]) => {
      if (activePanel !== 'chat') dispatchLocal({ type: 'local.setPanel', panel: 'chat' });
      // W2-F1: every turn pins the ACP wire mode at 'default'; the
      // edit-policy preset (not a wire mode) governs approvals host-side.
      bridge.post({
        type: 'prompt',
        sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER,
        text,
        mode: 'default',
        attachments,
        mentions,
      });
    },
    [activePanel, tab.sessionId, dispatchLocal],
  );

  // P7-N1: not memoized (matches its pre-hook App.tsx shape) — every render
  // captures the CURRENT tab fresh, and `sendDraft` is not on ChatView's
  // memoized prop surface (only the Composer, which isn't memoized).
  //
  // ARCH-1 (final review, UI I-3): this used to ALSO dispatch
  // `local.draft.clear` right here, optimistically — which destroyed the
  // user's typed text the moment Send was pressed, even if the host went on
  // to REFUSE the prompt (a turn already running, no live client, etc.) with
  // no way to get it back. The draft now clears only once the host's `user`
  // admission echo actually arrives (`transcript.ts`'s `user` fold,
  // exact-match guarded so a draft the user retyped in the meantime
  // survives). `local.draft.clear` itself stays in the `LocalAction` union —
  // `App.tsx`'s `newSession` is a legitimate different caller.
  const sendDraft = (text: string, attachments?: Attachment[], mentions?: ContextRef[]) => {
    sendPrompt(text, attachments, mentions);
  };

  const setModel = (modelId: string) => {
    // Optimistically reflect the choice on THIS tab; the host confirms via panel.data / hydrate.
    dispatchLocal({ type: 'local.setModel', tabId: tab.tabId, modelId });
    bridge.post({ type: 'setModel', sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER, modelId });
  };

  const setPreset = (preset: EditPolicyPreset) => {
    bridge.post({ type: 'policy.setPreset', sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER, preset });
  };

  const setMode = (modeId: string | null) => {
    bridge.post({ type: 'mode.set', sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER, modeId });
  };

  // Perf (ARCH Minor-11 parity): deps now ALSO carry `tab.tabId` (the
  // original App.tsx version only depended on `tab.sessionId`) — the
  // optimistic dispatch below reads it, and per React's useCallback
  // contract every reactive value a callback reads must be a dependency.
  // Without this, two DIFFERENT unbound tabs (both `sessionId === undefined`)
  // would compare equal across a tab switch and this callback would stay
  // memoized holding a STALE `tabId` — reintroducing the exact class of bug
  // N5 fixes, just moved into the memoization layer instead of the reducer.
  const respondApproval = useCallback(
    (id: string, optionId: string) => {
      dispatchLocal({ type: 'local.approvalResolved', tabId: tab.tabId, id, optionId });
      bridge.post({ type: 'approval.respond', sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER, id, optionId });
    },
    [tab.tabId, tab.sessionId, dispatchLocal],
  );

  const resolveDiff = useCallback(
    (toolId: string, hunkIndex: number, action: 'accept' | 'reject') => {
      dispatchLocal({ type: 'local.diffResolved', tabId: tab.tabId, toolId, hunkIndex, action });
      bridge.post({
        type: 'diff.resolve',
        sessionId: tab.sessionId ?? UNBOUND_SESSION_PLACEHOLDER,
        toolId,
        hunkIndex,
        action,
      });
    },
    [tab.tabId, tab.sessionId, dispatchLocal],
  );

  // N2 fix: a bound wrapper (no reactive reads -> empty deps, stable
  // forever) around `bridge.post`, replacing the raw `onLoad={bridge.post}`
  // method reference that lost `this` on every History-row click.
  //
  // TI-1 (AU-39): only reached on a COMMITTED load — `SessionsPanel` calls
  // this from `loadSession`, never from just opening its live-turn confirm
  // strip — so both effects below are exactly "the click that actually
  // loads":
  //  (a) reveal the chat surface, same idiom as `sendPrompt` above: the
  //      transcript replay that streams in right after IS the load's visible
  //      feedback (a History click issued from the History panel itself
  //      otherwise never shows it landing).
  //  (b) mark the row busy (`AppState.pendingSessionLoad`) so
  //      `SessionsPanel`'s `busyInteraction` click-guard blocks a double-post
  //      until the terminal `tab.bound`/`tab.error` for THIS tabId clears it
  //      (`state/transcript.ts`'s `clearResolvedSessionLoad`).
  const loadSession = useCallback(
    (message: Extract<WebviewToHost, { type: 'tab.load' }>) => {
      if (activePanel !== 'chat') dispatchLocal({ type: 'local.setPanel', panel: 'chat' });
      dispatchLocal({ type: 'local.sessionLoad.start', tabId: message.tabId, sessionId: message.sessionId });
      bridge.post(message);
    },
    [activePanel, dispatchLocal],
  );

  return { sendPrompt, sendDraft, setModel, setPreset, setMode, respondApproval, resolveDiff, loadSession };
}
