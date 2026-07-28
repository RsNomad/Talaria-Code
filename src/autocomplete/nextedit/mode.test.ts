import { describe, it, expect } from 'vitest';
import { resolveNextEditMode, applyToggleRequest, sanitizeStoredToggles } from './mode';

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

describe('applyToggleRequest — the Guard pure half, TOTAL over all 16 (4 accepted-states × 4 requests) rows', () => {
  const S = (next: boolean, generic: boolean) => ({ next, generic });
  const R = (source: 'next' | 'generic', on: boolean) => ({ source, on });
  it.each([
    // accepted        request              → accepted        result       alert
    [S(false,false), R('next',    true ), S(true, false), 'accepted', null],
    [S(false,false), R('generic', true ), S(false,true ), 'accepted', null],
    [S(false,false), R('next',    false), S(false,false), 'accepted', null],   // off is always accepted (no-op off)
    [S(false,false), R('generic', false), S(false,false), 'accepted', null],
    [S(true, false), R('generic', true ), S(true, false), 'refused',  'refused-generic'], // THE REFUSAL: blocker via the ratified first
    [S(true, false), R('next',    true ), S(true, false), 'accepted', null],   // already-on is an accepted no-op
    [S(true, false), R('next',    false), S(false,false), 'accepted', null],
    [S(true, false), R('generic', false), S(true, false), 'accepted', null],
    [S(false,true ), R('next',    true ), S(false,true ), 'refused',  'refused-next'],    // the mirror refusal
    [S(false,true ), R('generic', true ), S(false,true ), 'accepted', null],
    [S(false,true ), R('generic', false), S(false,false), 'accepted', null],
    [S(false,true ), R('next',    false), S(false,true ), 'accepted', null],
    // degenerate both-on rows: unreachable post-sanitize, but the function stays TOTAL —
    // turning either off resolves; turning either on is an accepted no-op (it is already on):
    [S(true, true ), R('next',    false), S(false,true ), 'accepted', null],
    [S(true, true ), R('generic', false), S(true, false), 'accepted', null],
    [S(true, true ), R('next',    true ), S(true, true ), 'accepted', null],
    [S(true, true ), R('generic', true ), S(true, true ), 'accepted', null],
  ] as const)('accepted=%o req=%o', (accepted, req, expAccepted, expResult, expAlert) => {
    const d = applyToggleRequest(accepted, req);
    expect(d.accepted).toEqual(expAccepted);
    expect(d.result).toBe(expResult);
    expect(d.alert).toBe(expAlert);
    if (d.result === 'refused') expect(d.accepted).toEqual(accepted);   // refusals never change ratified state
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
