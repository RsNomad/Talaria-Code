/*
 * RED-first: UI-I1. `SubagentsPanel` used to index `STATUS[d.status]`
 * directly — a delegation `status` outside the known `SubagentStatus` enum
 * made the lookup `undefined`, and `.tone` threw mid-render (no error
 * boundary -> blank webview). Exercised directly (no jsdom).
 */
import { describe, it, expect } from 'vitest';
import { totalLookup } from '../lookup';
import { STATUS, UNKNOWN_SUBAGENT_STATUS } from './SubagentsPanel';

describe('SubagentsPanel status lookup (UI-I1)', () => {
  it('resolves every known SubagentStatus to its real entry (behavior-preserving)', () => {
    expect(totalLookup(STATUS, 'running', UNKNOWN_SUBAGENT_STATUS)).toBe(STATUS.running);
    expect(totalLookup(STATUS, 'complete', UNKNOWN_SUBAGENT_STATUS)).toBe(STATUS.complete);
    expect(totalLookup(STATUS, 'failed', UNKNOWN_SUBAGENT_STATUS)).toBe(STATUS.failed);
    expect(totalLookup(STATUS, 'interrupted', UNKNOWN_SUBAGENT_STATUS)).toBe(STATUS.interrupted);
  });

  it('a malformed/out-of-contract status normalizes to the safe default, not undefined', () => {
    const result = totalLookup(STATUS, 'queued', UNKNOWN_SUBAGENT_STATUS);
    expect(result).toBe(UNKNOWN_SUBAGENT_STATUS);
    expect(() => result.tone).not.toThrow();
    expect(result.tone).toBe('neutral');
  });
});

/**
 * W4-T6 (UI#8): `running` used to share `tone: 'add'` with `complete` — the
 * SAME green "success" tone for an in-progress delegation as a finished one.
 * `ToolCard.tsx`'s STATUS map already established the vocabulary for this
 * exact situation (`running: { tone: 'run', ... }`, the dedicated
 * in-progress tone `Pill.tsx` defines); this pins SubagentsPanel onto it.
 */
describe('W4-T6: the "Running" status tone is unified with ToolCard.tsx (the dedicated "run" tone)', () => {
  it('STATUS.running uses the "run" tone, not "add" (which complete already claims)', () => {
    expect(STATUS.running.tone).toBe('run');
    expect(STATUS.running.tone).not.toBe(STATUS.complete.tone);
  });
});
