import { describe, it, expect } from 'vitest';

// R4-ARCH-01: no `vi.mock('vscode')` here — `control/` is headless-importable
// (the settings read is an injected port member); `controlHeadless.lock.test.ts`
// is the tier-wide proof and this file's plain import is another.

import { ControlDispatcher } from './ControlDispatcher';
import {
  makePort,
  registerFakeSource,
  registerSkillsSourceWithHubNames,
  makeFakeAdminClient,
  makeFakeDashboard,
} from './ControlDispatcher.golden.harness';
import type { HostToWebview } from '../../../shared/protocol';

/**
 * WS-GD.2a Task A1 — golden master 1: `invokeControl`'s dispatch-table
 * routing, the panels seam, and the checkpoints root-resolution refusals,
 * pinned against the CURRENT, unchanged `ControlDispatcher`. These tests
 * MUST pass on today's code — a failure here means the PIN is wrong (fix
 * the pin by re-reading the code), never the production code. Later pure-
 * move commits (Tasks A3–A9) prove behavior-identical by staying green
 * against this exact suite.
 */

describe('golden: invokeControl routing table', () => {
  it('refuses a method outside ALLOWED_CONTROL_METHODS', async () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    await expect(dispatcher.invokeControl('nope')).rejects.toThrow(
      "Refusing to invoke disallowed control method 'nope'",
    );
  });

  const PASSTHROUGH = [
    'tools.list',
    'tools.configure',
    'skills.manage',
    'skills.reload',
    'model.options',
    'config.set',
    'config.show',
    'context.searchFiles',
  ] as const;
  it.each(PASSTHROUGH)('%s passes through to port.dispatch verbatim and returns its result', async (method) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { port } = makePort({
      dispatch: async (m, p) => {
        calls.push({ method: m, params: p });
        return { echoed: m };
      },
    });
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl(method, { some: 'params' });
    expect(calls).toEqual([{ method, params: { some: 'params' } }]);
    expect(result).toEqual({ echoed: method });
  });
});

