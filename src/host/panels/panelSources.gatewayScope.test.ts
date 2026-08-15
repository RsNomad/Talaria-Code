import { describe, it, expect } from 'vitest';
import type { PanelSourceContext, PanelSource } from './PanelSourceRegistry';
import {
  ToolsPanelSource,
  SkillsPanelSource,
  ModelsPanelSource,
  SettingsPanelSource,
  McpPanelSource,
} from './panelSources';

/**
 * F10 (TG-6, AU-OBS-L3) lock test — freezes the "tui_gateway single-RPC
 * sources ride the gateway's unknown-session global fallback with no session
 * scoping" contract documented on the `/* ---- tui_gateway single-RPC
 * sources` block header in `panelSources.ts` (read that GROUNDING NOTE
 * first). This is a characterization test of already-correct behavior — it
 * should PASS immediately, not require a production fix.
 *
 * What this locks: none of `ToolsPanelSource`, `SkillsPanelSource`,
 * `ModelsPanelSource`, `SettingsPanelSource`, `McpPanelSource` reads,
 * resolves, or constructs a session id of its own — every dispatched call's
 * params are either the caller's `params` verbatim/merged (four sources) or a
 * fixed literal the source never looks at its input for (`McpPanelSource`).
 * Driven with the SAME production-shaped params these panels are ACTUALLY
 * invoked with (`resolvePanelRequest` in `webview/src/state/panels.ts` never
 * adds `sessionId` for these six panel kinds; no host-internal
 * `fetchPanelData` call site does either — see the GROUNDING NOTE), none of
 * the dispatched RPCs carry one.
 *
 * What this does NOT lock (see the GROUNDING NOTE + this task's report): the
 * four params-forwarding sources do not themselves strip an incidental
 * `sessionId` — that safety is a caller-convention guarantee, not enforced
 * here. This test guards the thing this task can freeze without a production
 * behavior change: no source may start EXPLICITLY deriving/threading a
 * session id into its own dispatch (mirroring `SessionsPanelSource`'s
 * `getSessionCwd`/`extractSessionId` pattern) — verified by a scratch edit
 * (see the report) that adding exactly that to a source turns this RED.
 */

interface DispatchCall {
  method: string;
  params: unknown;
}

function makeSpyContext(): { ctx: PanelSourceContext; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const ctx: PanelSourceContext = {
    dispatch: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return {}; // every reshape* function here tolerates an empty raw result
    },
    getAcpClient: () => undefined,
    getCwd: () => undefined,
    getSessionCwd: () => undefined,
    getSessionSubagentsSnapshot: () => undefined,
    getRootTracker: () => undefined,
    getOneShotSessionIds: () => new Set<string>(),
  };
  return { ctx, calls };
}

/**
 * No dispatched call's params may carry a session-scoping key (F10). Checks
 * BOTH spellings on purpose:
 *  - `sessionId` — the webview/PanelSource-side camelCase (e.g.
 *    `SessionsPanelSource`/`SubagentsPanelSource`'s `extractSessionId`);
 *  - `session_id` — the SNAKE_CASE key the Python gateway actually
 *    destructures (`tui_gateway/server.py`: `params.get("session_id")`), and
 *    the spelling this repo's OWN gateway dispatches already use
 *    (`AcpBackend.ts` `dispatch('session.delete', { session_id })`). A future
 *    edit that threads a session id into one of these five sources via EITHER
 *    spelling — the snake_case one is the more likely copy-paste of the
 *    existing in-repo convention — must turn this lock red.
 */
function assertNoSessionIdForwarded(calls: readonly DispatchCall[]): void {
  for (const call of calls) {
    const params = call.params;
    if (params && typeof params === 'object') {
      const keys = params as Record<string, unknown>;
      expect('sessionId' in keys).toBe(false);
      expect('session_id' in keys).toBe(false);
    }
  }
}

describe('F10 (TG-6, AU-OBS-L3) lock: tui_gateway single-RPC sources never scope by an acp sessionId', () => {
  // The REAL production params shape for these panels (resolvePanelRequest's
  // `tools`/`skills`/`models`/`settings` branches all return bare `{panel}`,
  // no sessionId — see the GROUNDING NOTE on panelSources.ts).
  it('ToolsPanelSource: dispatches exactly ["tools.list"], no sessionId', async () => {
    const { ctx, calls } = makeSpyContext();
    const source: PanelSource<'tools'> = new ToolsPanelSource(ctx);
    await source.fetch({ panel: 'tools' });

    expect(calls.map((c) => c.method)).toEqual(['tools.list']);
    assertNoSessionIdForwarded(calls);
  });

  it('SkillsPanelSource: dispatches exactly ["skills.manage"] (merging action:"list"), no sessionId', async () => {
    const { ctx, calls } = makeSpyContext();
    const source: PanelSource<'skills'> = new SkillsPanelSource(ctx);
    await source.fetch({ panel: 'skills' });

    expect(calls.map((c) => c.method)).toEqual(['skills.manage']);
    assertNoSessionIdForwarded(calls);
    // The one legitimate merge this source does — tolerated per the brief.
    expect(calls[0]?.params).toMatchObject({ action: 'list' });
  });

  it('ModelsPanelSource: dispatches exactly ["model.options"], no sessionId', async () => {
    const { ctx, calls } = makeSpyContext();
    const source: PanelSource<'models'> = new ModelsPanelSource(ctx);
    await source.fetch({ panel: 'models' });

    expect(calls.map((c) => c.method)).toEqual(['model.options']);
    assertNoSessionIdForwarded(calls);
  });

  it('SettingsPanelSource: dispatches exactly ["config.show"], no sessionId', async () => {
    const { ctx, calls } = makeSpyContext();
    const source: PanelSource<'settings'> = new SettingsPanelSource(ctx);
    await source.fetch({ panel: 'settings' });

    expect(calls.map((c) => c.method)).toEqual(['config.show']);
    assertNoSessionIdForwarded(calls);
  });

  it('McpPanelSource: dispatches exactly ["config.get","tools.list"] (fixed params — ignores its fetch argument entirely), no sessionId even when the caller passes one', async () => {
    const { ctx, calls } = makeSpyContext();
    const source: PanelSource<'mcp'> = new McpPanelSource(ctx);
    // McpPanelSource.fetch() takes no params at all — call it as if a caller
    // DID hand it a session-ish param (the exact adversarial shape the other
    // four are exercised with above), proving it is structurally immune
    // regardless of what any future caller passes.
    await source.fetch({ sessionId: 'acp-xyz', cwd: '/x' });

    expect(calls.map((c) => c.method).sort()).toEqual(['config.get', 'tools.list']);
    assertNoSessionIdForwarded(calls);
    expect(calls.find((c) => c.method === 'config.get')?.params).toEqual({ key: 'full' });
    expect(calls.find((c) => c.method === 'tools.list')?.params).toEqual({});
  });
});
