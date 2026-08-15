import { describe, it, expect, vi } from 'vitest';
import {
  PanelSourceRegistry,
  createDefaultPanelSources,
  type PanelSource,
  type PanelSourceContext,
} from './PanelSourceRegistry';
import {
  ToolsPanelSource,
  SkillsPanelSource,
  ModelsPanelSource,
  SettingsPanelSource,
  McpPanelSource,
  SessionsPanelSource,
  SubagentsPanelSource,
  CheckpointsPanelSource,
} from './panelSources';
import { CheckpointLockTimeoutError } from '../checkpoints/CheckpointTracker';
import type { CheckpointsData, SubagentsData } from '../../shared/protocol';

/**
 * Unit tests for the Zone Z3 panel-fetch strategy + registry (finding A1). Each
 * source is now an independently testable fetch/reshape unit; the registry is a
 * typed panel->source map with `register`/`get`/`has`. The reshapers themselves
 * are covered exhaustively in `reshapePanelData.test.ts` — here we prove each
 * source calls the RIGHT channel with the RIGHT params and packages its
 * {@link PanelFetchOutcome} correctly (just `data` now — the old `result` RAW
 * split was collapsed, A#6).
 */

/** A minimal, per-test {@link PanelSourceContext}; overrides plug in fakes. */
function makeContext(overrides: Partial<PanelSourceContext> = {}): PanelSourceContext {
  return {
    dispatch: vi.fn(async () => undefined),
    getAcpClient: () => undefined,
    getCwd: () => undefined,
    getSessionCwd: () => undefined,
    getSessionSubagentsSnapshot: () => undefined,
    getRootTracker: () => undefined,
    logger: undefined,
    ...overrides,
  };
}

describe('PanelSourceRegistry — typed panel->source map', () => {
  it('register + get round-trips the source for a panel', () => {
    const registry = new PanelSourceRegistry();
    const source: PanelSource<'tools'> = { fetch: async () => ({ data: { toolsets: [], tools: [] } }) };
    registry.register('tools', source);
    expect(registry.get('tools')).toBe(source);
  });

  it('has() reflects registration; get() throws for an unregistered panel', () => {
    const registry = new PanelSourceRegistry();
    expect(registry.has('models')).toBe(false);
    expect(() => registry.get('models')).toThrow(/No PanelSource registered for panel 'models'/);
  });

  it('register OVERRIDES an existing source (the dashboard-zone extension point)', () => {
    const registry = new PanelSourceRegistry();
    const first: PanelSource<'skills'> = { fetch: async () => ({ data: { skills: [], categories: [] } }) };
    const second: PanelSource<'skills'> = { fetch: async () => ({ data: { skills: [], categories: ['x'] } }) };
    registry.register('skills', first);
    registry.register('skills', second);
    expect(registry.get('skills')).toBe(second);
  });
});

describe('createDefaultPanelSources — registers all 8 panels', () => {
  it('has a source for every DataPanel, addable/overridable without touching AcpBackend', () => {
    const registry = createDefaultPanelSources(makeContext());
    for (const panel of ['tools', 'mcp', 'skills', 'checkpoints', 'subagents', 'sessions', 'models', 'settings'] as const) {
      expect(registry.has(panel)).toBe(true);
    }
  });
});

