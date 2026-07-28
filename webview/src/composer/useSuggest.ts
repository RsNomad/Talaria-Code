/*
 * The unified composer autocomplete primitive (W2 T1, architecture doc §2b).
 * Continue proves one engine serves both `@` (mentions) and `/` (slash
 * commands) — differing only in the trigger character and a boundary rule.
 * Hermes' existing `@` machinery (formerly inline in Composer.tsx) is
 * GENERALIZED here, not duplicated (the doc's named anti-pattern, doc 02
 * §5.1 "Cline's duplicated-matcher trap").
 *
 * Split in two layers on purpose:
 *  - `findTriggerStart`/`reduceSuggestKey` — pure, framework-free functions.
 *    This is the ONE shared matcher (security-relevant: it resolves an open
 *    token from the caret backward to an explicit trigger character; it never
 *    re-scans the whole draft, so an incidental `/compact` earlier in
 *    already-typed prose can never be picked up as a live command). Directly
 *    unit-tested in `useSuggest.test.ts` without any DOM/React runtime.
 *  - `useSuggest` — a thin React hook wrapping those functions in `useState`/
 *    `useCallback` for ergonomic use in `Composer.tsx`. Not separately unit
 *    tested (this repo's vitest has no jsdom/RTL environment, matching every
 *    other component in this tree — `Composer.test.ts` only exercises the
 *    pure `PRESETS` data, never renders); its correctness follows from the
 *    pure functions above plus `npm run build`.
 */
import { useCallback, useState } from 'react';

export interface SuggestState {
  open: boolean;
  start: number;
  query: string;
}

const CLOSED: SuggestState = { open: false, start: 0, query: '' };

/**
 * Find the start index of an open `trigger` token ending at `caret`, or
 * `null` if none is open. Scans backward from `caret - 1`: hitting the
 * trigger character first means a token is open there; hitting whitespace
 * first (before any trigger char) means there is nothing open at all — this
 * is what makes the query always whitespace-free by construction (typing a
 * space closes the menu, matching the pre-T1 `@`-only behavior).
 *
 * `requireStart` (used by `/`, Continue's `startOfLine`) additionally
 * requires the trigger to sit at the very start of the input OR right after
 * a newline — never mid-line — so a path like `/etc/hosts` mentioned in
 * prose never pops the palette (doc 02 §7.2).
 */
export function findTriggerStart(
  value: string,
  caret: number,
  trigger: '@' | '/',
  requireStart: boolean,
): number | null {
  let start = -1;
  for (let k = caret - 1; k >= 0; k--) {
    const ch = value[k];
    if (ch === trigger) {
      start = k;
      break;
    }
    // `ch` is `undefined` only if `caret` overruns `value.length` (a caller
    // bug, not a case this scan should crash on) — matches this loop's
    // pre-flag runtime behavior, where `.test(undefined)` coerces to the
    // string "undefined" and never matches `\s` either.
    if (ch !== undefined && /\s/.test(ch)) return null;
  }
  if (start < 0) return null;

  if (requireStart) {
    return start === 0 || value[start - 1] === '\n' ? start : null;
  }
  // `start < caret <= value.length`, so `value[start - 1]` is only read once
  // `start !== 0` has already ruled out the one out-of-range index.
  const prevChar = start === 0 ? undefined : value[start - 1];
  const boundary = start === 0 || (prevChar !== undefined && /\s/.test(prevChar));
  return boundary ? start : null;
}

export interface UseSuggestOptions {
  trigger: '@' | '/';
  /**
   * `/` fires only at input/line start (avoids path false-hits); `@` fires
   * at any word boundary (current behavior). Defaults to `false`.
   */
  requireStart?: boolean;
}

/** Outcome of {@link reduceSuggestKey} for one keystroke against the open menu. */
export type SuggestKeyResult =
  | { consumed: false }
  | { consumed: true; activeIndex: number }
  | { consumed: true; pick: number; close: true }
  | { consumed: true; close: true };

/**
 * The shared open-menu keyboard reducer (the Composer.tsx:314-335 branch,
 * extracted once so `@` and `/` never carry two copies of the same
 * ArrowUp/ArrowDown/Enter/Tab/Escape handling). `itemCount` is the CURRENT
 * filtered item count (it can shrink as the user keeps typing a query), so
 * Enter/Tab clamp the stored `activeIndex` into range rather than picking a
 * stale, now-out-of-bounds row.
 */
