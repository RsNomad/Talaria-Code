/*
 * W2 T3 (F-A code actions, §2e/§3.3) — applySeed: the PURE "append a
 * `composer.seed` push to the current draft" transform. NEVER a submit —
 * see the doc comment on the test file for the security posture this
 * signature (`(currentDraft, seed) => string`) locks in.
 *
 * `seed.mentions` (only ever `file`/`folder` refs in practice — the four
 * editor actions in F-A each emit exactly one `file` ref, §3.3) are rendered
 * as their canonical `@kind:path ` tokens via the SAME `formatMentionToken`
 * the live `@file`/`@folder` picker uses (I2), so `parseMentions(text)`
 * re-derives them on the very next render — text is the single source of
 * truth (T2e invariant); there is no mention side-array anywhere in this
 * flow, seeded or typed.
 */
import type { ContextRef } from '../protocol';
import { formatMentionToken } from './parseMentions';

/** The `composer.seed` message payload (`src/shared/protocol.ts:772`). */
export interface ComposerSeed {
  /**
   * The tab this seed was minted FOR, captured when the `composer.seed`
   * message arrived. Audit C-3: without it, a seed still pending when the
   * user switches tabs is applied to the NEW tab's draft, because
   * `onDraftChange` is bound to whichever tab is active at apply time.
   */
  tabId: string;
  text: string;
  mentions?: ContextRef[];
}

/** Render every path-bearing mention (`file`/`folder`) as its canonical
 * insertable token, in order; non-path kinds (`problems`/`selection`/
 * `terminal`/`git`) have no path to render and are skipped — F-A never emits
 * them, but this stays honest if a future caller ever does. */
function renderMentionTokens(mentions: ContextRef[] | undefined): string {
  if (!mentions || mentions.length === 0) return '';
  return mentions
    .filter((m): m is ContextRef & { kind: 'file' | 'folder'; path: string } =>
      (m.kind === 'file' || m.kind === 'folder') && !!m.path,
    )
    .map((m) => formatMentionToken(m.kind, m.path))
    .join('');
}

/**
 * Apply a `composer.seed` push to the current draft. An EMPTY draft is
 * replaced outright by the seed block; a NON-EMPTY draft is never clobbered
 * — the seed is appended after a separating newline, inserted only when the
 * draft doesn't already end in whitespace (so repeated seeds don't pile up
 * blank lines).
 */
export function applySeed(currentDraft: string, seed: ComposerSeed): string {
  const block = renderMentionTokens(seed.mentions) + seed.text;
  if (currentDraft.length === 0) return block;

  const needsSeparator = !/\s$/.test(currentDraft);
  return currentDraft + (needsSeparator ? '\n\n' : '') + block;
}
