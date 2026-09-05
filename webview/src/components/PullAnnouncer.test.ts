import { describe, it, expect } from 'vitest';
import { announcedPercent } from './PullAnnouncer';

/**
 * A11Y-05 (WCAG 4.1.3): the pure 10%-step latch behind `PullAnnouncer`. A
 * multi-GB pull moves 1% at a time — without this latch, a live region
 * announcing every `percent` change would chatter constantly. This function
 * decides, given the previously-announced value and the current raw
 * percent, what should now be announced: only 10%-step crossings, plus 100%
 * exactly (which may not land on a clean multiple of 10).
 */
describe('announcedPercent', () => {
  it('latches to 10% steps: 0→ announce 0; 7 after 0 → stay 0; 23 → 20; 23→24 → stay 20; 100 → 100', () => {
    expect(announcedPercent(undefined, 7)).toBe(0);
    expect(announcedPercent(0, 9)).toBe(0);
    expect(announcedPercent(0, 23)).toBe(20);
    expect(announcedPercent(20, 24)).toBe(20);
    expect(announcedPercent(20, 100)).toBe(100);
    expect(announcedPercent(undefined, undefined)).toBeUndefined();
  });
});
