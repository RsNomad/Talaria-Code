import { describe, it, expect, vi } from 'vitest';

/**
 * `ControlDispatcher.ts` pulls in `./customModes.ts`, which imports `vscode`
 * at module scope. Mirrors `ControlDispatcher.test.ts`'s own `vi.mock`.
 */
vi.mock('vscode', () => ({}));

import { ControlDispatcher } from './ControlDispatcher';
import {
  makePort,
  registerFakeSource,
  registerMcpSourceWithNames,
  registerSkillsSourceWithHubNames,
  makeFakeAdminClient,
  makeFakeDashboard,
  makeCatalogEntry,
  makeHubScan,
  makeDashboardSkill,
  VALID_HUB_IDENTIFIER,
} from './ControlDispatcher.golden.harness';
import type { DashboardToggleResult } from '../../dashboard/HermesDashboardClient';
import type { McpServer, McpTestResult, PanelDataMap } from '../../../shared/protocol';

/**
 * WS-GD.2a Task A2 — golden master 2: admin flows (MCP + skills) and the 4
 * concurrency mechanisms `ControlDispatcher` implements —
 *
 *   1. single-flight admin acquire (`busyMcpNames`/`busySkillInstallIds`/
 *      `busySkillUninstallNames`)
 *   2. the shared `dashboardToggleTail` serialization tail (×3 call sites)
 *      and its tail-exempt bypass set
 *   3. the ×3 background-action polls (`pollCatalogInstall`/
 *      `pollSkillInstall`/`pollSkillUninstall`) and their 4 outcomes each
 *   4. `panelFetchSeq` staleness (the T-12 stale-push drop)
 *
 * — pinned against the CURRENT, unchanged `ControlDispatcher`. These tests
 * MUST pass on today's code — a failure here means the PIN is wrong (fix the
 * pin by re-reading the code), never the production code. Later pure-move
 * commits (Tasks A5+) prove behavior-identical by staying green against this
 * exact suite. Complements Task A1's routing/panels/checkpoints golden
 * master — this file owns the admin+concurrency net only.
 */

// ---------------------------------------------------------------------------
// 1a. Trust-gate table — all 9 TRUST_GATED_METHODS
// ---------------------------------------------------------------------------

describe('golden: trust-gate table (all 9 TRUST_GATED_METHODS)', () => {
  const MCP_TRUST_GATED = ['mcp.add', 'mcp.remove', 'mcp.setEnabled', 'mcp.test', 'mcp.auth', 'mcp.catalogInstall'] as const;

  it.each(MCP_TRUST_GATED)('%s rejects with the MCP trust refusal and never calls the admin client', async (method) => {
    const client = makeFakeAdminClient();
    const { port } = makePort({ isTrusted: () => false, getDashboard: () => makeFakeDashboard(client) });
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl(method, { name: 'x' })).rejects.toThrow(
      `Refusing '${method}': the workspace is not trusted — trust this workspace to manage MCP servers.`,
    );
    expect(Object.values(client.calls).every((calls) => calls.length === 0)).toBe(true);
  });

  const SKILLS_TRUST_GATED = ['skills.create', 'skills.hubInstall', 'skills.hubUninstall'] as const;

  it.each(SKILLS_TRUST_GATED)('%s rejects with the skills trust refusal and never calls the admin client', async (method) => {
    const client = makeFakeAdminClient();
    const { port } = makePort({ isTrusted: () => false, getDashboard: () => makeFakeDashboard(client) });
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl(method, {})).rejects.toThrow(
      `Refusing '${method}': the workspace is not trusted — trust this workspace to manage skills.`,
    );
    expect(Object.values(client.calls).every((calls) => calls.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1b. Fail-closed name-cache pins
// ---------------------------------------------------------------------------

describe('golden: fail-closed name-cache pins (mcp.remove / skills.hubUninstall)', () => {
  it('mcp.remove with no name cache registered (plain fetch-only mcp source) refuses "not been listed yet"', async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    registerFakeSource(registry, 'mcp', async () => ({ data: { servers: [] } }));
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('mcp.remove', { name: 'x' })).rejects.toThrow(
      "Refusing 'mcp.remove': the MCP panel has not been listed yet — open it first.",
    );
  });

  it('mcp.remove with a name outside the last-listed set refuses by name', async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    registerMcpSourceWithNames(registry, ['github']);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('mcp.remove', { name: 'ghost' })).rejects.toThrow(
      "mcp.remove: 'ghost' is not in the last-listed MCP servers.",
    );
  });

  it('skills.hubUninstall with no hub cache registered (plain fetch-only skills source) refuses "not been listed yet"', async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    registerFakeSource(registry, 'skills', async () => ({ data: { skills: [], categories: [] } }));
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubUninstall', { name: 'x' })).rejects.toThrow(
      "Refusing 'skills.hubUninstall': the skills panel has not been listed yet — open it first.",
    );
  });

  it('skills.hubUninstall with a name outside the hub-provenance set refuses by name', async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client) });
    registerSkillsSourceWithHubNames(registry, ['bundled', 'hubby'], ['hubby']);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubUninstall', { name: 'bundled' })).rejects.toThrow(
      "skills.hubUninstall: 'bundled' is not a hub-installed skill in the last-listed skills.",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Single-flight pins — all 5 busy-refusal messages, verbatim, + release
