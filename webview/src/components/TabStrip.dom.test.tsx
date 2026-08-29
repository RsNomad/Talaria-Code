/*
 * B2 (UI I-8) / path doc §2.2, item B2. RED-first characterization of
 * TabStrip's broken tab semantics + invisible-under-keyboard-focus close
 * button, fixed to the APG Tabs pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/, fetched live for this
 * task):
 *  - the element carrying `role="tab"` must be the one that receives DOM
 *    focus (today it's a wrapper `<div>`; only its nested `<button>` is
 *    focusable) — "the tab element receives focus";
 *  - roving tabindex: only the active tab is a tab stop (`tabIndex=0`), every
 *    other tab is `tabIndex=-1`, so a single Tab keypress leaves the strip;
 *  - Left/Right/Home/End move focus across tabs and WRAP at the ends (APG:
 *    "Focus wraps from last to first tab and vice versa");
 *  - AUTOMATIC activation (path doc §2.2 CORRECTION vs the draft, ratified by
 *    APG: "It is recommended that tabs activate automatically when they
 *    receive focus as long as their associated tab panels are displayed
 *    without noticeable latency" — chat-tab switching is instant local
 *    state) — arrow navigation calls `onSelect` immediately, no separate
 *    Enter/Space step;
 *  - the close "×" button must stay visible while it holds keyboard focus
 *    (WCAG 2.4.7 / F78: `opacity-0` with only `group-hover:opacity-100` hides
 *    the focus indicator from keyboard users,
 *    https://www.w3.org/WAI/WCAG22/Techniques/failures/F78, fetched live for
 *    this task) — it stays OUT of the roving tab order (its own tab stop).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabStrip, tabDomId, CHAT_TABPANEL_ID } from './TabStrip';
import { makeTabState } from '../types';

const THREE_TABS = [makeTabState('t1', 'Alpha'), makeTabState('t2', 'Bravo'), makeTabState('t3', 'Charlie')];

describe('B2: TabStrip implements APG tabs', () => {
  it('each tab is the focusable role=tab element (not a wrapping div) and carries aria-selected', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t2"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    // The role="tab" element itself must be a real focusable button, not a
    // wrapper div whose nested button is the only focusable thing.
    for (const tab of tabs) {
      expect(tab.tagName).toBe('BUTTON');
    }
    const active = tabs.find((t) => t.textContent?.includes('Bravo'));
    expect(active).toHaveAttribute('aria-selected', 'true');
    const inactive = tabs.find((t) => t.textContent?.includes('Alpha'));
    expect(inactive).toHaveAttribute('aria-selected', 'false');
  });

  it('roving tabindex: only the active tab is tabIndex=0, the rest are -1', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t2"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    const active = tabs.find((t) => t.textContent?.includes('Bravo'));
    const inactive = tabs.filter((t) => t !== active);
    expect(active).toHaveAttribute('tabindex', '0');
    for (const t of inactive) {
      expect(t).toHaveAttribute('tabindex', '-1');
    }
  });

  it('ArrowRight on the active tab moves focus to the next tab AND selects it immediately (automatic activation)', () => {
    const onSelect = vi.fn();
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t1"
        maxTabs={5}
        onSelect={onSelect}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const alpha = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Alpha'))!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });

    const bravo = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Bravo'))!;
    expect(document.activeElement).toBe(bravo);
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('ArrowLeft on the first tab wraps focus+selection to the last tab', () => {
    const onSelect = vi.fn();
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t1"
        maxTabs={5}
        onSelect={onSelect}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const alpha = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Alpha'))!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });

    const charlie = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Charlie'))!;
    expect(document.activeElement).toBe(charlie);
    expect(onSelect).toHaveBeenCalledWith('t3');
  });

  it('End moves focus+selection to the last tab; Home moves it back to the first', () => {
    const onSelect = vi.fn();
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t1"
        maxTabs={5}
        onSelect={onSelect}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const alpha = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Alpha'))!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'End' });
    const charlie = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Charlie'))!;
    expect(document.activeElement).toBe(charlie);
    expect(onSelect).toHaveBeenLastCalledWith('t3');

    fireEvent.keyDown(charlie, { key: 'Home' });
    const alphaAgain = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Alpha'))!;
    expect(document.activeElement).toBe(alphaAgain);
    expect(onSelect).toHaveBeenLastCalledWith('t1');
  });

  it('the close button stays visible when it holds keyboard focus (WCAG 2.4.7 / F78)', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const closeAlpha = screen.getByRole('button', { name: 'Close Alpha' });
    expect(closeAlpha.className).toContain('focus-visible:opacity-100');
    expect(closeAlpha.className).toContain('group-focus-within:opacity-100');
  });

  it('close buttons are NOT part of the roving tab order (no role=tab, no tabindex arithmetic)', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const closeAlpha = screen.getByRole('button', { name: 'Close Alpha' });
    expect(closeAlpha).not.toHaveAttribute('role', 'tab');
  });
});

/*
 * B2 item 4 (path doc §4 B2, "aria-controls trio"): the tab<->tabpanel
 * association APG requires alongside the roving-tab semantics above —
 * "Each element with role tab has the property aria-controls referring to
 * its associated tabpanel element" (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/,
 * fetched live for this task). The panel side of the association (the
 * ChatView wrapper in App.tsx, `role="tabpanel"` + `aria-labelledby`) is
 * covered by App.dom.test.tsx — this file only proves the TAB side: every
 * tab carries `aria-controls` pointing at the single shared chat tabpanel,
 * and a stable DOM `id` (`tabDomId`) that App.tsx's `aria-labelledby` can
 * reference for whichever tab is active.
 */
