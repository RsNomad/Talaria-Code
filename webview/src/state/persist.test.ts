import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_TAB_ID, createInitialState } from '../types';
import { buildDraftSnapshot, MAX_PERSISTED_DRAFT_CHARS } from './persist';

describe('buildDraftSnapshot — AUDIT-5 UI M-2', () => {
  it('keeps non-empty drafts keyed by tabId, drops empty ones, caps each draft', () => {
    const state = createInitialState();
    const tab = state.tabs[BOOTSTRAP_TAB_ID];
    if (!tab) throw new Error('bootstrap tab missing');
    const withDraft = {
      ...state,
      tabs: { [BOOTSTRAP_TAB_ID]: { ...tab, draft: 'x'.repeat(MAX_PERSISTED_DRAFT_CHARS + 5) } },
    };

    expect(buildDraftSnapshot(state)).toEqual({}); // empty draft -> not persisted
    const snapshot = buildDraftSnapshot(withDraft);
    expect(Object.keys(snapshot)).toEqual([BOOTSTRAP_TAB_ID]);
    expect(snapshot[BOOTSTRAP_TAB_ID]).toHaveLength(MAX_PERSISTED_DRAFT_CHARS); // pathological paste capped
  });
});
