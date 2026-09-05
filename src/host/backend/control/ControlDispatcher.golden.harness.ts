import type { ControlDispatcherHostPort } from './ControlDispatcher';
import { PanelSourceRegistry } from '../../panels/PanelSourceRegistry';
import type { PanelSource } from '../../panels/PanelSourceRegistry';
import { SessionRegistry } from '../session/SessionRegistry';
import { RootRegistry } from '../../checkpoints/rootRegistry';
import type { ToggleNameCache, HubNameCache } from '../../dashboard/dashboardPanelSources';
import type { DashboardAdminClient, DashboardClientLike, DashboardSkill } from '../../dashboard/HermesDashboardClient';
import type { DashboardService } from '../../dashboard/HermesDashboardManager';
import type { DataPanel, PanelDataMap, HostToWebview, McpCatalogEntry, HubScan, HubPreview } from '../../../shared/protocol';

/**
 * WS-GD.2a Task A1: the shared golden-master harness for `ControlDispatcher`.
 * NOT a `*.test.ts` — registers no `describe`, so vitest never runs it as a
 * suite; nothing in `src/` imports it, so esbuild never bundles it into the
 * shipped extension. Tasks A2–A9 consume these exact exported names/shapes
 * — do not rename or reshape them without updating every consumer.
 *
 * `makePort`'s base is a verbatim lift of `ControlDispatcher.test.ts`'s own
 * `makePort` (same defaults: `confirm` resolves `false`, `isTrusted` true,
 * `getDashboard` undefined, `withProgress` runs the task with a
 * never-cancelled token) — copied here rather than imported, because the
 * test file registers `describe`s and must stay a suite, not a shared module.
 */

/**
 * A `vi.fn()`-free fake {@link ControlDispatcherHostPort}. `sessions`/
 * `rootRegistry` are REAL, empty instances (trivial no-arg constructors);
 * every other member is a minimal throwing/no-op stub, typed directly
 * against the real interface (no `any`, no unnecessary casts). `overrides`
 * lets a test replace exactly the members its scenario cares about.
 */
export function makePort(overrides: Partial<ControlDispatcherHostPort> = {}): {
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
 * fixture must be a complete, real `PanelDataMap[P]` shape — see the
 * per-panel fixture builders below for the panels admin/routing tests
 * actually assert payload content on.
 */
export function registerFakeSource<P extends DataPanel>(
  registry: PanelSourceRegistry,
  panel: P,
  fetch: (params?: unknown) => Promise<{ data: PanelDataMap[P] }>,
): void {
  registry.register(panel, { fetch });
}

/**
 * Register the `'mcp'` panel source with a fixed last-listed name set — the
 * fail-closed guard `requireListedMcpName`/`toggleDashboardInner` read via
 * `hasToggleNameCache`. `fetch` resolves a complete (if empty) `McpData`.
 */
export function registerMcpSourceWithNames(registry: PanelSourceRegistry, names: readonly string[]): void {
  const known = new Set(names);
  const source: PanelSource<'mcp'> & ToggleNameCache = {
    fetch: async () => ({ data: { servers: [] } }),
    lastListedNames: () => known,
  };
  registry.register('mcp', source);
}

/**
 * Register the `'skills'` panel source with both the full last-listed name
 * set AND the hub-provenance subset — `hasToggleNameCache`/`hasHubNameCache`
 * read these independently (see `DashboardSkillsPanelSource`'s own doc for
 * why the two caches are always set together). `fetch` resolves a complete
 * (if empty) `SkillsData`.
 */
export function registerSkillsSourceWithHubNames(
  registry: PanelSourceRegistry,
  allNames: readonly string[],
  hubNames: readonly string[],
): void {
  const known = new Set(allNames);
  const knownHub = new Set(hubNames);
  const source: PanelSource<'skills'> & ToggleNameCache & HubNameCache = {
    fetch: async () => ({ data: { skills: [], categories: [] } }),
    lastListedNames: () => known,
    lastListedHubNames: () => knownHub,
  };
  registry.register('skills', source);
}

/**
 * Grounded from `skillSourceGate.ts`'s `TRUSTED_SKILL_PREFIXES` allowlist —
 * `skillSourceGate.test.ts` asserts `assertSkillIdentifier('anthropics/skills/pdf').ok
 * === true` (tier `'trusted'`, under the `anthropics/skills` prefix row).
 */
export const VALID_HUB_IDENTIFIER = 'anthropics/skills/pdf';

/** Complete (all 17 fields), real `McpCatalogEntry` fixture — override only what a test cares about. */
export function makeCatalogEntry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    name: 'ctx',
    description: 'Test entry',
    source: 'nous',
    transport: 'stdio',
    auth_type: 'none',
    required_env: [],
    command: 'ctx-server',
    args: [],
    url: null,
    install_url: null,
    install_ref: null,
    bootstrap: [],
    default_enabled: null,
    post_install: '',
    needs_install: false,
    installed: false,
    enabled: false,
    ...overrides,
  };
}

