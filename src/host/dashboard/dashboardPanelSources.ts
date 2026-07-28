import type { SkillInfo, SkillsData, ToolInfo, ToolsData, ToolsetInfo } from '../../shared/protocol';
import { classifyKind, classifySource } from '../panels/reshapePanelData';
import type { PanelFetchOutcome, PanelSource } from '../panels/PanelSourceRegistry';
import type {
  DashboardClientLike,
  DashboardSkill,
  DashboardToolset,
} from './HermesDashboardClient';

/**
 * The dashboard-backed Skills & Tools {@link PanelSource}s (W1.5). Registered
 * over the default tui_gateway sources via `AcpBackend.registerPanelSource`
 * (Z3's Open-Closed extension point), so the panels get REAL `enabled` +
 * `description` + `provenance` + `usage` from Hermes's dashboard REST surface
 * (`GET /api/skills`, `GET /api/tools/toolsets`) instead of the name-only
 * tui_gateway `skills.manage list` / the per-tool `tools.list` shape.
 *
 * Each source resolves the ready {@link DashboardClientLike} through the injected
 * `ensure` (the manager's adopt-or-spawn), so a fetch made while the dashboard is
 * unreachable REJECTS — `AcpBackend.fetchPanelData` propagates that out and Z2's
 * RemoteData shows a RETRYABLE error, never a fake/empty success. Framework-free
 * (no `vscode`) and pure past the injected `ensure`, so both the reshapers and
 * the reject-on-unreachable path are unit-testable with a fake client.
 */

/**
 * A source that remembers the KEY SET from its most recent successful list
 * fetch, so `AcpBackend.toggleDashboard` can reject a `skills.toggle`/
 * `toolsets.toggle` naming something the panel never listed (S-M4
 * defense-in-depth — a compromised webview must not push an arbitrary name into
 * Hermes's `skills.disabled` denylist).
 */
export interface ToggleNameCache {
  /** Names seen in the last successful list fetch, or `undefined` if never fetched. */
  lastListedNames(): ReadonlySet<string> | undefined;
}

/** Structural check: does this panel source cache its last-listed toggle keys? */
export function hasToggleNameCache(source: unknown): source is ToggleNameCache {
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as ToggleNameCache).lastListedNames === 'function'
  );
}

/** `GET /api/skills` → `SkillsData` (`SkillsPanel.tsx`). */
export class DashboardSkillsPanelSource implements PanelSource<'skills'>, ToggleNameCache {
  /** Skill names from the last successful `GET /api/skills` (the toggle key set). */
  private knownNames: Set<string> | undefined;

  constructor(private readonly ensure: () => Promise<DashboardClientLike>) {}

  async fetch(): Promise<PanelFetchOutcome<'skills'>> {
    const client = await this.ensure();
    const raw = await client.listSkills();
    this.knownNames = new Set(raw.map((s) => s.name));
    return { data: reshapeDashboardSkills(raw) };
  }

  lastListedNames(): ReadonlySet<string> | undefined {
    return this.knownNames;
  }
}

/** `GET /api/tools/toolsets` → `ToolsData` (`ToolsPanel.tsx`). */
export class DashboardToolsPanelSource implements PanelSource<'tools'>, ToggleNameCache {
  /** Toolset names from the last successful `GET /api/tools/toolsets` (the toggle key set). */
  private knownNames: Set<string> | undefined;

  constructor(private readonly ensure: () => Promise<DashboardClientLike>) {}

  async fetch(): Promise<PanelFetchOutcome<'tools'>> {
    const client = await this.ensure();
    const raw = await client.listToolsets();
    this.knownNames = new Set(raw.map((ts) => ts.name));
    return { data: reshapeDashboardToolsets(raw) };
  }

  lastListedNames(): ReadonlySet<string> | undefined {
    return this.knownNames;
  }
}

/**
 * `GET /api/skills` rows → `SkillsData`. Real per-skill `enabled`/`description`/
 * `category` + the dashboard-only `provenance`/`usage`. `id` is the skill name
 * (the toggle key — `PUT /api/skills/toggle` is keyed by `name`). `categories`
 * is the distinct set of categories in first-seen order.
 */
export function reshapeDashboardSkills(raw: DashboardSkill[]): SkillsData {
  const categories: string[] = [];
  const skills: SkillInfo[] = raw.map((s) => {
    if (!categories.includes(s.category)) categories.push(s.category);
    const skill: SkillInfo = {
      id: s.name,
      name: s.name,
      category: s.category,
      description: s.description ?? '',
      enabled: s.enabled,
      provenance: normalizeProvenance(s.provenance),
    };
    if (typeof s.usage === 'number') skill.usage = s.usage;
    return skill;
  });
  return { skills, categories };
}

/**
 * `GET /api/tools/toolsets` rows → `ToolsData`. The dashboard toggles at the
 * TOOLSET level (`PUT /api/tools/toolsets/{name}`), so each toolset becomes one
 * {@link ToolsetInfo} carrying the real `enabled` + its tool count, and its
 * member tool NAMES become read-only {@link ToolInfo} rows (this endpoint gives
 * tool names only — no per-tool description/enable — so `description` is empty
 * and each tool inherits its toolset's `enabled`). `kind`/`source` are the same
 * name-heuristic classification the tui_gateway path uses.
 */
export function reshapeDashboardToolsets(raw: DashboardToolset[]): ToolsData {
  const toolsets: ToolsetInfo[] = raw.map((ts) => ({
    name: ts.name,
    enabled: ts.enabled,
    toolCount: ts.tools.length,
  }));
  const tools: ToolInfo[] = raw.flatMap((ts) =>
    ts.tools.map((name) => ({
      name,
      description: '',
      enabled: ts.enabled,
      kind: classifyKind(name),
      toolset: ts.name,
      source: classifySource(name),
    })),
  );
  return { toolsets, tools };
}

function normalizeProvenance(provenance: string | undefined): SkillInfo['provenance'] {
  return provenance === 'hub' || provenance === 'bundled' || provenance === 'agent'
    ? provenance
    : 'agent';
}
