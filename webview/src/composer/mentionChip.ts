/*
 * Pure view derivation for one `Pill` mention chip (§2b: chips are a VIEW
 * over `parseMentions(text)`, recomputed on every draft change — never a
 * tracked side-array). Reuses the `mentionCatalog` icon/label for every
 * kind so the chip and the `@` picker stay visually consistent by
 * construction; file/folder additionally show the path basename, with the
 * full path always available via `title` so nothing is silently lost.
 */
import { MENTIONS } from './mentionCatalog';
import type { ContextRef } from '../protocol';

const ICON_BY_KIND = new Map(MENTIONS.map((m) => [m.token, m.icon]));
const LABEL_BY_KIND = new Map(MENTIONS.map((m) => [m.token, m.label]));

/** Basename of a `/`- or `\`-separated path (workspace paths may carry either). */
export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export interface MentionChipView {
  icon: string;
  text: string;
  title: string;
}

export function describeMention(ref: ContextRef): MentionChipView {
  const icon = ICON_BY_KIND.get(ref.kind) ?? 'reference';
  const label = LABEL_BY_KIND.get(ref.kind) ?? ref.kind;
  if (ref.path) {
    return { icon, text: basename(ref.path), title: `${label}: ${ref.path}` };
  }
  return { icon, text: label, title: label };
}