/** Complete (all 7 fields), real `HubPreview` fixture — override only what a test cares about. */
export function makeHubPreview(overrides: Partial<HubPreview> = {}): HubPreview {
  return {
    name: 'my-skill',
    description: 'Test hub skill',
    source: 'hub',
    identifier: VALID_HUB_IDENTIFIER,
    trust_level: 'official',
    skill_md: '---\nname: my-skill\n---\n',
    files: ['SKILL.md'],
    ...overrides,
  };
}

/** Complete (all 10 fields), real `HubScan` fixture — override only what a test cares about. */
export function makeHubScan(overrides: Partial<HubScan> = {}): HubScan {
  return {
    name: 'my-skill',
    identifier: VALID_HUB_IDENTIFIER,
    source: 'hub',
    trust_level: 'official',
    verdict: 'safe',
    summary: '',
    policy: 'allow',
    policy_reason: '',
    findings: [],
    severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
    ...overrides,
  };
}

/**
 * Complete (all 6 fields), real `DashboardSkill` fixture — override only what
 * a test cares about. Added by Task A2 for the {@link pollSkillUninstall}/
 * {@link pollSkillInstall} ground-truth-verify poll pins (presence/absence
 * checks against `listSkills()`'s rows) — exported so a later skills-admin
 * task (A6+) can reuse it instead of hand-building a `DashboardSkill` row.
 */
export function makeDashboardSkill(overrides: Partial<DashboardSkill> = {}): DashboardSkill {
  return {
    name: 'my-skill',
    description: 'Test skill',
    category: 'general',
    enabled: true,
    usage: 0,
    provenance: 'hub',
    ...overrides,
  };
}

/**
 * Complete `DashboardAdminClient & DashboardClientLike` fake — every member
 * hasDashboardAdmin() checks MUST be a function, or the guard fails closed.
 * `vi.fn()`-free: plain closures + call-recording arrays (the
 * `ControlDispatcher.test.ts` harness idiom).
 */
export interface RecordedCalls {
  addMcpServer: unknown[];
  removeMcpServer: string[];
  testMcpServer: string[];
  setMcpServerEnabled: Array<{ name: string; enabled: boolean }>;
  authMcpServer: string[];
  listMcpCatalog: number[];
  installCatalogEntry: unknown[];
  actionStatus: string[];
  createSkill: unknown[];
  previewHubSkill: string[];
  scanHubSkill: string[];
  installHubSkill: string[];
  uninstallHubSkill: string[];
  listSkills: number[];
  toggleSkill: Array<{ name: string; enabled: boolean }>;
  toggleToolset: Array<{ name: string; enabled: boolean }>;
  setEnvVar: Array<{ key: string; value: string }>;
  listEnvKeys: number[];
  removeEnvVar: string[];
}

