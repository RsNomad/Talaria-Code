/*
 * Per-panel RemoteData state + the fetch controller (Part X2).
 *
 * Each control panel (Tools/MCP/Skills/Checkpoints/Subagents/Sessions/Models/
 * Settings) tracks its own {@link RemoteData}. This module owns:
 *  - the {@link PanelStateMap} shape held in AppState,
 *  - pure reducer helpers the transcript reducer folds panel actions through,
 *  - {@link fetchPanel}: the controller that issues a CORRELATED `panel.data`
 *    request (Part A2) and, crucially, CATCHES its rejection to set an error
 *    state instead of leaving the panel spinning forever. Retry just calls it
 *    again.
 *
 * Kept dependency-light (no React, no bridge import) so it is unit-testable in
 * a plain node environment and free of import cycles with the reducer.
 */
import type { ControlRequestMethod, DataPanel, GlobalPanel, PanelDataMap } from '../protocol';
import { failure, idle, loading, success, isSuccess, type RemoteData } from './remoteData';

/**
 * TI-3 (AU-42 Part B, scope decision): the global panels this task's
 * `refreshError` side-map + dismissible banner cover — {@link GlobalPanel}
 * minus `'setup'`. `'setup'` is deliberately excluded: unlike
 * `tools`/`mcp`/`skills`/`models`/`settings`, it is never wrapped by
 * App.tsx's EXTERNAL `RemotePanel` (SetupPanel owns its own internal gate
 * over a materially different, progress-driven snapshot — see
 * `SetupPanel.tsx`'s module doc and App.tsx's Task-10 comment on the
 * `'setup'` branch) and its many discrete mutations already have their own
 * per-action error surfaces. It still gets the keep-data reducer rule below
 * (a background refresh failure never wipes its data either — that rule is
 * panel-agnostic, applied uniformly), just no refreshError entry/banner.
 * Flagged as a follow-up if the owner wants parity later.
 */
export type RefreshErrorPanel = Exclude<GlobalPanel, 'setup'>;

/** Every data panel's current RemoteData; absent = never activated (idle). */
export type PanelStateMap = { [P in DataPanel]?: RemoteData<PanelDataMap[P]> };

/**
 * Local (webview-only) actions that drive a panel's loading/error
 * transitions. `scopeKey` (W4-T3b §7 B6) is the scope resolved at FETCH-
 * ISSUE time — never re-derived from `state.activeTabId` at dispatch time,
 * which is exactly the eternal-spinner-class race B6 exists to kill (a fetch
 * for tab A's panel resolving AFTER the user switches to tab B must still
 * land in A's slice). Its MEANING is panel-specific: the owning tab's id for
 * `subagents` (`TabState.subagents` is tab-keyed); the target root's id for
 * `checkpoints` (`AppState.rootPanels` is root-keyed, so keying on a tabId
 * here would wrongly drop the transition if THAT tab closes while a sibling
 * same-root tab is still watching the shared timeline); omitted for
 * `sessions` (one shared slice) and every global panel.
 */
export type PanelAction =
  | {
      type: 'local.panelLoading';
      panel: DataPanel;
      scopeKey?: string;
      /**
       * CF-10: set ONLY by `fetchPanel`'s unbound-subagents short-circuit —
       * carries the immediate empty payload for a fetch that was never
       * actually issued (an unbound tab's subagents request can never
       * receive its push, so there is no real "loading" happening). Kept
       * under the SAME `local.panelLoading` discriminant (rather than a new
       * action type) so the routing this already has —
       * `reduceLocal`/`reducePanelActionScoped` in `transcript.ts` — doesn't
       * need a matching new case; `applyPanelTransition` below is the only
       * place that inspects it. Type-erased to `unknown` for the same reason
       * `PanelAction` stays panel-agnostic everywhere else in this file (see
       * `reducePanelAction`'s doc): the caller (`fetchPanel`) is the only
       * place that ever sets it, and only with a
       * `PanelDataMap['subagents']`-shaped value.
       */
      emptyData?: unknown;
    }
  | { type: 'local.panelError'; panel: DataPanel; message: string; retryable: boolean; scopeKey?: string };

/**
 * Store a freshly-fetched (or pushed) snapshot as `success`. Called from BOTH
 * the correlated-request path AND the server-initiated `panel.data` PUSH path,
 * so a push always wins the panel to success regardless of prior state.
 */
export function setPanelSuccess<P extends DataPanel>(
  panels: PanelStateMap,
  panel: P,
  data: PanelDataMap[P],
): PanelStateMap {
  return { ...panels, [panel]: success(data) };
}

