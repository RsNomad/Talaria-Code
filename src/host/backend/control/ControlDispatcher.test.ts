import { describe, it, expect, vi } from 'vitest';

/**
 * `ControlDispatcher.ts` pulls in `./customModes.ts`, which imports `vscode`
 * at module scope (unused by the `sessions`-fetch path this suite exercises,
 * but still a static import that must resolve outside the Extension Host).
 * Mirrors `AcpBackend.test.ts`'s own `vi.mock('vscode', ...)` — this suite
 * never calls into `customModes.ts`'s functions, so an empty stub is enough.
 */
vi.mock('vscode', () => ({}));

import { ControlDispatcher } from './ControlDispatcher';
import type { ControlDispatcherHostPort } from './ControlDispatcher';
import { PanelSourceRegistry } from '../../panels/PanelSourceRegistry';
import { SessionRegistry } from '../session/SessionRegistry';
import { RootRegistry } from '../../checkpoints/rootRegistry';
import type { DataPanel, PanelDataMap, HostToWebview } from '../../../shared/protocol';
import type { DashboardClientLike } from '../../dashboard/HermesDashboardClient';
import type { DashboardService } from '../../dashboard/HermesDashboardManager';

/**
 * F3-16 harness (reused by WS-GD.1 Tasks 6-7): a `vi.fn()`-free fake {@link
 * ControlDispatcherHostPort}. `sessions`/`rootRegistry` are REAL, empty
 * instances (both have trivial no-arg constructors and the `sessions`-panel
 * fetch path under test here never populates or reads them beyond an empty
 * lookup) — every other member the sessions-fetch path never touches is a
 * minimal throwing/no-op stub, typed directly against the real interface (no
 * `any`, no unnecessary casts). `overrides` lets a test replace exactly the
 * members its scenario cares about.
 */
