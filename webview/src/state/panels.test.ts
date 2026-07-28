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
import { isError, isLoading, isSuccess } from './remoteData';
import {
  assertExhaustivePanel,
  fetchPanel,
  reducePanelAction,
  resolvePanelRequest,
  setPanelSuccess,
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
});

describe('fetchPanel controller — catch-on-invoke + retry (Part X2)', () => {
  it('a rejecting invoke flips the panel to an error state (no eternal spinner)', async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error('Hermes session is not started yet.'));

    await fetchPanel('mcp', { request, dispatch });

    // First it announces loading, then — on rejection — an error with the message.
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: 'local.panelLoading', panel: 'mcp' });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'local.panelError',
      panel: 'mcp',
      message: 'Hermes session is not started yet.',
      retryable: true,
    });
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
