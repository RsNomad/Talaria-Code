/*
 * B2 / path doc §2.2 — one pure roving-tabindex arithmetic helper shared by
 * every composite widget in this codebase that needs Arrow/Home/End index
 * math: `TabStrip` and `PriorityTabs` (both `wrap: true`, this task) and
 * `useMenuFocus` (B3, `wrap: false`). A plain exported function — deliberately
 * NOT a hook, since it calls no hooks itself (react.dev's custom-hooks
 * guidance: a function that doesn't call hooks must not carry the `use`
 * prefix, https://react.dev/learn/reusing-logic-with-custom-hooks, fetched
 * live for this task).
 *
 * Semantics copied verbatim from the two implementations this replaces:
 * `PriorityTabs.tsx`'s wrap-around Arrow/Home/End math and `AttachMenu.tsx`'s
 * clamp-at-edges math (`Math.max(0, Math.min(next, count - 1))`).
 *
 * `wrap: true` is APG's tabs behavior — "Focus wraps from last to first tab
 * and vice versa" (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/, fetched
 * live for this task). `wrap: false` is a clamp at the edges — APG leaves
 * wrapping optional for menus, and `AttachMenu` (this repo's canonical menu)
 * already clamps.
 */

/** Keys this helper understands. Any other key returns `null` (see below). */
export type RovingKey = 'ArrowRight' | 'ArrowLeft' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * Computes the next roving-tabindex position for a composite widget (tablist,
 * menu, etc.) given the currently-focused position and a keyboard event key.
 *
 * @param pos - the currently-focused index (0-based)
 * @param key - `KeyboardEvent.key` from the handler; any value not in
 *   {@link RovingKey} is not handled and yields `null` so the caller can let
 *   the event fall through (e.g. `Tab`, `Escape`, printable characters).
 * @param count - the total number of items in the composite (must be > 0 for
 *   a meaningful result; `count <= 0` yields `null`, nothing to move to).
 * @param opts.wrap - `true` wraps at the ends (APG tabs); `false` clamps
 *   (this repo's menu convention).
 * @returns the next index, or `null` if `key` is not a roving-navigation key
 *   (or there is nothing to navigate).
 */
export function nextRovingIndex(
  pos: number,
  key: string,
  count: number,
  opts: { wrap: boolean },
): number | null {
  if (count <= 0) return null;
  const last = count - 1;

  switch (key as RovingKey) {
    case 'ArrowRight':
    case 'ArrowDown':
      if (pos >= last) return opts.wrap ? 0 : last;
      return pos + 1;
    case 'ArrowLeft':
    case 'ArrowUp':
      if (pos <= 0) return opts.wrap ? last : 0;
      return pos - 1;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}
