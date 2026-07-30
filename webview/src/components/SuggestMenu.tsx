/*
 * The generalized `@`/`/` popup (W2 T1, architecture doc §2b) — formerly
 * `MentionMenu.tsx`, now driving BOTH triggers off `useSuggest` so there is
 * one rendering component instead of two near-duplicates. Rendering for the
 * plain `@` case (a single unheaded "Reference" list) is byte-identical to
 * the pre-T1 `MentionMenu` markup/classes; `/` additionally uses the
 * sectioned form (`sections`) for the "Commands"/"Agent" split (§3.2).
 *
 * B4 (UI M-2 + M-9) / path doc §4 B4: this component backs THREE independent
 * combobox popups in `Composer.tsx` (mention `@`, filePick `@file:`/
 * `@folder:`, slash `/`) — the composer textarea wires `role="combobox"` +
 * `aria-activedescendant` to whichever one is open (APG combobox: "DOM focus
 * is maintained on the combobox and the assistive technology focus is moved
 * within the listbox using aria-activedescendant",
 * https://www.w3.org/WAI/ARIA/apg/patterns/combobox/, fetched this task).
 * That requires every option to carry a STABLE id the caller can predict —
 * `idBase` (one of 'mention' | 'filepick' | 'slash', per-instance so the
 * three popups' ids never collide) plus the flat option index give
 * `${idBase}-opt-${i}`, exposed as the pure {@link activeOptionId} helper so
 * `Composer.tsx` can compute the SAME id its `activeIndex` state already
 * points at without duplicating the numbering scheme.
 */
import { Icon } from './Icon';

/** The minimal shape every suggestible item needs to render a row. */
export interface SuggestItem {
  id: string;
  label: string;
  hint: string;
  icon: string;
}

/** A named group of items — e.g. `/`'s "Commands" (client templates) vs "Agent" (ACP catalog). */
export interface SuggestSection<T extends SuggestItem = SuggestItem> {
  heading: string;
  items: readonly T[];
}

/**
 * Flatten sections into one ordered item list — the SAME order `SuggestMenu`
 * numbers rows in, so a caller's `activeIndex`/`pick(index)` (from
 * `useSuggest`'s `onKeyDown`) lines up with what's actually rendered.
 */
export function flattenSuggestSections<T extends SuggestItem>(sections: readonly SuggestSection<T>[]): T[] {
  return sections.flatMap((s) => s.items);
}

interface SuggestMenuProps<T extends SuggestItem> {
  ariaLabel: string;
  activeIndex: number;
  onPick: (item: T) => void;
  /**
   * B4: this instance's id namespace ('mention' | 'filepick' | 'slash') —
   * becomes the listbox's own `id` and the prefix for every option's `id`
   * (`${idBase}-opt-${i}`). See {@link activeOptionId}.
   */
  idBase: string;
  /** Ungrouped items rendered under one optional `heading` (the `@` shape). */
  items?: readonly T[];
  heading?: string;
  /** Pre-grouped sections (the `/` shape) — mutually exclusive with `items`/`heading`. */
  sections?: readonly SuggestSection<T>[];
}

/**
 * B4: the pure id formula for the option a caller's `activeIndex` refers to.
 * MUST match the id `SuggestMenu` assigns its `i`-th rendered option (the
 * SAME flat, cross-section numbering `activeIndex` is already expressed in —
 * see `useSuggest.ts`'s reducer) so a composer `aria-activedescendant` built
 * from this always names a real, currently-rendered `role="option"` element
 * rather than a phantom id.
 */
export function activeOptionId(idBase: string, activeIndex: number): string {
  return `${idBase}-opt-${activeIndex}`;
}

export function SuggestMenu<T extends SuggestItem>({
  ariaLabel,
  activeIndex,
  onPick,
  idBase,
  items,
  heading,
  sections,
}: SuggestMenuProps<T>) {
  const groups: readonly SuggestSection<T>[] = sections ?? [{ heading: heading ?? '', items: items ?? [] }];
  let cursor = 0;

  return (
    <div
      id={idBase}
      role="listbox"
      aria-label={ariaLabel}
      className="absolute bottom-full left-2 z-30 mb-1 max-h-[210px] min-w-[220px] overflow-y-auto rounded-card border border-border bg-overlay py-1 shadow-lg"
    >
      {groups.map((group, groupIndex) => (
        <div key={group.heading || groupIndex}>
          {group.heading && (
            <div className="px-3 pb-1 pt-0.5 text-2xs text-faint">{group.heading}</div>
          )}
          {group.items.map((it) => {
            const i = cursor;
            cursor += 1;
            const on = i === activeIndex;
            return (
              <button
                key={it.id}
                id={activeOptionId(idBase, i)}
                role="option"
                type="button"
                tabIndex={-1}
                aria-selected={on}
                // Keep textarea focus: prevent the mousedown from blurring it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(it)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  on ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-overlay'
                }`}
              >
                <Icon name={it.icon} size={14} className="flex-none text-accent" />
                <span className="flex-none text-[12px]">{it.label}</span>
                <span className="ml-auto truncate text-2xs text-faint">{it.hint}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
