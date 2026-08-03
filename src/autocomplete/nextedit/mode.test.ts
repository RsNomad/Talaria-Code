import { describe, it, expect } from 'vitest';
import { resolveNextEditMode, sanitizeStoredToggles } from './mode';

/*
 * Task 12 (T2 M-2 carry-forward): this file used to also cover
 * `applyToggleRequest` — the pre-Task-2 REFUSAL-based transition rule ("the
 * second source turning on while the first is ratified is REFUSED"). Task 2
 * re-based the Guard onto the `talaria.nextEdit.source` enum setting, making
 * mutual exclusion structural (`guard.ts`'s `applyToggleToSource`: the
 * second toggle REPLACES the first, nothing is ever refused), and
 * `applyToggleRequest`/`ToggleDecision`/`withToggle` were deleted from
 * `mode.ts` as production-dead. Those 16 "refused"-asserting rows are
 * removed here with them — they exercised a live-refusal code path
 * production has not emitted since Task 2, so keeping them green would have
 * been misleading coverage of behavior nothing produces anymore.
 */

describe('resolveNextEditMode — the inner half, total over the boolean square', () => {
  it.each([
    [false, false, 'off'],
    [true,  false, 'next'],
    [false, true,  'generic'],
    [true,  true,  'conflict'],   // cold start / both-flipped-at-once — no observable order
  ] as const)('next=%s generic=%s -> %s', (next, generic, expected) => {
    expect(resolveNextEditMode(next, generic)).toBe(expected);
  });
});

describe('sanitizeStoredToggles — cold-start hygiene («скинет в OFF»)', () => {
  it.each([
    [{ next: false, generic: false }, { next: false, generic: false }, false],
    [{ next: true,  generic: false }, { next: true,  generic: false }, false],
    [{ next: false, generic: true  }, { next: false, generic: true  }, false],
    [{ next: true,  generic: true  }, { next: false, generic: false }, true],   // hand-edited store ⇒ BOTH reset OFF, persisted by the shell
  ] as const)('stored=%o -> %o (didReset=%s)', (stored, expAccepted, expReset) => {
    const s = sanitizeStoredToggles(stored);
    expect(s.accepted).toEqual(expAccepted);
    expect(s.didReset).toBe(expReset);
  });
});
