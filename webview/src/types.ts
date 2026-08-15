/*
 * View-model types: the shapes the React tree actually renders. The reducer in
 * state/transcript.ts folds the streaming SHARED wire protocol (protocol.ts)
 * into these stable, addressable transcript items.
 *
 * These mirror the shared `TranscriptItem` variants (folded by turnId / blockId
 * / toolId) but add UI-only fields the wire protocol doesn't carry — `streaming`
 * flags for live cursors, and `resolvedHunks` for optimistic diff resolution.
 *
 * W4 §2e: `AppState` is reshaped PER-TAB (`TabState`) so N ACP sessions' streams
 * never bleed into each other (the P-1 isolation guarantee — the webview analog
 * of W2's host-side P-0). See `state/tabs.ts` for tab metadata + reconciliation
 * and `state/transcript.ts` for the re-keyed reducer.
 */
import type {
  AgentMode,
  ApprovalOption,
  Attachment,
  BackendKind,
  CheckpointsData,
  CustomModeInfo,
  EditPolicyPreset,
  NextEditToggleState,
  Panel,
  PlanItem,
  SessionsData,
  SlashCommandInfo,
  SubagentsData,
  ThemeInfo,
  ToolDiff,
  ToolKind,
  ToolStatus,
  UsageInfo,
} from './protocol';
import { BOOTSTRAP_TAB_ID } from './protocol';
import { EMPTY_SETUP_PROGRESS, type SetupProgressMap } from './panels/setupCards';
import type { PanelStateMap } from './state/panels';
import { idle, type RemoteData } from './state/remoteData';

export interface UserItem {
  kind: 'user';
  turnId: string;
  text: string;
  mode: AgentMode;
}

export interface ReasoningItem {
  kind: 'reasoning';
  turnId: string;
  blockId: string;
  text: string;
  streaming: boolean;
}

export interface MessageItem {
  kind: 'message';
  turnId: string;
  /** Locally-unique id so a turn can have several message blocks in order. */
  id: string;
  text: string;
  streaming: boolean;
}

export interface ToolItem {
  kind: 'tool';
  turnId: string;
  toolId: string;
  toolKind: ToolKind;
  title: string;
  status: ToolStatus;
  /** Raw tool input preview (path / command), from `tool.start.rawInput`. */
  rawInput?: string;
  output?: string;
  /** Reviewable diffs attached via `tool.diff` (folded by toolId). */
  diffs?: ToolDiff[];
  /** Optimistic per-hunk resolution, keyed by global hunk index. */
  resolvedHunks?: Record<number, 'accept' | 'reject'>;
  /**
   * T-A1 (audit-2 Cluster A, V-7): set when `local.diffResolved{reject}`
   * denies this tool's WHOLE edit (mirrors the host's `resolveDiff` reject,
   * which denies the entire diff — `SessionController.ts` — not just one
   * hunk), or when the authoritative `approval.settle` echo for this tool's
   * approval arrives. Every hunk with no `resolvedHunks` entry of its own is
   * "locked" — no further accept/reject offered for it (T-A2 renders it
   * neutral/"not applied") — kept DISTINCT from an explicit per-hunk
   * `'reject'` entry, which the rejected hunk still gets.
   *
   * T-20 (Tier-2 hygiene sweep, fork F-5, owner-ratified KEEP over remove):
   * written by the two reducer sites, read by NO production code (render
   * derives from `settledOutcome` per the A2 design), kept as the
   * state-level audit record; removal would require overturning A1-era
   * tests.
   */
  hunksLocked?: boolean;
}

