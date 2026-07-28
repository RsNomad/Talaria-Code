import { describe, it, expect } from 'vitest';
import {
  DashboardSkillsPanelSource,
  DashboardToolsPanelSource,
  reshapeDashboardSkills,
  reshapeDashboardToolsets,
} from './dashboardPanelSources';
import type {
  DashboardClientLike,
  DashboardSkill,
  DashboardToolset,
} from './HermesDashboardClient';
import { must } from '../../testing/must';

/**
 * The dashboard-backed Skills & Tools panel sources (W1.5): real
 * enabled/description/provenance/usage reshaping, and — crucially — that a fetch
 * made while the dashboard is unreachable REJECTS (so Z2's RemoteData shows a
 * retryable error, never a fake/empty success).
 */

function client(overrides: Partial<DashboardClientLike>): DashboardClientLike {
  return {
    probe: async () => true,
    listSkills: async () => [],
    listToolsets: async () => [],
    toggleSkill: async (name, enabled) => ({ ok: true, name, enabled }),
    toggleToolset: async (name, enabled) => ({ ok: true, name, enabled }),
    ...overrides,
  };
}

describe('reshapeDashboardSkills', () => {
  it('maps GET /api/skills rows to SkillInfo with real enabled/description/provenance/usage', () => {
    const raw: DashboardSkill[] = [
      { name: 'tdd', description: 'red-green', category: 'coding', enabled: true, usage: 12, provenance: 'bundled' },
      { name: 'deep-research', description: '', category: 'research', enabled: false, usage: 0, provenance: 'hub' },
    ];
    expect(reshapeDashboardSkills(raw)).toEqual({
      categories: ['coding', 'research'],
      skills: [
        { id: 'tdd', name: 'tdd', category: 'coding', description: 'red-green', enabled: true, provenance: 'bundled', usage: 12 },
        { id: 'deep-research', name: 'deep-research', category: 'research', description: '', enabled: false, provenance: 'hub', usage: 0 },
      ],
    });
  });

  it('normalizes an unknown provenance to "agent" and defaults a missing description', () => {
    const raw = [{ name: 's', description: undefined as unknown as string, category: 'x', enabled: true, usage: 1, provenance: 'weird' }];
    const out = reshapeDashboardSkills(raw);
    const skill0 = must(out.skills[0]);
    expect(skill0.provenance).toBe('agent');
    expect(skill0.description).toBe('');
  });
});

describe('reshapeDashboardToolsets', () => {
  it('maps toolsets to toolset rows (real enabled + tool count) and flattens member tools', () => {
    const raw: DashboardToolset[] = [
      { name: 'web', label: 'Web', description: '', enabled: true, available: true, configured: false, tools: ['web_search', 'browser_open'] },
      { name: 'vision', label: 'Vision', description: '', enabled: false, available: false, configured: false, tools: ['vision_analyze'] },
    ];
    const out = reshapeDashboardToolsets(raw);
    expect(out.toolsets).toEqual([
      { name: 'web', enabled: true, toolCount: 2 },
      { name: 'vision', enabled: false, toolCount: 1 },
    ]);
    // `classifyKind` maps a `web*`/`browser*` prefix to 'fetch' (name-heuristic
    // shared with the tui_gateway path) — checked here before the 'search' rule.
    expect(out.tools).toEqual([
      { name: 'web_search', description: '', enabled: true, kind: 'fetch', toolset: 'web', source: 'core' },
      { name: 'browser_open', description: '', enabled: true, kind: 'fetch', toolset: 'web', source: 'core' },
      { name: 'vision_analyze', description: '', enabled: false, kind: 'other', toolset: 'vision', source: 'core' },
    ]);
  });
});

describe('DashboardSkillsPanelSource / DashboardToolsPanelSource', () => {
  it('resolves the ready client via `ensure` and returns reshaped data', async () => {
    const skillsSrc = new DashboardSkillsPanelSource(async () =>
      client({ listSkills: async () => [{ name: 's', description: 'd', category: 'c', enabled: true, usage: 2, provenance: 'agent' }] }),
    );
    const outcome = await skillsSrc.fetch();
    expect(outcome.data).toEqual({
      categories: ['c'],
      skills: [{ id: 's', name: 's', category: 'c', description: 'd', enabled: true, provenance: 'agent', usage: 2 }],
    });

    const toolsSrc = new DashboardToolsPanelSource(async () =>
      client({ listToolsets: async () => [{ name: 't', label: 'T', description: '', enabled: true, available: true, configured: false, tools: [] }] }),
    );
    expect((await toolsSrc.fetch()).data).toEqual({ toolsets: [{ name: 't', enabled: true, toolCount: 0 }], tools: [] });
  });

  it('REJECTS (retryable error → panel Error+Retry) when the dashboard is unreachable', async () => {
    const src = new DashboardSkillsPanelSource(async () => {
      throw new Error('Hermes dashboard did not become reachable');
    });
    await expect(src.fetch()).rejects.toThrow(/did not become reachable/);
  });

  it('propagates a list-call rejection (dashboard up but the request failed)', async () => {
    const src = new DashboardToolsPanelSource(async () =>
      client({
        listToolsets: async () => {
          throw new Error('500 Internal Server Error');
        },
      }),
    );
    await expect(src.fetch()).rejects.toThrow(/500/);
  });
});