// ---------------------------------------------------------------------------

describe('golden: single-flight admin acquire — all 5 pinned busy messages + release', () => {
  it('a second mcp.auth for the same name is refused with the pinned sign-in message', async () => {
    let releaseAuth!: () => void;
    const hanging = new Promise<McpTestResult>((resolve) => {
      releaseAuth = () => resolve({ ok: false, error: 'x', tools: [] });
    });
    const client = makeFakeAdminClient({ authMcpServer: () => hanging });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
    registerMcpSourceWithNames(registry, ['github']);
    const dispatcher = new ControlDispatcher(port);

    const first = dispatcher.invokeControl('mcp.auth', { name: 'github' });
    await expect(dispatcher.invokeControl('mcp.auth', { name: 'github' })).rejects.toThrow(
      'Sign-in for "github" is already in progress.',
    );
    releaseAuth();
    await first;
  });

  it('a second mcp.catalogInstall for the same name is refused with the pinned install message', async () => {
    let releaseInstall!: () => void;
    const hanging = new Promise<{ ok: boolean; name: string; background: boolean }>((resolve) => {
      releaseInstall = () => resolve({ ok: true, name: 'github', background: false });
    });
    const client = makeFakeAdminClient({
      listMcpCatalog: async () => ({ entries: [makeCatalogEntry({ name: 'github' })] }),
      installCatalogEntry: () => hanging,
    });
    const { port, registry } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => true,
      dispatch: async () => undefined,
    });
    registerMcpSourceWithNames(registry, []);
    const dispatcher = new ControlDispatcher(port);
    await dispatcher.invokeControl('mcp.catalog', {}); // arms lastCatalogEntries (fail-closed guard)

    const first = dispatcher.invokeControl('mcp.catalogInstall', { name: 'github' });
    await expect(dispatcher.invokeControl('mcp.catalogInstall', { name: 'github' })).rejects.toThrow(
      'Installing "github" is already in progress.',
    );
    releaseInstall();
    await first;
  });

  it('mcp.test checks the busy map — refused by an in-flight mcp.setEnabled with the shared "change" message', async () => {
    let releaseSetEnabled!: () => void;
    const hanging = new Promise<{ ok: boolean; name: string; enabled: boolean }>((resolve) => {
      releaseSetEnabled = () => resolve({ ok: true, name: 'github', enabled: false });
    });
    const testCalls: string[] = [];
    const client = makeFakeAdminClient({
      setMcpServerEnabled: () => hanging,
      testMcpServer: async (name) => {
        testCalls.push(name);
        return { ok: true, tools: [] };
      },
    });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), dispatch: async () => undefined });
    registerMcpSourceWithNames(registry, ['github']);
    const dispatcher = new ControlDispatcher(port);

    const setEnabled = dispatcher.invokeControl('mcp.setEnabled', { name: 'github', enabled: false });
    await expect(dispatcher.invokeControl('mcp.test', { name: 'github' })).rejects.toThrow(
      'Another change to MCP server "github" is still in progress.',
    );
    expect(testCalls).toEqual([]); // refused BEFORE testMcpServer is ever called — a check, not a queue
    releaseSetEnabled();
    await setEnabled;
  });

  it('a second skills.hubScan for an identifier busy with an in-flight hubInstall is refused (check-only posture)', async () => {
    let releaseInstall!: () => void;
    const hanging = new Promise<{ ok: boolean; name: string }>((resolve) => {
      releaseInstall = () => resolve({ ok: true, name: 'act-1' });
    });
    const client = makeFakeAdminClient({
      installHubSkill: () => hanging,
      listSkills: async () => [makeDashboardSkill({ name: 'my-skill' })], // lets the release's own poll ground-truth-verify cleanly
    });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
    registerSkillsSourceWithHubNames(registry, [], []);
    const dispatcher = new ControlDispatcher(port);

    const install = dispatcher.invokeControl('skills.hubInstall', { identifier: VALID_HUB_IDENTIFIER });
    await expect(dispatcher.invokeControl('skills.hubScan', { identifier: VALID_HUB_IDENTIFIER })).rejects.toThrow(
      `Installing skill "${VALID_HUB_IDENTIFIER}" is already in progress.`,
    );
    releaseInstall();
    await install;
  });

  it('a second skills.hubUninstall for the same name is refused with the pinned uninstall message', async () => {
    let releaseUninstall!: () => void;
    const hanging = new Promise<{ ok: boolean; name: string }>((resolve) => {
      releaseUninstall = () => resolve({ ok: true, name: 'act-1' });
    });
    const client = makeFakeAdminClient({ uninstallHubSkill: () => hanging });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
    registerSkillsSourceWithHubNames(registry, ['my-skill'], ['my-skill']);
    const dispatcher = new ControlDispatcher(port);

    const first = dispatcher.invokeControl('skills.hubUninstall', { name: 'my-skill' });
    await expect(dispatcher.invokeControl('skills.hubUninstall', { name: 'my-skill' })).rejects.toThrow(
      'Uninstalling skill "my-skill" is already in progress.',
    );
    releaseUninstall();
    await first;
  });

  it('after a declined modal, the busy name lock is released and immediately reusable', async () => {
    const client = makeFakeAdminClient();
    let confirmCallCount = 0;
    const { port } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => {
        confirmCallCount += 1;
        return false; // decline every time
      },
    });
    const dispatcher = new ControlDispatcher(port);
    const params = { name: 'github', transport: 'http' as const, url: 'https://x.example' };

    await expect(dispatcher.invokeControl('mcp.add', params)).rejects.toThrow(
      'Adding MCP server "github" was declined or cancelled.',
    );
    // Immediately reusable: the SECOND call reaches the SAME confirm-modal
    // point again, rather than being refused as "already in progress" — a
    // stuck lock would surface as the busy message here instead.
    await expect(dispatcher.invokeControl('mcp.add', params)).rejects.toThrow(
      'Adding MCP server "github" was declined or cancelled.',
    );
    expect(confirmCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Shared serialization tail (×3 call sites) + tail-exempt bypass
// ---------------------------------------------------------------------------

describe('golden: dashboardToggleTail serialization + tail-exempt bypass', () => {
  it('config-mutating methods share one serialization tail; mcp.test bypasses it', async () => {
    const events: string[] = [];
    let releaseToggle!: () => void;
    const gate = new Promise<DashboardToggleResult>((res) => {
      releaseToggle = () => res({ ok: true, name: 'a', enabled: true });
    });
    const client = makeFakeAdminClient({
      toggleSkill: (name, _enabled) => {
        events.push(`toggle:${name}`);
        return gate;
      },
      setMcpServerEnabled: async (name, enabled) => {
        events.push(`setEnabled:${name}`);
        return { ok: true, name, enabled };
      },
      testMcpServer: async (name) => {
        events.push(`test:${name}`);
        return { ok: true, tools: [] };
      },
    });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), dispatch: async () => undefined });
    registerMcpSourceWithNames(registry, ['github', 'sentry']);
    // No toggle-name cache on the 'skills' source here — the lenient skip
    // branch (`toggleDashboardInner`'s `if (hasToggleNameCache(source))`).
    registerFakeSource(registry, 'skills', async () => ({ data: {} as unknown as PanelDataMap['skills'] }));
    const dispatcher = new ControlDispatcher(port);

    const toggle = dispatcher.invokeControl('skills.toggle', { name: 'a', enabled: true });
    const setEnabled = dispatcher.invokeControl('mcp.setEnabled', { name: 'github', enabled: false });
    const test = dispatcher.invokeControl('mcp.test', { name: 'sentry' });
    await test; // tail-exempt: completes while the toggle still holds the tail
    expect(events).toContain('test:sentry');
    expect(events).not.toContain('setEnabled:github'); // queued behind the hung toggle
    releaseToggle();
    await toggle;
    await setEnabled;
    expect(events.indexOf('setEnabled:github')).toBeGreaterThan(events.indexOf('toggle:a'));
  });
});