describe('B2 item 4: tabs carry aria-controls + a stable id for the shared chat tabpanel', () => {
  it('every tab has aria-controls="chat-tabpanel" and a stable id derived from its tabId', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t2"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.id)).toEqual(THREE_TABS.map((t) => tabDomId(t.tabId)));
    for (const tab of tabs) {
      expect(tab).toHaveAttribute('aria-controls', CHAT_TABPANEL_ID);
    }
  });

  it('the close button is not part of the aria-controls trio (no id, no aria-controls)', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    const closeAlpha = screen.getByRole('button', { name: 'Close Alpha' });
    expect(closeAlpha).not.toHaveAttribute('aria-controls');
  });
});

/*
 * W4-T6 (UI#14): the shared chat tabpanel (`CHAT_TABPANEL_ID`, App.tsx) is
 * only ever MOUNTED while `state.activePanel === 'chat'` — TabStrip itself
 * renders unconditionally (App.tsx:526, above the `PriorityTabs` side-panel
 * switch), so once the user switches to a different side panel (Settings,
 * Tools, ...) every chat-session tab's `aria-controls="chat-tabpanel"`
 * pointed at an id with NO element in the DOM at all — a dangling IDREF (axe
 * `aria-valid-attr-value`). `chatPanelMounted` (threaded from App.tsx as
 * `state.activePanel === 'chat'`) makes that mounted-ness explicit: every
 * tab omits `aria-controls` entirely while it's false, rather than pointing
 * at a target that doesn't exist.
 */
/*
 * UX-10: closing a tab whose turn is still live must ask first — reuses the
 * shared `ConfirmStrip` alertdialog (A11Y-07/ConfirmStrip.tsx) rather than
 * calling `onClose` immediately. Idle tabs (the existing characterization
 * above, all built via `makeTabState` → `turnActive: false`) are UNCHANGED:
 * × still closes them immediately. The strip renders as a SIBLING of the
 * `role="tablist"` div (a strip inside a tablist would be invalid tablist
 * content), so it is found by its own `alertdialog` role, not scoped inside
 * `getAllByRole('tab')`.
 */