describe('single-RPC tui_gateway sources — dispatch + reshaped {data} (A#6: no raw `result`)', () => {
  it('ToolsPanelSource dispatches tools.list and returns reshaped data', async () => {
    const raw = {
      toolsets: [{ name: 'hermes-acp', tool_count: 1, enabled: true, tools: [{ name: 'read_file' }] }],
    };
    const dispatch = vi.fn(async () => raw);
    const outcome = await new ToolsPanelSource(makeContext({ dispatch })).fetch({ panel: 'tools' });

    expect(dispatch).toHaveBeenCalledWith('tools.list', { panel: 'tools' });
    expect(outcome.data).toEqual({
      toolsets: [{ name: 'hermes-acp', enabled: true, toolCount: 1 }],
      tools: [
        { name: 'read_file', description: '', enabled: true, kind: 'read', toolset: 'hermes-acp', source: 'core' },
      ],
    });
  });

  it("SkillsPanelSource merges action:'list' into the skills.manage dispatch params", async () => {
    const dispatch = vi.fn(async () => ({ skills: { coding: ['python-debug'] } }));
    const outcome = await new SkillsPanelSource(makeContext({ dispatch })).fetch({ panel: 'skills' });

    expect(dispatch).toHaveBeenCalledWith('skills.manage', { panel: 'skills', action: 'list' });
    expect(outcome.data).toEqual({
      skills: [{ id: 'python-debug', name: 'python-debug', category: 'coding', description: '', enabled: true }],
      categories: ['coding'],
    });
  });

  it('ModelsPanelSource dispatches model.options and reshapes to ModelsData (Minors fix)', async () => {
    const raw = { providers: [{ slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-4-8'] }], model: 'claude-opus-4-8' };
    const dispatch = vi.fn(async () => raw);
    const outcome = await new ModelsPanelSource(makeContext({ dispatch })).fetch({ panel: 'models' });

    expect(dispatch).toHaveBeenCalledWith('model.options', { panel: 'models' });
    expect(outcome.data).toEqual({
      providers: [{ id: 'anthropic', name: 'Anthropic', connected: true, models: [{ id: 'claude-opus-4-8', label: 'claude-opus-4-8' }] }],
      currentModelId: 'claude-opus-4-8',
    });
  });

  it('SettingsPanelSource dispatches config.show and reshapes to SettingsData (Minors fix)', async () => {
    const raw = { sections: [{ title: 'Model', rows: [['Model', 'claude-opus-4-8']] }] };
    const dispatch = vi.fn(async () => raw);
    const outcome = await new SettingsPanelSource(makeContext({ dispatch })).fetch({ panel: 'settings' });

    expect(dispatch).toHaveBeenCalledWith('config.show', { panel: 'settings' });
    expect(outcome.data).toEqual({
      sections: [{ name: 'Model', fields: [{ key: 'Model', value: 'claude-opus-4-8', type: 'string' }] }],
    });
  });
});

describe('McpPanelSource — 2-RPC join (config.get + tools.list), no raw result', () => {
  it('joins config.get({key:full}) with tools.list into McpData and resolves with the reshaped data', async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === 'config.get') return { mcp_servers: { filesystem: { command: 'npx', args: ['-y', 'server-fs'] } } };
      if (method === 'tools.list') return { toolsets: [{ name: 'filesystem', tool_count: 4, enabled: true, tools: [] }] };
      return undefined;
    });
    const outcome = await new McpPanelSource(makeContext({ dispatch })).fetch();

    expect(dispatch).toHaveBeenNthCalledWith(1, 'config.get', { key: 'full' });
    expect(dispatch).toHaveBeenNthCalledWith(2, 'tools.list', {});
    expect(outcome.data).toEqual({
      servers: [{ id: 'filesystem', name: 'filesystem', status: 'connected', command: 'npx -y server-fs', toolCount: 4, enabled: true, transport: 'stdio' }],
    });
  });
});

