/*
 * Red-first tests for the per-panel RemoteData model (Part X2).
 *
 * Panels used to spin on "Loading…" forever when an invoke rejected (no catch,
 * no error surface). This models each panel as RemoteData —
 * `idle | loading | success<data> | error<{message,retryable}>` (the ADT from
 * `devexperts/remote-data-ts`, mirrored on TanStack Query's
 * `status: pending|error|success` split) — so a rejected fetch flips to an
 * honest Error+Retry state, and Retry re-invokes.
 */
import { describe, it, expect, vi } from 'vitest';
import type { DataPanel, PanelDataMap } from '../protocol';
import { idle, isError, isLoading, isSuccess, success } from './remoteData';
import {
  applyPanelTransition,
  assertExhaustivePanel,
  DECLINED,
  fetchPanel,
  reducePanelAction,
  resolvePanelRequest,
  setPanelSuccess,
  unwrapSetupResult,
  type PanelAction,
  type PanelStateMap,
} from './panels';

const toolsData: PanelDataMap['tools'] = { toolsets: [], tools: [] };

describe('panel RemoteData reducer helpers (Part X2)', () => {
  it('setPanelSuccess stores a success<data> entry', () => {
    const next = setPanelSuccess({}, 'tools', toolsData);
    const entry = next.tools;
    expect(entry && isSuccess(entry)).toBe(true);
    if (entry && isSuccess(entry)) expect(entry.data).toBe(toolsData);
  });

  it('panelLoading moves an untouched (idle/undefined) panel to loading', () => {
    const next = reducePanelAction({}, { type: 'local.panelLoading', panel: 'mcp' });
    expect(next.mcp && isLoading(next.mcp)).toBe(true);
  });

  it('panelLoading does NOT flash loading over already-loaded data (silent background refresh)', () => {
    const loaded: PanelStateMap = setPanelSuccess({}, 'tools', toolsData);
    const next = reducePanelAction(loaded, { type: 'local.panelLoading', panel: 'tools' });
    // Cached data stays visible while the correlated refresh is in flight.
    expect(next.tools && isSuccess(next.tools)).toBe(true);
  });

  it('panelError moves a panel to an error state carrying message + retryable', () => {
    const next = reducePanelAction(
      { tools: { status: 'loading' } },
      { type: 'local.panelError', panel: 'tools', message: 'not connected', retryable: true },
    );
    const entry = next.tools;
    expect(entry && isError(entry)).toBe(true);
    if (entry && isError(entry)) {
      expect(entry.error).toEqual({ message: 'not connected', retryable: true });
    }
  });

  /*
   * TI-3 (AU-42 Part B): the SYSTEMIC fix — a background-refresh failure
   * (a Reload that fails, a push-triggered refetch that errors) must NEVER
   * wipe already-loaded data. RED at HEAD: `local.panelError` replaced
   * `success` with `failure(...)` unconditionally, so this asserted
   * `next.tools` was `{status:'error',...}`, not the preserved success data.
   */
  it('TI-3: a background-refresh error over ALREADY-success data KEEPS the data — never replaces it with a failure card', () => {
    const loaded: PanelStateMap = setPanelSuccess({}, 'tools', toolsData);
    const next = reducePanelAction(loaded, {
      type: 'local.panelError',
      panel: 'tools',
      message: 'refresh failed',
      retryable: true,
    });
    expect(next.tools).toEqual({ status: 'success', data: toolsData });
    // Same object reference, not just equal — no new RemoteData allocated
    // for a slot that didn't change.
    expect(next.tools).toBe(loaded.tools);
  });

  /*
   * Companion to the test above: a FIRST-load failure (no data yet — idle,
   * or loading as pinned by the pre-existing 'panelError moves a panel...'
   * test just above) still becomes `failure` — the error card stays correct
   * there. Pinned explicitly for the idle case too (loading already covered).
   */
  it('TI-3 companion: a first-load error (current is idle, no data to preserve) still becomes failure', () => {
    const next = reducePanelAction({}, { type: 'local.panelError', panel: 'mcp', message: 'boom', retryable: false });
    const entry = next.mcp;
    expect(entry && isError(entry)).toBe(true);
    if (entry && isError(entry)) expect(entry.error).toEqual({ message: 'boom', retryable: false });
  });

  /*
   * CF-10: an unbound tab's subagents request can never receive its push (the
   * host stamps it `unknown-session`; `foldSessionScoped` drops it — see
   * `fetchPanel`'s short-circuit below), so `fetchPanel` announces it via a
   * `local.panelLoading` action carrying `emptyData` instead of a real
   * fetch-in-flight. `applyPanelTransition` (the scoped-panel half —
   * `subagents`/`checkpoints`/`sessions` all fold through this, not the
   * keyed-map `reducePanelAction` above) must turn THAT into an immediate
   * `success`, not `loading`.
   */
  it('CF-10: applyPanelTransition turns a panelLoading action carrying emptyData into an immediate success, not loading', () => {
    const next = applyPanelTransition(idle, {
      type: 'local.panelLoading',
      panel: 'subagents',
      scopeKey: 'tab-1',
      emptyData: { delegations: [] },
    });
    expect(isSuccess(next)).toBe(true);
    if (isSuccess(next)) expect(next.data).toEqual({ delegations: [] });
  });

  it('a plain panelLoading action (no emptyData) still transitions to loading, unaffected', () => {
    const next = applyPanelTransition(idle, { type: 'local.panelLoading', panel: 'subagents', scopeKey: 'tab-1' });
    expect(isLoading(next)).toBe(true);
  });

  /*
   * TI-3 (AU-42 Part B): the re-scoped panels (subagents/checkpoints/
   * sessions — everything that folds through `applyPanelTransition` rather
   * than the map-keyed `reducePanelAction` above) get the SAME keep-data
   * rule — assessed clean to extend (panel-agnostic, no new state shape) and
   * done; only the refreshError side-map/banner is scoped OUT for these
   * three (see this file's `RefreshErrorPanel` doc for why).
   */
  it('TI-3: applyPanelTransition ALSO keeps success data on a background-refresh error (subagents/checkpoints/sessions share the reducePanelAction rule)', () => {
    const loaded = success<PanelDataMap['subagents']>({ delegations: [] });
    const next = applyPanelTransition(loaded, {
      type: 'local.panelError',
      panel: 'subagents',
      scopeKey: 'tab-1',
      message: 'refresh failed',
      retryable: true,
    });
    expect(next).toBe(loaded); // unchanged reference — no new RemoteData allocated
  });

  it('TI-3 companion: applyPanelTransition — a first-load error (idle, no data yet) still becomes failure', () => {
    const next = applyPanelTransition(idle, {
      type: 'local.panelError',
      panel: 'checkpoints',
      scopeKey: '/root-a',
      message: 'lock timeout',
      retryable: true,
    });
    expect(isError(next)).toBe(true);
    if (isError(next)) expect(next.error).toEqual({ message: 'lock timeout', retryable: true });
  });
});

