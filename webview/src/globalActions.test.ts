/*
 * WS-F1 F1-4 (FI-04 close): proves, for each of the 18 connection-global
 * actions moved out of App.tsx into this module, that it issues the EXACT
 * wire call (method literal + params expression + tag arg / absence) the
 * pre-move source did — invariant 1 the adjudicator re-measures. Every
 * expected {method, params, tag} tuple below is read straight off
 * `git show 02ba769:webview/src/App.tsx`, not invented.
 *
 * This repo's `webview-pure` vitest project has no jsdom (see
 * `vitest.config.ts`'s own doc) — `bridge.ts`'s module-level singleton
 * construction touches the `window` global (`addEventListener('message'/
 * 'pagehide', ...)`), which plain Node lacks, and `globalActions.ts`/
 * `rpcShaped.ts` both import that same singleton. Mirrors `bridge.test.ts`'s
 * own fix exactly: stub the one global surface the constructor touches via
 * `vi.stubGlobal`, then dynamically import `./globalActions` (and re-import
 * `./bridge`, already cached from the first import, to get the SAME
 * singleton instance to spy on) AFTER the stub is in place — a static
 * top-level `import` would be hoisted and run before the stub exists.
 *
 * `expectedArgs` spells out the ACTUAL arity `bridge.request` receives at
 * each call site rather than a fixed 2- or 3-tuple: a direct
 * `bridge.request(method, params)` call site (`toggle`, `reloadMcp`,
 * `removeMcpServer`, `setMcpServerEnabled`, `createSkill`,
 * `uninstallHubSkill`, `setConfig`, `setNextEditToggle`, `dispatchSetup`)
 * records a 2-length `mock.calls` entry, while a `requestShaped`-routed site
 * (`addMcpServer`/`testMcpServer`/`authMcpServer`/`mcpCatalog`/
 * `mcpCatalogInstall`/`previewHubSkill`/`scanHubSkill`/`installHubSkill`)
 * always forwards a 3rd `tag` argument explicitly as `undefined` — verified
 * empirically that `toHaveBeenCalledWith` does NOT treat a 2-length expected
 * array as matching a real 3-length call (different `.length`), so a single
 * fixed arity here would silently mis-assert half the rows. The SEPARATE
 * `mock.calls[0][2]` check below is the actual F-1 untagged proof (same idiom
 * as `App.dom.test.tsx`'s own `toHaveBeenCalledWith(..., undefined)` checks)
 * — it reads `undefined` correctly either way (an out-of-bounds array index
 * or an explicit `undefined` element are indistinguishable through `[]`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as GlobalActions from './globalActions';
import type { bridge as BridgeSingleton } from './bridge';

let ga: typeof GlobalActions;
let bridge: typeof BridgeSingleton;

beforeAll(async () => {
  vi.stubGlobal('window', {
    addEventListener: () => {
      /* no-op — nothing here ever needs to fire a message/pagehide event */
    },
  });
  ga = await import('./globalActions');
  ({ bridge } = await import('./bridge'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

interface RequestRow {
  readonly name: string;
  readonly invoke: () => unknown;
  readonly expectedArgs: readonly unknown[];
  /** What `bridge.request` resolves with — only needed so a `requestShaped`
   * guard doesn't throw on an unshaped mock result; irrelevant to the
   * method/params/tag assertions this row makes. */
  readonly resolveWith?: unknown;
}

const requestRows: RequestRow[] = [
  {
    name: 'toggle',
    invoke: () => ga.toggle('toolsets.toggle', { name: 'tool1', enabled: true }),
    expectedArgs: ['toolsets.toggle', { name: 'tool1', enabled: true }],
  },
  {
    name: 'reloadMcp',
    invoke: () => ga.reloadMcp(),
    expectedArgs: ['reload.mcp', { confirm: true }],
  },
  {
    name: 'addMcpServer',
    invoke: () => ga.addMcpServer({ name: 'srv1', transport: 'http', url: 'http://x' }),
    expectedArgs: ['mcp.add', { name: 'srv1', transport: 'http', url: 'http://x' }, undefined],
    resolveWith: { ok: true, name: 'srv1', transport: 'http' },
  },
  {
    name: 'testMcpServer',
    invoke: () => ga.testMcpServer('srv1'),
    expectedArgs: ['mcp.test', { name: 'srv1' }, undefined],
    resolveWith: { ok: true, tools: [] },
  },
  {
    name: 'removeMcpServer',
    invoke: () => ga.removeMcpServer('srv1'),
    expectedArgs: ['mcp.remove', { name: 'srv1' }],
  },
  {
    name: 'setMcpServerEnabled',
    invoke: () => ga.setMcpServerEnabled('srv1', true),
    expectedArgs: ['mcp.setEnabled', { name: 'srv1', enabled: true }],
  },
  {
    name: 'authMcpServer',
    invoke: () => ga.authMcpServer('srv1'),
    expectedArgs: ['mcp.auth', { name: 'srv1' }, undefined],
    resolveWith: { ok: true, tools: [] },
  },
  {
    name: 'mcpCatalog',
    invoke: () => ga.mcpCatalog(),
    expectedArgs: ['mcp.catalog', {}, undefined],
    resolveWith: { entries: [] },
  },
  {
    name: 'mcpCatalogInstall',
    invoke: () => ga.mcpCatalogInstall({ name: 'entry1' }),
    expectedArgs: ['mcp.catalogInstall', { name: 'entry1' }, undefined],
    resolveWith: { ok: true, name: 'entry1' },
  },
  {
    name: 'createSkill',
    invoke: () => ga.createSkill({ name: 'skill1', content: 'body' }),
    expectedArgs: ['skills.create', { name: 'skill1', content: 'body' }],
  },
  {
    name: 'previewHubSkill',
    invoke: () => ga.previewHubSkill('id1'),
    expectedArgs: ['skills.hubPreview', { identifier: 'id1' }, undefined],
    resolveWith: {
      name: 'n',
      description: 'd',
      source: 's',
      identifier: 'id1',
      trust_level: 't',
      skill_md: 'md',
      files: [],
    },
  },
  {
    name: 'scanHubSkill',
    invoke: () => ga.scanHubSkill('id1'),
    expectedArgs: ['skills.hubScan', { identifier: 'id1' }, undefined],
    resolveWith: {
      name: 'n',
      identifier: 'id1',
      source: 's',
      trust_level: 't',
      verdict: 'safe',
      summary: 'sum',
      policy: 'allow',
      policy_reason: 'pr',
      findings: [],
      severity_counts: {},
    },
  },
  {
    name: 'installHubSkill',
    invoke: () => ga.installHubSkill('id1'),
    expectedArgs: ['skills.hubInstall', { identifier: 'id1' }, undefined],
    resolveWith: { ok: true, name: 'id1' },
  },
  {
    name: 'uninstallHubSkill',
    invoke: () => ga.uninstallHubSkill('skill1'),
    expectedArgs: ['skills.hubUninstall', { name: 'skill1' }],
  },
  {
    name: 'setConfig',
    invoke: () => ga.setConfig('key1', 'value1'),
    expectedArgs: ['config.set', { key: 'key1', value: 'value1' }],
  },
  {
    name: 'setNextEditToggle',
    invoke: () => ga.setNextEditToggle('next', true),
    expectedArgs: ['nextEdit.toggle', { source: 'next', on: true }],
  },
  {
    name: 'dispatchSetup',
    invoke: () => ga.dispatchSetup('setup.recheck', { foo: 'bar' }),
    expectedArgs: ['setup.recheck', { foo: 'bar' }],
    resolveWith: { ok: true },
  },
];

describe('globalActions.ts — the 18 connection-global handlers (WS-F1 F1-4)', () => {
  it.each(requestRows)('$name issues its bridge.request call UNTAGGED', async (row) => {
    const spy = vi.spyOn(bridge, 'request').mockResolvedValue(row.resolveWith);
    const outcome = row.invoke();
    expect(spy).toHaveBeenCalledWith(...row.expectedArgs);
    // F-1 untagged proof: the tag arg (3rd position) is undefined, whether
    // the call site omitted it or forwarded it explicitly.
    expect(spy.mock.calls[0]?.[2]).toBeUndefined();
    await Promise.resolve(outcome).catch(() => {
      /* only the call-site args matter here; guard-shape rejections are inert */
    });
    spy.mockRestore();
  });

  it('onAddProviderKey posts model.addKey with the slug (fire-and-forget — no bridge.request tag applies)', () => {
    const spy = vi.spyOn(bridge, 'post').mockImplementation(() => {
      /* no-op */
    });
    ga.onAddProviderKey('openai');
    expect(spy).toHaveBeenCalledWith({ type: 'model.addKey', slug: 'openai' });
    spy.mockRestore();
  });

  describe('dispatchSetup resolve/reject contract (unwrapSetupResult itself is covered in state/panels tests)', () => {
    it('rejects with the refusal reason when the host resolves {ok:false, reason}', async () => {
      const spy = vi.spyOn(bridge, 'request').mockResolvedValue({ ok: false, reason: 'busy' });
      await expect(ga.dispatchSetup('setup.recheck', {})).rejects.toThrow('busy');
      spy.mockRestore();
    });

    it('resolves with the result when the host resolves {ok:true, ...}', async () => {
      const spy = vi.spyOn(bridge, 'request').mockResolvedValue({ ok: true, value: 42 });
      await expect(ga.dispatchSetup('setup.recheck', {})).resolves.toEqual({ ok: true, value: 42 });
      spy.mockRestore();
    });
  });
});
