/*
 * W2 T1 (§2b): the ONE shared `@`/`/` detection matcher + keyboard reducer
 * behind `useSuggest`. Headless per the architecture doc — these pure
 * functions are exported alongside the hook precisely so they're testable
 * without React/jsdom (this repo's vitest runs in the default `node`
 * environment; the hook itself is exercised transitively through Composer).
 *
 * The `@` cases below pin the EXISTING Composer.tsx inline behavior
 * (`updateMention`, pre-T1) byte-identical — this is the regression net for
 * "MentionMenu behavior must stay byte-identical" now that the matcher is
 * shared with `/`.
 */
import { describe, it, expect } from 'vitest';
import { findTriggerStart, reduceSuggestKey, pathPickEmptyKey } from './useSuggest';

describe('findTriggerStart — the one shared @/`/` matcher (security: explicit token, never re-scanned prose)', () => {
  describe('@ (requireStart: false — fires at any word boundary, current Composer.tsx behavior)', () => {
    it('opens at the very start of the input', () => {
      expect(findTriggerStart('@', 1, '@', false)).toBe(0);
    });

    it('opens after a word boundary (space) mid-sentence', () => {
      const value = 'hello @wor';
      expect(findTriggerStart(value, value.length, '@', false)).toBe(6);
    });

    it('does NOT open when @ is glued to a preceding word (no boundary)', () => {
      const value = 'foo@bar';
      expect(findTriggerStart(value, value.length, '@', false)).toBeNull();
    });

    it('closes as soon as a space is typed after the trigger (whitespace in the query)', () => {
      const value = 'hello @wor ';
      expect(findTriggerStart(value, value.length, '@', false)).toBeNull();
    });

    it('resolves to the NEAREST open trigger when several appear in the text', () => {
      const value = '@foo @bar';
      // caret right after "@bar" — must resolve to the SECOND @, not re-scan
      // all prose for the first/any incidental occurrence (security: explicit
      // token position only).
      expect(findTriggerStart(value, value.length, '@', false)).toBe(5);
    });

    it('returns null with no trigger character at all', () => {
      expect(findTriggerStart('just plain text', 6, '@', false)).toBeNull();
    });
  });

  describe('/ (requireStart: true — Continue-style startOfLine, avoids "see /etc/hosts" mid-sentence false-hits)', () => {
    it('opens at the very start of the input', () => {
      expect(findTriggerStart('/', 1, '/', true)).toBe(0);
    });

    it('opens at the start of a LATER line in a multi-line draft', () => {
      const value = 'hello\n/help';
      expect(findTriggerStart(value, value.length, '/', true)).toBe(6);
    });

    it('does NOT open mid-sentence, even at a word boundary (the /etc/hosts pitfall)', () => {
      const value = 'see /etc/hosts';
      expect(findTriggerStart(value, value.length, '/', true)).toBeNull();
    });

    it('does NOT open mid-sentence right after the trigger char either', () => {
      const value = 'hello /help';
      expect(findTriggerStart(value, value.length, '/', true)).toBeNull();
    });

    it('closes as soon as a space is typed after the command name', () => {
      const value = '/help ';
      expect(findTriggerStart(value, value.length, '/', true)).toBeNull();
    });
  });

  it('an incidental slash deep in unrelated prose never resolves (explicit token only, never re-scanned)', () => {
    // The security pitfall named in the brief: an in-flight "/compact" earlier
    // in the draft must not get picked up just because it re-appears in a scan.
    const value = 'earlier I mentioned /compact but this is just prose now';
    expect(findTriggerStart(value, value.length, '/', true)).toBeNull();
  });
});

describe('reduceSuggestKey — the shared open-menu keyboard reducer (ArrowUp/Down/Enter/Tab/Escape)', () => {
  it('ArrowDown advances the active index and wraps at the end', () => {
    expect(reduceSuggestKey('ArrowDown', 0, 3)).toEqual({ consumed: true, activeIndex: 1 });
    expect(reduceSuggestKey('ArrowDown', 2, 3)).toEqual({ consumed: true, activeIndex: 0 });
  });

  it('ArrowUp retreats the active index and wraps at the start', () => {
    expect(reduceSuggestKey('ArrowUp', 1, 3)).toEqual({ consumed: true, activeIndex: 0 });
    expect(reduceSuggestKey('ArrowUp', 0, 3)).toEqual({ consumed: true, activeIndex: 2 });
  });

  it('Enter and Tab both pick the (clamped) active index and close', () => {
    expect(reduceSuggestKey('Enter', 1, 3)).toEqual({ consumed: true, pick: 1, close: true });
    expect(reduceSuggestKey('Tab', 1, 3)).toEqual({ consumed: true, pick: 1, close: true });
  });

  it('clamps the picked index when the filtered item count shrank below the stored active index', () => {
    expect(reduceSuggestKey('Enter', 5, 2)).toEqual({ consumed: true, pick: 1, close: true });
  });

  it('Escape closes without picking', () => {
    expect(reduceSuggestKey('Escape', 0, 3)).toEqual({ consumed: true, close: true });
  });

  it('an unrelated key is not consumed', () => {
    expect(reduceSuggestKey('a', 0, 3)).toEqual({ consumed: false });
  });

  it('with zero items, arrow keys are not consumed (nothing to navigate)', () => {
    expect(reduceSuggestKey('ArrowDown', 0, 0)).toEqual({ consumed: false });
    expect(reduceSuggestKey('Enter', 0, 0)).toEqual({ consumed: false });
  });
});

describe('pathPickEmptyKey — H2 M3: what an open @file:/@folder: submenu does with a key at 0 items', () => {
  // `reduceSuggestKey` deliberately returns `consumed: false` at itemCount===0
  // (correct for a top-level `@foo` with no matches — Enter should submit the
  // text as-is). While the async file/folder search submenu is open, though,
  // 0 items means "still searching" / "no matches yet" — Enter must NOT fall
  // through to submit the dangling `@file:` token, and Escape must close the
  // stuck-open submenu. This is a SEPARATE decision from `reduceSuggestKey`
  // (which stays untouched), gated by the caller on `showFilePick` only.
  it('Escape closes the submenu', () => {
    expect(pathPickEmptyKey('Escape', false)).toBe('close');
  });

  it('Enter without Shift is swallowed (never falls through to submit)', () => {
    expect(pathPickEmptyKey('Enter', false)).toBe('swallow');
  });

  it('Shift+Enter passes through untouched (newline insertion is not our concern)', () => {
    expect(pathPickEmptyKey('Enter', true)).toBeNull();
  });

  it('an unrelated key (ArrowDown) passes through untouched', () => {
    expect(pathPickEmptyKey('ArrowDown', false)).toBeNull();
  });

  it('an unrelated key (a plain character) passes through untouched', () => {
    expect(pathPickEmptyKey('a', false)).toBeNull();
  });
});