export interface ApprovalItem {
  kind: 'approval';
  turnId: string;
  id: string;
  /** The tool call this approval gates, when applicable (edit approvals
   * always carry one). W2 T4 (F-D): lets the transcript correlate a
   * `ToolItem`'s diffs back to their still-pending approval, so the DiffCard's
   * "Open diff in editor" button only ever renders while genuinely pending. */
  toolId?: string;
  approvalKind: 'command' | 'edit';
  title: string;
  detail?: string;
  options: ApprovalOption[];
  resolvedOptionId?: string;
  /**
   * T-A1 (audit-2 Cluster A): the AUTHORITATIVE settlement of this approval —
   * from the host's `approval.settle` echo (V-5/V-6), from a client-side
   * `turn.end{status !== 'complete'}` fold while still open (V-4/V-5), or
   * from an optimistic `local.diffResolved{reject}` that denies the whole
   * edit up front (V-7, later reconfirmed by the host's own echo). ALWAYS
   * wins over the optimistic `resolvedOptionId` — once set, neither
   * `local.approvalResolved` nor `local.diffResolved` may write this item
   * again (see their reducer guards in `state/transcript.ts`); optimistic
   * state can never override authoritative state (ARCH-1).
   */
  settledOutcome?: 'selected' | 'cancelled' | 'expired' | 'superseded';
  /**
   * T-A1: auto-deny deadline in ms, folded straight from `approval.request`
   * (the field already existed on the wire — `protocol.ts` — read by ZERO
   * webview files before this). The reducer only STORES it; it never reads
   * `Date.now()` itself — the live countdown display lives in the component
   * (T-A2), keeping this fold StrictMode-safe (pure, no wall-clock read).
   */
  timeoutMs?: number;
}

/**
 * AUDIT-5 UI I-1 (F-3 TYPE SURGERY): the webview's plan-step shape. It
 * DIVERGES from the wire `PlanItem` (src/shared/protocol.ts:96-99) by
 * exactly one UI-only status member — `'interrupted'` — per this file's
 * charter ("add UI-only fields the wire protocol doesn't carry"). The wire
 * union is a structural SUBTYPE of this one, so `plan.update` ingestion
 * needs no mapping; the ONLY producer of `'interrupted'` is
 * `settlePlanSteps` (state/transcript.ts) on an abnormal turn end, and the
 * next real `plan.update` wholesale-replaces the array (M8: no per-step
 * id), erasing the marker. Never send this type toward the host — the wire
 * type stays `PlanItem` (nothing does today; `tab.plan` is write-only).
 */
export interface PlanStepView {
  text: string;
  status: PlanItem['status'] | 'interrupted';
}

export interface PlanItemView {
  kind: 'plan';
  turnId: string;
  items: PlanStepView[];
}

export interface ResultItem {
  kind: 'result';
  turnId: string;
  /** ARCH-1 (final review, UI I-4): required — see `result.summary`'s doc in
   * `src/shared/protocol.ts`. Drives the card's tone (T4 owns the render). */
  status: 'complete' | 'cancelled' | 'error';
  text?: string;
  usage?: UsageInfo;
}

export type TranscriptItem =
  | UserItem
  | ReasoningItem
  | MessageItem
  | ToolItem
  | ApprovalItem
  | PlanItemView
  | ResultItem;

/**
 * W4 §2e: one chat-session tab's full state slice — everything the OLD flat
 * `AppState` used to hold, now addressed per-tab so N sessions' folds can
 * never cross-contaminate (P-1).
 */
