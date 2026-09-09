import type { Attachment } from '../../../shared/protocol';
import { resolveWithinWorkspaceReal } from './pathConfine';
import { isSecretPath } from '../../context/sanitize';
import type { AcpOutboundContentBlock } from './types';
import type { PromptDegradeCaps } from './promptCaps';

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
declare const CONFINED_BRAND: unique symbol;
/**
 * CA-M03 (WS-AC): compile-time brand for "this attachment came out of
 * {@link confineAttachmentPaths}" — the ONE blessing point (V-19's
 * confine-first, secret-gate-second choke; dataUri-only attachments pass
 * through it too and are blessed by passage). Zero runtime representation;
 * the single `as` below is the documented blessing, making a RAW webview
 * attachment handed straight to {@link buildPromptContent} a type error
 * instead of a reviewer catch.
 */
export type ConfinedAttachment = Attachment & { readonly [CONFINED_BRAND]: true };

/** {@link buildPromptContent}'s result: the wire-ready blocks, plus a COUNT
 *  (never a path/name/content) of attachments that were genuinely unreadable. */
export interface BuildPromptContentResult {
  blocks: AcpOutboundContentBlock[];
  droppedCount: number;
}

export function buildPromptContent(
  text: string,
  attachments: readonly ConfinedAttachment[] | undefined,
  promptCaps: PromptDegradeCaps,
): BuildPromptContentResult {
  const blocks: AcpOutboundContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  let droppedCount = 0;
  for (const attachment of attachments ?? []) {
    const block = attachmentToContentBlock(attachment, promptCaps);
    if (block) {
      blocks.push(block);
      continue;
    }
    // L2-CA-25: `attachmentToContentBlock` returns `undefined` from exactly
    // two situations, both reachable only once `attachment.path` is absent
    // (a present path always resolves to a `resource_link`, never
    // `undefined`) — (1) `attachment.dataUri` was present but genuinely
    // unparseable/unreadable (a REAL drop, worth counting), or (2) the
    // attachment carried NEITHER a `dataUri` NOR a `path` at all (the golden
    // "ghost" case, characterized by `attachments.test.ts`'s "skips an
    // attachment with neither a path nor a data URI" — there was nothing to
    // read, so this is an intentional non-attachment skip, not a drop).
    // `attachment.dataUri !== undefined` is exactly the discriminator: only
    // case (1) had a data URI in hand that failed to become a block.
    if (attachment.dataUri !== undefined) droppedCount++;
  }
  return { blocks, droppedCount };
}

function attachmentToContentBlock(
  attachment: Attachment,
  promptCaps: PromptDegradeCaps,
): AcpOutboundContentBlock | undefined {
  const parsed = attachment.dataUri ? parseDataUri(attachment.dataUri) : undefined;

  if (attachment.kind === 'image') {
    if (parsed) return { type: 'image', data: parsed.base64, mimeType: parsed.mime };
    if (attachment.path) {
      return {
        type: 'resource_link',
        uri: pathToFileUri(attachment.path),
        name: attachment.name,
        ...(attachment.mime !== undefined ? { mimeType: attachment.mime } : {}),
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
      ...(attachment.mime !== undefined ? { mimeType: attachment.mime } : {}),
    };
  }
  if (parsed) {
    const uri = `attachment://${attachment.id}/${encodeURIComponent(attachment.name)}`;
    if (isTextMime(parsed.mime)) {
      const text = Buffer.from(parsed.base64, 'base64').toString('utf8');
      if (promptCaps.degradeEmbeddedResources) {
        // A-03 degrade (INACTIVE vs pinned Hermes — promptCaps.ts): the
        // decoded text still reaches the agent, as a plain text block
        // headed by the attachment name (no on-disk path exists to link).
        return { type: 'text', text: `[attachment: ${attachment.name}]\n${text}` };
      }
      return { type: 'resource', resource: { uri, mimeType: parsed.mime, text } };
    }
    if (promptCaps.degradeEmbeddedResources) {
      // A-03 degrade: binary bytes have no text form — a resource_link to
      // the synthetic attachment uri is the best remaining reference
      // (fidelity loss is exactly why this path ships inactive).
      return { type: 'resource_link', uri, name: attachment.name, mimeType: parsed.mime };
    }
    return { type: 'resource', resource: { uri, mimeType: parsed.mime, blob: parsed.base64 } };
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

/**
 * L2-CA-25: RFC 2397-tolerant data-URI parse. The prior regex
 * (`/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/s`) hard-required
 * exactly `data:<type>[;charset=…];base64,<payload>` — an extra media-type
 * param (`;name=…`), a non-base64 (percent-encoded) payload, or the
 * `data:,` shorthand all failed to match and were silently DROPPED with no
 * signal (the finding this fixes). This version accepts the general RFC
 * 2397 grammar: an optional mime type, zero or more `;param` segments (ANY
 * of which may be the bare `base64` flag, in any position), a comma, then
 * the payload — non-base64 payloads are percent-decoded then re-encoded to
 * base64 so the return shape stays `{mime, base64}` unchanged for callers.
 */
function parseDataUri(dataUri: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUri);
  if (!match) return undefined;
  const mimeRaw = match[1];
  const paramsRaw = match[2];
  const payload = match[3];
  if (mimeRaw === undefined || paramsRaw === undefined || payload === undefined) {
    // Unreachable: all three capture groups are non-optional in the pattern
    // (no alternation), so a successful match always captures all three.
    return undefined;
  }
  const mime = mimeRaw || 'text/plain';
  const isBase64 = paramsRaw.split(';').some((param) => param === 'base64');
  if (isBase64) return { mime, base64: payload };
  try {
    return { mime, base64: Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64') };
  } catch (err: unknown) {
    // A malformed percent-encoded payload (e.g. a truncated `%A` escape)
    // throws `URIError` from `decodeURIComponent` — caught here and turned
    // into a drop (the caller counts it), never left to propagate out of
    // `buildPromptContent` and abort the rest of the turn (critic M-5).
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

/** The confine primitive's shape (`resolveWithinWorkspaceReal`'s signature) — injected so tests stay headless, mirroring `context/resolver.ts`'s `ConfineFn`. */
export type AttachmentConfineFn = (path: string, roots: readonly string[]) => Promise<string | null>;

export interface ConfineAttachmentsResult {
  attachments: ConfinedAttachment[];
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
  const kept: ConfinedAttachment[] = [];
  let droppedCount = 0;
  for (const attachment of attachments) {
    if (!attachment.path) {
      kept.push(attachment as ConfinedAttachment); // blessed: no fs reference to confine
      continue;
    }
    const canonical = await confine(attachment.path, workspaceRoots);
    if (canonical === null || isSecretPath(canonical)) {
      droppedCount++;
      continue;
    }
    kept.push((canonical === attachment.path ? attachment : { ...attachment, path: canonical }) as ConfinedAttachment);
  }
  return { attachments: kept, droppedCount };
}

/**
 * CA-M02 (WS-AC): RFC-3986-safe `file://` URI from a (confined) filesystem
 * path — per-segment `encodeURIComponent`, restoring `:` (legal in path
 * segments; keeps `C:` drive prefixes intact). Deliberately NOT
 * `node:url.pathToFileURL`: that resolves through the HOST platform's path
 * rules, so the same input produces different URIs on the Windows dev gate
 * vs Linux CI — this must stay platform-deterministic (repo lesson: never
 * per-arch behavior in gate-covered code). Inputs that already look like
 * URIs pass through untouched, as before.
 */
function pathToFileUri(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  const rooted = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encoded = rooted
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
  return `file://${encoded}`;
}