function makePort(overrides: Partial<ControlDispatcherHostPort> = {}): {
  port: ControlDispatcherHostPort;
  emitted: HostToWebview[];
  registry: PanelSourceRegistry;
} {
  const emitted: HostToWebview[] = [];
  const registry = new PanelSourceRegistry();
  const base: ControlDispatcherHostPort = {
    dispatch: async () => undefined,
    emit: (msg) => {
      emitted.push(msg);
    },
    panelSources: registry,
    sessions: new SessionRegistry(),
    isPendingClose: () => false,
    rootRegistry: new RootRegistry(),
    resolveRootCoordinator: (_cwd) => {
      throw new Error('resolveRootCoordinator not used in these tests');
    },
    getConnectionCwd: () => undefined,
    getActiveSessionId: () => undefined,
    getDashboard: () => undefined,
    showWarningMessage: (_message) => {},
    isTrusted: () => true,
    confirm: async (_message, _detail, _actionLabel) => false,
    promptSecret: async (_prompt) => undefined,
    withProgress: async (_title, task) =>
      task({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    loadSessionIntoTab: async (_sessionId, _cwd, _tabId, _title) => undefined,
  };
  return { port: { ...base, ...overrides }, emitted, registry };
}

/**
 * Register a fetch-only fake {@link PanelSource} for one panel. The `data`
 * fixture is deliberately shape-agnostic (cast at the call site) — these
 * tests assert on the emitted `panel.data` message's SCOPE key, never on the
 * payload shape.
 */
function registerFakeSource<P extends DataPanel>(
  registry: PanelSourceRegistry,
  panel: P,
  fetch: (params?: unknown) => Promise<{ data: PanelDataMap[P] }>,
): void {
  registry.register(panel, { fetch });
}

describe('ControlDispatcher — WS-GD.1 F3-16: sessions scope snapshot', () => {
  it('snapshots the sessions cwd once at fetch entry — a mid-await connection-cwd mutation does not drift the pushed scope', async () => {
    let cwd = 'X';
    const { port, emitted, registry } = makePort({ getConnectionCwd: () => cwd });
    registerFakeSource(registry, 'sessions', async () => {
      // The live connection cwd changes DURING this fetch's await — the bug
      // this test pins is that `buildPanelDataMessage` (post-await) and
      // `panelScopeKey` (pre-await) used to each re-read this live value at
      // their own call time instead of sharing one snapshot.
      cwd = 'Y';
      return { data: {} as unknown as PanelDataMap['sessions'] };
    });
    const dispatcher = new ControlDispatcher(port);

    await dispatcher.invokeControl('panel.data', { panel: 'sessions' });

    const push = emitted.find(
      (m): m is Extract<HostToWebview, { type: 'panel.data'; panel: 'sessions' }> =>
        m.type === 'panel.data' && m.panel === 'sessions',
    );
    expect(push).toBeDefined();
    // The entry-time snapshot ('X'), NOT the drifted live value ('Y').
    expect(push?.cwd).toBe('X');
  });
});

describe('ControlDispatcher — WS-GD.1 CA-M04: panelFetchSeq pruning', () => {
  it('pruneFetchSeqForSession removes the unbounded per-session (subagents) fetch-seq entry', async () => {
    const { port, registry } = makePort();
    registerFakeSource(registry, 'subagents', async () => ({
      data: {} as unknown as PanelDataMap['subagents'], // shape-agnostic; the test asserts on the map key, not payload
    }));
    const dispatcher = new ControlDispatcher(port);
    // Reach the private map (private is compile-time only — no production surface added).
    // WS-GD.2a A4: panelFetchSeq now lives on the extracted PanelDataCoordinator.
    const seqMap = (dispatcher as unknown as { panels: { panelFetchSeq: Map<string, number> } }).panels.panelFetchSeq;

    await dispatcher.invokeControl('panel.data', { panel: 'subagents', sessionId: 'S1' });
    expect(seqMap.has('subagents:S1')).toBe(true); // the fetch minted the per-session key

    dispatcher.pruneFetchSeqForSession('S1');
    expect(seqMap.has('subagents:S1')).toBe(false); // ... and prune drops exactly it
  });
});

describe('ControlDispatcher — WS-GD.1 CA-M04b: registry-close pruning (all close paths, not just closeTabInternal)', () => {
  it('a SessionRegistry.close prunes the subagents fetch-seq entry — the rebind/swap/failed-load/recovery close paths reduce to exactly this seam', async () => {
    const { port, registry } = makePort();
    registerFakeSource(registry, 'subagents', async () => ({
      data: {} as unknown as PanelDataMap['subagents'], // shape-agnostic; the test asserts on the map key, not payload
    }));
    const dispatcher = new ControlDispatcher(port);
    // Reach the private map (private is compile-time only — no production surface added).
    // WS-GD.2a A4: panelFetchSeq now lives on the extracted PanelDataCoordinator.
    const seqMap = (dispatcher as unknown as { panels: { panelFetchSeq: Map<string, number> } }).panels.panelFetchSeq;

    await dispatcher.invokeControl('panel.data', { panel: 'subagents', sessionId: 'S1' });
    expect(seqMap.has('subagents:S1')).toBe(true); // the fetch minted the per-session key

    // Every close site that BYPASSES AcpBackend.closeTabInternal (rebind,
    // swap-eviction, failed-load, crash-recovery failure, disposeAll) funnels
    // through SessionRegistry.close — drive that seam directly. No controller
    // is registered for S1: the hook contract is UNCONDITIONAL, preserving the
    // semantics of the explicit closeTabInternal prune it replaces.
    port.sessions.close('S1');
    expect(seqMap.has('subagents:S1')).toBe(false); // pruned via the registry hook, no per-site wiring
  });
});

describe('ControlDispatcher — WS-GD.1 CA-M19 [SECURITY]: push-channel redaction', () => {
  it('redacts secret-shaped keys in the proactive panel.data PUSH (closes the AU-OBS-TE5 bypass)', async () => {
    const { port, emitted, registry } = makePort();
    registerFakeSource(registry, 'models', async () => ({
      data: { providers: [{ id: 'openai', token: 'sk-LIVE-SECRET' }] } as unknown as PanelDataMap['models'],
    }));
    const dispatcher = new ControlDispatcher(port);

    await dispatcher.invokeControl('panel.data', { panel: 'models' });

    // F3-16 pattern: narrow by the `panel: 'models'` discriminant (a bare
    // `{ type: 'panel.data' }` narrowing does not sufficiently overlap the
    // fixture's `{ providers }` assertion shape, since `HostToWebview`'s
    // `panel.data` variant is itself a union over every DataPanel).
    const push = emitted.find(
      (m): m is Extract<HostToWebview, { type: 'panel.data'; panel: 'models' }> =>
        m.type === 'panel.data' && m.panel === 'models',
    );
    expect(push).toBeDefined();
    const providers = (push?.data as unknown as { providers: Array<{ token: unknown }> } | undefined)?.providers;
    expect(providers?.[0]?.token).toBe('[redacted]'); // walked by the SAME deny-list the response path uses
  });
});

/**
 * BH-01 (round-2, WS-C C1): `skills.toggle`/`toolsets.toggle` used to return
 * the toggle RPC result with NO re-push — the config persisted server-side,
 * but the webview's `useToggle` V-11 reconcile shows the (stale) last-pushed
 * `serverValue` the instant the op settles, so the switch visibly "snapped
 * back" even though the toggle worked. `fakeClient` implements the full
 * {@link DashboardClientLike} surface (`vi.fn()`-free — plain closures, no
 * call-recording needed here since these tests assert on the EMITTED PUSH /
 * LOG, not on what reached the client).
 */
function makeFakeToggleClient(): DashboardClientLike {
  return {
    probe: async () => true,
    listSkills: async () => [],
    toggleSkill: async (name, enabled) => ({ ok: true, name, enabled }),
    listToolsets: async () => [],
    toggleToolset: async (name, enabled) => ({ ok: true, name, enabled }),
  };
}

describe('ControlDispatcher — WS-C C1 (BH-01): toggle re-push', () => {
  it('toolsets.toggle pushes the persisted tools panel BEFORE the toggle RPC resolves', async () => {
    const dashboard: DashboardService = { ensure: async () => makeFakeToggleClient(), dispose() {} };
    const { port, emitted, registry } = makePort({ getDashboard: () => dashboard });
    registerFakeSource(registry, 'tools', async () => ({
      data: { toolsets: [{ name: 'web', enabled: true, toolCount: 1 }], tools: [] },
    }));
    const dispatcher = new ControlDispatcher(port);

    let pushedBeforeResolve = false;
    const raw = await dispatcher.invokeControl('toolsets.toggle', { name: 'web', enabled: true }).then((r) => {
      pushedBeforeResolve = emitted.some((m) => m.type === 'panel.data' && m.panel === 'tools');
      return r;
    });
    expect(raw).toEqual({ ok: true, name: 'web', enabled: true });
    expect(pushedBeforeResolve, 'the persisted panel is pushed BEFORE the toggle RPC resolves').toBe(true);
  });

  it('skills.toggle pushes the persisted skills panel BEFORE the toggle RPC resolves', async () => {
    const dashboard: DashboardService = { ensure: async () => makeFakeToggleClient(), dispose() {} };
    const { port, emitted, registry } = makePort({ getDashboard: () => dashboard });
    registerFakeSource(registry, 'skills', async () => ({
      data: {
        skills: [{ id: 'my-skill', name: 'my-skill', category: 'coding', description: 'x', enabled: true }],
        categories: [],
      },
    }));
    const dispatcher = new ControlDispatcher(port);

    let pushedBeforeResolve = false;
    const raw = await dispatcher.invokeControl('skills.toggle', { name: 'my-skill', enabled: true }).then((r) => {
      pushedBeforeResolve = emitted.some((m) => m.type === 'panel.data' && m.panel === 'skills');
      return r;
    });
    expect(raw).toEqual({ ok: true, name: 'my-skill', enabled: true });
    expect(pushedBeforeResolve, 'the persisted panel is pushed BEFORE the toggle RPC resolves').toBe(true);
  });

  it('toolsets.toggle: a rejecting re-push still resolves the toggle result and logs exactly one line naming the method and "re-push"', async () => {
    const dashboard: DashboardService = { ensure: async () => makeFakeToggleClient(), dispose() {} };
    const logLines: string[] = [];
    const { port, registry } = makePort({
      getDashboard: () => dashboard,
      logger: { append: (line) => logLines.push(line) },
    });
    registerFakeSource(registry, 'tools', async (): Promise<{ data: PanelDataMap['tools'] }> => {
      throw new Error('dashboard unreachable');
    });
    const dispatcher = new ControlDispatcher(port);

    const raw = await dispatcher.invokeControl('toolsets.toggle', { name: 'web', enabled: true });

    expect(raw).toEqual({ ok: true, name: 'web', enabled: true });
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toEqual(expect.stringContaining('toolsets.toggle'));
    expect(logLines[0]).toEqual(expect.stringContaining('re-push'));
  });
});

/**
 * WS-R1 R1-6 (L2-CA-26, ADR-R2-16 completion): C1/BH-01 made ONLY the toggle
 * branches failure-isolated (the suite above) — `reload.mcp` and
 * `model.save_key` still `await`ed their re-fetch UNGUARDED, so a
 * `fetchPanelData` rejection there turned an already-persisted, SUCCESSFUL
 * mutation into a REJECTED RPC (the exact hazard ADR-R2-16 named). This table
 * drives all THREE panel-mutating branches through one rejecting fake panel
 * source and asserts the shared `rePushPanel` contract on every row: the RPC
 * still RESOLVES its raw dispatch result, and exactly one `logger` line
 * names the method and contains "re-push". Before `rePushPanel` exists, the
 * `reload.mcp`/`model.save_key` rows fail (RED) because the unguarded await
 * rejects the whole `invokeControl` call; the `toolsets.toggle` row already
 * passes (it pins that the new helper preserves C1's existing behaviour).
 */
describe('ControlDispatcher — WS-R1 R1-6 (L2-CA-26): rePushPanel unifies all panel-mutating branches', () => {
  interface RePushCase {
    method: string;
    panel: DataPanel;
    invokeParams: unknown;
    dispatchResult: unknown;
  }

  const CASES: RePushCase[] = [
    { method: 'reload.mcp', panel: 'mcp', invokeParams: {}, dispatchResult: { status: 'reloaded' } },
    {
      method: 'model.save_key',
      panel: 'models',
      invokeParams: { slug: 'x', api_key: 'sk-super-secret-value' },
      dispatchResult: { provider: {} },
    },
    {
      method: 'toolsets.toggle',
      panel: 'tools',
      invokeParams: { name: 'web', enabled: true },
      dispatchResult: { ok: true, name: 'web', enabled: true },
    },
  ];

  it.each(CASES)(
    '$method: a rejecting panel re-push still resolves the RPC result and logs exactly one "re-push" line, never the params',
    async ({ method, panel, invokeParams, dispatchResult }) => {
      const logLines: string[] = [];
      const dashboard: DashboardService = { ensure: async () => makeFakeToggleClient(), dispose() {} };
      const { port, registry } = makePort({
        dispatch: async () => dispatchResult,
        getDashboard: () => dashboard,
        logger: { append: (line) => logLines.push(line) },
      });
      registerFakeSource(registry, panel, async () => {
        throw new Error(`${panel} panel unreachable`);
      });
      const dispatcher = new ControlDispatcher(port);

      const raw = await dispatcher.invokeControl(method, invokeParams);

      expect(raw).toEqual(dispatchResult);
      expect(logLines).toHaveLength(1);
      expect(logLines[0]).toEqual(expect.stringContaining(method));
      expect(logLines[0]).toEqual(expect.stringContaining('re-push'));
      // SECURITY (model.save_key's params carry the API key): the log line
      // must never interpolate `params` on any of the three branches.
      expect(logLines[0]).not.toEqual(expect.stringContaining('sk-super-secret-value'));
    },
  );
});