/**
 * Apply a loading/error {@link PanelAction} transition to a SINGLE RemoteData
 * slot. No-flash: a slot already showing `success` data stays visible during
 * a silent background refresh (mirrors TanStack Query's success +
 * isFetching) rather than flashing back to a loading spinner.
 *
 * TI-3 (AU-42 Part B): the SAME no-flash posture now applies to a
 * background-refresh FAILURE too — a slot already showing `success` data
 * KEEPS it on `local.panelError` (returns `current` unchanged) instead of
 * being replaced by a `failure(...)` error card; only a first-load failure
 * (idle/loading, no data yet) still becomes `failure`. Mirrors TanStack
 * Query's `data` staying intact across a background `error` (query stays
 * `status: 'success'`, `isError` is a separate flag) — the analogous
 * `refreshError` side-map (`AppState.refreshError`, `state/transcript.ts`)
 * is what a caller reads to know a background refresh failed; this function
 * only owns the RemoteData half.
 *
 * Extracted (W4 §2f) so the three re-scoped panels — `TabState.subagents`,
 * `AppState.rootPanels[rootId]`, `AppState.sessionsPanel` — which do NOT live
 * in a {@link PanelStateMap}, share the exact same transition rule as the
 * map-keyed global panels below instead of re-deriving it. TI-3 assessed
 * extending the FULL Part B package (rule + a scoped `refreshError` banner)
 * to these three and scoped the BANNER out (each needs its own differently-
 * shaped side-map — tabId-keyed for subagents, rootId-keyed for checkpoints,
 * a single shared slot for sessions — plus separate UI wiring per panel;
 * see `RefreshErrorPanel`'s own doc for the analogous `'setup'` exclusion).
 * The keep-data RULE itself is panel-agnostic and free to extend uniformly
 * (no new state shape), so it applies here too — these three panels stop
 * wiping their data on a background-refresh failure as well, they just
 * surface no dismissible notice about it (a follow-up, if wanted).
 */
export function applyPanelTransition<T>(current: RemoteData<T>, action: PanelAction): RemoteData<T> {
  if (action.type === 'local.panelLoading') {
    // CF-10: `fetchPanel`'s unbound-subagents short-circuit carries its
    // pre-built empty payload here instead of a real fetch-in-flight — land
    // it as an immediate success rather than `loading`. See `PanelAction`'s
    // `emptyData` doc for why the cast is safe.
    if (action.emptyData !== undefined) return success(action.emptyData as T);
    return current.status === 'success' ? current : loading;
  }
  // local.panelError — TI-3 (AU-42 Part B): keep already-loaded data intact.
  if (current.status === 'success') return current;
  return failure({ message: action.message, retryable: action.retryable });
}

/**
 * Fold a {@link PanelAction} into the map (loading with a no-flash guard, or
 * error). NOTE: deliberately NOT expressed as `applyPanelTransition(panels[
 * action.panel] ?? idle, action)` — `action.panel` is a generic `DataPanel`
 * here (not narrowed to one literal), so TypeScript cannot correlate the
 * computed-property KEY with `applyPanelTransition`'s inferred return type
 * across the whole mapped union (the same class of limitation `makePanelData`
 * documents in `protocol.ts`). `loading`/`failure(...)` are both
 * `RemoteData<never>`, assignable to every member of the union, which is what
 * lets this switch stay correlation-free.
 */
export function reducePanelAction(panels: PanelStateMap, action: PanelAction): PanelStateMap {
  switch (action.type) {
    case 'local.panelLoading': {
      const current = panels[action.panel];
      if (current && current.status === 'success') return panels;
      return { ...panels, [action.panel]: loading };
    }
    case 'local.panelError': {
      // TI-3 (AU-42 Part B): mirrors `applyPanelTransition`'s sibling rule —
      // a background-refresh failure over data already showing must KEEP it
      // (return `panels` unchanged for this slot) rather than replacing it
      // with a `failure(...)` card. Only a first-load failure (current is
      // idle/loading/error — no data to preserve) still becomes `failure`.
      // `state/transcript.ts`'s `reducePanelActionScoped` is what records the
      // parallel `refreshError` side-map entry for the 5 in-scope panels —
      // this function only owns the RemoteData half, same split as
      // `applyPanelTransition`.
      const current = panels[action.panel];
      if (current && current.status === 'success') return panels;
      return {
        ...panels,
        [action.panel]: failure({ message: action.message, retryable: action.retryable }),
      };
    }
  }
}