describe('fetchPanel controller — catch-on-invoke + retry (Part X2)', () => {
  it('a rejecting invoke flips the panel to an error state (no eternal spinner)', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error('The agent session is not started yet.'));

    await fetchPanel('mcp', { request, dispatch });

    // First it announces loading, then — on rejection — an error with the message.
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: 'local.panelLoading', panel: 'mcp' });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'local.panelError',
      panel: 'mcp',
      message: 'The agent session is not started yet.',
      retryable: true,
    });
  });

  /*
   * AU-10: the host-side companion fix (`ControlDispatcher.fetchPanelData`)
   * now REJECTS a `panel.data{panel:'sessions'}` request with a reasoned
   * `PanelUnavailableError` (e.g. "Agent is not connected yet.") instead of
   * silently resolving with no data and no push. This test proves the
   * webview HALF of INV-14 end-to-end through the REAL reducer (not just the
   * dispatched action): once that rejection lands, `RemoteData` moves fully
   * OUT of `loading` into a retryable `error` state — a spinner that would
   * otherwise have no bounded lifetime now surfaces Retry. `fetchPanel`'s
   * generic catch-on-invoke path (proven above) is what does this; nothing
   * webview-side needed a NEW code path for the AU-10 scenario specifically
   * — it was already sound, the host was just never rejecting.
   */
  it('AU-10: a rejected sessions fetch ("Agent is not connected yet.") folds through the REAL reducer into a retryable error RemoteData — never stuck in loading', async () => {
    const dispatched: PanelAction[] = [];
    const dispatch = vi.fn((action: PanelAction) => dispatched.push(action));
    const request = vi.fn().mockRejectedValue(new Error('Agent is not connected yet.'));

    await fetchPanel('sessions', { request, dispatch });

    let state = reducePanelAction({}, dispatched[0] as PanelAction);
    expect(state.sessions && isLoading(state.sessions)).toBe(true); // passes through loading...
    state = reducePanelAction(state, dispatched[1] as PanelAction);
    // ...but settles on a retryable error, not stuck.
    expect(state.sessions && isError(state.sessions)).toBe(true);
    if (state.sessions && isError(state.sessions)) {
      expect(state.sessions.error).toEqual({ message: 'Agent is not connected yet.', retryable: true });
    }
  });

  it('issues a correlated panel.data request for the panel', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue(undefined);

    await fetchPanel('skills', { request, dispatch });

    expect(request).toHaveBeenCalledWith('panel.data', { panel: 'skills' });
  });

  it('does NOT dispatch an error when the invoke resolves (push path fills the data)', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue({ some: 'raw-result' });

    await fetchPanel('tools', { request, dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1); // loading only
    expect(dispatch).toHaveBeenCalledWith({ type: 'local.panelLoading', panel: 'tools' });
  });

  /*
   * TI-3 (AU-42 Part A): `fetchPanel` now resolves to a `FetchPanelOutcome`
   * (was bare `Promise<void>`) — purely additive, still never REJECTS (a
   * rejection is still caught and folded into `local.panelError` exactly as
   * before, proven by the dispatch-focused tests above/below). This is what
   * lets a caller that wants the settled outcome — SkillsPanel's "Reload
   * skills" busy+notice (TI-3 Part A) — react without a second request.
   */
  it('TI-3: resolves {ok:true} when the invoke resolves', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue(undefined);

    await expect(fetchPanel('skills', { request, dispatch })).resolves.toEqual({ ok: true });
  });

  it('TI-3: resolves {ok:false, message} — never rejects — when the invoke rejects', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error('dashboard unreachable'));

    await expect(fetchPanel('skills', { request, dispatch })).resolves.toEqual({
      ok: false,
      message: 'dashboard unreachable',
    });
  });

  it('Retry re-invokes: calling fetchPanel again issues a second request', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await fetchPanel('models', { request, dispatch }); // initial → error
    await fetchPanel('models', { request, dispatch }); // retry → success

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, 'panel.data', { panel: 'models' });
    expect(request).toHaveBeenNthCalledWith(2, 'panel.data', { panel: 'models' });
  });

  it('A#7: the `req` override routes Sessions "Load more" over session.list, still landing on the sessions RemoteData', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue(undefined);

    await fetchPanel(
      'sessions',
      { request, dispatch },
      { req: { method: 'session.list', params: { cursor: 'c2' } } },
    );

    // Loading is announced against the SESSIONS panel (so failure/loading shows
    // there), but the correlated request carries the paginated method+cursor.
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: 'local.panelLoading', panel: 'sessions', scopeKey: undefined });
    expect(request).toHaveBeenCalledWith('session.list', { cursor: 'c2' });
  });

  it('A#7: a rejecting "Load more" surfaces the sessions error (no longer silent)', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error('list failed'));

    await fetchPanel(
      'sessions',
      { request, dispatch },
      { req: { method: 'session.list', params: { cursor: 'c2' } } },
    );

    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'local.panelError',
      panel: 'sessions',
      message: 'list failed',
      retryable: true,
    });
  });

  /*
   * CF-10: an UNBOUND tab (no `sessionId` yet — before a session binds) omits
   * `sessionId` from its subagents `panel.data` request params (see
   * `resolvePanelRequest`'s own "unbound tab" test below — this is the exact
   * signal it produces). The host stamps the resulting push `unknown-session`;
   * `foldSessionScoped` drops it (it can't match this tab's real session,
   * which doesn't exist yet); the RPC still resolves, but nothing ever lands
   * -> the panel spins on "Loading subagents…" forever. Fix: `fetchPanel`
   * detects the unbound case from `req.params` BEFORE issuing the fetch and
   * short-circuits to an immediate empty success instead.
   */
  it('CF-10: an UNBOUND tab (no sessionId) subagents request short-circuits to an empty success — the RPC is never sent', async () => {
    const dispatch = vi.fn();
    const request = vi.fn();

    await fetchPanel(
      'subagents',
      { request, dispatch },
      { scopeKey: 'tab-1', req: { method: 'panel.data', params: { panel: 'subagents' } } },
    );

    expect(request).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'local.panelLoading',
      panel: 'subagents',
      scopeKey: 'tab-1',
      emptyData: { delegations: [] },
    });
  });

  it('CF-10: a BOUND tab (sessionId present) subagents request is unaffected — still fetches and announces plain loading', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue(undefined);

    await fetchPanel(
      'subagents',
      { request, dispatch },
      { scopeKey: 'tab-1', req: { method: 'panel.data', params: { panel: 'subagents', sessionId: 'session-1' } } },
    );

    expect(request).toHaveBeenCalledWith('panel.data', { panel: 'subagents', sessionId: 'session-1' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'local.panelLoading', panel: 'subagents', scopeKey: 'tab-1' });
  });

  it('CF-10: the short-circuit is subagents-only — an unbound "sessions" request (no sessionId either) still fetches normally', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue(undefined);

    await fetchPanel('sessions', { request, dispatch }, { req: { method: 'panel.data', params: { panel: 'sessions' } } });

    expect(request).toHaveBeenCalledWith('panel.data', { panel: 'sessions' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'local.panelLoading', panel: 'sessions', scopeKey: undefined });
  });
});