export interface TabState {
  tabId: string;
  /** Unbound until `tab.bound` (Continue's optional-id shape). */
  sessionId?: string;
  /** §7 B9 — `pending` tabs are NON-ADOPTABLE by reconciliation (see tabs.ts). */
  binding: 'unbound' | 'pending' | 'bound';
  title: string;
  transcript: TranscriptItem[];
  plan: PlanStepView[];
  turnActive: boolean;
  currentModelId: string | null;
  /** Per-tab (Q-7 decided) — W2-F1 edit-policy preset. */
  preset: EditPolicyPreset;
  /** Per-tab custom mode (SF-2, T4 populates; T3a threads the field only). */
  activeModeId: string | null;
  /** Which workspace root this tab's cwd resolves to (checkpoints slice key).
   * `''` until `tab.bound` carries the real `RootCoordinator` root key (D1 —
   * the checkpoints eternal-spinner fix: this is what makes the fetch-loading
   * write, the host's `panel.data{rootId}` push, and the App-level
   * `rootPanels[tab.rootId]` read all key on the SAME real root). */
  rootId: string;
  /** SF-2 (T4 populates): the custom modes this tab's session may switch to —
   * T3b wires only the picker UI SHELL reading this list; the engine/floor
   * that populates it via `mode.state` is T4's job. */
  availableModes: CustomModeInfo[];
  /** The ONLY genuinely per-tab panel (§2f) — a fold over THIS session's stream. */
  subagents: RemoteData<SubagentsData>;
  /**
   * `kind` (W4-T3b, §7 B8) is present only for a `tab.error` (never for the
   * generic session-scoped `error`) — `'open-failed'` drives the in-place
   * retry affordance (re-post `tab.open` for this SAME tabId); `'session-lost'`
   * gets no in-place retry (the session itself is gone, not the connection —
   * a retry would just fail again) and instead routes to History via the
   * `sessionLost` marker below (ARCH-1, final review UI I-3, T3).
   */
  error?: { message: string; detail?: string; kind?: 'open-failed' | 'session-lost' };
  /**
   * Audit G-9. `local.dismissError` clears `error` and leaves `binding`
   * untouched, and the ONLY Retry affordance lived inside the dismissed banner
   * (`App.tsx`, gated on `error.kind === 'open-failed'`). Dismissing therefore
   * deleted the only route back: the tab stayed `pending` forever, the composer
   * stayed disabled, and nothing on screen explained why. This marker outlives
   * the banner and is cleared by a successful `tab.bound`.
   */
  openFailed?: boolean;
  /**
   * ARCH-1 (final review, UI I-3): a previously-bound tab's session died and
   * could not be restored (`tab.error{kind:'session-lost'}`). T3 owns the
   * fold (regresses `binding` to `'unbound'` so the composer stops accepting
   * sends that have nowhere to go) and the UI affordance; this marker
   * outlives the dismissible banner exactly like `openFailed` does (G-9
   * pattern) and is cleared by the next successful `tab.bound`.
   */
  sessionLost?: boolean;
  /**
   * W6-FE Part 1 (3-way ARCH I-3b): the ACP `available_commands` catalog for
   * THIS tab's session — per-tab (was a single GLOBAL `useState` in
   * `App.tsx` pre-fix, which let a second tab's `commands.available` push
   * clobber the first tab's slash palette). Folded from the now
   * session-scoped `commands.available` message and from `hydrate.state.
   * availableCommands` (both keyed onto the owning tab).
   */
  availableCommands: SlashCommandInfo[];
  /**
   * P7-N1 (Critical wrong-session-send fix): the per-tab composer draft —
   * lives HERE, not in the `Composer` component, so it survives tab switches
   * (the N1 bug: an unkeyed component-local `useState` let switching tabs
   * carry tab A's typed draft under tab B, and Send stamped B's sessionId)
   * and panel peeks (sibling finding UI-I3 — Composer unmounts on panel
   * switch regardless of any `key`). RULE (ARCH S-1): any state whose
   * MEANING is per-tab lives in `TabState`, or the component holding it is
   * explicitly reset per-tab — never bare component-local `useState`.
   */
  draft: string;
  /** P7-N1: in-progress attachments for this tab's draft — same wire shape
   * the `prompt` message carries (`Attachment`, `src/shared/protocol.ts`).
   * Appended atomically at the reducer (`local.draft.attach.add`) so two
   * concurrent async `FileReader.onload` resolutions can never drop a
   * sibling file (a whole-array controlled write would race them). */
  draftAttachments: Attachment[];
}