/** Read the success data for a panel, or `undefined` if it is not loaded. */
export function panelData<P extends DataPanel>(
  panels: PanelStateMap,
  panel: P,
): PanelDataMap[P] | undefined {
  const entry = panels[panel];
  return entry && isSuccess(entry) ? entry.data : undefined;
}

export { idle };

/** Dependencies {@link fetchPanel} needs — injectable so it is testable without React/bridge. */
export interface FetchPanelDeps {
  /** Issue a correlated control request (see bridge.request). */
  request: (method: ControlRequestMethod, params?: Record<string, unknown>) => Promise<unknown>;
  dispatch: (action: PanelAction) => void;
}

/**
 * Fetch (or re-fetch) a panel's data over the correlated request path.
 * Announces `loading` (a no-flash guard keeps already-loaded data visible during
 * a background refresh), then relies on the server-initiated `panel.data` PUSH
 * to fill the data on success — the resolved RPC value is deliberately ignored
 * (the reshaped snapshot only ever rides the push). A REJECTION (RPC error, "not
 * connected", or a lost-response timeout) flips the panel to an error state
 * instead of an eternal spinner. Retry = call this again.
 *
 * `req` overrides the default `panel.data` fetch — e.g. the Sessions "Load more"
 * (A#7) issues `{ method: 'session.list', params: { cursor } }` so pagination
 * rides the SAME correlated + error-surfacing path instead of a silent
 * fire-and-forget, while still landing on this `panel`'s RemoteData state.
 *
 * `scopeKey` (W4-T3b §7 B6) is captured HERE, at issue time, and threaded
 * onto both the `loading` and (on rejection) the `error` dispatch — so
 * whichever tab/root this fetch belongs to is fixed for its whole lifetime,
 * independent of whatever the ACTIVE tab happens to be when the promise
 * settles. Omit it for panels that don't need one (sessions/global).
 *
 * CF-10: an UNBOUND tab (no `sessionId` yet — before a session binds) can
 * never receive a `subagents` push — the host stamps it `unknown-session`
 * and `foldSessionScoped` drops any push that doesn't match a REAL session,
 * so the RPC would resolve while the tab's slice never gets its data and the
 * panel spins on "Loading subagents…" forever. `resolvePanelRequest` already
 * omits `sessionId` from `req.params` for exactly this case (its own test
 * pins that). Detected here, BEFORE the fetch is issued, from that same
 * signal — an honest empty success is dispatched instead, and `deps.request`
 * is never called. Bound tabs (`req.params` carries `sessionId`) and every
 * other panel fall through to the unchanged fetch path below.
 *
 * TI-3 (AU-42 Part A): resolves to a {@link FetchPanelOutcome} — purely
 * ADDITIVE (was `Promise<void>`, always resolving; still never REJECTS, a
 * rejection is still caught and folded into `local.panelError` exactly as
 * before). Every existing caller (`void fetchPanel(...)`, every `await
 * fetchPanel(...)` in `panels.test.ts`) ignores the resolved value and is
 * unaffected; App.tsx's `requestPanel` now forwards it so a caller that DOES
 * care about the settled outcome (SkillsPanel's "Reload skills" busy+notice
 * — unlike McpPanel's dedicated `reload.mcp` RPC, a Skills reload IS this
 * same `panel.data` refetch) can react without a second, duplicate request.
 */
export function fetchPanel(
  panel: DataPanel,
  deps: FetchPanelDeps,
  opts: {
    scopeKey?: string;
    req?: { method: ControlRequestMethod; params?: Record<string, unknown> };
  } = {},
): Promise<FetchPanelOutcome> {
  const { scopeKey } = opts;
  const req = opts.req ?? { method: 'panel.data' as const, params: { panel } };

  if (panel === 'subagents' && !(req.params && 'sessionId' in req.params)) {
    const emptySubagents: PanelDataMap['subagents'] = { delegations: [] };
    deps.dispatch({ type: 'local.panelLoading', panel, scopeKey, emptyData: emptySubagents });
    return Promise.resolve({ ok: true });
  }

  deps.dispatch({ type: 'local.panelLoading', panel, scopeKey });
  return deps.request(req.method, req.params).then(
    (): FetchPanelOutcome => {
      /* success data arrives via the `panel.data` push; nothing to do here. */
      return { ok: true };
    },
    (err: unknown): FetchPanelOutcome => {
      const message = errorMessage(err);
      deps.dispatch({
        type: 'local.panelError',
        panel,
        scopeKey,
        message,
        retryable: true,
      });
      return { ok: false, message };
    },
  );
}

