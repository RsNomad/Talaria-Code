import type { AcpToolCallContent } from '../backend/acp/types';
import type { PreviewFile } from './EditPreviewRegistry';

/**
 * W2 T4 — F-D: pull the RAW `{path, oldText, newText}` triples straight off an
 * ACP tool call's content blocks — the PRE-hunk-derivation texts
 * {@link EditPreviewRegistry} needs.
 *
 * Deliberately separate from `contentBlocks.ts`'s `extractDiffs` (which feeds
 * `buildDiffHunks` for the DISPLAY hunks): that derivation is lossy by design
 * (hunk headers, context windows), and the diff preview must show the same
 * texts the human is being asked to approve, not a re-diffed display copy.
 * Same shape-guard as `extractDiffs` (`item.type === 'diff'`), just without
 * the `buildDiffHunks` call — see `diffHunks.ts`'s amended module comment for
 * why both the post-apply tool-call stream AND this pre-exec ask path share
 * the one `AcpDiffContent` shape.
 */
export function extractPreviewFiles(content: AcpToolCallContent[] | null | undefined): PreviewFile[] {
  if (!content) return [];
  const files: PreviewFile[] = [];
  for (const item of content) {
    if ('type' in item && item.type === 'diff') {
      files.push({ path: item.path, oldText: item.oldText, newText: item.newText });
    }
  }
  return files;
}
