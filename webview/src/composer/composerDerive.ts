/*
 * Pure derived-UI-state helpers extracted from `Composer.tsx` (WS-F5 F5-1,
 * FI-37). Three derived values there were written as deep nested ternaries —
 * hard to read/test, drift-prone. Each is a named pure function here with an
 * exhaustive truth-table test in `composerDerive.test.ts`; the call sites in
 * `Composer.tsx` become one-liners. Behaviour is byte-identical to the
 * ternaries these replace for every input combination.
 */
import type { FileSearchStatus } from './fileSearch';
import { activeOptionId } from '../components/SuggestMenu';

/** The three suggest popups `Composer.tsx`'s textarea can drive as an APG combobox. */
export type PopupId = 'mention' | 'filepick' | 'slash';

/**
 * The `@file`/`@folder` submenu's heading. Precedence, checked in this exact
 * order: an in-flight search beats a failed one beats an empty result beats
 * the folder/file distinction. Mirrors the nested ternary formerly at
 * `Composer.tsx`'s `filePickHeading` call site (~:662-671).
 */
export function filePickHeading(status: FileSearchStatus, itemCount: number, isFolder: boolean): string {
  if (status === 'loading') return 'Searching…';
  if (status === 'error') return 'Search failed';
  if (itemCount === 0) return 'No matches';
  return isFolder ? 'Folders' : 'Files';
}

/**
 * Which of the three suggest popups is open, first-match order: mention,
 * then filePick, then slash. `showMention`/`showFilePick` are mutually
 * exclusive by construction in `Composer.tsx` (see the comment above its
 * call site, ~:686-694) but this function does not assume that — it picks
 * the first true flag, same as the ternary it replaces (~:695-701).
 */
export function openPopupId(showMention: boolean, showFilePick: boolean, showSlash: boolean): PopupId | undefined {
  if (showMention) return 'mention';
  if (showFilePick) return 'filepick';
  if (showSlash) return 'slash';
  return undefined;
}

/**
 * The `aria-activedescendant` id for whichever popup `openPopupId` names, or
 * `undefined` if that popup is open with ZERO rendered options. The filePick
 * popup can be open with nothing rendered yet (the "Searching…"/"No matches"
 * states — its `show*` flag doesn't gate on item count, unlike mention/slash
 * which already require count > 0 to show at all); an `aria-activedescendant`
 * naming an id with no matching `role="option"` element would itself be an
 * a11y bug, so each arm re-checks its own count before naming an id. Mirrors
 * the nested ternary formerly at `Composer.tsx`'s `activeOptId` call site
 * (~:708-715).
 *
 * NB: 'mention' and 'filepick' both read `mentionActiveIndex` — `Composer.tsx`
 * tracks one shared active-index across those two (they're mutually
 * exclusive); only 'slash' has its own `slashActiveIndex`. Preserved exactly.
 */
export function activeOptionOf(
  popupId: PopupId | undefined,
  mentionCount: number,
  filePickCount: number,
  slashCount: number,
  mentionActiveIndex: number,
  slashActiveIndex: number,
): string | undefined {
  switch (popupId) {
    case 'mention':
      return mentionCount > 0 ? activeOptionId('mention', mentionActiveIndex) : undefined;
    case 'filepick':
      return filePickCount > 0 ? activeOptionId('filepick', mentionActiveIndex) : undefined;
    case 'slash':
      return slashCount > 0 ? activeOptionId('slash', slashActiveIndex) : undefined;
    default:
      return undefined;
  }
}