/**
 * TI-3 (AU-42 Part A): the settled outcome of one {@link fetchPanel} call —
 * see that function's doc for why this is a purely additive resolve-value
 * change (`fetchPanel` still never rejects).
 */
export type FetchPanelOutcome = { ok: true } | { ok: false; message: string };

/** Exported (BF-A) so `App.tsx`'s `loadMoreSessions` rejection handler reuses
 * this stringify instead of duplicating it — the SAME shape `fetchPanel`
 * already uses for every other panel's error message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Request failed.';
}

/**
 * T2 (beta.5, §0.1 ②, §2.2.4): the sentinel `unwrapSetupResult` resolves to
 * when a Setup mutation was refused because the USER dismissed a native
 * confirmation modal (`reason: 'declined'`) — not an error, and not a
 * success `ActionButton` (T9) should label. A unique symbol (not a string
 * literal or `null`) so it can never collide with, or be produced by,
 * `JSON.parse`-derived wire data.
 */
export const DECLINED: unique symbol = Symbol('setup-declined');

/**
 * Re-shape a Setup control.response result into the ordinary
 * resolve-on-success/reject-on-refusal contract every other correlated
 * mutation (`setConfig`, `setNextEditToggle`) already has. §0.1 ②: a
 * controller REFUSAL is `ok:true` at the RPC transport layer (the request
 * itself succeeded) carrying `result:{ok:false,reason}` — so the raw
 * `bridge.request(...)` promise RESOLVES on a refusal, and callers that only
 * `.catch()` never see it. `dispatchSetup` (App.tsx) routes every Setup
 * mutation through this pure function so a refusal throws instead.
 *
 * One reason is neither a success nor a failure: `'declined'` means the user
 * cancelled a native confirmation modal, and resolves to the {@link DECLINED}
 * sentinel — deliberately NOT a throw and NOT a plain resolve of the raw
 * `{ok:false,...}` result (critic C-2 — a silent resolve would render
 * "cancel the Apply dialog" as "✓ Applied").
 */
export function unwrapSetupResult(result: unknown): unknown {
  const r = result as { ok?: boolean; reason?: string } | undefined;
  if (r && r.ok === false) {
    if (r.reason === 'declined') return DECLINED; // user cancelled the native modal — not an error, NOT a success
    throw new Error(r.reason || 'The action was refused.');
  }
  return result;
}

/**
 * BF-A: the Sessions "Load more" footer's tri-state (+hidden), pure and
 * exported so it is unit-testable without a DOM (this repo's webview tests
 * are no-jsdom — see `SessionsPanel.test.ts`). Mirrors TanStack
 * `useInfiniteQuery`'s split between `data.pages` (untouched) and
 * `error`/`isFetchingNextPage` (separate signals): a failed append must
 * NEVER wipe the already-loaded list, so `loadMoreError` lives OUTSIDE the
 * panel's `RemoteData` (same posture as the existing `sessionsLoadingMore`
 * React state) and only ever gates this footer, never the list above it.
 */
export type LoadMoreFooter = 'hidden' | 'idle' | 'loading' | 'error';

/** The sessions "Load more" footer state. `error` only shows when NOT loading
 *  and a cursor still exists (a failed append leaves nextCursor intact). */
export function loadMoreFooterState(
  hasCursor: boolean,
  loadingMore: boolean,
  loadMoreError: string | undefined,
): LoadMoreFooter {
  if (!hasCursor) return 'hidden';
  if (loadingMore) return 'loading';
  if (loadMoreError) return 'error';
  return 'idle';
}

/*
 * P7-N4 (ARCH I-1): the VALUE-tier fix for the panel-scope routing gap.
 * `PANEL_SCOPE` (`shared/protocol.ts`) made the panel->scope TAXONOMY
 * exhaustive at the TYPE tier, but the three webview routing sites that
 * consult it at RUNTIME (`foldPanelData`/`reducePanelActionScoped` below,
 * and `App.tsx`'s `requestPanel`, which now delegates to
 * {@link resolvePanelRequest}) all used to `default: -> globalPanels` for
 * any panel their switch didn't name — so a FUTURE session/root/cwd-scoped
 * panel added to `PanelDataMap`/`PANEL_SCOPE` without a matching case at
 * one of these sites would compile clean while silently landing in the
 * GLOBAL slice: the exact cross-tab bleed (P-1 violation) the taxonomy
 * exists to prevent. `assertExhaustivePanel` closes all three switches with
 * the canonical TypeScript exhaustiveness idiom (a `never`-typed parameter)
 * so that gap is now a COMPILE error, not a silent global write — mirrors
 * `buildPanelDataMessage`'s existing use of the identical shape for the
 * SAME DataPanel union (`AcpBackend`/host+webview `MockBackend`s'
 * `ControlDispatcher.ts`), applied here at the opposite (routing, not
 * construction) end of the wire.
 */

