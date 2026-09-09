/*
 * The `@`-mention catalog — moved verbatim from `components/MentionMenu.tsx`
 * (W2 T1, architecture doc §2b: `SuggestMenu.tsx` generalizes the RENDERING,
 * this file keeps the DATA). Typing `@` in the composer opens the shared
 * `SuggestMenu` so people can drop a reference token (file / folder /
 * problems / terminal / selection) into the prompt.
 */
import type { SuggestItem } from '../components/SuggestMenu';

export interface MentionItem extends SuggestItem {
  /** Inserted as `@<token>` into the prompt. */
  token: string;
}

/**
 * The reference kinds Hermes can resolve itself once wired to a backend.
 *
 * SY-02: deeply immutable at the type level — `readonly … []` blocks
 * `.push`/index-write on the catalog itself, and wrapping each element in
 * `Readonly<>` blocks a per-entry field write too (`MENTIONS[0].label = …`),
 * matching this repo's `ignoreFilter.ts`/`nextEditCopy.ts` "readonly-typed
 * literal, no runtime freeze" idiom for a latent-only (no consumer mutates)
 * catalog — unlike `EMPTY_SETUP_PROGRESS`, this is never handed out as a
 * shared mutable default, so a compile-time guard is enough. `filterMentions`
 * below still returns the wide, mutable `MentionItem[]` its signature always
 * has — a `Readonly<MentionItem>` reads as a `MentionItem` (readonly-ness
 * on an object's fields isn't part of structural assignability), so
 * `.filter()`'s result satisfies it with no cast.
 */
export const MENTIONS: readonly Readonly<MentionItem>[] = [
  { id: 'file', label: 'File', hint: 'reference a file', icon: 'file', token: 'file' },
  { id: 'folder', label: 'Folder', hint: 'reference a folder', icon: 'folder', token: 'folder' },
  { id: 'problems', label: 'Problems', hint: 'current diagnostics', icon: 'warning', token: 'problems' },
  { id: 'terminal', label: 'Terminal', hint: 'last terminal output', icon: 'terminal', token: 'terminal' },
  { id: 'selection', label: 'Selection', hint: 'the active editor selection', icon: 'list-selection', token: 'selection' },
  { id: 'git', label: 'Git', hint: 'working-tree diff + status', icon: 'git-commit', token: 'git' },
];

/** Filter {@link MENTIONS} by a (lowercased) query — same predicate the pre-T1 inline code used. */
export function filterMentions(query: string): MentionItem[] {
  const q = query.toLowerCase();
  return MENTIONS.filter((m) => m.id.includes(q) || m.label.toLowerCase().includes(q));
}