export interface AppState {
  tabs: Record<string, TabState>;
  tabOrder: string[];
  activeTabId: string;
  theme: ThemeInfo;
  /**
   * D2 (A2): which backend is LIVE — CONNECTION-GLOBAL (mirrors `theme`
   * above), not per-tab (P-1: there is exactly one backend per connection,
   * never one per chat tab). Folded from `WebviewState.backendKind` on
   * `hydrate` and from the `backend.state` push on a mock->acp trust-upgrade
   * swap (`TalariaViewProvider.setBackend` never re-hydrates — see
   * `state/transcript.ts`'s `backend.state` case doc). Drives the "Mock"
   * `Pill` in `TabStrip`.
   */
  backendKind: BackendKind;
  /**
   * W5.1 R5 (Task 13): the Guard-ratified «Next Edit Suggestions» toggles —
   * CONNECTION-GLOBAL, exactly like `theme`/`backendKind` above (there is one
   * toggle store per extension, never one per chat tab). Written ONLY by the
   * `nextEdit.state` push: the Guard is the sole authority and this panel
   * keeps no persistence of its own, so there is no webview-side write path
   * that could disagree with the store.
   */
  nextEditToggles: NextEditToggleState;
  /** GLOBAL — the panel strip is one strip; switching chat tabs keeps panel context. */
  activePanel: Panel;
  /** tools / mcp / skills / models / settings — no scope beyond the one connection. */
  globalPanels: PanelStateMap;
  /** §2f — checkpoints: one shadow-git timeline shared by every same-root tab. */
  rootPanels: Record<string, RemoteData<CheckpointsData>>;
  /** §2f — sessions: filtered by cwd, shared (not per-tab). */
  sessionsPanel: RemoteData<SessionsData>;
  /** §7 B1 — connection-global banner (respawn/"reconnecting"/not-started). */
  systemError?: { message: string; detail?: string };
  /**
   * §7 B9(c): tabIds `handleSessionChange`'s dedup dropped that had a real or
   * in-flight host session — queued here so App.tsx's drain effect can post
   * `tab.close` for each (the host session must not leak). Drained (cleared)
   * by `local.tab.closeIntentsDrained` once posted.
   */
  closeIntents: string[];
  /**
   * H1-A1: the display-only counter behind the next generic `Chat N` title —
   * count-based titles (`tabOrder.length + 1`) collide when a MIDDLE tab is
   * closed and a new one opened (both mint the same freed `N`). RULE:
   * `nextChatNumber` increments once per newly-minted generic-titled tab and
   * is NEVER reused or decremented (not even on `tab.close`). It carries no
   * routing meaning — `sessionToTab`/case-selection/dedup are untouched.
   */
  nextChatNumber: number;
  /**
   * D1 (M7, architect memo Decision 1): a READ-ONLY boot-time snapshot of
   * this connection's persisted tab titles, restored from `vscode.getState()`
   * (App.tsx) and consumed exactly once by `foldHydrateReconcile`
   * (transcript.ts) to give a reconciled tab back its real title instead of
   * the generic `Chat ${index + 1}` fallback a webview dispose+recreate would
   * otherwise stamp on it. Keyed by **tabId**, never sessionId (sessionIds
   * rotate on auto-compaction — R8). Nothing ever writes this after boot; the
   * live source of truth stays `TabState.title` — this is a snapshot, not a
   * second store (P-1: never a routing key).
   */
  restoredTitles?: Record<string, string>;
  /**
   * AUDIT-5 UI M-2: a READ-ONLY boot-time snapshot of this connection's
   * persisted, unsent per-tab Composer drafts, restored from
   * `vscode.getState()` (App.tsx) and consumed exactly once by
   * `foldHydrateReconcile` (transcript.ts) — same lifecycle/keying posture as
   * {@link restoredTitles} (keyed by tabId, boot-only, never a second source
   * of truth for `TabState.draft`). A LIVE draft on the reconciled base
   * always wins over a restored one (see `foldHydrateReconcile`'s fold);
   * `draftAttachments` are deliberately NOT restored (see `persist.ts`).
   */
  restoredDrafts?: Record<string, string>;
  /**
   * Task 10: the client-side accumulation of `setup.progress` pushes for the
   * Setup / Talaria Config panel (Agent install log lines, FIM/RAG model
   * pull bytes), keyed by `${op}:${id}` (`setupCards.ts`'s `progressKey`).
   * CONNECTION-GLOBAL — installing a backend or pulling a model is not
   * scoped to any one chat tab, same posture as `nextEditToggles`/
   * `backendKind` above. Folded by `state/transcript.ts`'s `setup.progress`
   * case (Task 8 left that case an explicit no-op for this task to replace).
   */
  setupProgress: SetupProgressMap;
  /**
   * TI-1 (AU-39): the History-panel row currently mid-load, set the moment a
   * committed row click posts `tab.load` (`useHostActions.loadSession`) and
   * cleared by that SAME `tabId`'s next `tab.bound` (success) or `tab.error`
   * (failure) — the terminal signal `AcpBackend.loadSessionIntoTab` already
   * emits on every branch (see that method's own doc; extensively pinned in
   * `AcpBackend.test.ts`). Carries BOTH ids: `tabId` is what the clearing
   * fold matches on (`tab.error` carries no `sessionId` on the wire —
   * `protocol.ts`'s `tab.error` shape), `sessionId` is what SessionsPanel's
   * row lookup needs to render the busy posture. CONNECTION-GLOBAL-shaped
   * like `systemError` above — at most one History-panel load is ever in
   * flight at a time (mirrors `SessionsPanel`'s own `confirmingId` "at most
   * one" local-state posture).
   */
  pendingSessionLoad?: { tabId: string; sessionId: string };
}

