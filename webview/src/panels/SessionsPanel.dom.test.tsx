/**
 * DOM-level tests for the Sessions/History panel (C4).
 *
 * Scope: two gaps in the row-click affordance.
 *  1. A session already loaded into an open tab (`TabState.sessionId`) had no
 *     visible marker in History — a user could not tell which rows were
 *     "already open" before clicking. Bound rows now carry an "Open" `Pill`
 *     and `aria-current="true"` (WAI-ARIA `aria-current`: "true" is the
 *     generic fallback for the current item in a set when none of the more
 *     specific tokens — page/step/location/date/time — apply; MDN,
 *     https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current).
 *  2. Every row fired `onLoad` on a single click, even while the active tab
 *     had a turn in flight — silently replacing a live conversation with no
 *     warning. Loading over a live turn now asks first, mirroring
 *     `CheckpointsPanel`'s inline confirm-strip precedent (a destructive/
 *     surprising action gets an explicit "do it anyway" step rather than
 *     firing on the first click).
 *
 * Reuses the `setup(jsx)` idiom from `SettingsPanel.dom.test.tsx` /
 * `CheckpointsPanel.dom.test.tsx` (userEvent instance created BEFORE render)
 * and the `session()` fixture pattern from `SessionsPanel.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSummary, SessionsData, WebviewToHost } from '../protocol';
import { SessionsPanel } from './SessionsPanel';

/** Documented shape: invoke `userEvent.setup()` BEFORE rendering, and use the
 *  returned instance rather than the direct API. */
function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'sess-1', cwd: '/ws', title: 'Fix the bug', ...overrides };
}

type TabLoadMessage = Extract<WebviewToHost, { type: 'tab.load' }>;

function renderPanel(config: {
  sessions?: SessionSummary[];
  boundSessionIds?: ReadonlySet<string>;
  activeTabHasLiveTurn?: boolean;
  onLoad?: (message: TabLoadMessage) => void;
}) {
  const data: SessionsData = { sessions: config.sessions ?? [session()] };
  return (
    <SessionsPanel
      data={data}
      activeTabId="tab-1"
      boundSessionIds={config.boundSessionIds ?? new Set()}
      activeTabHasLiveTurn={config.activeTabHasLiveTurn ?? false}
      onLoad={config.onLoad ?? (() => {})}
      onLoadMore={() => {}}
      loadingMore={false}
    />
  );
}

describe('C4: History rows carry a bound marker and confirm before replacing a live turn', () => {
  it('a bound session gets an "Open" pill and aria-current="true"; an unbound one gets neither', () => {
    setup(
      renderPanel({
        sessions: [
          session({ id: 'sess-1', title: 'Bound session' }),
          session({ id: 'sess-2', title: 'Unbound session' }),
        ],
        boundSessionIds: new Set(['sess-1']),
      }),
    );

    const boundRow = screen.getByRole('button', { name: /Bound session/ });
    const unboundRow = screen.getByRole('button', { name: /Unbound session/ });

    expect(boundRow).toHaveAttribute('aria-current', 'true');
    expect(unboundRow).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('with no live turn in the active tab, a click loads the row immediately (no regression)', async () => {
    const loads: TabLoadMessage[] = [];
    const { user } = setup(renderPanel({ activeTabHasLiveTurn: false, onLoad: (m) => loads.push(m) }));

    await user.click(screen.getByRole('button', { name: /Fix the bug/ }));

    expect(loads).toEqual([{ type: 'tab.load', tabId: 'tab-1', sessionId: 'sess-1', cwd: '/ws' }]);
    expect(screen.queryByRole('button', { name: 'Load anyway' })).not.toBeInTheDocument();
  });

  it('with a live turn active, a click does NOT load and shows an inline confirm strip instead', async () => {
    const loads: TabLoadMessage[] = [];
    const { user } = setup(renderPanel({ activeTabHasLiveTurn: true, onLoad: (m) => loads.push(m) }));

    await user.click(screen.getByRole('button', { name: /Fix the bug/ }));

    expect(loads).toEqual([]);
    expect(screen.getByRole('button', { name: 'Load anyway' })).toBeInTheDocument();
  });

  it('"Load anyway" loads the session exactly once', async () => {
    const loads: TabLoadMessage[] = [];
    const { user } = setup(renderPanel({ activeTabHasLiveTurn: true, onLoad: (m) => loads.push(m) }));

    await user.click(screen.getByRole('button', { name: /Fix the bug/ }));
    await user.click(screen.getByRole('button', { name: 'Load anyway' }));

    expect(loads).toEqual([{ type: 'tab.load', tabId: 'tab-1', sessionId: 'sess-1', cwd: '/ws' }]);
  });

  it('Cancel dismisses the confirm strip without loading', async () => {
    const loads: TabLoadMessage[] = [];
    const { user } = setup(renderPanel({ activeTabHasLiveTurn: true, onLoad: (m) => loads.push(m) }));

    await user.click(screen.getByRole('button', { name: /Fix the bug/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(loads).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Load anyway' })).not.toBeInTheDocument();
  });
});