describe('golden: panel.data / session.list routing', () => {
  it('panel.data with an unregistered panel resolves undefined and never calls port.dispatch', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { port } = makePort({
      dispatch: async (m, p) => {
        calls.push({ method: m, params: p });
        return undefined;
      },
    });
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl('panel.data', { panel: 'mcp' });
    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('panel.data for a registered panel resolves the fetched data and emits exactly one scoped panel.data push', async () => {
    const { port, emitted, registry } = makePort();
    const fixture = { toolsets: [], tools: [] };
    registerFakeSource(registry, 'tools', async () => ({ data: fixture }));
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('panel.data', { panel: 'tools' });

    expect(result).toEqual(fixture);
    const pushes = emitted.filter(
      (m): m is Extract<HostToWebview, { type: 'panel.data'; panel: 'tools' }> =>
        m.type === 'panel.data' && m.panel === 'tools',
    );
    expect(pushes).toEqual([{ type: 'panel.data', panel: 'tools', data: fixture }]);
  });

  it("session.list routes to the 'sessions' panel fetch and the push carries cwd", async () => {
    let fetchCount = 0;
    const { port, emitted, registry } = makePort({ getConnectionCwd: () => '/workspace' });
    registerFakeSource(registry, 'sessions', async () => {
      fetchCount++;
      return { data: { sessions: [] } };
    });
    const dispatcher = new ControlDispatcher(port);

    await dispatcher.invokeControl('session.list', {});

    expect(fetchCount).toBe(1);
    const push = emitted.find(
      (m): m is Extract<HostToWebview, { type: 'panel.data'; panel: 'sessions' }> =>
        m.type === 'panel.data' && m.panel === 'sessions',
    );
    expect(push).toBeDefined();
    expect(push?.cwd).toBe('/workspace');
  });
});

describe('golden: session.load', () => {
  it('with missing sessionId/cwd resolves undefined, never calls loadSessionIntoTab, and logs the miss', async () => {
    const logLines: string[] = [];
    const loadCalls: Array<{ sessionId: string; cwd: string }> = [];
    const { port } = makePort({
      logger: {
        append: (line) => {
          logLines.push(line);
        },
      },
      loadSessionIntoTab: async (sessionId, cwd) => {
        loadCalls.push({ sessionId, cwd });
        return undefined;
      },
    });
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('session.load', { sessionId: 'S1' });

    expect(result).toBeUndefined();
    expect(loadCalls).toEqual([]);
    expect(logLines).toEqual(['[AcpBackend] session.load: missing sessionId/cwd (sessionId=S1, cwd=undefined)']);
  });

  it('with both sessionId and cwd present calls loadSessionIntoTab(sessionId, cwd) and returns its result', async () => {
    const loadCalls: Array<{ sessionId: string; cwd: string }> = [];
    const { port } = makePort({
      loadSessionIntoTab: async (sessionId, cwd) => {
        loadCalls.push({ sessionId, cwd });
        return { found: false };
      },
    });
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('session.load', { sessionId: 'S2', cwd: '/c' });

    expect(loadCalls).toEqual([{ sessionId: 'S2', cwd: '/c' }]);
    expect(result).toEqual({ found: false });
  });
});

describe('golden: reload.mcp panel refetch', () => {
  it("a 'reloaded' status refetches the mcp panel and returns the raw result", async () => {
    let mcpFetchCount = 0;
    const { port, registry } = makePort({ dispatch: async () => ({ status: 'reloaded' }) });
    registerFakeSource(registry, 'mcp', async () => {
      mcpFetchCount++;
      return { data: { servers: [] } };
    });
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('reload.mcp', {});

    expect(result).toEqual({ status: 'reloaded' });
    expect(mcpFetchCount).toBe(1);
  });

  it('any other status does NOT refetch the mcp panel', async () => {
    let mcpFetchCount = 0;
    const { port, registry } = makePort({ dispatch: async () => ({ status: 'noop' }) });
    registerFakeSource(registry, 'mcp', async () => {
      mcpFetchCount++;
      return { data: { servers: [] } };
    });
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('reload.mcp', {});

    expect(result).toEqual({ status: 'noop' });
    expect(mcpFetchCount).toBe(0);
  });
});

describe('golden: model.save_key panel refetch', () => {
  it('a resolved { provider } refetches the models panel', async () => {
    let modelsFetchCount = 0;
    const { port, registry } = makePort({ dispatch: async () => ({ provider: {} }) });
    registerFakeSource(registry, 'models', async () => {
      modelsFetchCount++;
      return { data: { providers: [], currentModelId: '' } };
    });
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('model.save_key', { slug: 'x', api_key: 'y' });

    expect(result).toEqual({ provider: {} });
    expect(modelsFetchCount).toBe(1);
  });

  it('an empty {} result does NOT refetch the models panel', async () => {
    let modelsFetchCount = 0;
    const { port, registry } = makePort({ dispatch: async () => ({}) });
    registerFakeSource(registry, 'models', async () => {
      modelsFetchCount++;
      return { data: { providers: [], currentModelId: '' } };
    });
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('model.save_key', { slug: 'x', api_key: 'y' });

    expect(result).toEqual({});
    expect(modelsFetchCount).toBe(0);
  });
});

describe('golden: checkpoint.restore / checkpoint.redo / checkpoint.redoAll — root-resolution refusals', () => {
  const NO_TRACKER_REFUSAL = {
    restored: false,
    reason: 'Checkpoints are not available for this workspace — nothing was restored.',
  };
  const UNKNOWN_ROOT_REFUSAL = {
    restored: false,
    reason: 'Could not determine which workspace this checkpoint action targets — refusing to restore against the wrong worktree.',
  };

  it('checkpoint.restore with an empty root registry (no rootId) refuses "checkpoints not available"', async () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl('checkpoint.restore', { id: 'ckpt-1' });
    expect(result).toEqual(NO_TRACKER_REFUSAL);
  });

  it('checkpoint.restore with rootId: "unknown" refuses "could not determine which workspace"', async () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl('checkpoint.restore', { id: 'ckpt-1', rootId: 'unknown' });
    expect(result).toEqual(UNKNOWN_ROOT_REFUSAL);
  });

  it('checkpoint.redo with an empty root registry (no rootId) refuses "checkpoints not available"', async () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl('checkpoint.redo', {});
    expect(result).toEqual(NO_TRACKER_REFUSAL);
  });

  it('checkpoint.redo with rootId: "unknown" refuses "could not determine which workspace"', async () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl('checkpoint.redo', { rootId: 'unknown' });
    expect(result).toEqual(UNKNOWN_ROOT_REFUSAL);
  });

  it('checkpoint.redoAll with an empty root registry (no rootId) refuses "checkpoints not available"', async () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl('checkpoint.redoAll', {});
    expect(result).toEqual(NO_TRACKER_REFUSAL);
  });

  it('checkpoint.redoAll with rootId: "unknown" refuses "could not determine which workspace"', async () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    const result = await dispatcher.invokeControl('checkpoint.redoAll', { rootId: 'unknown' });
    expect(result).toEqual(UNKNOWN_ROOT_REFUSAL);
  });
});