/*
 * P7-N4 (ARCH I-1): `resolvePanelRequest` is the pure half of `App.tsx`'s
 * `requestPanel` if-chain, extracted so it's unit-testable without React/
 * jsdom (the ARCH first-pass note that "the no-jsdom test convention is
 * structurally blind to exactly this failure shape" — App.tsx itself has NO
 * test file today). The if-chain it replaced quietly fell through to the
 * global shape (`{params: {panel}}`, no scopeKey) for ANY unrecognized
 * panel — exactly the fail-open this whole task closes. Every branch below
 * pins today's EXACT pre-existing behavior (unchanged); `assertExhaustivePanel`
 * closes the switch this function uses.
 */
describe('resolvePanelRequest — P7-N4: every DataPanel resolves its EXACT pre-existing scope key + params (behavior-preserving)', () => {
  const tab = { tabId: 'tab-1', sessionId: 'session-1', rootId: '/workspace/root-a' };

  it('subagents: scopeKey = the owning tab id; params carry sessionId when bound', () => {
    expect(resolvePanelRequest('subagents', tab)).toEqual({
      scopeKey: 'tab-1',
      rejectTag: 'tab-1',
      params: { panel: 'subagents', sessionId: 'session-1' },
    });
  });

  it('subagents: an unbound tab (no sessionId) omits the sessionId param but still carries scopeKey', () => {
    expect(resolvePanelRequest('subagents', { ...tab, sessionId: undefined })).toEqual({
      scopeKey: 'tab-1',
      rejectTag: 'tab-1',
      params: { panel: 'subagents' },
    });
  });

  it('checkpoints: scopeKey = the tab\'s rootId; params carry rootId', () => {
    expect(resolvePanelRequest('checkpoints', tab)).toEqual({
      scopeKey: '/workspace/root-a',
      params: { panel: 'checkpoints', rootId: '/workspace/root-a' },
    });
  });

  it('sessions: NO scopeKey (shared slot) — params carry sessionId only when bound', () => {
    expect(resolvePanelRequest('sessions', tab)).toEqual({
      params: { panel: 'sessions', sessionId: 'session-1' },
    });
    expect(resolvePanelRequest('sessions', { ...tab, sessionId: undefined })).toEqual({
      params: { panel: 'sessions' },
    });
  });

  it.each(['tools', 'mcp', 'skills', 'models', 'settings'] as const)(
    'global panel "%s": no scopeKey, params carry nothing but {panel}',
    (panel) => {
      expect(resolvePanelRequest(panel, tab)).toEqual({ params: { panel } });
    },
  );

  /*
   * F-1 (final-4way-fixes.md): the regression lock for the connection-global
   * mistagging bug — `rejectTag` must be set ONLY for `subagents` (tab-owned;
   * a tab close should reject its in-flight subagents fetch) and left
   * `undefined` for every panel a single tab does NOT own (`checkpoints` is
   * root-shared across sibling same-root tabs; `sessions` is one shared
   * slice; every global panel is connection-wide). A wrongly-set rejectTag
   * on e.g. `settings` would let closing tab A reject tab B's (or the
   * connection's) in-flight `config.set`-style correlated request.
   */
  it('F-1: rejectTag === tab.tabId for subagents (tab-owned — reject on close is correct)', () => {
    expect(resolvePanelRequest('subagents', tab).rejectTag).toBe(tab.tabId);
  });

  it.each(['checkpoints', 'sessions', 'tools', 'mcp', 'skills', 'models', 'settings'] as const)(
    'F-1: rejectTag is undefined for "%s" (shared/connection-global — must survive a sibling tab close)',
    (panel) => {
      expect(resolvePanelRequest(panel, tab).rejectTag).toBeUndefined();
    },
  );
});

