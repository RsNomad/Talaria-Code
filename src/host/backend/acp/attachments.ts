import type { Attachment } from '../../../shared/protocol';
import { resolveWithinWorkspaceReal } from './pathConfine';
import { isSecretPath } from '../../context/sanitize';
import type { AcpOutboundContentBlock } from './types';

/**
 * Build the ACP `session/prompt` `prompt: ContentBlock[]` array from the
 * composer's text + attachments.
 *
 * ACP's `ContentBlock` union (confirmed via Context7 —
 * `types/ContentBlock`) has first-class `text`/`image` variants but no
 * dedicated "pdf" or generic "file" variant; those map to `resource_link`
 * (when the attachment references a workspace path) or an embedded
 * `resource` (when only inline bytes are available), following the MCP
 * embedded-resource convention (`{uri, mimeType, text|blob}`) ACP's
 * `resource` content block is built on. The `text`/`blob` split is
 * contract-pinned by `AcpEmbeddedResourceResource` (types.ts) — we emit
 * `text` for text-ish MIME types (decoded UTF-8) and `blob` (base64) for
 * everything else; live Hermes acceptance of both variants is verified at
 * the Fedora local-test phase (cannot run `hermes acp` here).
 */
export function buildPromptContent(text: string, attachments: Attachment[] | undefined): AcpOutboundContentBlock[] {
  const blocks: AcpOutboundContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const attachment of attachments ?? []) {
    const block = attachmentToContentBlock(attachment);
    if (block) blocks.push(block);
  }
  return blocks;
}

function attachmentToContentBlock(attachment: Attachment): AcpOutboundContentBlock | undefined {
  const parsed = attachment.dataUri ? parseDataUri(attachment.dataUri) : undefined;

  if (attachment.kind === 'image') {
    if (parsed) return { type: 'image', data: parsed.base64, mimeType: parsed.mime };
    if (attachment.path) {
      return {
        type: 'resource_link',
        uri: pathToFileUri(attachment.path),
        name: attachment.name,
        mimeType: attachment.mime,
      };
    }
    return undefined;
  }

  // 'pdf' | 'file': prefer a workspace path reference over inlining bytes.
  if (attachment.path) {
    return {
      type: 'resource_link',
      uri: pathToFileUri(attachment.path),
      name: attachment.name,
      mimeType: attachment.mime,
    };
  }
  if (parsed) {
    const uri = `attachment://${attachment.id}/${encodeURIComponent(attachment.name)}`;
    if (isTextMime(parsed.mime)) {
      return {
        type: 'resource',
        resource: { uri, mimeType: parsed.mime, text: Buffer.from(parsed.base64, 'base64').toString('utf8') },
      };
    }
    return {
      type: 'resource',
      resource: { uri, mimeType: parsed.mime, blob: parsed.base64 },
    };
  }
  return undefined;
}

/** MIME types (beyond the `text/*` prefix) that carry UTF-8 text worth decoding inline. */
const TEXT_MIME_SET = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/x-sh',
  'application/x-httpd-php',
]);

/** Whether a MIME type should be decoded to inline `text` rather than kept as a base64 `blob`. */
function isTextMime(mime?: string): boolean {
  if (!mime) return false;
  return mime.startsWith('text/') || TEXT_MIME_SET.has(mime);
}

function parseDataUri(dataUri: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(dataUri);
  if (!match) return undefined;
  const mime = match[1];
  const base64 = match[2];
  if (mime === undefined || base64 === undefined) {
    // Unreachable: both capture groups are non-optional in the pattern (no
    // alternation), so a successful match always captures both.
    return undefined;
  }
  return { mime, base64 };
}

/** The confine primitive's shape (`resolveWithinWorkspaceReal`'s signature) — injected so tests stay headless, mirroring `context/resolver.ts`'s `ConfineFn`. */
export type AttachmentConfineFn = (path: string, roots: readonly string[]) => Promise<string | null>;

export interface ConfineAttachmentsResult {
  attachments: Attachment[];
  droppedCount: number;
}

/**
 * V-19: confine every `Attachment.path` to the workspace BEFORE it can reach
 * `buildPromptContent`'s `pathToFileUri`. `attachments.ts` used to build a
 * `file:` URI straight from a webview-supplied `path` with none of the
 * confinement its sibling mention path gets — the same class of hole
 * `context/resolver.ts`'s `resolveFileOrFolder` closes for `@`-mentions.
 * Reuses the SAME primitives, in the SAME order (confine FIRST, secret gate
 * SECOND, both on the CONFINED canonical path — see `resolver.ts:162-177`'s
 * doc comment): an attachment whose path resolves outside every workspace
 * root, or whose canonical path is secret-classified, is DROPPED — never
 * sent, never named individually (the caller surfaces only a COUNT, never
 * the path/content, per V-19's fail-toward-less-egress requirement).
 *
 * An attachment with no `path` (dataUri-only — pasted/inline bytes) bypasses
 * this entirely: there is no filesystem reference to confine, so `confine`
 * is never called for it.
 */
export async function confineAttachmentPaths(
  attachments: Attachment[],
  workspaceRoots: readonly string[],
  confine: AttachmentConfineFn = resolveWithinWorkspaceReal,
): Promise<ConfineAttachmentsResult> {
  const kept: Attachment[] = [];
  let droppedCount = 0;
  for (const attachment of attachments) {
    if (!attachment.path) {
      kept.push(attachment);
      continue;
    }
    const canonical = await confine(attachment.path, workspaceRoots);
    if (canonical === null || isSecretPath(canonical)) {
      droppedCount++;
      continue;
    }
    kept.push(canonical === attachment.path ? attachment : { ...attachment, path: canonical });
  }
  return { attachments: kept, droppedCount };
}

function pathToFileUri(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}
