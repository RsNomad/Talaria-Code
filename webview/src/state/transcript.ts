/*
 * Reducer: folds the SHARED host->webview wire protocol into renderable
 * AppState. Streaming deltas are matched to their transcript item by
 * turnId / blockId / toolId (per the shared contract) and appended.
 *
 * W4 §2e: ONE reducer, re-keyed per-tab. The FIRST step for every
 * session-scoped message resolves `msg.sessionId` -> a tabId via
 * `sessionToTab` (tabs.ts) and folds into THAT tab's slice — an unknown
 * session is DROPPED (dev-log, never `!`/`as` past a missing tab). This is
 * the P-1 isolation guarantee: a message tagged session B can only ever fold
 * into B's tab, never into A's.
 */
import type { ApprovalOption, Attachment, HostToWebview, Panel, PanelDataMap, PlanItem, WebviewState } from '../protocol';
import { MAX_TABS } from '../protocol';
import { foldSetupProgress } from '../panels/setupCards';
import {
  DEFAULT_PRESET,
  INITIAL_STATE,
  makeTabState,
  type ApprovalItem,
  type AppState,
  type PlanStepView,
  type TabState,
  type TranscriptItem,
} from '../types';
import { applyPanelTransition, assertExhaustivePanel, reducePanelAction, setPanelSuccess, type PanelAction } from './panels';
import { success, type RemoteData } from './remoteData';
import { handleSessionChange, sessionToTab } from './tabs';

/**
 * Deterministic id for a new message block, derived from the turn and how many
 * message blocks already exist for it. Pure — safe under React StrictMode's
 * double-invocation of reducers (no module-level mutable counter).
 */
function messageId(turnId: string, list: TranscriptItem[]): string {
  const n = list.filter((i) => i.kind === 'message' && i.turnId === turnId).length;
  return `msg-${turnId}-${n}`;
}

