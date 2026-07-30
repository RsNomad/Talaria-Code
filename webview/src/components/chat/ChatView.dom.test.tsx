import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatView } from './ChatView';
import type { ApprovalItem, MessageItem, TranscriptItem, UserItem } from '../../types';

/**
 * UI I-7 (path doc `af-architecture-path.md` §4 B1). Two independent gaps:
 *
 * 1. The transcript's scroll container (`ChatView.tsx` scroll div) was a
 *    plain `overflow-y-auto` div — no `role="log"` (MDN log role: implicit
 *    `aria-live="polite"`, purpose-built for chat/message history,
 *    https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role,
 *    fetched live for this task) and no `tabindex="0"`, so a keyboard-only
 *    user could neither have streamed replies announced nor scroll/focus the
 *    region at all (axe `scrollable-region-focusable`, WCAG 2.1.1 serious —
 *    recommended fix is exactly `tabindex="0"` on the scrollable container,
 *    https://dequeuniversity.com/rules/axe/4.10/scrollable-region-focusable,
 *    fetched live for this task).
 * 2. The arrival of a blocking edit-approval request (the product's core
 *    consent gate) produced NO screen-reader announcement at all. MDN
 *    Live_regions (fetched live for this task):
 *    `aria-live="assertive"` "should only be used for time-sensitive/
 *    critical notifications that absolutely require the user's immediate
 *    attention" — a blocking approval prompt is exactly that case. Wired via
 *    the shared, UNMODIFIED `LiveRegion` component (assertive → `role="alert"`
 *    with no extra `aria-live`, matching `LiveRegion.dom.test.tsx`'s pinned
 *    contract) as a permanently-mounted sibling BEFORE the scroll div — never
 *    conditionally mounted (Finding-7 mounted-when-empty discipline).
 */

function messageItem(overrides: Partial<MessageItem> = {}): MessageItem {
  return { kind: 'message', turnId: 't1', id: 'm1', text: 'hello', streaming: false, ...overrides };
}

function userItem(overrides: Partial<UserItem> = {}): UserItem {
  return { kind: 'user', turnId: 't1', text: 'hi', mode: 'default', ...overrides };
}

function approvalItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval',
    turnId: 't1',
    id: 'appr-1',
    toolId: 'tool-1',
    approvalKind: 'edit',
    title: 'Edit: src/a.ts',
    options: [],
    ...overrides,
  };
}

function renderChatView(transcript: TranscriptItem[]) {
  return render(
    <ChatView
      transcript={transcript}
      onApproval={() => undefined}
      onDiff={() => undefined}
      onOpenDiff={() => undefined}
      onStarter={() => undefined}
    />,
  );
}

describe('ChatView accessibility (B1)', () => {
  it('renders the transcript scroll container as a keyboard-focusable ARIA log', () => {
    const { getByRole } = renderChatView([messageItem()]);

    const log = getByRole('log', { name: 'Conversation' });
    expect(log).toHaveAttribute('tabindex', '0');
  });

  it('announces a pending edit-approval arrival via an assertive live region', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ title: 'Edit: src/a.ts' }),
    ]);

    const alert = getByRole('alert');
    expect(alert).not.toHaveAttribute('aria-live');
    expect(alert).toHaveTextContent('Approval required: Edit: src/a.ts');
  });

  it('does not announce a resolved approval (region stays mounted but empty)', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ resolvedOptionId: 'allow_once' }),
    ]);

    const alert = getByRole('alert');
    expect(alert).toHaveTextContent('');
  });

  it('renders neither log nor approval announcer for an empty transcript (Hero screen)', () => {
    const { queryByRole } = renderChatView([]);

    expect(queryByRole('log')).toBeNull();
    expect(queryByRole('alert')).toBeNull();
  });

  /**
   * T-A2-SC1 (audit-2 wave-3 refinement, MUST): `pendingApprovalAnnouncement`
   * must ALSO exclude an item with `settledOutcome` set, not just one with a
   * live `resolvedOptionId`. A1's committed reducer CLEARS `resolvedOptionId`
   * on a non-'selected' settle (expired/cancelled/superseded), so without
   * this exclusion a dead, already-settled approval still matches the
   * `resolvedOptionId === undefined` scan and gets a fresh ASSERTIVE
   * re-announcement the moment it becomes the last unresolved-looking item —
   * resurrecting a decision the backend already closed.
   */
  it('SC1: does not (re-)announce an approval that has already settled (expired), even though resolvedOptionId is unset', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ settledOutcome: 'expired', resolvedOptionId: undefined }),
    ]);

    const alert = getByRole('alert');
    expect(alert).toHaveTextContent('');
  });

  it('SC1: does not (re-)announce a cancelled approval either', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ settledOutcome: 'cancelled', resolvedOptionId: undefined }),
    ]);

    const alert = getByRole('alert');
    expect(alert).toHaveTextContent('');
  });
});

