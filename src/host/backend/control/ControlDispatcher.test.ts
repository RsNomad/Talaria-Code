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
