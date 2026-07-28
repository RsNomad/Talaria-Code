/*
 * Table-driven tests for W4 §2e tab metadata + reconciliation — Continue's
 * `handleSessionChange` FOUR cases (Q-5) adopted verbatim, plus the four B9
 * race rules (§7 B9, gating). Pure, framework-agnostic — no bridge, no React.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTabState, type AppState, type TabState } from '../types';
import { must } from '../testing/must';
import { handleSessionChange, sessionToTab } from './tabs';

function tabsOf(...tabs: TabState[]): Record<string, TabState> {
  return Object.fromEntries(tabs.map((t) => [t.tabId, t]));
}

function stateFrom(tabs: TabState[], activeTabId: string): Pick<AppState, 'tabs' | 'tabOrder' | 'activeTabId'> {
  return { tabs: tabsOf(...tabs), tabOrder: tabs.map((t) => t.tabId), activeTabId };
}

describe('sessionToTab — routing-key resolver', () => {
  it('maps each bound sessionId to its owning tabId', () => {
    const a = { ...makeTabState('a', 'A'), sessionId: 's1' };
    const b = { ...makeTabState('b', 'B'), sessionId: 's2' };
    expect(sessionToTab(tabsOf(a, b))).toEqual({ s1: 'a', s2: 'b' });
  });

  it('omits unbound/unassigned tabs (no sessionId)', () => {
    const a = makeTabState('a', 'A'); // sessionId undefined
    expect(sessionToTab(tabsOf(a))).toEqual({});
  });

  it('B9(d): a PENDING tab with an optimistically-assigned sessionId is still in the registry', () => {
    const pending = { ...makeTabState('a', 'A'), sessionId: 's1', binding: 'pending' as const };
    expect(sessionToTab(tabsOf(pending))).toEqual({ s1: 'a' });
  });
});

describe('handleSessionChange — Continue reconciliation, four cases (Q-5)', () => {
  it('case 1: active tab already owns the session -> retitle only, no new/activated tab', () => {
    const active = { ...makeTabState('a', 'Old title'), sessionId: 's1', binding: 'bound' as const };
    const state = stateFrom([active], 'a');

    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'New title' });

    expect(result.activeTabId).toBe('a');
    expect(result.tabs.a).toMatchObject({ sessionId: 's1', title: 'New title', binding: 'bound' });
    expect(result.tabOrder).toEqual(['a']);
    expect(result.closeIntents).toEqual([]);
  });

  it('case 2: another tab owns the session -> activate it, retitle it, and dedup unassigned tabs', () => {
    const active = makeTabState('a', 'Blank'); // unbound, no session
    const owner = { ...makeTabState('b', 'Old'), sessionId: 's1', binding: 'bound' as const };
    const state = stateFrom([active, owner], 'a');

    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'Renamed' });

    expect(result.activeTabId).toBe('b');
    expect(result.tabs.b).toMatchObject({ sessionId: 's1', title: 'Renamed' });
    // The unassigned active tab 'a' was dropped by the dedup filter.
    expect(result.tabs.a).toBeUndefined();
    expect(result.tabOrder).toEqual(['b']);
  });

  it('case 2 preserves a bystander tab that owns a DIFFERENT session (not unassigned)', () => {
    const active = makeTabState('a', 'Blank');
    const owner = { ...makeTabState('b', 'Owner'), sessionId: 's1', binding: 'bound' as const };
    const bystander = { ...makeTabState('c', 'Other'), sessionId: 's9', binding: 'bound' as const };
    const state = stateFrom([active, owner, bystander], 'a');

    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'Renamed' });

    expect(result.tabs.c).toMatchObject({ sessionId: 's9' }); // untouched, kept
    expect(Object.keys(result.tabs).sort()).toEqual(['b', 'c']);
  });

  it('case 3: the active tab is unbound (unassigned) -> adopts the session, binding becomes pending', () => {
    const active = makeTabState('a', 'Blank');
    const state = stateFrom([active], 'a');

    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'Adopted' });

    expect(result.activeTabId).toBe('a');
    expect(result.tabs.a).toMatchObject({ sessionId: 's1', title: 'Adopted', binding: 'pending' });
    expect(result.tabOrder).toEqual(['a']);
    expect(result.closeIntents).toEqual([]);
  });

  it('case 4: the active tab already owns a DIFFERENT session -> a new tab is created and activated', () => {
    const active = { ...makeTabState('a', 'Existing'), sessionId: 's-old', binding: 'bound' as const };
    const state = stateFrom([active], 'a');

    const result = handleSessionChange(state, {
      currentSessionId: 's-new',
      currentSessionTitle: 'Fresh',
      newTabId: 'b',
    });

    expect(result.activeTabId).toBe('b');
    expect(result.tabs.b).toMatchObject({ sessionId: 's-new', title: 'Fresh', binding: 'pending' });
    expect(result.tabs.a).toMatchObject({ sessionId: 's-old' }); // untouched
    expect(result.tabOrder).toEqual(['a', 'b']);
  });

  it('case 4: mints its own tabId when the caller supplies none', () => {
    const active = { ...makeTabState('a', 'Existing'), sessionId: 's-old', binding: 'bound' as const };
    const state = stateFrom([active], 'a');

    const result = handleSessionChange(state, { currentSessionId: 's-new', currentSessionTitle: 'Fresh' });

    const mintedId = result.tabOrder.find((id) => id !== 'a');
    expect(mintedId).toBeDefined();
    expect(result.activeTabId).toBe(mintedId);
  });

  it('I4: case 4 with newTabTitle supplied mints the FRESH title, never currentSessionTitle (RED before the fix: two tabs both titled "Chat 1")', () => {
    // The exact S0-shim shape that produced the I4 bug: the active tab's own
    // title ('Chat 1') is passed through as currentSessionTitle (turn.start's
    // caller convention), while the caller ALSO supplies a fresh newTabTitle
    // for the brand-new tab this call mints.
    const active = { ...makeTabState('a', 'Chat 1'), sessionId: 's-old', binding: 'bound' as const };
    const state = stateFrom([active], 'a');

    const result = handleSessionChange(state, {
      currentSessionId: 's-new',
      currentSessionTitle: 'Chat 1',
      newTabTitle: 'Chat 2',
      newTabId: 'b',
    });

    expect(result.tabs.b).toMatchObject({ title: 'Chat 2' }); // fresh title, not inherited
    expect(result.tabs.a).toMatchObject({ title: 'Chat 1' }); // active tab's own title untouched
    expect(result.tabs.b?.title).not.toBe(result.tabs.a?.title);
  });

  it('I4 fallback: case 4 WITHOUT newTabTitle still falls back to currentSessionTitle (old callers unbroken)', () => {
    const active = { ...makeTabState('a', 'Existing'), sessionId: 's-old', binding: 'bound' as const };
    const state = stateFrom([active], 'a');

    const result = handleSessionChange(state, {
      currentSessionId: 's-new',
      currentSessionTitle: 'Fresh',
      newTabId: 'b',
    });

    expect(result.tabs.b).toMatchObject({ title: 'Fresh' });
  });
});

describe('handleSessionChange — B9 race rules (gating, §7 B9)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('B9(a): a PENDING active tab is NON-ADOPTABLE -> falls through to case 4 (new tab), never case 3', () => {
    // The active tab already has an in-flight tab.load for s-other (pending,
    // no sessionId settled yet would still be the common shape, but even a
    // pending tab that DOES carry an optimistic sessionId must not be
    // silently re-targeted by a second, unrelated reconciliation call).
    const pendingActive: TabState = { ...makeTabState('a', 'Loading…'), binding: 'pending' };
    const state = stateFrom([pendingActive], 'a');

    const result = handleSessionChange(state, {
      currentSessionId: 's-history',
      currentSessionTitle: 'History session',
      newTabId: 'b',
    });

    // NOT adopted into 'a' (would clobber the in-flight bind of 'a').
    expect(result.activeTabId).toBe('b');
    expect(result.tabs.b).toMatchObject({ sessionId: 's-history', binding: 'pending' });
    expect(result.tabs.a).toMatchObject({ binding: 'pending', sessionId: undefined }); // untouched
  });

  it('B9(b): tab.bound / tab.load announces the binding — folding a subsequent message for the same session no longer drop-unknowns it', () => {
    // Exercised at the reducer level (transcript.test.ts); tabs.ts's contract
    // here is just that handleSessionChange's result is IMMEDIATELY queryable
    // via sessionToTab (no separate "commit" step), so a caller that folds
    // the announced binding before a replay stream sees it.
    const active = makeTabState('a', 'Blank');
    const state = stateFrom([active], 'a');
    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'Loaded' });
    expect(sessionToTab(result.tabs)).toEqual({ s1: 'a' });
  });

  it('B9(c): the dedup that removes a PENDING tab (no session yet) yields a tab.close intent for it', () => {
    const active: TabState = { ...makeTabState('a', 'Blank'), binding: 'pending' }; // in-flight tab.open, no session yet
    const owner = { ...makeTabState('b', 'Owner'), sessionId: 's1', binding: 'bound' as const };
    const state = stateFrom([active, owner], 'a');

    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'Owner' });

    expect(result.tabs.a).toBeUndefined(); // removed by dedup
    expect(result.closeIntents).toEqual(['a']); // and the host is told to close it
  });

  it('B9(c): the dedup that removes a genuinely UNBOUND tab (nothing ever opened host-side) emits NO close intent', () => {
    const active = makeTabState('a', 'Blank'); // unbound — never sent tab.open
    const owner = { ...makeTabState('b', 'Owner'), sessionId: 's1', binding: 'bound' as const };
    const state = stateFrom([active, owner], 'a');

    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'Owner' });

    expect(result.tabs.a).toBeUndefined();
    expect(result.closeIntents).toEqual([]); // nothing to leak — never opened
  });

  it('B9(d): the registry (sessionToTab over the result) includes a PENDING open, not only bound tabs', () => {
    const active = makeTabState('a', 'Blank');
    const state = stateFrom([active], 'a');
    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'Adopted' });

    expect(must(result.tabs.a).binding).toBe('pending'); // not yet host-confirmed
    expect(sessionToTab(result.tabs)).toEqual({ s1: 'a' }); // but already registered
  });

  it('defensive: an unknown activeTabId is a documented no-op (never throws, dev-logs)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = stateFrom([], 'ghost');

    const result = handleSessionChange(state, { currentSessionId: 's1', currentSessionTitle: 'X' });

    expect(result).toEqual({ tabs: {}, tabOrder: [], activeTabId: 'ghost', closeIntents: [] });
    expect(warn).toHaveBeenCalled();
  });
});
