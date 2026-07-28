import type { ResolvedContext } from '../../context/types';
import type { AcpOutboundContentBlock } from './types';

/**
 * Pure mapper: `ResolvedContext[]` → outbound ACP content blocks (§2a/§3.1).
 * Sibling of `attachments.ts`'s `buildPromptContent` — reuses the same
 * `AcpOutboundContentBlock` union and the same two delivery shapes it
 * already emits (`resource_link`, `resource`):
 *
 * - `linkOnly` refs (file/folder) → a bare `resource_link` (name + uri, no
 *   inlined bytes) — the agent reads the file itself (§3.1).
 * - Non-link refs carrying `text` (the ambient kinds: problems/selection/
 *   terminal/git) → an embedded `resource`, `text/plain`, at the ref's
 *   synthetic uri.
 * - `skipped` refs emit NO block — the skip is surfaced elsewhere (the
 *   transcript notice), never silently dropped and never this mapper's job.
 * - A ref that is neither `linkOnly` nor carries `text` (and isn't skipped)
 *   emits no block either — there's nothing to send.
 */
export function mentionBlocks(resolved: ResolvedContext[]): AcpOutboundContentBlock[] {
  const blocks: AcpOutboundContentBlock[] = [];

  for (const item of resolved) {
    if (item.skipped) continue;

    if (item.linkOnly) {
      blocks.push({ type: 'resource_link', uri: item.uri, name: item.title });
      continue;
    }

    if (item.text !== undefined) {
      blocks.push({
        type: 'resource',
        resource: { uri: item.uri, mimeType: 'text/plain', text: item.text },
      });
    }
  }

  return blocks;
}