export type FakeAdminClient = DashboardAdminClient & DashboardClientLike & { calls: RecordedCalls };

export function makeFakeAdminClient(overrides: Partial<FakeAdminClient> = {}): FakeAdminClient {
  const calls: RecordedCalls = {
    addMcpServer: [],
    removeMcpServer: [],
    testMcpServer: [],
    setMcpServerEnabled: [],
    authMcpServer: [],
    listMcpCatalog: [],
    installCatalogEntry: [],
    actionStatus: [],
    createSkill: [],
    previewHubSkill: [],
    scanHubSkill: [],
    installHubSkill: [],
    uninstallHubSkill: [],
    listSkills: [],
    toggleSkill: [],
    toggleToolset: [],
    setEnvVar: [],
    listEnvKeys: [],
    removeEnvVar: [],
  };
  const base: FakeAdminClient = {
    calls,
    probe: async () => true,
    listSkills: async () => {
      calls.listSkills.push(1);
      return [];
    },
    toggleSkill: async (name, enabled) => {
      calls.toggleSkill.push({ name, enabled });
      return { ok: true, name, enabled };
    },
    listToolsets: async () => [],
    toggleToolset: async (name, enabled) => {
      calls.toggleToolset.push({ name, enabled });
      return { ok: true, name, enabled };
    },
    addMcpServer: async (body) => {
      calls.addMcpServer.push(body);
      return {};
    },
    removeMcpServer: async (name) => {
      calls.removeMcpServer.push(name);
      return { ok: true };
    },
    testMcpServer: async (name) => {
      calls.testMcpServer.push(name);
      return { ok: true, tools: [] };
    },
    setMcpServerEnabled: async (name, enabled) => {
      calls.setMcpServerEnabled.push({ name, enabled });
      return { ok: true, name, enabled };
    },
    authMcpServer: async (name) => {
      calls.authMcpServer.push(name);
      return { ok: true, tools: [] };
    },
    listMcpCatalog: async () => {
      calls.listMcpCatalog.push(1);
      return { entries: [] };
    },
    installCatalogEntry: async (body) => {
      calls.installCatalogEntry.push(body);
      return { ok: true, name: 'x', background: false };
    },
    actionStatus: async (name) => {
      calls.actionStatus.push(name);
      return { running: false, exit_code: 0, lines: [] };
    },
    createSkill: async (body) => {
      calls.createSkill.push(body);
      return {};
    },
    previewHubSkill: async (id) => {
      calls.previewHubSkill.push(id);
      return makeHubPreview({ identifier: id });
    },
    scanHubSkill: async (id) => {
      calls.scanHubSkill.push(id);
      return makeHubScan({ identifier: id });
    },
    installHubSkill: async (id) => {
      calls.installHubSkill.push(id);
      return { ok: true, name: 'act-1' };
    },
    uninstallHubSkill: async (name) => {
      calls.uninstallHubSkill.push(name);
      return { ok: true, name: 'act-1' };
    },
    setEnvVar: async (key, value) => {
      calls.setEnvVar.push({ key, value });
      return { ok: true, key };
    },
    // Default mirrors a NON-managed Hermes: every key this fake was asked to
    // set reads back `is_set:true`. A managed-mode scenario overrides this with
    // `async () => ({})` to reproduce the `{ok:true}`-but-nothing-written
    // false positive Layer 6 exists for.
    listEnvKeys: async () => {
      calls.listEnvKeys.push(1);
      return Object.fromEntries(calls.setEnvVar.map((c) => [c.key, { is_set: true }]));
    },
    removeEnvVar: async (key) => {
      calls.removeEnvVar.push(key);
      return { ok: true, key };
    },
  };
  return { ...base, ...overrides, calls };
}

/** `{ ensure: async () => client, dispose() {} }` — the minimal `DashboardService` fake. */
export function makeFakeDashboard(client: DashboardClientLike): DashboardService {
  return {
    ensure: async () => client,
    dispose() {},
  };
}
