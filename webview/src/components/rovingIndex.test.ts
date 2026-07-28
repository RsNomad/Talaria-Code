/*
 * B2 / path doc §2.2: `nextRovingIndex` is the ONE pure roving-tabindex
 * arithmetic helper — semantics copied verbatim from the two hand-rolled
 * implementations it replaces (`PriorityTabs.tsx`'s wrap-around Arrow/Home/End
 * math and `AttachMenu.tsx`'s clamp-at-edges math). A plain function, NOT a
 * hook (it calls no hooks — react.dev's custom-hooks guidance: functions that
 * don't call hooks must not carry the `use` prefix,
 * https://react.dev/learn/reusing-logic-with-custom-hooks).
 *
 * `wrap: true` = APG tabs behavior ("Focus wraps from last to first tab and
 * vice versa", https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ — grounded live
 * for this task). `wrap: false` = clamp (AttachMenu's existing menu
 * behavior — APG menus leave wrapping optional).
 */
import { describe, it, expect } from 'vitest';
import { nextRovingIndex } from './rovingIndex';

describe('nextRovingIndex', () => {
  describe('wrap: true (APG tabs)', () => {
    it('ArrowRight moves forward by one', () => {
      expect(nextRovingIndex(0, 'ArrowRight', 5, { wrap: true })).toBe(1);
    });

    it('ArrowDown moves forward by one (vertical-orientation alias)', () => {
      expect(nextRovingIndex(1, 'ArrowDown', 5, { wrap: true })).toBe(2);
    });

    it('ArrowRight at the last index wraps to 0', () => {
      expect(nextRovingIndex(4, 'ArrowRight', 5, { wrap: true })).toBe(0);
    });

    it('ArrowLeft moves backward by one', () => {
      expect(nextRovingIndex(2, 'ArrowLeft', 5, { wrap: true })).toBe(1);
    });

    it('ArrowUp moves backward by one (vertical-orientation alias)', () => {
      expect(nextRovingIndex(2, 'ArrowUp', 5, { wrap: true })).toBe(1);
    });

    it('ArrowLeft at index 0 wraps to the last index', () => {
      expect(nextRovingIndex(0, 'ArrowLeft', 5, { wrap: true })).toBe(4);
    });

    it('Home jumps to 0 regardless of current position', () => {
      expect(nextRovingIndex(3, 'Home', 5, { wrap: true })).toBe(0);
    });

    it('End jumps to count-1 regardless of current position', () => {
      expect(nextRovingIndex(1, 'End', 5, { wrap: true })).toBe(4);
    });
  });

  describe('wrap: false (clamp, AttachMenu-style menus)', () => {
    it('ArrowRight at the last index clamps at the last index (no wrap)', () => {
      expect(nextRovingIndex(4, 'ArrowRight', 5, { wrap: false })).toBe(4);
    });

    it('ArrowDown at the last index clamps at the last index (no wrap)', () => {
      expect(nextRovingIndex(4, 'ArrowDown', 5, { wrap: false })).toBe(4);
    });

    it('ArrowLeft at index 0 clamps at 0 (no wrap)', () => {
      expect(nextRovingIndex(0, 'ArrowLeft', 5, { wrap: false })).toBe(0);
    });

    it('ArrowUp at index 0 clamps at 0 (no wrap)', () => {
      expect(nextRovingIndex(0, 'ArrowUp', 5, { wrap: false })).toBe(0);
    });

    it('Home still jumps to 0', () => {
      expect(nextRovingIndex(3, 'Home', 5, { wrap: false })).toBe(0);
    });

    it('End still jumps to count-1', () => {
      expect(nextRovingIndex(1, 'End', 5, { wrap: false })).toBe(4);
    });
  });

  describe('unknown / unhandled keys', () => {
    it('returns null for a key the caller should not handle (e.g. Tab)', () => {
      expect(nextRovingIndex(1, 'Tab', 5, { wrap: true })).toBeNull();
    });

    it('returns null for a plain character key', () => {
      expect(nextRovingIndex(1, 'a', 5, { wrap: true })).toBeNull();
    });

    it('returns null for Escape', () => {
      expect(nextRovingIndex(1, 'Escape', 5, { wrap: false })).toBeNull();
    });
  });
});
