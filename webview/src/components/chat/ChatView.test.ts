/*
 * W2 T4 (F-D): the pure selector deciding which tool diffs are still
 * pending an approval — DiffCard's "Open diff in editor" button must render
 * ONLY for those, never for a post-apply tool.diff card (which has no
 * ApprovalItem at all, or one that's already resolved).
 */
import { describe, it, expect } from 'vitest';
import { pendingDiffToolIds, deniedToolIds, itemKey } from './ChatView';
import type { ApprovalItem, ToolItem, TranscriptItem, UserItem, ResultItem, PlanItemView } from '../../types';

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
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

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool',
    turnId: 't1',
    toolId: 'tool-1',
    toolKind: 'edit',
    title: 'write_file',
    status: 'pending',
    ...overrides,
  };
}

describe('pendingDiffToolIds', () => {
  it('includes a toolId whose approval is still unresolved', () => {
    const transcript: TranscriptItem[] = [tool(), approval()];
    expect(pendingDiffToolIds(transcript).has('tool-1')).toBe(true);
  });

  it('excludes a toolId whose approval already resolved', () => {
    const transcript: TranscriptItem[] = [tool(), approval({ resolvedOptionId: 'deny' })];
    expect(pendingDiffToolIds(transcript).has('tool-1')).toBe(false);
  });

  it('excludes a toolId with NO approval at all (post-apply tool.diff — auto-allowed edit)', () => {
    const transcript: TranscriptItem[] = [tool({ toolId: 'post-apply-1' })];
    expect(pendingDiffToolIds(transcript).has('post-apply-1')).toBe(false);
  });

  it('excludes a command approval that carries no toolId', () => {
    const transcript: TranscriptItem[] = [approval({ toolId: undefined, approvalKind: 'command' })];
    expect(pendingDiffToolIds(transcript).size).toBe(0);
  });

  it('returns an empty set for an empty transcript', () => {
    expect(pendingDiffToolIds([]).size).toBe(0);
  });

  it('T-A2 (V-4/V-5): excludes a toolId whose approval has settledOutcome set, even with no resolvedOptionId (e.g. a turn.end cancel-fold)', () => {
    const transcript: TranscriptItem[] = [
      tool(),
      approval({ resolvedOptionId: undefined, settledOutcome: 'cancelled' }),
    ];
    expect(pendingDiffToolIds(transcript).has('tool-1')).toBe(false);
  });
});

/**
 * T-A2-SC2 (audit-2 wave-3 refinement): the toolIds whose gating approval
 * settled to an EFFECTIVE deny — never derived from the raw `hunksLocked`
 * state marker (A1 sets that unconditionally on any settle, including an
 * ALLOW). Two independent ways a toolId lands here: (a) settledOutcome is a
 * non-'selected' terminal (cancelled/expired/superseded — the harness maps
 * all three to deny, permissions.py:95-104), or (b) the chosen option's
 * `kind` is 'deny'/'deny_always' (covers an explicit card-deny click, the
 * optimistic hunk-reject cascade, and the host's own deny echo).
 */
function denyOption(id = 'deny') {
  return { id, label: 'Deny', kind: 'deny' as const };
}
function allowOption(id = 'allow') {
  return { id, label: 'Allow', kind: 'allow_once' as const };
}

describe('deniedToolIds (T-A2-SC2)', () => {
  it('includes a toolId whose approval settled cancelled (harness maps to deny)', () => {
    const transcript: TranscriptItem[] = [approval({ settledOutcome: 'cancelled' })];
    expect(deniedToolIds(transcript).has('tool-1')).toBe(true);
  });

  it('includes a toolId whose approval settled expired', () => {
    const transcript: TranscriptItem[] = [approval({ settledOutcome: 'expired' })];
    expect(deniedToolIds(transcript).has('tool-1')).toBe(true);
  });

  it('includes a toolId whose approval settled superseded', () => {
    const transcript: TranscriptItem[] = [approval({ settledOutcome: 'superseded' })];
    expect(deniedToolIds(transcript).has('tool-1')).toBe(true);
  });

  it('includes a toolId whose approval resolved to a deny-kind option (settled "selected")', () => {
    const transcript: TranscriptItem[] = [
      approval({
        options: [allowOption(), denyOption()],
        resolvedOptionId: 'deny',
        settledOutcome: 'selected',
      }),
    ];
    expect(deniedToolIds(transcript).has('tool-1')).toBe(true);
  });

  it('EXCLUDES a toolId whose approval resolved to an allow-kind option (SC2: never mislabel an applied edit)', () => {
    const transcript: TranscriptItem[] = [
      approval({
        options: [allowOption(), denyOption()],
        resolvedOptionId: 'allow',
        settledOutcome: 'selected',
      }),
    ];
    expect(deniedToolIds(transcript).has('tool-1')).toBe(false);
  });

  it('EXCLUDES a toolId whose approval is still genuinely pending', () => {
    const transcript: TranscriptItem[] = [approval()];
    expect(deniedToolIds(transcript).size).toBe(0);
  });

  it('returns an empty set for an empty transcript', () => {
    expect(deniedToolIds([]).size).toBe(0);
  });
});

/*
 * M8: user/result/plan items each carry a stable turnId (one per kind per
 * turn) — itemKey must key off it, NOT the transcript index, so React
 * doesn't misattribute component state when earlier items are
 * inserted/removed (e.g. a streaming reasoning block folding into place
 * ahead of the eventual `result` item shifts every later index).
 */
function userItem(overrides: Partial<UserItem> = {}): UserItem {
  return { kind: 'user', turnId: 't1', text: 'hi', mode: 'default', ...overrides };
}

function resultItem(overrides: Partial<ResultItem> = {}): ResultItem {
  return { kind: 'result', turnId: 't1', status: 'complete', ...overrides };
}

function planItem(overrides: Partial<PlanItemView> = {}): PlanItemView {
  return { kind: 'plan', turnId: 't1', items: [], ...overrides };
}

describe('itemKey', () => {
  it('keys a user item by turnId, not index', () => {
    expect(itemKey(userItem({ turnId: 'abc' }), 0)).toBe('user-abc');
  });

  it('keys a result item by turnId, not index', () => {
    expect(itemKey(resultItem({ turnId: 'abc' }), 0)).toBe('result-abc');
  });

  it('keys a plan item by turnId, not index', () => {
    expect(itemKey(planItem({ turnId: 'abc' }), 0)).toBe('plan-abc');
  });

  it('gives distinct user items from different turns distinct keys even at the same index', () => {
    const a = itemKey(userItem({ turnId: 't1' }), 2);
    const b = itemKey(userItem({ turnId: 't2' }), 2);
    expect(a).not.toBe(b);
  });

  it('gives the same user item the same key across different indices (stable across reflow)', () => {
    const a = itemKey(userItem({ turnId: 't1' }), 0);
    const b = itemKey(userItem({ turnId: 't1' }), 5);
    expect(a).toBe(b);
  });
});