/** Mark every still-streaming message block as settled (called before non-message items). */
function closeOpenMessages(list: TranscriptItem[]): TranscriptItem[] {
  let changed = false;
  const next = list.map((item) => {
    if (item.kind === 'message' && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? next : list;
}

/** AUDIT-5 UI I-1 (F-3): a plan step claiming `active` after its turn died
 * is a card claiming a running state that is not happening — the same CF-06
 * class as an eternally-streaming reasoning block (PlanList renders `active`
 * as a perpetually spinning `loading` icon). Fold it to the webview-only
 * `'interrupted'` (see PlanStepView's doc): honest "was running when the
 * turn died" — distinct from never-started `pending` — mirroring the tool
 * fold above (`running` → `'interrupted'`), and non-spinning in PlanList. */
function settlePlanSteps(items: PlanStepView[]): PlanStepView[] {
  return items.some((step) => step.status === 'active')
    ? items.map((step) => (step.status === 'active' ? { ...step, status: 'interrupted' as const } : step))
    : items;
}

/**
 * CF-06 (R2 — "settled is enumerated, not derived"): the ONE place every
 * still-open/streaming transcript-item kind is settled, used on an ABNORMAL
 * `turn.end` (any status other than `'complete'` — see that arm's own
 * deliberate no-fold below, T-A1 owner fork, left unchanged). Before this
 * fix, settling was enumerated per-kind: `closeOpenMessages` settled only
 * `message`, and the turn.end fold mapped only `tool`/`approval` — a
 * streaming `reasoning` block fell through BOTH and never settled on an
 * abnormal turn.end, leaving an eternal "Thinking" spinner and its 10 Hz
 * `setInterval` (`ReasoningBlock.tsx`, keyed on `item.streaming`). Every
 * open/streaming kind is enumerated HERE, in one function, so a FUTURE
 * streaming kind added to `TranscriptItem` is a single-site fix, not a fresh
 * miss (see the trip-wire test in transcript.test.ts). `closeOpenMessages`
 * above is UNCHANGED and keeps its own separate MID-TURN role (closing a
 * prior message block when a new reasoning/tool/approval/plan/result block
 * starts) — this function only takes over the turn-END settle. Settled
 * kinds: message, reasoning, tool, approval, and a plan's `active` step (→
 * webview-only `'interrupted'`) alike.
 */
function settleOpenItems(list: TranscriptItem[]): TranscriptItem[] {
  return list.map((item) => {
    if (item.kind === 'message' && item.streaming) {
      return { ...item, streaming: false };
    }
    if (item.kind === 'reasoning' && item.streaming) {
      return { ...item, streaming: false };
    }
    if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running')) {
      return { ...item, status: 'interrupted' as const };
    }
    if (item.kind === 'approval' && item.settledOutcome === undefined) {
      return { ...item, settledOutcome: 'cancelled' as const };
    }
    if (item.kind === 'plan' && item.items.some((step) => step.status === 'active')) {
      return { ...item, items: settlePlanSteps(item.items) };
    }
    return item;
  });
}

/**
 * T-A1 (V-7): the first option of the given kind, or undefined if the
 * approval carries none (never fabricated). Mirrors the host's own
 * `findOptionId` (`SessionController.ts`) so the webview's optimistic
 * reject-fold denies via the SAME option the host itself would pick.
 */
function findOptionId(options: ApprovalOption[], kind: ApprovalOption['kind']): string | undefined {
  return options.find((option) => option.kind === kind)?.id;
}

/** Every session-scoped {@link HostToWebview} variant `foldTab` folds — i.e.
 * everything EXCEPT `turn.start` (its own adoption/reconciliation case,
 * below) and `policy.state` (folds `preset`, not the transcript). */
type TranscriptFoldMessage = Extract<
  HostToWebview,
  {
    type:
      | 'clear'
      | 'turn.end'
      | 'user'
      | 'reasoning.start'
      | 'reasoning.delta'
      | 'reasoning.end'
      | 'message.delta'
      | 'message.end'
      | 'tool.start'
      | 'tool.update'
      | 'tool.diff'
      | 'approval.request'
      | 'approval.settle'
      | 'plan.update'
      | 'result.summary'
      | 'error';
  }
>;

/**
 * The existing fold logic (pre-W4: `reduce`'s own switch, `state.transcript`
 * as its root), reused verbatim with a {@link TabState} as its root (§2e).
 */
function foldTab(tab: TabState, msg: TranscriptFoldMessage): TabState {
  switch (msg.type) {
    case 'clear':
      return { ...tab, transcript: [], plan: [], turnActive: false, error: undefined };

    case 'turn.end': {
      if (msg.status === 'complete') {
        // T-A1 owner fork: NO fold on a complete turn — a tool/approval (or,
        // by the same fork, a reasoning block) still open after
        // `status: 'complete'` is a host bug better left visible than
        // papered over client-side. `closeOpenMessages` still runs its own
        // narrower MID-TURN role here (settling only a still-streaming
        // `message` block) — unchanged, pre-dates this fork.
        return { ...tab, turnActive: false, transcript: closeOpenMessages(tab.transcript) };
      }
      // V-5/V-4 + CF-06/R2: the webview mirror of the host's
      // `markSubagentsInterrupted` — a turn ending anything other than
      // `'complete'` means nothing is still running in THIS session (one
      // live turn per session), so EVERY still-open/streaming transcript
      // item — message, reasoning, tool, approval alike — must stop lying
      // about being live. Derived in one place (settleOpenItems) instead of
      // enumerated per-kind here.
      return { ...tab, turnActive: false, transcript: settleOpenItems(tab.transcript), plan: settlePlanSteps(tab.plan) };
    }

    case 'user': {
      // ARCH-1 (final review, UI I-3): the draft is cleared by the HOST's
      // admission echo (emitted synchronously at `SessionController.sendPrompt`
      // AFTER every refusal gate), never optimistically at post time
      // (`useHostActions.sendDraft` no longer dispatches `local.draft.clear`).
      // CF-03: the Composer sends `draft.trim()` as the prompt text (see
      // Composer.tsx `submit`), so `msg.text` here is always the TRIMMED
      // echo — comparing it against the RAW `tab.draft` meant a
      // whitespace-padded draft ('fix bug ') never matched its own trimmed
      // send ('fix bug') and the draft + its attachment chips survived to be
      // accidentally re-sent. Trim-aware guard: if the user already retyped
      // new text while the echo was in flight, `tab.draft.trim()` no longer
      // equals `msg.text` — their new text survives untouched.
      const admitted = tab.draft.trim() === msg.text;
      return {
        ...tab,
        ...(admitted ? { draft: '', draftAttachments: [] } : {}),
        transcript: [...tab.transcript, { kind: 'user', turnId: msg.turnId, text: msg.text, mode: msg.mode }],
      };
    }

    case 'reasoning.start':
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          { kind: 'reasoning', turnId: msg.turnId, blockId: msg.blockId, text: '', streaming: true },
        ],
      };

    case 'reasoning.delta':
      return {
        ...tab,
        transcript: tab.transcript.map((i) =>
          i.kind === 'reasoning' && i.blockId === msg.blockId ? { ...i, text: i.text + msg.text } : i,
        ),
      };

    case 'reasoning.end':
      return {
        ...tab,
        transcript: tab.transcript.map((i) =>
          i.kind === 'reasoning' && i.blockId === msg.blockId ? { ...i, streaming: false } : i,
        ),
      };

    case 'message.delta': {
      const open = [...tab.transcript]
        .reverse()
        .find((i) => i.kind === 'message' && i.streaming && i.turnId === msg.turnId);
      if (open && open.kind === 'message') {
        return {
          ...tab,
          transcript: tab.transcript.map((i) => (i === open ? { ...i, text: i.text + msg.text } : i)),
        };
      }
      return {
        ...tab,
        transcript: [
          ...tab.transcript,
          { kind: 'message', turnId: msg.turnId, id: messageId(msg.turnId, tab.transcript), text: msg.text, streaming: true },
        ],
      };
    }

    case 'message.end': {
      // audit-3 Code Important: the host accumulates ALL deltas for the whole
      // turn and emits ONE message.end carrying the FULL turn buffer
      // (turnTranslator.ts:39-49, pinned by turnTranslator.test.ts). On a
      // say→tool→say turn the deltas already built TWO+ message blocks (an
      // interleaving tool/reasoning/approval/plan element closes the
      // pre-tool block via closeOpenMessages, so the next delta opens a NEW
      // one) — the whole-turn buffer only equals ONE block's own text when
      // exactly one block exists for the turn. Reconcile `text` from the
      // buffer ONLY in that single-block case; with multiple blocks, trust
      // the delta-built text and only settle `streaming`.
      const blocks = tab.transcript.filter(
        (i): i is Extract<TranscriptItem, { kind: 'message' }> => i.kind === 'message' && i.turnId === msg.turnId,
      );
      const target = blocks[blocks.length - 1];
      if (!target) {
        // Unreachable today: finish() only emits message.end after >=1
        // delta (turnTranslator.ts:45), which implies >=1 message block
        // already exists for the turn — kept as a defensive fallback per
        // this codebase's defensive-fold convention (audit-3 Code Info-1).
        return {
          ...tab,
          transcript: [
            ...tab.transcript,
            { kind: 'message', turnId: msg.turnId, id: messageId(msg.turnId, tab.transcript), text: msg.text, streaming: false },
          ],
        };
      }
      const text = blocks.length === 1 ? msg.text : target.text;
      return {
        ...tab,
        transcript: tab.transcript.map((i) => (i === target ? { ...i, text, streaming: false } : i)),
      };
    }

    case 'tool.start':
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          {
            kind: 'tool',
            turnId: msg.turnId,
            toolId: msg.toolId,
            toolKind: msg.kind,
            title: msg.title,
            status: msg.status,
            rawInput: msg.rawInput,
          },
        ],
      };

    case 'tool.update':
      return {
        ...tab,
        transcript: tab.transcript.map((i) =>
          i.kind === 'tool' && i.toolId === msg.toolId
            ? {
                ...i,
                status: msg.status ?? i.status,
                output: msg.output !== undefined ? (i.output ?? '') + msg.output : i.output,
              }
            : i,
        ),
      };

    case 'tool.diff':
      return {
        ...tab,
        transcript: tab.transcript.map((i) =>
          i.kind === 'tool' && i.toolId === msg.toolId
            ? { ...i, diffs: [...(i.diffs ?? []), { path: msg.path, hunks: msg.hunks }] }
            : i,
        ),
      };

    case 'approval.request':
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          {
            kind: 'approval',
            turnId: msg.turnId,
            id: msg.id,
            toolId: msg.toolId,
            approvalKind: msg.kind,
            title: msg.title,
            detail: msg.detail,
            options: msg.options,
            // T-A1: the field already existed on the wire — folded now so
            // T-A2's countdown display has something to read.
            timeoutMs: msg.timeoutMs,
          },
        ],
      };

    case 'approval.settle':
      // V-5/V-6/V-7: the authoritative host settlement — OVERWRITES any
      // optimistic value unconditionally (ARCH-1: optimistic can never
      // override authoritative). Also locks the settled approval's tool
      // hunks (M3-b) so a still-unresolved sibling hunk (e.g. a 60s auto-deny
      // that fired with zero user clicks) is never left looking live.
      return {
        ...tab,
        transcript: tab.transcript.map((item) => {
          if (item.kind === 'approval' && item.id === msg.id) {
            // audit-2 review finding 2: a non-'selected' outcome (cancelled/
            // expired/superseded) must CLEAR a stale optimistic
            // resolvedOptionId, not leave it standing next to the contradicting
            // settlement — a dangling "consent" field on a cancel/expire is a
            // lie any pre-T-A2 consumer reading resolvedOptionId would render.
            // Destructure it out and only re-add on an actual 'selected' pick.
            const { resolvedOptionId: _staleResolvedOptionId, ...rest } = item;
            return {
              ...rest,
              settledOutcome: msg.outcome,
              ...(msg.outcome === 'selected' && msg.optionId !== undefined ? { resolvedOptionId: msg.optionId } : {}),
            };
          }
          if (item.kind === 'tool' && msg.toolId !== undefined && item.toolId === msg.toolId) {
            return { ...item, hunksLocked: true };
          }
          return item;
        }),
      };

    case 'plan.update': {
      const exists = tab.transcript.some((i) => i.kind === 'plan');
      const transcript = exists
        ? tab.transcript.map((i) => (i.kind === 'plan' ? { ...i, items: msg.items } : i))
        : [...closeOpenMessages(tab.transcript), { kind: 'plan' as const, turnId: msg.turnId, items: msg.items }];
      return { ...tab, plan: msg.items, transcript };
    }

    case 'result.summary':
      // ARCH-1 (final review, UI I-4): `status` is required on the wire (T1)
      // and passed straight through — T4 owns the honest tone-mapped render.
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          { kind: 'result', turnId: msg.turnId, status: msg.status, text: msg.text, usage: msg.usage },
        ],
      };

    case 'error':
      // R-A2: a session-scoped error is NOT a turn terminator. Non-fatal
      // errors (setModel/setMode failures, a refused concurrent prompt)
      // arrive mid-turn and must not unlock THIS tab's composer while its
      // turn still runs — every fatal turn error is accompanied by its own
      // `turn.end{error}`, which is the single place `turnActive` clears.
      return { ...tab, error: { message: msg.message, detail: msg.detail } };

    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}