describe('UX-10: close-tab with a live turn asks first (ConfirmStrip gate)', () => {
  function liveTab(tabId: string, title: string) {
    return { ...makeTabState(tabId, title), turnActive: true };
  }

  it('closing a tab whose turn is live does NOT call onClose and opens a Confirm close tab alertdialog', () => {
    const onClose = vi.fn();
    render(
      <TabStrip
        tabs={[liveTab('t1', 'Alpha'), makeTabState('t2', 'Bravo')]}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={onClose}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close Alpha' }));

    expect(onClose).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm close tab' });
    expect(dialog).toHaveTextContent('Closing this tab will cancel the turn still running in it.');
  });

  it('"Close anyway" calls onClose(tabId) exactly once', () => {
    const onClose = vi.fn();
    render(
      <TabStrip
        tabs={[liveTab('t1', 'Alpha'), makeTabState('t2', 'Bravo')]}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={onClose}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close anyway' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('t1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('characterization: × on an idle tab still closes immediately (unchanged path, no confirm)', () => {
    const onClose = vi.fn();
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={onClose}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close Alpha' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('t1');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Escape cancels and returns focus to that tab\'s tab button (no onClose)', () => {
    const onClose = vi.fn();
    render(
      <TabStrip
        tabs={[liveTab('t1', 'Alpha'), makeTabState('t2', 'Bravo')]}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={onClose}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close Alpha' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm close tab' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const alphaTab = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Alpha'))!;
    expect(document.activeElement).toBe(alphaTab);
  });
});

describe('W4-T6 (UI#14): aria-controls is a dangling IDREF when the chat panel is not the mounted target', () => {
  it('every tab OMITS aria-controls when chatPanelMounted is false (a side panel is active, no chat-tabpanel in the DOM)', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t2"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={false}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab).not.toHaveAttribute('aria-controls');
    }
  });

  it('every tab carries aria-controls again once chatPanelMounted flips back to true', () => {
    const { rerender } = render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t2"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={false}
      />,
    );

    rerender(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t2"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('aria-controls', CHAT_TABPANEL_ID);
    }
  });
});

/*
 * Task 18 (WCAG 1.1.1, WV4-MIN): the "waiting on tab.bound" spinner (this
 * file's header doc) was a bare `<Icon name="loading" spin>` inside the tab
 * button — an SVG glyph with no text alternative, so a pending tab's
 * accessible name was just its title, identical to a bound tab's. AT users
 * had no way to tell a session was still connecting. An `sr-only` span
 * (same pattern as ChatView's/PanelShell's sr-only regions) folds
 * "(connecting…)" into the tab button's accessible name ONLY while
 * `tab.binding === 'pending'` — bound/unbound tabs are textually unchanged.
 */
describe('A11Y-06: tab close button meets the 24x24 minimum target size', () => {
  it('each close button carries the ≥24px min-size + centering utilities', () => {
    render(
      <TabStrip
        tabs={THREE_TABS}
        activeTabId="t2"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );
    const closeButtons = screen.getAllByRole('button', { name: /^Close / });
    expect(closeButtons).toHaveLength(3);
    for (const close of closeButtons) {
      const cls = close.className;
      expect(cls).toContain('min-h-6');
      expect(cls).toContain('min-w-6');
      expect(cls).toContain('items-center');
      expect(cls).toContain('justify-center');
    }
  });
});

describe('Task 18 (WCAG 1.1.1): a pending tab announces "connecting" to assistive tech', () => {
  function pendingTab(tabId: string, title: string) {
    return { ...makeTabState(tabId, title), binding: 'pending' as const };
  }

  function boundTab(tabId: string, title: string) {
    return { ...makeTabState(tabId, title), binding: 'bound' as const };
  }

  it('a pending tab resolves via getByRole("tab", { name: /connecting/i })', () => {
    render(
      <TabStrip
        tabs={[pendingTab('t1', 'Alpha'), boundTab('t2', 'Bravo')]}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    expect(screen.getByRole('tab', { name: /connecting/i })).toBeInTheDocument();
  });

  it("a bound tab's accessible name does NOT match /connecting/i", () => {
    render(
      <TabStrip
        tabs={[pendingTab('t1', 'Alpha'), boundTab('t2', 'Bravo')]}
        activeTabId="t1"
        maxTabs={5}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        backendKind="acp"
        chatPanelMounted={true}
      />,
    );

    // Exact-name match ('Bravo', no trailing text) proves the accessible
    // name carries nothing extra; the regex assertion is the direct check
    // the brief asks for.
    const bravo = screen.getByRole('tab', { name: 'Bravo' });
    expect(bravo).not.toHaveAccessibleName(/connecting/i);
  });
});
