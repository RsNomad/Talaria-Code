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
  loadingSessionId?: string;
  nextCursor?: string;
  onLoadMore?: (cursor: string) => void;
  loadingMore?: boolean;
}) {
  const data: SessionsData = { sessions: config.sessions ?? [session()], nextCursor: config.nextCursor };
  return (
    <SessionsPanel
      data={data}
      activeTabId="tab-1"
      boundSessionIds={config.boundSessionIds ?? new Set()}
      activeTabHasLiveTurn={config.activeTabHasLiveTurn ?? false}
      onLoad={config.onLoad ?? (() => {})}
      loadingSessionId={config.loadingSessionId}
      onLoadMore={config.onLoadMore ?? (() => {})}
      loadingMore={config.loadingMore ?? false}
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

    expect(loads).toEqual([
      { type: 'tab.load', tabId: 'tab-1', sessionId: 'sess-1', cwd: '/ws', title: 'Fix the bug' },
    ]);
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

    expect(loads).toEqual([
      { type: 'tab.load', tabId: 'tab-1', sessionId: 'sess-1', cwd: '/ws', title: 'Fix the bug' },
    ]);
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

/**
 * TI-1 (AU-39) — a committed History-row load is now feedback-full: the
 * loading row goes busy (reused `busyInteraction`, never natively disabled)
 * and a second click on it while busy is a no-op, closing the double-post
 * `onLoad`/`tab.load` used to fire.
 *
 * `loadingSessionId` is a PROP driven by the parent (App.tsx's own
 * `AppState.pendingSessionLoad`, reducer-tested in `transcript.test.ts`), not
 * local state this component owns — so "the load this click started is now
 * in flight" is modeled by re-rendering with it set, exactly the AU-40
 * "Load more" busy test's own pattern just below.
 */
describe('TI-1 (AU-39): a loading History row goes busy; a second click on it is a no-op', () => {
  it('the loading row is aria-busy and NOT natively disabled; an idle sibling row carries neither', () => {
    setup(
      renderPanel({
        sessions: [
          session({ id: 'sess-1', title: 'Fix the bug' }),
          session({ id: 'sess-2', title: 'Other session' }),
        ],
        loadingSessionId: 'sess-1',
      }),
    );

    const loadingRow = screen.getByRole('button', { name: /Fix the bug/ });
    const idleRow = screen.getByRole('button', { name: /Other session/ });

    expect(loadingRow).toHaveAttribute('aria-busy', 'true');
    expect(loadingRow).toHaveAttribute('aria-disabled', 'true');
    expect(loadingRow, 'TI-1: a busy row must stay focusable — never natively disabled').not.toBeDisabled();
    expect(idleRow).not.toHaveAttribute('aria-busy');
    expect(idleRow).not.toHaveAttribute('aria-disabled');
  });

  it('a double-click posts tab.load exactly once — the second click, while the row is busy, is a no-op guard; a click after the busy state clears loads again', async () => {
    const loads: TabLoadMessage[] = [];
    const { user, rerender } = setup(renderPanel({ onLoad: (m) => loads.push(m) }));

    await user.click(screen.getByRole('button', { name: /Fix the bug/ }));
    expect(loads).toHaveLength(1);

    // The App-level round trip: `useHostActions.loadSession` dispatches
    // `local.sessionLoad.start` the MOMENT it posts `tab.load` — simulated
    // here by re-rendering with the row's busy prop now set.
    rerender(renderPanel({ onLoad: (m) => loads.push(m), loadingSessionId: 'sess-1' }));

    const busyRow = screen.getByRole('button', { name: /Fix the bug/ });
    expect(busyRow).toHaveAttribute('aria-busy', 'true');
    await user.click(busyRow);
    expect(loads, 'RED at HEAD: the pre-fix row has no busy state, so this second click also posts').toHaveLength(1);

    // The host's terminal tab.bound for that tabId lands -> the reducer
    // clears pendingSessionLoad -> the row goes idle again.
    rerender(renderPanel({ onLoad: (m) => loads.push(m) }));
    expect(screen.getByRole('button', { name: /Fix the bug/ })).not.toHaveAttribute('aria-busy');

    await user.click(screen.getByRole('button', { name: /Fix the bug/ }));
    expect(loads).toHaveLength(2);
  });
});

/**
 * AU-40 — F-8 doctrine sweep, SessionsPanel representative.
 *
 * RED at HEAD (⟐ Rev-1 B1): the "Load more" footer button used to render
 * `disabled={loading}` — natively disabled the instant a request went in
 * flight. The load-bearing assertion is ATTRIBUTE POSTURE, not focus
 * retention: jsdom does not emulate the browser's blur-on-disable (probed —
 * focusing a button then setting `disabled` leaves `document.activeElement`
 * on it), so a focus-retention check alone would falsely pass even against
 * the pre-fix native-`disabled` code. `toBeDisabled()` (jest-dom) does not
 * consider `aria-disabled` at all, so `.not.toBeDisabled()` genuinely
 * distinguishes the two mechanisms.
 */
describe('AU-40: "Load more" goes BUSY, not natively disabled, while a request is in flight', () => {
  it('while loadingMore is true: not natively disabled, aria-busy + aria-disabled both true, and focus survives the click', async () => {
    const { user, rerender } = setup(
      renderPanel({ nextCursor: 'cursor-1', loadingMore: false }),
    );

    const idle = screen.getByRole('button', { name: /Load more/i });
    expect(idle, 'fixture integrity: not already focused before the click').not.toHaveFocus();
    await user.click(idle);

    // `loadingMore` is a PROP driven by the parent (App.tsx's own in-flight
    // state), not local state this component owns — so "the request this
    // click started is now in flight" is modeled by re-rendering with it
    // flipped, exactly what the real parent does once its correlated
    // `sessions.loadMore` request is issued.
    rerender(renderPanel({ nextCursor: 'cursor-1', loadingMore: true }));

    const pending = screen.getByRole('button', { name: /Loading…/i });
    expect(pending, 'AU-40: an in-flight "Load more" must stay focusable — never natively disabled').not.toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(pending).toHaveAttribute('aria-disabled', 'true');
    // Secondary lock (browser-vs-jsdom gap, see this describe block's doc):
    // true in real browsers per W3C-APG/MDN's disabled-elements-drop-focus
    // rule; jsdom witnesses it only indirectly, through the attribute
    // posture above, since it never actually blurs a disabled element.
    expect(pending).toHaveFocus();
  });
});

/**
 * AU-46: the empty state used to return a BARE `EmptyPanel` — dropping the
 * panel's `PanelShell` header entirely, so an empty History panel lost its
 * "History" title (and the tabpanel's accessible label along with it). The
 * non-empty path already wraps in `<PanelShell title="History" ...>`; the
 * empty path now does too, so the title survives at zero sessions.
 */
describe('AU-46: the empty state keeps the "History" panel header', () => {
  it('renders the "History" title alongside the empty-state hint when there are no sessions', () => {
    setup(renderPanel({ sessions: [] }));

    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('No past sessions yet.')).toBeInTheDocument();
  });
});