/** Resolve `sessionId` to a known tab and fold `updater` into it; DROP
 * (dev-log, unchanged state) when the session is not registered to any tab —
 * the P-1 isolation guarantee. Never `!`/`as` past the missing-tab case. */
function foldSessionScoped(
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
function foldTabScoped(
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

/**
 * `turn.start`'s session adoption (§2e) — the S0-shim adoption path: the
 * CURRENT host has not yet wired `tab.open`/`tab.bound` (single implicit
 * session), so `turn.start` remains the signal that binds a session to a
 * tab, via Continue's `handleSessionChange` reconciliation (case 1 retitle /
 * case 3 adopt on an unbound active tab) instead of a blind
 * `state.sessionId = msg.sessionId` overwrite. Once T3b wires real
 * `tab.open`/`tab.bound`, a `turn.start` for an ALREADY-bound tab is the
 * common case (handled below without reconciliation); this path only fires
 * for a session `turn.start` observes before any binding announced it.
 */
function foldTurnStart(state: AppState, msg: Extract<HostToWebview, { type: 'turn.start' }>): AppState {
  const known = sessionToTab(state.tabs)[msg.sessionId];
  if (known) {
    return foldTabScoped(state, known, 'turn.start', (tab) => ({ ...tab, turnActive: true, error: undefined }));
  }
  const activeTab = state.tabs[state.activeTabId];
  const title = activeTab?.title ?? 'Chat';
  const result = handleSessionChange(state, {
    currentSessionId: msg.sessionId,
    currentSessionTitle: title,
    // H1-I4: case 4's fresh-title value — `title` above is the case-1/2/3
    // RETITLE value (an existing tab renamed to the session's own title);
    // if case 4 fires instead (a brand-new tab), it must use THIS, never
    // `title` (a S0-shim `turn.start` for a not-yet-known session always
    // passes the ACTIVE tab's own title as `currentSessionTitle`, so a
    // case-4 mint that inherited it would name two tabs identically).
    newTabTitle: `Chat ${state.nextChatNumber}`,
  });
  // H1-A1: only case 4 ever grows tabOrder (cases 1/2/3 retitle/adopt an
  // EXISTING tab) — a mint is therefore detected by tabOrder growing, and
  // `nextChatNumber` advances exactly once per mint, never on close/retitle.
  const minted = result.tabOrder.length > state.tabOrder.length;
  const nextChatNumber = minted ? state.nextChatNumber + 1 : state.nextChatNumber;
  // W4-T3b (§7 B9(c) wiring): APPEND whatever handleSessionChange returns
  // onto the existing queue — never overwrite it. Case 2's dedup (the only
  // case that actually produces a closeIntent) is unreachable through THIS
  // specific caller (the `known` check above already proves no tab owns
  // `msg.sessionId`, which is exactly case 2's own precondition) — real
  // dedup fires via T5's `tab.load` reconciliation — but the append must be
  // correct regardless of which caller eventually exercises it, so an
  // unrelated pending intent from a DIFFERENT path is never silently lost.
  const closeIntents = result.closeIntents.length
    ? [...state.closeIntents, ...result.closeIntents]
    : state.closeIntents;
  const boundTab = result.tabs[result.activeTabId];
  if (!boundTab) {
    // Defensive only: handleSessionChange already dev-logged (its one no-op
    // path, an unknown activeTabId) — nothing well-formed to bind a session
    // onto, so preserve the reconciled tab list rather than write a
    // malformed partial TabState.
    return {
      ...state,
      tabs: result.tabs,
      tabOrder: result.tabOrder,
      activeTabId: result.activeTabId,
      closeIntents,
      nextChatNumber,
    };
  }
  return {
    ...state,
    tabs: {
      ...result.tabs,
      [result.activeTabId]: { ...boundTab, binding: 'bound', turnActive: true, error: undefined },
    },
    tabOrder: result.tabOrder,
    activeTabId: result.activeTabId,
    closeIntents,
    nextChatNumber,
  };
}

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
function foldPanelData(state: AppState, msg: Extract<HostToWebview, { type: 'panel.data' }>): AppState {
  // Switch on the ALIASED discriminant (not `msg.panel` directly): `panel`
  // IS the tag `PanelDataMessage`'s union is keyed on, so exhausting it
  // narrows `msg` itself to `never` inside `default` — leaving no `.panel`
  // to read there. Assigning it to a local first keeps `msg` independently
  // narrowed per case (TS's aliased-discriminant control-flow analysis)
  // while giving the `default:` branch an actual panel value to report.
  const panel = msg.panel;
  switch (panel) {
    case 'subagents':
      return foldSessionScoped(state, msg.sessionId, 'panel.data:subagents', (tab) => ({
        ...tab,
        subagents: success(msg.data),
      }));
    case 'checkpoints':
      return { ...state, rootPanels: { ...state.rootPanels, [msg.rootId]: success(msg.data) } };
    case 'sessions':
      return { ...state, sessionsPanel: success(msg.data) };
    case 'tools':
    case 'mcp':
    case 'skills':
    case 'models':
    case 'settings':
    case 'setup':
      return { ...state, globalPanels: setPanelSuccess(state.globalPanels, msg.panel, msg.data) };
    default:
      return assertExhaustivePanel(panel);
  }
}

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
    const base =
      (priorTabId ? state.tabs[priorTabId] : undefined) ??
      state.tabs[entry.tabId] ??
      makeTabState(entry.tabId, state.restoredTitles?.[entry.tabId] ?? `Chat ${index + 1}`);
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
function foldHydrate(state: AppState, s: HostToWebview & { type: 'hydrate' }): AppState {
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
        sessionId: seed.sessionId ?? activeTab.sessionId,
        currentModelId: seed.currentModelId ?? activeTab.currentModelId,
        preset: seed.preset,
        availableCommands: seed.availableCommands ?? activeTab.availableCommands,
      },
    },
  };
}

