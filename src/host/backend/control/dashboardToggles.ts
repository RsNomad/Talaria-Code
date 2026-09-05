import type { DashboardToggleResult } from '../../dashboard/HermesDashboardClient';
import { hasToggleNameCache } from '../../dashboard/dashboardPanelSources';
import type { ConfigWriteTail } from './configWriteTail';
import type { ControlDispatcherHostPort } from './ControlDispatcher';

/**
 * WS-GD.2a A9: the narrowed slice of {@link ControlDispatcherHostPort} the
 * dashboard-toggles domain actually reads — every member `toggle` (and the
 * private `toggleDashboardInner` it routes through) touches, and nothing
 * else.
 */
export type DashboardTogglePort = Pick<ControlDispatcherHostPort, 'getDashboard' | 'panelSources'>;

/**
 * WS-GD.2a A9: the dashboard-toggles domain — pure move off `ControlDispatcher`
 * behind the same `ControlDispatcherHostPort` slice ({@link
 * DashboardTogglePort}) and the SAME `ConfigWriteTail` instance
 * `ControlDispatcher` owns (injected here, not constructed). Zero behavior
 * change — see each member's own doc (moved verbatim) for the full
 * rationale.
 */
export class DashboardToggleHandler {
  constructor(
    private readonly port: DashboardTogglePort,
    private readonly tail: ConfigWriteTail,
  ) {}

  /**
   * W1.5: the real Skills / Tools toggle — routed to the dashboard REST
   * channel. Moved verbatim off `AcpBackend.toggleDashboard` — AH5's
   * host-side serialization tail ({@link ConfigWriteTail}) moved WITH
   * it (see that field's own doc).
   */
  async toggle(method: 'skills.toggle' | 'toolsets.toggle', params: unknown): Promise<DashboardToggleResult> {
    return this.tail.join(() => this.toggleDashboardInner(method, params));
  }

  private async toggleDashboardInner(
    method: 'skills.toggle' | 'toolsets.toggle',
    params: unknown,
  ): Promise<DashboardToggleResult> {
    const dashboard = this.port.getDashboard();
    if (!dashboard) {
      throw new Error(`Refusing '${method}': the Hermes dashboard channel is not configured.`);
    }
    const { name, enabled } = extractToggleParams(params);
    if (!name) {
      throw new Error(`'${method}' requires a { name, enabled } payload.`);
    }

    const panel = method === 'skills.toggle' ? 'skills' : 'tools';
    const source = this.port.panelSources.get(panel);
    if (hasToggleNameCache(source)) {
      const known = source.lastListedNames();
      if (known && !known.has(name)) {
        throw new Error(`Refusing '${method}': '${name}' is not in the last-listed ${panel} set.`);
      }
    }

    const client = await dashboard.ensure();
    return method === 'skills.toggle'
      ? client.toggleSkill(name, enabled)
      : client.toggleToolset(name, enabled);
  }
}

/** W1.5: pull `{name, enabled}` out of a `skills.toggle`/`toolsets.toggle` payload. Moved verbatim. */
function extractToggleParams(params: unknown): { name?: string; enabled: boolean } {
  if (!params || typeof params !== 'object') return { enabled: false };
  const p = params as { name?: unknown; enabled?: unknown };
  const name = typeof p.name === 'string' ? p.name : undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    enabled: p.enabled === true,
  };
}
