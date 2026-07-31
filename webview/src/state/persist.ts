import type { AppState } from '../types';

/** AUDIT-5 UI M-2: drafts ride the SAME setState channel as tabTitles.
 * Only non-empty drafts are included (bounds the payload); draftAttachments
 * are deliberately EXCLUDED (data-URIs can be megabytes — VS Code setState
 * is for small state). Per-draft cap keeps a pathological paste from
 * bloating the snapshot. */
export const MAX_PERSISTED_DRAFT_CHARS = 20_000;

export function buildDraftSnapshot(state: AppState): Record<string, string> {
  return Object.fromEntries(
    state.tabOrder
      .map((id) => state.tabs[id])
      .filter((t): t is NonNullable<typeof t> => t !== undefined && t.draft !== '')
      .map((t) => [t.tabId, t.draft.slice(0, MAX_PERSISTED_DRAFT_CHARS)]),
  );
}
