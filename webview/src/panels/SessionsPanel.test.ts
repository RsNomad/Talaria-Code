/*
 * W4-T5b (tab.load wire): the History row's click now posts `tab.load
 * {tabId, sessionId, cwd}` for the ACTIVE tab — routed through
 * `AcpBackend.loadTab` (T5a's hardened `loadSessionIntoTab` with an
 * EXPLICIT tabId) instead of the legacy tabId-less `session.load` control
 * invocation, so a History-load can target a chosen (non-bootstrap) tab.
 * `loadTabMessage` is the pure piece of that wiring — extracted so the
 * click's payload is unit-testable without a DOM (mirrors
 * `ChatView.test.ts`'s `pendingDiffToolIds` pattern: a pure helper exported
 * alongside the component, tested directly).
 */
import { describe, it, expect } from 'vitest';
import { loadTabMessage } from './SessionsPanel';
import { loadMoreFooterState } from '../state/panels';
import type { SessionSummary } from '../protocol';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'sess-1', cwd: '/ws', title: 'Fix the bug', ...overrides };
}

describe('loadTabMessage', () => {
  it('builds a tab.load message for the ACTIVE tab, carrying the row\'s session id + cwd', () => {
    expect(loadTabMessage('tab-2', session({ id: 'sess-9', cwd: '/repo' }))).toEqual({
      type: 'tab.load',
      tabId: 'tab-2',
      sessionId: 'sess-9',
      cwd: '/repo',
    });
  });

  it('targets whichever tabId is passed (a bootstrap-tab load looks identical, just with that id)', () => {
    expect(loadTabMessage('bootstrap', session()).tabId).toBe('bootstrap');
  });

  it('never carries a session.load-shaped payload (no stray sessionId/cwd-only object)', () => {
    const msg = loadTabMessage('tab-1', session());
    expect(msg.type).toBe('tab.load');
    expect(Object.keys(msg).sort()).toEqual(['cwd', 'sessionId', 'tabId', 'type']);
  });
});

/*
 * BF-A: a "Load more" failure must NOT wipe the already-loaded sessions list —
 * the append error is a SEPARATE signal from the panel's RemoteData (mirrors
 * the existing `sessionsLoadingMore` split). `loadMoreFooterState` is the
 * pure tri-state (+hidden) decision the footer renders from; exhaustively
 * unit-tested here since this repo's webview tests are no-jsdom (the JSX
 * itself is inspection-verified, not rendered).
 */
describe('loadMoreFooterState', () => {
  it('is hidden when there is no next cursor, regardless of loading/error', () => {
    expect(loadMoreFooterState(false, false, undefined)).toBe('hidden');
    expect(loadMoreFooterState(false, true, undefined)).toBe('hidden');
    expect(loadMoreFooterState(false, false, 'boom')).toBe('hidden');
    expect(loadMoreFooterState(false, true, 'boom')).toBe('hidden');
  });

  it('loading wins over a stale error (a retry clears the error, but assert the precedence directly too)', () => {
    expect(loadMoreFooterState(true, true, 'boom')).toBe('loading');
  });

  it('is error when idle (not loading), a cursor exists, and an error is set', () => {
    expect(loadMoreFooterState(true, false, 'boom')).toBe('error');
  });

  it('is idle when a cursor exists, not loading, and no error', () => {
    expect(loadMoreFooterState(true, false, undefined)).toBe('idle');
  });
});
