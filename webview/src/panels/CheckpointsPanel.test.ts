/*
 * W4-T5b: checkpoint-row session labels are DISPLAY-ONLY (R8) — a muted
 * `· <label>` suffix on the row's meta line when the checkpoint carries a
 * `sessionLabel`, omitted (unchanged row layout) when it doesn't (legacy
 * rows, or rows no controller supplied a label for). `checkpointSessionLabelSuffix`
 * is the pure piece of that render decision — extracted so it is
 * unit-testable without a DOM (mirrors `ChatView.test.ts`'s
 * `pendingDiffToolIds` pattern).
 */
import { describe, it, expect } from 'vitest';
import { checkpointSessionLabelSuffix } from './CheckpointsPanel';
import type { Checkpoint } from '../protocol';

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'ckpt-1',
    label: 'Before turn 1',
    age: '2m ago',
    timestamp: '2026-07-14T00:00:00Z',
    ...overrides,
  };
}

describe('checkpointSessionLabelSuffix', () => {
  it('renders the sessionLabel when the row carries one', () => {
    expect(checkpointSessionLabelSuffix(checkpoint({ sessionLabel: 'Session session-1' }))).toBe(
      'Session session-1',
    );
  });

  it('renders nothing (undefined) when sessionLabel is absent — legacy/unlabeled rows stay clean', () => {
    expect(checkpointSessionLabelSuffix(checkpoint())).toBeUndefined();
  });

  it('never reads any OTHER field (e.g. would not fall back to id/turnOrdinal) — purely the sessionLabel, display-only', () => {
    expect(
      checkpointSessionLabelSuffix(checkpoint({ id: 'ckpt-should-not-appear', turnOrdinal: 42 })),
    ).toBeUndefined();
  });
});
