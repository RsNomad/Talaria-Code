/**
 * DOM-level tests for the MCP panel's reload notice (Tier-2 T-15, F6).
 *
 * Finding-7 / MDN Live_regions (fetched live for this task,
 * https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions):
 * "Start with an empty live region, then – in a separate step – change the
 * content inside the region." The reload notice used to be a bare
 * `<div role="status">…{notice.text}</div>` that only ever entered the DOM
 * ONCE `notice` was already populated — the region and its content mounted
 * together, which is the documented unreliable-announcement pattern. The fix
 * routes the announcement through the shared `LiveRegion` component
 * (`../components/LiveRegion.tsx`), which is permanently mounted and only
 * ever swaps its `text` — same pattern already proven for the Composer's
 * `attachNotice` (`Composer.tsx` A2) and ChatView's approval/settlement
 * announcers.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { McpAddResult, McpData, McpTestResult } from '../protocol';
import { McpPanel } from './McpPanel';
import { must } from '../testing/must';

function mcpData(): McpData {
  return {
    servers: [
      { id: 'srv-1', name: 'filesystem', status: 'connected', command: 'npx mcp-fs', toolCount: 4, enabled: true, transport: 'stdio' },
    ],
  };
}

/* Task A7: stub admin handlers for the 3 pre-existing reload-only tests
 * below, now that `McpPanelProps` carries the full row-action surface
 * (`onAdd`/`onTest`/`onRemove`/`onSetEnabled`/`onAuth`) — none of these tests
 * exercise those actions, so trivial resolves are enough to satisfy the
 * (required, non-optional — every real caller always provides them) prop
 * contract. */
function noopMcpAdminProps() {
  return {
    onAdd: async (): Promise<McpAddResult> => ({ ok: true, name: 'x', transport: 'stdio' }),
    onTest: async (): Promise<McpTestResult> => ({ ok: true, tools: [] }),
    onRemove: async () => ({ ok: true }),
    onSetEnabled: async () => ({ ok: true, name: 'x', enabled: true }),
    onAuth: async (): Promise<McpTestResult> => ({ ok: true, tools: [] }),
  };
}

/* Task A7 note on `getByRole('status')` below: the panel now renders a
 * `role="status"` LiveRegion per SERVER ROW too (the Toggle rollback +
 * per-row Test/Remove notice), so an unscoped `getByRole('status')` would
 * find more than one match. The Reload notice's own region lives inside a
 * `<section class="contents">` wrapper (display:contents — invisible to
 * layout, present for query-scoping only) alongside the "Reload servers"
 * button, so `within(...).getByRole('status')` still finds exactly the
 * Reload region, unaffected by however many server rows are present — same
 * `within(fieldRow).getByRole('status')` idiom `SettingsPanel.dom.test.tsx`
 * already uses for its own per-row regions. */
function reloadStatusRegion() {
  const section = must(screen.getByRole('button', { name: /Reload servers/i }).closest('section'));
  return within(section).getByRole('status');
}

describe('F6: MCP reload notice is carried by a permanently-mounted LiveRegion', () => {
  it('the status live region is present — and empty — before any reload is triggered', () => {
    render(<McpPanel data={mcpData()} onReload={async () => ({ status: 'reloaded' })} {...noopMcpAdminProps()} />);

    // RED today: no role="status" element exists at all until `notice` is
    // set — the region is not mounted ahead of content.
    const region = reloadStatusRegion();
    expect(region).toHaveTextContent('');
  });

  it('a completed reload updates the SAME mounted region rather than mounting a fresh one', async () => {
    const user = userEvent.setup();
    render(
      <McpPanel
        data={mcpData()}
        onReload={async () => ({ status: 'reloaded', message: 'Reloaded 2 servers.' })}
        {...noopMcpAdminProps()}
      />,
    );

    const before = reloadStatusRegion();
    await user.click(screen.getByRole('button', { name: /Reload servers/i }));
    await waitFor(() => expect(reloadStatusRegion()).toHaveTextContent('Reloaded 2 servers.'));

    // RED today: `notice &&` conditionally MOUNTS a brand-new role="status"
    // div once the reload resolves — this identity check fails against the
    // old implementation because there is no earlier node to be the same as.
    expect(reloadStatusRegion()).toBe(before);
  });

  it('a reload failure surfaces its message through the same mounted region', async () => {
    const user = userEvent.setup();
    render(
      <McpPanel
        data={mcpData()}
        onReload={async () => {
          throw new Error('Gateway unreachable.');
        }}
        {...noopMcpAdminProps()}
      />,
    );

    // Capture the region BEFORE the click and assert the SAME node picks up
    // the failure text — the visible colored card also renders the same
    // sentence (by design: sighted users see it too), so a plain
    // `findByText` would match two nodes; asserting on the captured `before`
    // reference is what actually proves "same mounted node", not a new one.
    const before = reloadStatusRegion();
    await user.click(screen.getByRole('button', { name: /Reload servers/i }));
    await waitFor(() => expect(before).toHaveTextContent('Gateway unreachable.'));
  });
});

