/*
 * §7.2.2 (extra-a, AU-61 round T4): the terminal `done` marker on
 * `foldSetupProgress` — the webview half of "cancelled/failed pull leaves
 * frozen progress + dead Cancel". Colocated with `setupCards.ts` per the
 * architecture doc's Files line (`docs_claude/au61-round-architecture.md`
 * §3.3); `SetupPanel.test.ts` carries the PRE-EXISTING `foldSetupProgress`
 * accumulation-only coverage (byte-unchanged behavior) — this file adds ONLY
 * the new deletion-arm behavior so the two suites stay additive, not
 * duplicated. `webview-pure` vitest project, `environment: 'node'` (no DOM).
 */
import { describe, it, expect } from 'vitest';
import { EMPTY_SETUP_PROGRESS, foldSetupProgress, progressKey } from './setupCards';

describe('§7.2.2: foldSetupProgress — the terminal `done` marker deletes the settled entry', () => {
  it('a done push deletes the (op,id) entry', () => {
    const m1 = foldSetupProgress(EMPTY_SETUP_PROGRESS, {
      op: 'pull',
      id: 'm',
      phase: 'downloading',
      completedBytes: 5,
      totalBytes: 10,
    });
    expect(m1[progressKey('pull', 'm')]).toBeDefined();

    // RED at HEAD: `done` is not yet a field of `SetupProgress` (type-RED,
    // src/shared/protocol.ts) — once the protocol gains it, this is
    // behavior-RED until foldSetupProgress grows the deletion arm.
    const m2 = foldSetupProgress(m1, { op: 'pull', id: 'm', done: true });
    expect(m2[progressKey('pull', 'm')]).toBeUndefined();
  });

  it('a done push for an absent key is a same-reference no-op (no spurious re-render)', () => {
    const m = foldSetupProgress(EMPTY_SETUP_PROGRESS, { op: 'pull', id: 'other', phase: 'x' });
    expect(foldSetupProgress(m, { op: 'pull', id: 'm', done: true })).toBe(m);
  });
});