describe('SessionsPanelSource — ACP channel (NOT tui_gateway), two-channel invariant', () => {
  it('AU-10: resolves a reasoned `unavailable` outcome (not a silent data:undefined hold) when no ACP client exists yet', async () => {
    const outcome = await new SessionsPanelSource(makeContext({ getAcpClient: () => undefined })).fetch();
    expect(outcome).toEqual({ unavailable: 'Agent is not connected yet.' });
    expect(outcome.data).toBeUndefined();
  });

  it('calls client.listSessions(cwd, cursor) and reshapes to SessionsData — never touching dispatch', async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [{ session_id: 's1', cwd: '/ws', title: 'Fix', updated_at: '2026-07-10T12:00:00Z' }],
      next_cursor: 'c2',
    }));
    const dispatch = vi.fn(async () => undefined);
    const ctx = makeContext({
      dispatch,
      getAcpClient: () => ({ listSessions }) as never,
      getCwd: () => '/ws', // last-resort fallback — no explicit cwd/sessionId on this fetch
    });

    const outcome = await new SessionsPanelSource(ctx).fetch({ cursor: 'c1' });

    expect(listSessions).toHaveBeenCalledWith('/ws', 'c1');
    expect(dispatch).not.toHaveBeenCalled(); // proves the ACP channel, not tui_gateway
    expect(outcome.data).toEqual({
      sessions: [{ id: 's1', cwd: '/ws', title: 'Fix', updatedAt: '2026-07-10T12:00:00Z' }],
      nextCursor: 'c2',
    });
  });

  describe('W4-T3b (§7 B6): explicit scope-key resolution', () => {
    it('an explicit cwd on the fetch wins over the connection-level default', async () => {
      const listSessions = vi.fn(async () => ({ sessions: [], next_cursor: undefined }));
      const ctx = makeContext({ getAcpClient: () => ({ listSessions }) as never, getCwd: () => '/default-ws' });

      await new SessionsPanelSource(ctx).fetch({ cwd: '/explicit-ws' });

      expect(listSessions).toHaveBeenCalledWith('/explicit-ws', undefined);
    });

    it('resolves cwd via an explicit sessionId when no cwd is given', async () => {
      const listSessions = vi.fn(async () => ({ sessions: [], next_cursor: undefined }));
      const ctx = makeContext({
        getAcpClient: () => ({ listSessions }) as never,
        getSessionCwd: (sessionId) => (sessionId === 'session-b' ? '/ws-b' : undefined),
        getCwd: () => '/default-ws',
      });

      await new SessionsPanelSource(ctx).fetch({ sessionId: 'session-b' });

      expect(listSessions).toHaveBeenCalledWith('/ws-b', undefined);
    });
  });

  describe('W4-T3b (§7 B7): per-cwd accumulation/coalescing — a same-toolId-shaped bug this class fixes', () => {
    function makeCwdClient(): { listSessions: ReturnType<typeof vi.fn> } {
      const pages: Record<string, { sessions: Array<{ session_id: string; cwd: string; title: string; updated_at: string }> }> = {
        '/ws-a': { sessions: [{ session_id: 'a-1', cwd: '/ws-a', title: 'A session', updated_at: '2026-07-10T00:00:00Z' }] },
        '/ws-b': { sessions: [{ session_id: 'b-1', cwd: '/ws-b', title: 'B session', updated_at: '2026-07-10T00:00:00Z' }] },
      };
      const listSessions = vi.fn(async (cwd: string) => pages[cwd] ?? { sessions: [] });
      return { listSessions };
    }

    it('tab A\'s fetch for cwd-a and tab B\'s fetch for cwd-b never cross-contaminate the accumulated list', async () => {
      const { listSessions } = makeCwdClient();
      const ctx = makeContext({ getAcpClient: () => ({ listSessions }) as never });
      const source = new SessionsPanelSource(ctx);

      const [outcomeA, outcomeB] = await Promise.all([
        source.fetch({ cwd: '/ws-a' }),
        source.fetch({ cwd: '/ws-b' }),
      ]);

      expect(outcomeA.data).toEqual({ sessions: [{ id: 'a-1', cwd: '/ws-a', title: 'A session', updatedAt: '2026-07-10T00:00:00Z' }] });
      expect(outcomeB.data).toEqual({ sessions: [{ id: 'b-1', cwd: '/ws-b', title: 'B session', updatedAt: '2026-07-10T00:00:00Z' }] });
    });

    it('a "Load more" (cursored fetch) for cwd-b does not append onto cwd-a\'s accumulated bucket', async () => {
      const listSessions = vi
        .fn()
        .mockResolvedValueOnce({ sessions: [{ session_id: 'a-1', cwd: '/ws-a', title: 'A', updated_at: 't' }], next_cursor: undefined })
        .mockResolvedValueOnce({ sessions: [{ session_id: 'b-1', cwd: '/ws-b', title: 'B', updated_at: 't' }], next_cursor: 'b-2' })
        .mockResolvedValueOnce({ sessions: [{ session_id: 'b-2', cwd: '/ws-b', title: 'B2', updated_at: 't' }], next_cursor: undefined });
      const ctx = makeContext({ getAcpClient: () => ({ listSessions }) as never });
      const source = new SessionsPanelSource(ctx);

      await source.fetch({ cwd: '/ws-a' }); // page 1 of A
      await source.fetch({ cwd: '/ws-b' }); // page 1 of B
      const loadMoreB = await source.fetch({ cwd: '/ws-b', cursor: 'b-2' }); // page 2 of B

      // B's accumulated list carries ONLY B's two sessions — A's page-1
      // session never leaked into B's bucket.
      expect(loadMoreB.data).toEqual({
        sessions: [
          { id: 'b-1', cwd: '/ws-b', title: 'B', updatedAt: 't' },
          { id: 'b-2', cwd: '/ws-b', title: 'B2', updatedAt: 't' },
        ],
      });
    });

    it('reset() clears every cwd\'s bucket', async () => {
      const { listSessions } = makeCwdClient();
      const ctx = makeContext({ getAcpClient: () => ({ listSessions }) as never });
      const source = new SessionsPanelSource(ctx);

      await source.fetch({ cwd: '/ws-a' });
      source.reset();
      // A cursor-less re-fetch after reset re-derives page 1 fresh (not
      // observable via a public "is it empty" check, so just prove it
      // doesn't throw and still returns a coherent page).
      const outcome = await source.fetch({ cwd: '/ws-a' });
      expect(outcome.data).toEqual({ sessions: [{ id: 'a-1', cwd: '/ws-a', title: 'A session', updatedAt: '2026-07-10T00:00:00Z' }] });
    });
  });
});