/* Task A7 (§4.9): row actions (Toggle/Test/Remove) + the Add-server
 * disclosure. Same harness as the F6 tests above (`render`/`screen`/
 * `waitFor` + `userEvent`), same `mcpData()` fixture. */
describe('A7: MCP panel row actions + Add server form', () => {
  it('submitting the Add form fires onAdd with the parsed params and then auto-tests the new server', async () => {
    const user = userEvent.setup();
    const added: unknown[] = [];
    const tested: string[] = [];
    render(
      <McpPanel
        data={mcpData()}
        onReload={async () => ({ status: 'reloaded' })}
        onAdd={async (p) => {
          added.push(p);
          return { ok: true, name: 'gh', transport: 'stdio' };
        }}
        onTest={async (n) => {
          tested.push(n);
          return { ok: true, tools: [] };
        }}
        onRemove={async () => ({ ok: true })}
        onSetEnabled={async () => ({ ok: true, name: 'x', enabled: true })}
        onAuth={async () => ({ ok: true, tools: [] })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Add server/i }));
    await user.type(screen.getByLabelText(/Name/i), 'gh');
    await user.type(screen.getByLabelText(/Command/i), 'npx');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(added).toHaveLength(1));
    await waitFor(() => expect(tested).toEqual(['gh']));
  });

  it('the Toggle drives onSetEnabled (optimistic on) and the Test/Remove buttons fire the correlated calls', async () => {
    const user = userEvent.setup();
    const setEnabledCalls: Array<[string, boolean]> = [];
    const testedCalls: string[] = [];
    const removedCalls: string[] = [];
    render(
      <McpPanel
        data={mcpData()}
        onReload={async () => ({ status: 'reloaded' })}
        onAdd={async () => ({ ok: true, name: 'x', transport: 'stdio' })}
        onTest={async (name) => {
          testedCalls.push(name);
          return { ok: true, tools: [{ name: 't', description: '' }] };
        }}
        onRemove={async (name) => {
          removedCalls.push(name);
          return { ok: true };
        }}
        onSetEnabled={async (name, enabled) => {
          setEnabledCalls.push([name, enabled]);
          return { ok: true, name, enabled };
        }}
        onAuth={async () => ({ ok: true, tools: [] })}
      />,
    );

    await user.click(screen.getByRole('switch', { name: /Enable filesystem/i }));
    await waitFor(() => expect(setEnabledCalls).toEqual([['filesystem', false]]));

    await user.click(screen.getByRole('button', { name: /^Test$/i }));
    await waitFor(() => expect(testedCalls).toEqual(['filesystem']));
    // Row notice renders through BOTH the sr-only LiveRegion and the
    // sighted-user card (same by-design duplication the Reload notice
    // already carries, see this file's `reloadStatusRegion` comment above)
    // — so two matches for the same text is the expected, correct outcome.
    await waitFor(() => expect(screen.getAllByText('Connected — 1 tools')).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: /^Remove$/i }));
    await waitFor(() => expect(removedCalls).toEqual(['filesystem']));
  });
});
