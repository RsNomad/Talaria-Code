/*
 * D1 (M7): pure tests for `createInitialState` — the boot-time factory that
 * lets App.tsx seed the reducer with persisted `getState()` titles/counter
 * without disturbing `INITIAL_STATE`'s own no-restore default shape (every
 * existing `INITIAL_STATE` importer must keep working unchanged).
 */
import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_TAB_ID, createInitialState, INITIAL_STATE } from './types';

describe('createInitialState — D1 boot-time restore factory', () => {
  it('with no argument, matches INITIAL_STATE exactly (no-restore default unchanged)', () => {
    expect(createInitialState()).toEqual(INITIAL_STATE);
  });

  it('with no argument, restoredTitles is undefined and nextChatNumber is the 2 bootstrap default', () => {
    const state = createInitialState();
    expect(state.restoredTitles).toBeUndefined();
    expect(state.nextChatNumber).toBe(2);
  });

  it('threads restored tabTitles onto AppState.restoredTitles, keyed by tabId', () => {
    const state = createInitialState({ tabTitles: { t1: 'Chat 5' } });
    expect(state.restoredTitles).toEqual({ t1: 'Chat 5' });
  });

  it('threads a restored nextChatNumber verbatim', () => {
    const state = createInitialState({ tabTitles: { t1: 'Chat 5' }, nextChatNumber: 6 });
    expect(state.restoredTitles).toEqual({ t1: 'Chat 5' });
    expect(state.nextChatNumber).toBe(6);
  });

  it('an absent nextChatNumber in a partial restore still falls back to 2', () => {
    const state = createInitialState({ tabTitles: { t1: 'Chat 5' } });
    expect(state.nextChatNumber).toBe(2);
  });

  it('everything else matches the INITIAL_STATE shape (same bootstrap tab, tabOrder, theme, backendKind)', () => {
    const state = createInitialState({ tabTitles: { t1: 'Chat 5' }, nextChatNumber: 6 });
    expect(state.tabs).toEqual(INITIAL_STATE.tabs);
    expect(state.tabOrder).toEqual([BOOTSTRAP_TAB_ID]);
    expect(state.activeTabId).toBe(BOOTSTRAP_TAB_ID);
    expect(state.theme).toEqual(INITIAL_STATE.theme);
    expect(state.backendKind).toBe(INITIAL_STATE.backendKind);
  });
});