export function reduce(state: AppState, msg: HostToWebview): AppState {
  switch (msg.type) {
    case 'hydrate':
      return foldHydrate(state, msg);

    case 'theme':
      return { ...state, theme: msg.theme };

    // D2 (A2): connection-global scalar push, folded exactly like `theme`
    // above — the trust-upgrade mock->acp swap's ONLY signal, since
    // `TalariaViewProvider.setBackend` deliberately never re-hydrates.
    case 'backend.state':
      return { ...state, backendKind: msg.kind };

    // W5.1 R5 (Task 13): connection-global scalar push, folded exactly like
    // `theme`/`backend.state` above. This is the ONLY writer of
    // `nextEditToggles` — the Guard ratifies, the host pushes, the panel
    // renders. A refused toggle pushes nothing, so a refusal can never move
    // this slice (the row's own rollback is what snaps the switch back).
    case 'nextEdit.state':
      return { ...state, nextEditToggles: msg.state };

    case 'system.error':
      // §7 B1: a CONNECTION-GLOBAL error — no session to tag it to. Renders
      // as a banner across every tab (AppState.systemError), never folded
      // into (or dropped alongside) any one tab's transcript.
      return { ...state, systemError: { message: msg.message, detail: msg.detail } };

    case 'system.recovered':
      // ARCH-1 / Q2 (final review): retirement of the `system.error` banner
      // on a successful connection establish — not a second signal, the
      // resolution of the first. Idempotent (a fresh boot with no standing
      // banner folds to the same undefined it already was).
      return { ...state, systemError: undefined };

    case 'turn.start':
      return foldTurnStart(state, msg);

    case 'policy.state':
      return foldSessionScoped(state, msg.sessionId, 'policy.state', (tab) => ({ ...tab, preset: msg.preset }));

    case 'commands.available':
      // W6-FE Part 1 (3-way ARCH I-3b): session-scoped, folded per-tab —
      // was a single GLOBAL `useState` in App.tsx pre-fix, so a second
      // tab's push overwrote the first tab's slash palette (cross-tab
      // clobber). Routes through the SAME foldSessionScoped -> sessionToTab
      // discipline every other session-scoped message uses (P-1).
      return foldSessionScoped(state, msg.sessionId, 'commands.available', (tab) => ({
        ...tab,
        availableCommands: msg.commands,
      }));

    case 'mode.state':
      // SF-2 (T4 owns the engine/floor — T3b wires only the picker UI SHELL
      // reading this fold): the active custom mode + the catalog this
      // session may switch to.
      return foldSessionScoped(state, msg.sessionId, 'mode.state', (tab) => ({
        ...tab,
        activeModeId: msg.modeId,
        availableModes: msg.available,
      }));

    case 'model.state':
      // ARCH-1 (final review, UI I-1): the authoritative overwrite of the
      // optimistic `local.setModel` write — legal ONLY because this push
      // (confirm or corrective snap-back) always lands afterward and owns
      // the same field. T2 owns the SessionController emitter.
      return foldSessionScoped(state, msg.sessionId, 'model.state', (tab) => ({
        ...tab,
        currentModelId: msg.modelId,
      }));

    case 'panel.data':
      return foldPanelData(state, msg);

    case 'tab.bound':
      // D1 (the checkpoints eternal-spinner fix): `rootId` is the tab's
      // REAL RootCoordinator root key — until this fold sets it, the tab's
      // `''` default never matches the `rootId` a checkpoints `panel.data`
      // push carries, so `AppState.rootPanels[tab.rootId]` (the App-level
      // read) can never resolve. This is the ONE place `TabState.rootId`
      // ever changes.
      return clearResolvedSessionLoad(
        foldTabScoped(state, msg.tabId, 'tab.bound', (tab) => ({
          ...tab,
          sessionId: msg.sessionId,
          binding: 'bound',
          rootId: msg.rootId,
          title: msg.title ?? tab.title,
          // Audit G-9: a successful bind is the one thing that retires the marker.
          openFailed: false,
          // ARCH-1 (final review, UI I-3): a successful bind is likewise the
          // one thing that retires the session-lost marker (G-9 parity).
          sessionLost: false,
        })),
        msg.tabId,
      );

    case 'tab.error':
      // §7 B8: `kind` drives the retry affordance (App.tsx re-posts `tab.open`
      // for `open-failed`). Audit G-9: `openFailed` outlives the banner so the
      // route back survives a dismissal.
      return clearResolvedSessionLoad(
        foldTabScoped(state, msg.tabId, 'tab.error', (tab) => ({
          ...tab,
          error: { message: msg.message, kind: msg.kind },
          ...(msg.kind === 'open-failed' ? { openFailed: true } : {}),
          // ARCH-1 (final review, UI I-3): a lost session is a terminal
          // transition — regress `binding` so the composer (App.tsx
          // `disabled={tab.binding !== 'bound'}`) stops accepting sends that
          // have nowhere to go. `sessionLost` outlives the dismissible banner
          // exactly like `openFailed` does (G-9 pattern); cleared by the next
          // successful `tab.bound` above.
          ...(msg.kind === 'session-lost' ? { binding: 'unbound' as const, sessionLost: true } : {}),
        })),
        msg.tabId,
      );

    case 'tab.clear':
      // IMP-2 (W3-T6 3-lens review fix, CF-11): tabId-scoped — NOT routed
      // through `foldSessionScoped`/`sessionToTab` like the generic `clear`
      // below, because the whole point is to reach a tab whose session is
      // already gone (no sessionId left to resolve). Reuses `foldTab`'s own
      // `clear` reset (transcript/plan/turnActive/error) and ALSO retires
      // `openFailed`/`sessionLost` — those two markers deliberately OUTLIVE
      // the dismissible banner (G-9/ARCH-1) and `foldTab`'s generic clear was
      // never taught to retire them (its only callers until now always
      // preceded a fresh bind on an already-live tab, never a session-lost
      // one). Without this, a "New Session" click on a session-lost tab left
      // the stale "Session lost" banner standing even after the fresh
      // `tab.bound` that follows.
      return foldTabScoped(state, msg.tabId, 'tab.clear', (tab) => ({
        ...tab,
        transcript: [],
        plan: [],
        turnActive: false,
        error: undefined,
        openFailed: false,
        sessionLost: false,
      }));

    // ---- generic session-scoped fold (drop-unknown; §2e reuses foldTab) ----
    case 'clear':
    case 'turn.end':
    case 'user':
    case 'reasoning.start':
    case 'reasoning.delta':
    case 'reasoning.end':
    case 'message.delta':
    case 'message.end':
    case 'tool.start':
    case 'tool.update':
    case 'tool.diff':
    case 'approval.request':
    case 'approval.settle':
    case 'plan.update':
    case 'result.summary':
    case 'error':
      return foldSessionScoped(state, msg.sessionId, msg.type, (tab) => foldTab(tab, msg));

    // Task 10: CONNECTION-GLOBAL accumulation of the throttled
    // `setup.progress` stream (Agent install log lines, FIM/RAG model pull
    // bytes) — same posture as `nextEdit.state`/`backend.state` above (no
    // sessionId; there is one Setup panel per connection, not one per chat
    // tab). `foldSetupProgress` (setupCards.ts) is pure and independently
    // tested (`SetupPanel.test.ts`); this fold just threads it through.
    case 'setup.progress':
      return { ...state, setupProgress: foldSetupProgress(state.setupProgress, msg) };

    // P1 entry-point fix: host-driven panel switch — same connection-global
    // posture as `setup.progress` above (no sessionId). This folds only the
    // STATE half (`activePanel`); the App layer owns the FETCH half (a
    // `trigger`-tagged `requestPanel` call), which the pure reducer cannot
    // perform as a side effect.
    case 'panel.activate':
      return { ...state, activePanel: msg.panel };

    default:
      return state;
  }
}

