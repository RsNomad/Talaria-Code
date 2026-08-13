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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { McpData } from '../protocol';
import { McpPanel } from './McpPanel';

function mcpData(): McpData {
  return {
    servers: [
      { id: 'srv-1', name: 'filesystem', status: 'connected', command: 'npx mcp-fs', toolCount: 4, enabled: true, transport: 'stdio' },
    ],
  };
}

describe('F6: MCP reload notice is carried by a permanently-mounted LiveRegion', () => {
  it('the status live region is present — and empty — before any reload is triggered', () => {
    render(<McpPanel data={mcpData()} onReload={async () => ({ status: 'reloaded' })} />);

    // RED today: no role="status" element exists at all until `notice` is
    // set — the region is not mounted ahead of content.
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('');
  });

  it('a completed reload updates the SAME mounted region rather than mounting a fresh one', async () => {
    const user = userEvent.setup();
    render(
      <McpPanel
        data={mcpData()}
        onReload={async () => ({ status: 'reloaded', message: 'Reloaded 2 servers.' })}
      />,
    );

    const before = screen.getByRole('status');
    await user.click(screen.getByRole('button', { name: /Reload servers/i }));
    const after = await screen.findByRole('status', undefined, { timeout: 2000 });

    // RED today: `notice &&` conditionally MOUNTS a brand-new role="status"
    // div once the reload resolves — this identity check fails against the
    // old implementation because there is no earlier node to be the same as.
    expect(after).toBe(before);
    expect(after).toHaveTextContent('Reloaded 2 servers.');
  });

  it('a reload failure surfaces its message through the same mounted region', async () => {
    const user = userEvent.setup();
    render(
      <McpPanel
        data={mcpData()}
        onReload={async () => {
          throw new Error('Gateway unreachable.');
        }}
      />,
    );

    // Capture the region BEFORE the click and assert the SAME node picks up
    // the failure text — the visible colored card also renders the same
    // sentence (by design: sighted users see it too), so a plain
    // `findByText` would match two nodes; asserting on the captured `before`
    // reference is what actually proves "same mounted node", not a new one.
    const before = screen.getByRole('status');
    await user.click(screen.getByRole('button', { name: /Reload servers/i }));
    await waitFor(() => expect(before).toHaveTextContent('Gateway unreachable.'));
  });
});