describe('assertExhaustivePanel — the compile-time gate `foldPanelData`/`reducePanelActionScoped`/`resolvePanelRequest` all close their DataPanel switch with (non-vacuous proof)', () => {
  it('its parameter type is `never` — passing any REAL DataPanel literal is ALREADY a compile error, proving the gate is reachable only after a switch has exhaustively matched every current DataPanel', () => {
    const realPanel: DataPanel = 'settings';
    // @ts-expect-error — TS2345: Argument of type 'DataPanel' is not
    // assignable to parameter of type 'never'. This is the EXACT class of
    // error a routing site's `default:` raises at `npm run typecheck -w
    // webview` the moment its switch forgets a real DataPanel case — proving
    // the gate is load-bearing, not decorative. If this stops needing
    // `@ts-expect-error` (e.g. the signature widens to `unknown`/`DataPanel`),
    // the exhaustiveness guarantee itself has silently regressed.
    expect(() => assertExhaustivePanel(realPanel)).toThrow('unreachable DataPanel: settings');
  });

  it('throws (never silently returns) if ever reached — the fail-open this whole task deletes', () => {
    // Only reachable via a type-system bypass (an `as`/`any` cast on a
    // malformed/corrupted wire value) — this is the runtime backstop for
    // that case, mirroring `buildPanelDataMessage`'s existing use of the
    // identical `assertNever`-style gate for the SAME DataPanel union
    // (AcpBackend/host+webview MockBackend `ControlDispatcher.ts`).
    expect(() => assertExhaustivePanel('unknown-future-panel' as never)).toThrow(
      'unreachable DataPanel: unknown-future-panel',
    );
  });
});