export function reduceSuggestKey(key: string, activeIndex: number, itemCount: number): SuggestKeyResult {
  if (itemCount === 0) return { consumed: false };
  switch (key) {
    case 'ArrowDown':
      return { consumed: true, activeIndex: (activeIndex + 1) % itemCount };
    case 'ArrowUp':
      return { consumed: true, activeIndex: (activeIndex - 1 + itemCount) % itemCount };
    case 'Enter':
    case 'Tab':
      return { consumed: true, pick: Math.min(activeIndex, itemCount - 1), close: true };
    case 'Escape':
      return { consumed: true, close: true };
    default:
      return { consumed: false };
  }
}

/**
 * H2 M3: decide what an OPEN path-pick submenu (`@file:`/`@folder:`, W2 T2e)
 * should do with a key while its async search has 0 results (`Searching…` /
 * `Search failed` / `No matches`). Deliberately separate from
 * `reduceSuggestKey`'s `itemCount === 0` branch above — that `consumed: false`
 * is correct for a top-level `@foo` with no matches (Enter should submit the
 * text as typed). Here, 0 items means the submenu is still open and the user
 * is mid-search, so:
 *  - Escape must close the stuck-open submenu (never falls through to `reduceSuggestKey`,
 *    which wouldn't consume it either).
 *  - Enter (no Shift) must be swallowed rather than fall through to Composer's
 *    `submit()`, which would otherwise send the draft with a dangling,
 *    incomplete `@file:<partial>` token.
 *  - Shift+Enter (newline) and every other key are left alone (`null`) — the
 *    caller does nothing and normal textarea behavior proceeds.
 * Only called by `Composer.onKeyDown` while `showFilePick` is true, i.e.
 * strictly narrower than the top-level mention/slash paths.
 */
export function pathPickEmptyKey(key: string, shiftKey: boolean): 'close' | 'swallow' | null {
  if (key === 'Escape') return 'close';
  if (key === 'Enter' && !shiftKey) return 'swallow';
  return null;
}

export interface UseSuggestResult {
  state: SuggestState;
  activeIndex: number;
  /** Recompute `state` from the current textarea value + caret position. */
  onTextChange(value: string, caret: number): void;
  /**
   * Handle Arrow/Enter/Tab/Esc while the menu is open. `itemCount` is the
   * live filtered item count; `pick` is invoked with the clamped index on
   * Enter/Tab. Returns whether the key was consumed, so the caller's own
   * Enter-to-submit handling can bail out for that keystroke.
   */
  onKeyDown(e: { key: string; preventDefault(): void }, itemCount: number, pick: (index: number) => void): boolean;
  close(): void;
}

/** The detection state machine as a hook (pure logic) — see the module doc. */
export function useSuggest({ trigger, requireStart = false }: UseSuggestOptions): UseSuggestResult {
  const [state, setState] = useState<SuggestState>(CLOSED);
  const [activeIndex, setActiveIndex] = useState(0);

  const onTextChange = useCallback(
    (value: string, caret: number) => {
      const start = findTriggerStart(value, caret, trigger, requireStart);
      if (start === null) {
        setState((s) => (s.open ? CLOSED : s));
        return;
      }
      setState({ open: true, start, query: value.slice(start + 1, caret) });
      setActiveIndex(0);
    },
    [trigger, requireStart],
  );

  const onKeyDown = useCallback(
    (e: { key: string; preventDefault(): void }, itemCount: number, pick: (index: number) => void) => {
      if (!state.open) return false;
      const result = reduceSuggestKey(e.key, activeIndex, itemCount);
      if (!result.consumed) return false;
      e.preventDefault();
      if ('activeIndex' in result) {
        setActiveIndex(result.activeIndex);
      } else if ('pick' in result) {
        pick(result.pick);
        setState(CLOSED);
      } else {
        setState(CLOSED);
      }
      return true;
    },
    [state.open, activeIndex],
  );

  const close = useCallback(() => setState((s) => (s.open ? CLOSED : s)), []);

  return { state, activeIndex, onTextChange, onKeyDown, close };
}