describe('SubagentsPanelSource — live fold snapshot (NOT tui_gateway)', () => {
  it('resolves the EXPLICIT sessionId\'s snapshot without dispatching any RPC', async () => {
    const dispatch = vi.fn(async () => undefined);
    const snapshot: SubagentsData = { delegations: [{ id: 'tc-1', goal: 'delegate: x', status: 'running' }] };
    const getSessionSubagentsSnapshot = vi.fn((sessionId: string) =>
      sessionId === 'session-1' ? snapshot : undefined,
    );
    const outcome = await new SubagentsPanelSource(makeContext({ getSessionSubagentsSnapshot, dispatch })).fetch({
      sessionId: 'session-1',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(getSessionSubagentsSnapshot).toHaveBeenCalledWith('session-1');
    expect(outcome.data).toEqual(snapshot);
  });

  it('degrades to an empty fold when no sessionId is given (never ambiently guesses "the active session")', async () => {
    const snapshot: SubagentsData = { delegations: [{ id: 'tc-1', goal: 'x', status: 'running' }] };
    const getSessionSubagentsSnapshot = vi.fn(() => snapshot);
    const outcome = await new SubagentsPanelSource(makeContext({ getSessionSubagentsSnapshot })).fetch();
    expect(getSessionSubagentsSnapshot).not.toHaveBeenCalled();
    expect(outcome.data).toEqual({ delegations: [] });
  });

  it('degrades to an empty fold when sessionId names no live controller', async () => {
    const outcome = await new SubagentsPanelSource(
      makeContext({ getSessionSubagentsSnapshot: () => undefined }),
    ).fetch({ sessionId: 'ghost' });
    expect(outcome.data).toEqual({ delegations: [] });
  });

  it('W4-T3b (§7 B6): session A\'s fetch never resolves session B\'s snapshot, even when B is "more active"', async () => {
    const getSessionSubagentsSnapshot = (sessionId: string) =>
      sessionId === 'session-a'
        ? { delegations: [{ id: 'a-task', goal: 'A work', status: 'running' as const }] }
        : { delegations: [{ id: 'b-task', goal: 'B work', status: 'running' as const }] };
    const source = new SubagentsPanelSource(makeContext({ getSessionSubagentsSnapshot }));

    const outcomeA = await source.fetch({ sessionId: 'session-a' });
    expect(outcomeA.data).toEqual({ delegations: [{ id: 'a-task', goal: 'A work', status: 'running' }] });
  });
});

describe('CheckpointsPanelSource — Zone Z9 #2 transient vs permanent split', () => {
  const okList: CheckpointsData = {
    checkpoints: [{ id: 'ckpt-1', label: 'Turn 1', age: 'just now', timestamp: '2026-07-11T00:00:00Z', turnOrdinal: 1 }],
  };

  it('returns the tracker.list() CheckpointsData unchanged on success, resolved via the EXPLICIT rootId', async () => {
    const tracker = { list: async () => okList } as never;
    const getRootTracker = vi.fn((rootId: string) => (rootId === '/root-a' ? tracker : undefined));
    const outcome = await new CheckpointsPanelSource(makeContext({ getRootTracker })).fetch({ rootId: '/root-a' });
    expect(getRootTracker).toHaveBeenCalledWith('/root-a');
    expect(outcome.data).toEqual(okList);
  });

  it('marks the panel available:false (disabled state) when no rootId is given', async () => {
    const outcome = await new CheckpointsPanelSource(makeContext({ getRootTracker: () => undefined })).fetch();
    expect(outcome.data).toEqual({ checkpoints: [], available: false, unavailableReason: 'No workspace open.' });
  });

  it('marks the panel available:false with an "unknown root" reason when rootId names no registered coordinator', async () => {
    const outcome = await new CheckpointsPanelSource(makeContext({ getRootTracker: () => undefined })).fetch({
      rootId: 'never-registered',
    });
    expect(outcome.data).toEqual({ checkpoints: [], available: false, unavailableReason: 'Unknown workspace root.' });
  });

  it('W4-T3b (§7 B6): root A\'s fetch never resolves root B\'s tracker', async () => {
    const trackerA = { list: async () => okList } as never;
    const trackerB = { list: async () => ({ checkpoints: [] }) } as never;
    const getRootTracker = (rootId: string) => (rootId === '/root-a' ? trackerA : rootId === '/root-b' ? trackerB : undefined);

    const outcomeA = await new CheckpointsPanelSource(makeContext({ getRootTracker })).fetch({ rootId: '/root-a' });
    expect(outcomeA.data).toEqual(okList);
  });

  it('maps a GENUINE-PERMANENT failure (e.g. GitUnavailableError) to available:false, NOT a rejection', async () => {
    const tracker = {
      list: async () => {
        throw new Error('git executable not found on PATH; checkpoints are disabled');
      },
    } as never;
    const outcome = await new CheckpointsPanelSource(makeContext({ getRootTracker: () => tracker })).fetch({
      rootId: '/root-a',
    });
    expect(outcome.data).toEqual({
      checkpoints: [],
      available: false,
      unavailableReason: 'git executable not found on PATH; checkpoints are disabled',
    });
  });

  it('RE-THROWS a CheckpointLockTimeoutError (transient) so it surfaces as a retryable error, not a permanent disabled panel', async () => {
    const tracker = {
      list: async () => {
        throw new CheckpointLockTimeoutError('another window holds the checkpoint lock');
      },
    } as never;
    await expect(
      new CheckpointsPanelSource(makeContext({ getRootTracker: () => tracker })).fetch({ rootId: '/root-a' }),
    ).rejects.toBeInstanceOf(CheckpointLockTimeoutError);
  });
});