/**
 * T-A2-SC4 (owner-approved rider): a POLITE `aria-live="polite"` announcement
 * of an approval's settlement, mirroring B1's assertive announcer. A state
 * change inside `role="log"` is not reliably announced by real AT
 * (`aria-relevant`'s text-change default is documented unreliable), and an
 * auto-deny is a consequence-bearing action taken by the passage of time
 * (NN/g visibility-of-system-status heuristic #1) — so it must be disclosed,
 * not just silently rendered. Uses the shared, unmodified `LiveRegion`
 * (default = polite `role="status"`), a SEPARATE region from B1's assertive
 * one so neither double-announces the other's text.
 */
describe('ChatView accessibility (T-A2-SC4): polite settlement announcement', () => {
  it('announces an expired settlement via a polite status region, distinct from the assertive approval announcer', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ settledOutcome: 'expired', resolvedOptionId: undefined, title: 'Edit: src/a.ts' }),
    ]);

    const status = getByRole('status');
    expect(status).toHaveTextContent('Approval expired — automatically denied: Edit: src/a.ts');
    // The assertive region must stay silent for a settled (non-pending) item — SC1 above.
    expect(getByRole('alert')).toHaveTextContent('');
  });

  it('announces a cancelled settlement distinctly from an expired one', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ settledOutcome: 'cancelled', resolvedOptionId: undefined, title: 'Run: npm test' }),
    ]);

    expect(getByRole('status')).toHaveTextContent('Approval cancelled: Run: npm test');
  });

  it('announces a superseded settlement distinctly', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ settledOutcome: 'superseded', resolvedOptionId: undefined, title: 'Edit: src/b.ts' }),
    ]);

    expect(getByRole('status')).toHaveTextContent('Approval no longer pending: Edit: src/b.ts');
  });

  it('does not announce a "selected" settlement on the polite region (that outcome is not a time-caused surprise)', () => {
    const { getByRole } = renderChatView([
      messageItem(),
      approvalItem({ settledOutcome: 'selected', resolvedOptionId: 'allow_once' }),
    ]);

    expect(getByRole('status')).toHaveTextContent('');
  });

  it('stays silent on the polite region when nothing has settled', () => {
    const { getByRole } = renderChatView([messageItem(), approvalItem()]);

    expect(getByRole('status')).toHaveTextContent('');
  });
});

/**
 * UI#1 (Wave 2, task W2-T7). ChatView's streaming auto-scroll "pin" used to
 * implement only HALF the contract: scrolling up during a live turn silenced
 * auto-scroll with no signal that content was still arriving below and no
 * one-click way back — the user just quietly falls behind. `scrollAway`
 * below fakes jsdom's always-zero scroll geometry (jsdom runs no real
 * layout, same gap `PriorityTabs.dom.test.tsx` documents for
 * `offsetWidth`/`getBoundingClientRect`) so `ChatView`'s own `onScroll`
 * handler sees a real "scrolled far from the bottom" position and flips its
 * pin latch, exactly like a real trackpad scroll would.
 */