/**
 * A6 (T-18 mechanization): compile-time-only companion to the `default:
 * return state` fallback above — never invoked at runtime (this function is
 * not called anywhere; its whole job is to fail `npm run typecheck -w
 * webview` if it ever stops compiling). `composer.seed` (folded by the
 * composer's own seed effect — see `App.tsx` — never through this reducer)
 * and `control.response` (folded by the control-request correlator) are the
 * two `HostToWebview` variants every `case` in the switch above
 * deliberately leaves unhandled; every OTHER variant — exactly
 * `Exclude<HostToWebview, { type: 'composer.seed' | 'control.response' }>`
 * — must be given an explicit `case` there. If `HostToWebview` ever grows a
 * new variant that is neither of those two nor added to a `case` in EITHER
 * switch, `msg` in the `default:` branch below stops narrowing to `never`
 * and this function fails to compile — the TS narrowing handbook's
 * never-assert pattern (same shape as `foldTab`'s own `default` above and
 * `assertExhaustivePanel` in `./panels`), applied to the complementary
 * slice of the union this reducer's own switch is responsible for. This is
 * the mechanical trip-wire: without it, a genuinely new message type with
 * no `case` anywhere would compile clean forever and silently hit
 * `default: return state` above — exactly the silent-swallow class
 * `assertExhaustivePanel`'s own module doc already named for `panel.data`.
 */