describe('golden: skills.toggle / toolsets.toggle', () => {
  it('rejects when no dashboard is configured', async () => {
    const { port } = makePort({ getDashboard: () => undefined });
    const dispatcher = new ControlDispatcher(port);
    await expect(dispatcher.invokeControl('skills.toggle', { name: 'x', enabled: true })).rejects.toThrow(
      "Refusing 'skills.toggle': the Hermes dashboard channel is not configured.",
    );
  });

  it('rejects a payload missing name', async () => {
    const client = makeFakeAdminClient();
    const { port } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    const dispatcher = new ControlDispatcher(port);
    await expect(dispatcher.invokeControl('skills.toggle', { enabled: true })).rejects.toThrow(
      "'skills.toggle' requires a { name, enabled } payload.",
    );
  });

  it("rejects a name outside the last-listed skills set", async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    registerSkillsSourceWithHubNames(registry, ['known'], []);
    const dispatcher = new ControlDispatcher(port);
    await expect(dispatcher.invokeControl('skills.toggle', { name: 'unknown', enabled: true })).rejects.toThrow(
      "Refusing 'skills.toggle': 'unknown' is not in the last-listed skills set.",
    );
  });

  it('skills.toggle happy path calls client.toggleSkill(name, enabled) and returns its result', async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    registerSkillsSourceWithHubNames(registry, ['known'], []);
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('skills.toggle', { name: 'known', enabled: true });

    expect(client.calls.toggleSkill).toEqual([{ name: 'known', enabled: true }]);
    expect(result).toEqual({ ok: true, name: 'known', enabled: true });
  });

  it('toolsets.toggle happy path calls client.toggleToolset(name, enabled) on the tools panel', async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    registerFakeSource(registry, 'tools', async () => ({ data: { toolsets: [], tools: [] } }));
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('toolsets.toggle', { name: 'anything', enabled: false });

    expect(client.calls.toggleToolset).toEqual([{ name: 'anything', enabled: false }]);
    expect(result).toEqual({ ok: true, name: 'anything', enabled: false });
  });
});

describe('golden: public-surface seed pins', () => {
  it('getPreset() with no active session returns "manual"', () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    expect(dispatcher.getPreset()).toBe('manual');
  });

  it('listTabs() with an empty registry returns []', () => {
    const { port } = makePort();
    const dispatcher = new ControlDispatcher(port);
    expect(dispatcher.listTabs()).toEqual([]);
  });
});