// ---------------------------------------------------------------------------
// 4. Background-action poll pins — 3 polls × 4 outcomes each
// ---------------------------------------------------------------------------

describe('golden: pollCatalogInstall (mcp.catalogInstall background poll) — 4 outcomes', () => {
  it('success: polls to done, ground-truth verifies, reloads and refetches', async () => {
    vi.useFakeTimers();
    try {
      const entry = makeCatalogEntry({ name: 'ctx', needs_install: true });
      let polls = 0;
      const client = makeFakeAdminClient({
        listMcpCatalog: async () => ({ entries: [{ ...entry, installed: polls > 0 }] }),
        installCatalogEntry: async () => ({ ok: true, name: 'ctx', background: true, action: 'act-1' }),
        actionStatus: async () => {
          polls += 1;
          return { running: polls < 2, exit_code: polls < 2 ? null : 0, lines: ['tail'] };
        },
      });
      const dispatched: string[] = [];
      const { port, registry } = makePort({
        getDashboard: () => makeFakeDashboard(client),
        confirm: async () => true,
        dispatch: async (m) => {
          dispatched.push(m);
          return undefined;
        },
      });
      registerMcpSourceWithNames(registry, []);
      const dispatcher = new ControlDispatcher(port);
      await dispatcher.invokeControl('mcp.catalog', {});

      const install = dispatcher.invokeControl('mcp.catalogInstall', { name: 'ctx' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(install).resolves.toEqual({ ok: true, name: 'ctx' });
      expect(dispatched).toContain('reload.mcp');
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout: exceeds the 180s cap — rejects "Catalog install did not complete"', async () => {
    vi.useFakeTimers();
    try {
      const entry = makeCatalogEntry({ name: 'ctx', needs_install: true });
      const client = makeFakeAdminClient({
        listMcpCatalog: async () => ({ entries: [entry] }),
        installCatalogEntry: async () => ({ ok: true, name: 'ctx', background: true, action: 'act-1' }),
        actionStatus: async () => ({ running: true, exit_code: null, lines: ['still going'] }),
      });
      const { port, registry } = makePort({
        getDashboard: () => makeFakeDashboard(client),
        confirm: async () => true,
        dispatch: async () => undefined,
      });
      registerMcpSourceWithNames(registry, []);
      const dispatcher = new ControlDispatcher(port);
      await dispatcher.invokeControl('mcp.catalog', {});

      const install = dispatcher.invokeControl('mcp.catalogInstall', { name: 'ctx' });
      const assertion = expect(install).rejects.toThrow('Catalog install did not complete — see the Talaria output log.');
      await vi.advanceTimersByTimeAsync(181_000); // > CATALOG_POLL_CAP_MS (180s)
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ground-truth-fail: action finished but the installed flag is still false — rejects "did not complete"', async () => {
    const entry = makeCatalogEntry({ name: 'ctx', needs_install: true });
    const client = makeFakeAdminClient({
      listMcpCatalog: async () => ({ entries: [{ ...entry, installed: false }] }),
      installCatalogEntry: async () => ({ ok: true, name: 'ctx', background: true, action: 'act-1' }),
      actionStatus: async () => ({ running: false, exit_code: 1, lines: ['build failed'] }),
    });
    const { port, registry } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => true,
      dispatch: async () => undefined,
    });
    registerMcpSourceWithNames(registry, []);
    const dispatcher = new ControlDispatcher(port);
    await dispatcher.invokeControl('mcp.catalog', {});

    await expect(dispatcher.invokeControl('mcp.catalogInstall', { name: 'ctx' })).rejects.toThrow(
      'Catalog install did not complete — see the Talaria output log.',
    );
  });

  it('transport-unconfirmed: an actionStatus rejection reports "could not be confirmed", not a hard failure', async () => {
    const entry = makeCatalogEntry({ name: 'ctx', needs_install: true });
    const client = makeFakeAdminClient({
      listMcpCatalog: async () => ({ entries: [entry] }),
      installCatalogEntry: async () => ({ ok: true, name: 'ctx', background: true, action: 'act-1' }),
      actionStatus: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const { port, registry } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => true,
      dispatch: async () => undefined,
    });
    registerMcpSourceWithNames(registry, []);
    const dispatcher = new ControlDispatcher(port);
    await dispatcher.invokeControl('mcp.catalog', {});

    await expect(dispatcher.invokeControl('mcp.catalogInstall', { name: 'ctx' })).rejects.toThrow(
      'The action was dispatched, but its status could not be confirmed — refresh the panel to check whether it completed.',
    );
  });
});

describe('golden: pollSkillInstall (skills.hubInstall background poll) — 4 outcomes', () => {
  it('success: presence-verifies, refetches the skills panel', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const client = makeFakeAdminClient({
        scanHubSkill: async (id) => makeHubScan({ identifier: id, name: 'my-skill' }),
        installHubSkill: async () => ({ ok: true, name: 'act-1' }),
        actionStatus: async () => {
          polls += 1;
          return { running: polls < 2, exit_code: polls < 2 ? null : 0, lines: ['tail'] };
        },
        listSkills: async () => (polls > 1 ? [makeDashboardSkill({ name: 'my-skill' })] : []),
      });
      const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
      registerSkillsSourceWithHubNames(registry, [], []);
      const dispatcher = new ControlDispatcher(port);

      const install = dispatcher.invokeControl('skills.hubInstall', { identifier: VALID_HUB_IDENTIFIER });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(install).resolves.toEqual({ ok: true, name: 'my-skill' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout: exceeds the 120s cap — rejects "Install did not complete"', async () => {
    vi.useFakeTimers();
    try {
      const client = makeFakeAdminClient({
        scanHubSkill: async (id) => makeHubScan({ identifier: id, name: 'my-skill' }),
        installHubSkill: async () => ({ ok: true, name: 'act-1' }),
        actionStatus: async () => ({ running: true, exit_code: null, lines: ['still going'] }),
      });
      const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
      registerSkillsSourceWithHubNames(registry, [], []);
      const dispatcher = new ControlDispatcher(port);

      const install = dispatcher.invokeControl('skills.hubInstall', { identifier: VALID_HUB_IDENTIFIER });
      const assertion = expect(install).rejects.toThrow('Install did not complete — see the Talaria output log.');
      await vi.advanceTimersByTimeAsync(121_000); // > SKILLS_INSTALL_POLL_CAP_MS (120s)
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ground-truth-fail: action finished but listSkills never shows the new row — rejects "did not complete"', async () => {
    const client = makeFakeAdminClient({
      scanHubSkill: async (id) => makeHubScan({ identifier: id, name: 'my-skill' }),
      installHubSkill: async () => ({ ok: true, name: 'act-1' }),
      actionStatus: async () => ({ running: false, exit_code: 0, lines: ['done'] }),
      listSkills: async () => [],
    });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
    registerSkillsSourceWithHubNames(registry, [], []);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubInstall', { identifier: VALID_HUB_IDENTIFIER })).rejects.toThrow(
      'Install did not complete — see the Talaria output log.',
    );
  });

  it('transport-unconfirmed: an actionStatus rejection reports "could not be confirmed"', async () => {
    const client = makeFakeAdminClient({
      scanHubSkill: async (id) => makeHubScan({ identifier: id, name: 'my-skill' }),
      installHubSkill: async () => ({ ok: true, name: 'act-1' }),
      actionStatus: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
    registerSkillsSourceWithHubNames(registry, [], []);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubInstall', { identifier: VALID_HUB_IDENTIFIER })).rejects.toThrow(
      'The action was dispatched, but its status could not be confirmed — refresh the panel to check whether it completed.',
    );
  });
});

describe('golden: pollSkillUninstall (skills.hubUninstall background poll) — 4 outcomes', () => {
  it('success: absence-verifies, refetches the skills panel', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const client = makeFakeAdminClient({
        uninstallHubSkill: async () => ({ ok: true, name: 'act-1' }),
        actionStatus: async () => {
          polls += 1;
          return { running: polls < 2, exit_code: polls < 2 ? null : 0, lines: ['tail'] };
        },
        listSkills: async () => (polls > 1 ? [] : [makeDashboardSkill({ name: 'my-skill' })]),
      });
      const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
      registerSkillsSourceWithHubNames(registry, ['my-skill'], ['my-skill']);
      const dispatcher = new ControlDispatcher(port);

      const uninstall = dispatcher.invokeControl('skills.hubUninstall', { name: 'my-skill' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(uninstall).resolves.toEqual({ ok: true, name: 'my-skill' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout: exceeds the 120s cap — rejects "Uninstall did not complete"', async () => {
    vi.useFakeTimers();
    try {
      const client = makeFakeAdminClient({
        uninstallHubSkill: async () => ({ ok: true, name: 'act-1' }),
        actionStatus: async () => ({ running: true, exit_code: null, lines: ['still going'] }),
      });
      const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
      registerSkillsSourceWithHubNames(registry, ['my-skill'], ['my-skill']);
      const dispatcher = new ControlDispatcher(port);

      const uninstall = dispatcher.invokeControl('skills.hubUninstall', { name: 'my-skill' });
      const assertion = expect(uninstall).rejects.toThrow('Uninstall did not complete — see the Talaria output log.');
      await vi.advanceTimersByTimeAsync(121_000); // > SKILLS_INSTALL_POLL_CAP_MS (120s)
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ground-truth-fail: action finished but the row is still present — rejects "did not complete"', async () => {
    const client = makeFakeAdminClient({
      uninstallHubSkill: async () => ({ ok: true, name: 'act-1' }),
      actionStatus: async () => ({ running: false, exit_code: 0, lines: ['done'] }),
      listSkills: async () => [makeDashboardSkill({ name: 'my-skill' })],
    });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
    registerSkillsSourceWithHubNames(registry, ['my-skill'], ['my-skill']);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubUninstall', { name: 'my-skill' })).rejects.toThrow(
      'Uninstall did not complete — see the Talaria output log.',
    );
  });

  it('transport-unconfirmed: an actionStatus rejection reports "could not be confirmed"', async () => {
    const client = makeFakeAdminClient({
      uninstallHubSkill: async () => ({ ok: true, name: 'act-1' }),
      actionStatus: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => true });
    registerSkillsSourceWithHubNames(registry, ['my-skill'], ['my-skill']);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubUninstall', { name: 'my-skill' })).rejects.toThrow(
      'The action was dispatched, but its status could not be confirmed — refresh the panel to check whether it completed.',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Modal/consent-order + decline pins
// ---------------------------------------------------------------------------

describe('golden: modal/consent-order + decline pins', () => {
  it('mcp.catalogInstall: a declined/blank promptSecret answer declines the WHOLE install, after consent runs first', async () => {
    const order: string[] = [];
    const entry = makeCatalogEntry({
      name: 'ctx',
      required_env: [{ name: 'API_KEY', prompt: 'API key', required: true }],
    });
    const installCalls: unknown[] = [];
    const client = makeFakeAdminClient({
      listMcpCatalog: async () => ({ entries: [entry] }),
      installCatalogEntry: async (body) => {
        installCalls.push(body);
        return { ok: true, name: 'ctx', background: false };
      },
    });
    const { port, registry } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => {
        order.push('confirm');
        return true;
      },
      promptSecret: async () => {
        order.push('promptSecret');
        return undefined;
      },
    });
    registerMcpSourceWithNames(registry, []);
    const dispatcher = new ControlDispatcher(port);
    await dispatcher.invokeControl('mcp.catalog', {});

    await expect(dispatcher.invokeControl('mcp.catalogInstall', { name: 'ctx' })).rejects.toThrow(
      'Installing MCP "ctx" was declined or cancelled.',
    );
    expect(installCalls).toEqual([]);
    expect(order).toEqual(['confirm', 'promptSecret']); // consent BEFORE the secret prompt
  });

  it('mcp.remove: a declined modal declines the whole removal, removeMcpServer never called', async () => {
    const client = makeFakeAdminClient();
    const { port, registry } = makePort({ getDashboard: () => makeFakeDashboard(client), confirm: async () => false });
    registerMcpSourceWithNames(registry, ['github']);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('mcp.remove', { name: 'github' })).rejects.toThrow(
      'Removing MCP server "github" was declined or cancelled.',
    );
    expect(client.calls.removeMcpServer).toEqual([]);
  });

  it('skills.hubInstall: scan policy "ask" blocks BEFORE any modal, installHubSkill never called', async () => {
    let confirmCalled = false;
    const client = makeFakeAdminClient({
      scanHubSkill: async (id) => makeHubScan({ identifier: id, name: 'my-skill', policy: 'ask', verdict: 'safe' }),
    });
    const { port } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubInstall', { identifier: VALID_HUB_IDENTIFIER })).rejects.toThrow(
      'Refusing to install skill "my-skill": scan policy is "ask", verdict "safe" — blocked.',
    );
    expect(confirmCalled).toBe(false);
    expect(client.calls.installHubSkill).toEqual([]);
  });

  it('skills.hubInstall: verdict "dangerous" with policy "allow" is equally blocked before any modal', async () => {
    let confirmCalled = false;
    const client = makeFakeAdminClient({
      scanHubSkill: async (id) => makeHubScan({ identifier: id, name: 'my-skill', policy: 'allow', verdict: 'dangerous' }),
    });
    const { port } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('skills.hubInstall', { identifier: VALID_HUB_IDENTIFIER })).rejects.toThrow(
      'Refusing to install skill "my-skill": scan policy is "allow", verdict "dangerous" — blocked.',
    );
    expect(confirmCalled).toBe(false);
    expect(client.calls.installHubSkill).toEqual([]);
  });

  it('mcp.setEnabled: happy path is modal-free and ends with exactly one mcp panel.data push', async () => {
    let confirmCalled = false;
    const client = makeFakeAdminClient();
    const { port, registry, emitted } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
      dispatch: async () => undefined,
    });
    registerMcpSourceWithNames(registry, ['github']);
    const dispatcher = new ControlDispatcher(port);

    const result = await dispatcher.invokeControl('mcp.setEnabled', { name: 'github', enabled: false });

    expect(confirmCalled).toBe(false);
    expect(result).toEqual({ ok: true, name: 'github', enabled: false });
    const pushes = emitted.filter((m) => m.type === 'panel.data' && m.panel === 'mcp');
    expect(pushes.length).toBe(1);
  });

  it('F2-08: a reload.mcp failure after a successful mutate discloses divergence but still refetches the panel', async () => {
    const client = makeFakeAdminClient();
    const { port, registry, emitted } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      dispatch: async () => {
        throw new Error('reload failed');
      },
    });
    registerMcpSourceWithNames(registry, ['github']);
    const dispatcher = new ControlDispatcher(port);

    await expect(dispatcher.invokeControl('mcp.setEnabled', { name: 'github', enabled: true })).rejects.toThrow(
      'The MCP configuration was saved, but reloading the running Hermes server failed — reload the window or restart Hermes to apply the change.',
    );
    expect(client.calls.setMcpServerEnabled).toEqual([{ name: 'github', enabled: true }]);
    const pushes = emitted.filter((m) => m.type === 'panel.data' && m.panel === 'mcp');
    expect(pushes.length).toBe(1); // the disclose-divergence refetch still ran
  });
});

// ---------------------------------------------------------------------------
// 6. panelFetchSeq staleness (T-12) — not covered by Task A1
// ---------------------------------------------------------------------------

describe('golden: panelFetchSeq staleness — a superseded fetch drops its push but stays honest to its own caller', () => {
  it('an older fetch that resolves AFTER a newer one for the same panel drops its OWN push; the newer push lands; both callers get honest data', async () => {
    type Resolver = (data: PanelDataMap['mcp']) => void;
    const resolvers: Resolver[] = [];
    const { port, registry, emitted } = makePort();
    registerFakeSource(registry, 'mcp', () => {
      return new Promise<{ data: PanelDataMap['mcp'] }>((resolve) => {
        resolvers.push((data) => resolve({ data }));
      });
    });
    const dispatcher = new ControlDispatcher(port);
    const serverA: McpServer = {
      id: 'a',
      name: 'a',
      status: 'disconnected',
      command: 'a',
      toolCount: 0,
      enabled: true,
      transport: 'stdio',
    };
    const serverB: McpServer = {
      id: 'b',
      name: 'b',
      status: 'disconnected',
      command: 'b',
      toolCount: 0,
      enabled: true,
      transport: 'stdio',
    };

    // Both fetches are issued for the SAME panel scope ('mcp') before either
    // resolves — `older` mints seq 1, `newer` mints seq 2 (T-12).
    const older = dispatcher.invokeControl('panel.data', { panel: 'mcp' });
    const newer = dispatcher.invokeControl('panel.data', { panel: 'mcp' });
    const resolveOlder = resolvers[0];
    const resolveNewer = resolvers[1];
    if (!resolveOlder || !resolveNewer) {
      throw new Error('test setup: expected two pending fetch resolvers');
    }

    // Resolve the NEWER fetch first, then the OLDER one — the older is now stale.
    resolveNewer({ servers: [serverB] });
    await newer;
    resolveOlder({ servers: [serverA] });
    const olderResult = await older;

    // The caller's own correlated resolve is always honest, race or not.
    expect(olderResult).toEqual({ servers: [serverA] });
    // But only the newer fetch's push landed — the older, now-stale push was dropped.
    const pushes = emitted.filter((m) => m.type === 'panel.data' && m.panel === 'mcp');
    expect(pushes).toEqual([{ type: 'panel.data', panel: 'mcp', data: { servers: [serverB] } }]);
  });
});