/**
 * Compile-time-only exhaustiveness gate: `x`'s parameter type is `never`,
 * so this is only callable from a switch's `default:` AFTER every current
 * {@link DataPanel} literal has been matched by an earlier case. If a new
 * `DataPanel` is added without a matching case at the call site, `x` no
 * longer narrows to `never` there and the call fails `npm run typecheck`
 * (webview) / `npm run check-types` (host) — see `panels.test.ts` for the
 * non-vacuous proof. At runtime this is reachable only via a type-system
 * bypass (a corrupted/forward-incompatible wire value); it throws rather
 * than guessing a scope.
 */
export function assertExhaustivePanel(x: never): never {
  throw new Error(`unreachable DataPanel: ${String(x)}`);
}

/** Minimal read-only shape {@link resolvePanelRequest} needs from the tab
 * issuing the fetch — narrower than the full `TabState` (avoids an import
 * cycle: `../types` already imports {@link PanelStateMap} FROM this
 * module). Structurally, `TabState` satisfies this at every call site. */
export interface PanelRequestTab {
  tabId: string;
  sessionId?: string;
  rootId: string;
}

/** The correlated `panel.data` fetch's scope key (W4 §7 B6 — fixed at
 * issue time) + wire request params for one panel.
 *
 * `rejectTag` (F-1, final-4way-fixes.md) is the SEPARATE decision of which
 * in-flight requests a tab close should reject (`bridge.rejectTab` ->
 * `rpc.rejectByTag`): set it ONLY when `panel` is owned by exactly this one
 * tab (today: `subagents`). Leave it `undefined` for every scope a single
 * tab does NOT own outright — `checkpoints` (root-shared across sibling
 * same-root tabs), `sessions` (one connection-wide shared slice), and every
 * connection-global panel (`tools`/`mcp`/`skills`/`models`/`settings`) —
 * so closing one tab can never reject a sibling tab's (or the connection's)
 * still-in-flight request. `rejectTag` is deliberately independent of
 * `scopeKey`: `checkpoints` HAS a scopeKey (`tab.rootId`, for routing the
 * loading/error transition to the right root slice) but must NOT have a
 * rejectTag (a sibling tab watching the same root must survive this tab's
 * close). */
export interface PanelRequestScope {
  scopeKey?: string;
  rejectTag?: string;
  params: Record<string, unknown>;
}

/**
 * Resolve `panel`'s scope key + reject tag + request params from the tab
 * issuing the fetch — the pure half of `App.tsx`'s `requestPanel`,
 * extracted so it is unit-testable without React/jsdom (this repo's webview
 * test convention is no-jsdom; `App.tsx` itself has no test file).
 * Behavior-preserving for scope/params: every branch reproduces the EXACT
 * pre-extraction scope/params the if-chain it replaced computed for that
 * panel (§2f) — subagents keys on the owning tab id (+ sessionId param once
 * bound); checkpoints keys on the tab's rootId (+ rootId param); sessions
 * carries no scopeKey (the one shared slot) but forwards sessionId once
 * bound; every global panel carries neither. P7-N4 (ARCH I-1): exhaustive
 * over `DataPanel` via {@link assertExhaustivePanel} — the if-chain this
 * replaced fell through to the global shape for ANY unrecognized panel,
 * which would have silently under-scoped a FUTURE session/root/cwd-scoped
 * panel's fetch too. `rejectTag` (F-1) is a NEW field, not behavior-
 * preserving by design — see {@link PanelRequestScope}'s doc for the rule.
 */
export function resolvePanelRequest(panel: DataPanel, tab: PanelRequestTab): PanelRequestScope {
  const params: Record<string, unknown> = { panel };
  switch (panel) {
    case 'subagents': {
      if (tab.sessionId) params.sessionId = tab.sessionId;
      return { scopeKey: tab.tabId, rejectTag: tab.tabId, params };
    }
    case 'checkpoints':
      params.rootId = tab.rootId;
      return { scopeKey: tab.rootId, params };
    case 'sessions':
      if (tab.sessionId) params.sessionId = tab.sessionId;
      return { params };
    case 'tools':
    case 'mcp':
    case 'skills':
    case 'models':
    case 'settings':
    case 'setup':
      return { params };
    default:
      return assertExhaustivePanel(panel);
  }
}
