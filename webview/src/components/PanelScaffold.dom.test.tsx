import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PanelScaffold } from './PanelScaffold';
import { panelTabpanelId, panelTabDomId } from './PriorityTabs';

/**
 * FI-14 drift-lock: `PanelScaffold` single-sources the `role="tabpanel"` +
 * `aria-labelledby` + `id` + `className` + `ErrorBoundary region` chrome that
 * App.tsx's 9 side-panel render sites (tools/mcp/skills/checkpoints/
 * subagents/sessions/models/setup/settings) used to repeat inline. This test
 * asserts that chrome byte-for-byte against two representative panel keys —
 * including `mcp`, whose region label ("the MCP panel") is uppercase and
 * therefore NOT derivable by capitalizing the key — so any future drift in
 * the ONE shared component is caught here first.
 */
function ThrowingChild(): never {
  throw new Error('boom');
}

describe('PanelScaffold: shared tabpanel chrome for App.tsx side panels (FI-14)', () => {
  it('renders the tabpanel div with id/role/aria-labelledby/className from the panel key, and the children inside', () => {
    render(
      <PanelScaffold panel="tools" region="the Tools panel">
        <div>Tools content</div>
      </PanelScaffold>,
    );

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', panelTabpanelId('tools'));
    expect(panel).toHaveAttribute('aria-labelledby', panelTabDomId('tools'));
    expect(panel).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col');
    expect(screen.getByText('Tools content')).toBeInTheDocument();
  });

  it('derives id/aria-labelledby from the given panel key for a DIFFERENT panel, incl. the uppercase "MCP" region label', () => {
    render(
      <PanelScaffold panel="mcp" region="the MCP panel">
        <div>MCP content</div>
      </PanelScaffold>,
    );

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', panelTabpanelId('mcp'));
    expect(panel).toHaveAttribute('aria-labelledby', panelTabDomId('mcp'));
    expect(panel.id).not.toBe(panelTabpanelId('tools'));
  });

  it('wraps children in an ErrorBoundary scoped to the given region label', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <PanelScaffold panel="mcp" region="the MCP panel">
          <ThrowingChild />
        </PanelScaffold>,
      );

      // The tabpanel wrapper itself must survive the child's render throw —
      // only the ErrorBoundary's fallback replaces the CHILD, same contract
      // as every other ErrorBoundary-guarded region in App.tsx.
      expect(screen.getByRole('tabpanel')).toBeInTheDocument();
      expect(screen.getByText('Something went wrong in the MCP panel.')).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