/** W2-F1 boot default — ask-everything until the host's live preset arrives. */
export const DEFAULT_PRESET: EditPolicyPreset = 'manual';

/** A freshly-minted, fully-idle tab (unbound, empty transcript, idle panels). */
export function makeTabState(tabId: string, title: string): TabState {
  return {
    tabId,
    sessionId: undefined,
    binding: 'unbound',
    title,
    transcript: [],
    plan: [],
    turnActive: false,
    currentModelId: null,
    preset: DEFAULT_PRESET,
    activeModeId: null,
    rootId: '',
    availableModes: [],
    subagents: idle,
    error: undefined,
    availableCommands: [],
    draft: '',
    draftAttachments: [],
  };
}

/** Stable id for the ONE implicit bootstrap tab the app renders before any
 * `tab.bound`/`turn.start` — see `state/transcript.ts`'s `hydrate`/`turn.start`
 * handling and the T3a report for why a single bootstrap tab (rather than an
 * empty `tabs` map) is the shape that keeps today's single-session flow
 * rendering unchanged. Re-exported from `./protocol` (the shared module) so
 * the host's connection-boot session mint and this bootstrap tab agree on
 * the SAME id (W4-T3b D1). */
export { BOOTSTRAP_TAB_ID };

/**
 * D1 (M7): the boot-time factory behind {@link INITIAL_STATE}. `restored` is
 * App.tsx's `bridge.getState()` snapshot (persisted `tabTitles`/
 * `nextChatNumber` from BEFORE a dispose+recreate) — passing nothing (or
 * omitting a field) reproduces the exact no-restore default this const has
 * always had, so every existing `INITIAL_STATE` importer/test keeps working
 * unchanged. `restored.tabTitles` becomes the read-only `restoredTitles`
 * boot snapshot (see its doc on {@link AppState}); `restored.nextChatNumber`
 * is threaded straight through (2 = the current bootstrap default — the
 * bootstrap tab already occupies "Chat 1", so the next mint is "Chat 2").
 * `restored.drafts` (AUDIT-5 UI M-2) becomes the read-only `restoredDrafts`
 * boot snapshot, same posture as `tabTitles`/`restoredTitles`.
 */
export function createInitialState(restored?: {
  tabTitles?: Record<string, string>;
  nextChatNumber?: number;
  drafts?: Record<string, string>;
}): AppState {
  return {
    tabs: { [BOOTSTRAP_TAB_ID]: makeTabState(BOOTSTRAP_TAB_ID, 'Chat 1') },
    tabOrder: [BOOTSTRAP_TAB_ID],
    activeTabId: BOOTSTRAP_TAB_ID,
    theme: { kind: 'dark', accent: '#14b8a6' },
    // D2 (A2): boot-default to 'mock', not 'acp' — before the first `hydrate`
    // arrives there IS no live backend, and a brief false "Mock" that
    // self-corrects the instant hydrate lands is the honest failure mode
    // (the alternative, defaulting to 'acp', would silently hide a real mock
    // fallback for the one render before hydrate — exactly the A2 bug this
    // badge exists to close).
    backendKind: 'mock',
    // R5 (Task 13): boot both-OFF — the same hardcoded first-run default the
    // Guard itself uses. Before the first `nextEdit.state` push there IS no
    // known state, and honestly showing OFF (then self-correcting the instant
    // the push lands) is the only safe direction: a guessed ON would claim a
    // model is serving next-edit when none is.
    nextEditToggles: { next: false, generic: false },
    activePanel: 'chat',
    globalPanels: {},
    rootPanels: {},
    sessionsPanel: idle,
    systemError: undefined,
    pendingSessionLoad: undefined,
    closeIntents: [],
    nextChatNumber: restored?.nextChatNumber ?? 2,
    restoredTitles: restored?.tabTitles,
    restoredDrafts: restored?.drafts,
    setupProgress: EMPTY_SETUP_PROGRESS,
  };
}

export const INITIAL_STATE: AppState = createInitialState();