function assertReduceHandlesEveryRoutedMessage(
  msg: Exclude<HostToWebview, { type: 'composer.seed' | 'control.response' }>,
): void {
  switch (msg.type) {
    case 'hydrate':
    case 'theme':
    case 'backend.state':
    case 'nextEdit.state':
    case 'system.error':
    case 'system.recovered':
    case 'turn.start':
    case 'policy.state':
    case 'commands.available':
    case 'mode.state':
    case 'model.state':
    case 'panel.data':
    case 'tab.bound':
    case 'tab.error':
    case 'tab.clear':
    case 'clear':
    case 'turn.end':
    case 'user':
    case 'reasoning.start':
    case 'reasoning.delta':
    case 'reasoning.end':
    case 'message.delta':
    case 'message.end':
    case 'tool.start':
    case 'tool.update':
    case 'tool.diff':
    case 'approval.request':
    case 'approval.settle':
    case 'plan.update':
    case 'result.summary':
    case 'error':
    // Task 10: see the matching `case 'setup.progress'` in `reduce()` above
    // (folds into `AppState.setupProgress` via `foldSetupProgress`).
    case 'setup.progress':
    // P1 entry-point fix: see the matching `case 'panel.activate'` in
    // `reduce()` above (folds `AppState.activePanel`).
    case 'panel.activate':
      return;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}
// Referenced (never called) so `noUnusedLocals` doesn't flag a function
// whose entire value is compile-time-only.
void assertReduceHandlesEveryRoutedMessage;

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
  // `tab.error` cases below).
  | { type: 'local.sessionLoad.start'; tabId: string; sessionId: string }
  // Part X2: a panel's own loading/error transitions (fed by fetchPanel).
  | PanelAction;

/**
 * TI-1 (AU-39): clears `AppState.pendingSessionLoad` once the load it
 * tracks has resolved — called from BOTH the `tab.bound` and `tab.error`
 * cases below, which is why it takes the already-folded `next` state rather
 * than folding itself. Matches on `tabId` alone (never `sessionId`):
 * `tab.error` carries no `sessionId` on the wire (`protocol.ts`'s `tab.error`
 * shape has no such field), and a `tab.bound` for the loading tab is always
 * the SAME load resolving (P3's target-tab-busy refusal means a second load
 * can never be issued into a tab that already has one in flight). A
 * `tab.bound`/`tab.error` for any OTHER tabId leaves it untouched (P-1
 * isolation — an unrelated tab's own bind/error must never clear a DIFFERENT
 * tab's still-in-flight History load).
 */
function clearResolvedSessionLoad(next: AppState, tabId: string): AppState {
  return next.pendingSessionLoad?.tabId === tabId ? { ...next, pendingSessionLoad: undefined } : next;
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
function reducePanelActionScoped(state: AppState, action: PanelAction): AppState {
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
      return { ...state, tabs: { ...state.tabs, [tabId]: { ...tab, subagents: applyPanelTransition(tab.subagents, action) } } };
    }
    case 'checkpoints': {
      const rootId = action.scopeKey ?? '';
      const current: RemoteData<PanelDataMap['checkpoints']> = state.rootPanels[rootId] ?? { status: 'idle' };
      return { ...state, rootPanels: { ...state.rootPanels, [rootId]: applyPanelTransition(current, action) } };
    }
    case 'sessions':
      return { ...state, sessionsPanel: applyPanelTransition(state.sessionsPanel, action) };
    case 'tools':
    case 'mcp':
    case 'skills':
    case 'models':
    case 'settings':
    case 'setup':
      return { ...state, globalPanels: reducePanelAction(state.globalPanels, action) };
    default:
      return assertExhaustivePanel(action.panel);
  }
}

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
      return foldTabScoped(state, action.tabId, action.type, (tab) => ({ ...tab, error: undefined }));
    case 'local.sessionLoad.start':
      return { ...state, pendingSessionLoad: { tabId: action.tabId, sessionId: action.sessionId } };
    case 'local.dismissSystemError':
      return { ...state, systemError: undefined };
    case 'local.panelLoading':
    case 'local.panelError':
      return reducePanelActionScoped(state, action);

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

    default:
      return state;
  }
}

export type { PlanItem };
export { INITIAL_STATE };