function scrollAway(log: HTMLElement) {
  Object.defineProperty(log, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(log, 'scrollTop', { value: 200, configurable: true });
  Object.defineProperty(log, 'clientHeight', { value: 400, configurable: true });
  // distance = 2000 - 200 - 400 = 1400px — far past even the raised ~100px
  // re-pin buffer, so this is unambiguously "scrolled away" under either the
  // old 48px or the new ~100px threshold.
  fireEvent.scroll(log);
}

describe('ChatView jump-to-latest pill (UI#1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a jump-to-latest pill carrying the unseen count once new content arrives after the user scrolls away', () => {
    const { getByRole, rerender } = renderChatView([
      userItem(),
      messageItem({ id: 'm1', streaming: true, text: 'partial' }),
    ]);

    scrollAway(getByRole('log'));

    // Two more blocks stream in while the user is scrolled away reading history.
    rerender(
      <ChatView
        transcript={[
          userItem(),
          messageItem({ id: 'm1', streaming: true, text: 'partial and more' }),
          messageItem({ id: 'm2', streaming: true, text: 'a second block' }),
          messageItem({ id: 'm3', streaming: true, text: 'a third block' }),
        ]}
        onApproval={() => undefined}
        onDiff={() => undefined}
        onOpenDiff={() => undefined}
        onStarter={() => undefined}
      />,
    );

    const pill = getByRole('button', { name: 'Jump to latest, 2 new' });
    expect(pill).toBeInTheDocument();
  });

  it('does not render the pill while pinned to the bottom, even as new content streams in', () => {
    const { getByRole, queryByRole, rerender } = renderChatView([
      userItem(),
      messageItem({ id: 'm1', streaming: true, text: 'partial' }),
    ]);
    // No scroll — stays pinned.
    void getByRole('log');

    rerender(
      <ChatView
        transcript={[
          userItem(),
          messageItem({ id: 'm1', streaming: true, text: 'partial and more' }),
          messageItem({ id: 'm2', streaming: true, text: 'a second block' }),
        ]}
        onApproval={() => undefined}
        onDiff={() => undefined}
        onOpenDiff={() => undefined}
        onStarter={() => undefined}
      />,
    );

    expect(queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('does not render the pill right after scrolling away when nothing new has arrived yet', () => {
    const { getByRole, queryByRole } = renderChatView([
      userItem(),
      messageItem({ id: 'm1', streaming: true, text: 'partial' }),
    ]);

    scrollAway(getByRole('log'));

    expect(queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('clicking the pill re-pins, scrolls to the newest item, and hides itself', () => {
    const { getByRole, queryByRole, rerender } = renderChatView([
      userItem(),
      messageItem({ id: 'm1', streaming: true, text: 'partial' }),
    ]);

    scrollAway(getByRole('log'));
    rerender(
      <ChatView
        transcript={[
          userItem(),
          messageItem({ id: 'm1', streaming: true, text: 'partial and more' }),
          messageItem({ id: 'm2', streaming: true, text: 'a second block' }),
          messageItem({ id: 'm3', streaming: true, text: 'a third block' }),
        ]}
        onApproval={() => undefined}
        onDiff={() => undefined}
        onOpenDiff={() => undefined}
        onStarter={() => undefined}
      />,
    );

    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const pill = getByRole('button', { name: 'Jump to latest, 2 new' });

    fireEvent.click(pill);

    expect(scrollSpy).toHaveBeenCalled();
    expect(queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  /**
   * The other half of the wiring fix: the pin latch must RESET when a new
   * turn starts, even if the user scrolled away mid the PREVIOUS turn — a
   * fresh `user` item landing as the transcript's newest entry means the
   * conversation has moved on, and silently staying unpinned forever (long
   * after the user forgot they'd scrolled) is the exact bug this task closes.
   */
  it('resets the pin latch on turn start, auto-scrolling again even though the user never re-pinned by hand', () => {
    const { getByRole, queryByRole, rerender } = renderChatView([
      userItem({ turnId: 't1' }),
      messageItem({ id: 'm1', turnId: 't1', streaming: true, text: 'partial' }),
    ]);

    scrollAway(getByRole('log'));
    rerender(
      <ChatView
        transcript={[
          userItem({ turnId: 't1' }),
          messageItem({ id: 'm1', turnId: 't1', streaming: false, text: 'done' }),
          messageItem({ id: 'm2', turnId: 't1', streaming: false, text: 'a second block' }),
        ]}
        onApproval={() => undefined}
        onDiff={() => undefined}
        onOpenDiff={() => undefined}
        onStarter={() => undefined}
      />,
    );
    // Sanity: the pill is up before the new turn starts.
    expect(getByRole('button', { name: 'Jump to latest, 1 new' })).toBeInTheDocument();

    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    // A brand new turn begins — a fresh `user` item lands as the newest entry.
    rerender(
      <ChatView
        transcript={[
          userItem({ turnId: 't1' }),
          messageItem({ id: 'm1', turnId: 't1', streaming: false, text: 'done' }),
          messageItem({ id: 'm2', turnId: 't1', streaming: false, text: 'a second block' }),
          userItem({ turnId: 't2', text: 'next question' }),
        ]}
        onApproval={() => undefined}
        onDiff={() => undefined}
        onOpenDiff={() => undefined}
        onStarter={() => undefined}
      />,
    );

    expect(scrollSpy).toHaveBeenCalled();
    expect(queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });
});