/*
 * T2 (beta.5, §0.1 ②, §2.2.4): the Setup panel's control.response transport
 * always RESOLVES (a controller refusal is `ok:true` at the RPC layer,
 * carrying `result:{ok:false,reason}` — the request itself succeeded, only
 * the requested action was declined) — so `dispatchSetup`'s raw
 * `bridge.request(...)` used to resolve on a refusal too, and `ActionButton`
 * never saw an error. `unwrapSetupResult` is the pure re-shape that restores
 * the ordinary resolve-on-success/reject-on-refusal contract every OTHER
 * correlated mutation (`setConfig`, `setNextEditToggle`) already has — with
 * one deliberate exception: `reason: 'declined'` (the user dismissed a
 * native confirmation modal) is neither a success nor a failure, so it
 * resolves to the `DECLINED` sentinel instead of throwing OR silently
 * resolving the raw `{ok:false,...}` shape (critic C-2 — a silent resolve
 * would have rendered "cancel the Apply dialog" as "✓ Applied").
 */
describe('unwrapSetupResult + DECLINED (T2, §2.2.4)', () => {
  it('an accepted result (no ok:false) passes through unchanged', () => {
    const result = { ok: true, data: { installed: true } };
    expect(unwrapSetupResult(result)).toBe(result);
  });

  it('a result with no `ok` field at all passes through unchanged (not every SetupMethod result carries an ok flag)', () => {
    const result = { next: true, generic: false };
    expect(unwrapSetupResult(result)).toBe(result);
  });

  it('undefined passes through unchanged', () => {
    expect(unwrapSetupResult(undefined)).toBeUndefined();
  });

  it('a refusal throws an Error carrying its `reason` verbatim', () => {
    expect(() => unwrapSetupResult({ ok: false, reason: 'pipx was not found on your PATH.' })).toThrow(
      'pipx was not found on your PATH.',
    );
  });

  it('a refusal with no `reason` throws the default "The action was refused." message', () => {
    expect(() => unwrapSetupResult({ ok: false })).toThrow('The action was refused.');
  });

  it('`reason: "declined"` returns the DECLINED sentinel — NOT a throw', () => {
    expect(() => unwrapSetupResult({ ok: false, reason: 'declined' })).not.toThrow();
  });

  it('`reason: "declined"` returns EXACTLY the DECLINED sentinel', () => {
    expect(unwrapSetupResult({ ok: false, reason: 'declined' })).toBe(DECLINED);
  });

  it('`reason: "declined"` does NOT resolve the raw `{ok:false,...}` result (the C-2 silent-resolve regression)', () => {
    const raw = { ok: false, reason: 'declined' };
    const unwrapped = unwrapSetupResult(raw);
    expect(unwrapped).not.toBe(raw);
    expect(unwrapped).not.toEqual(raw);
  });
});
