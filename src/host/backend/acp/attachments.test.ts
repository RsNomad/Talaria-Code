import { describe, it, expect } from 'vitest';
import { buildPromptContent, confineAttachmentPaths } from './attachments';
import type { AttachmentConfineFn } from './attachments';
import { derivePromptCaps, PROMPT_DEGRADE_INACTIVE, type PromptDegradeCaps } from './promptCaps';
import type { Attachment } from '../../../shared/protocol';
import type { ConfinedAttachment } from './attachments';

/** Test-local blessing: unit fixtures did not pass through confineAttachmentPaths. */
const asConfined = (a: Attachment[]): ConfinedAttachment[] => a as ConfinedAttachment[];

const INACTIVE = PROMPT_DEGRADE_INACTIVE;
const ACTIVE: PromptDegradeCaps = { degradeEmbeddedResources: true };

describe('buildPromptContent', () => {
  it('always leads with a text block when text is non-empty', () => {
    expect(buildPromptContent('hello', undefined, INACTIVE).blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('omits the text block for empty text', () => {
    expect(buildPromptContent('', undefined, INACTIVE).blocks).toEqual([]);
  });

  it('maps an image attachment with a data URI to an image content block', () => {
    const { blocks } = buildPromptContent('look', asConfined([
      { id: 'a1', name: 'shot.png', kind: 'image', dataUri: 'data:image/png;base64,QUJD' },
    ]), INACTIVE);
    expect(blocks).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
  });

  it('maps a path-only image attachment to a resource_link', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'a2', name: 'shot.png', kind: 'image', path: '/repo/shot.png', mime: 'image/png' },
    ]), INACTIVE);
    expect(blocks).toEqual([{ type: 'resource_link', uri: 'file:///repo/shot.png', name: 'shot.png', mimeType: 'image/png' }]);
  });

  it('maps a file attachment with a workspace path to a resource_link', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'a3', name: 'notes.txt', kind: 'file', path: '/repo/notes.txt', mime: 'text/plain' },
    ]), INACTIVE);
    expect(blocks).toEqual([
      { type: 'resource_link', uri: 'file:///repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
    ]);
  });

  it('maps a pdf attachment with only inline bytes to an embedded resource', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'a4', name: 'doc.pdf', kind: 'pdf', mime: 'application/pdf', dataUri: 'data:application/pdf;base64,ZmFr' },
    ]), INACTIVE);
    expect(blocks).toEqual([
      {
        type: 'resource',
        resource: { uri: 'attachment://a4/doc.pdf', mimeType: 'application/pdf', blob: 'ZmFr' },
      },
    ]);
  });

  it('skips an attachment with neither a path nor a data URI — an intentional non-attachment skip, NOT counted as a drop', () => {
    const result = buildPromptContent('', asConfined([{ id: 'a5', name: 'ghost.txt', kind: 'file' }]), INACTIVE);
    expect(result.blocks).toEqual([]);
    expect(result.droppedCount).toBe(0);
  });

  it('maps a path-less generic text file to an embedded resource with decoded text (no blob)', () => {
    // base64 of "a,b\n1,2"
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'a6', name: 'data.csv', kind: 'file', mime: 'text/csv', dataUri: 'data:text/csv;base64,YSxiCjEsMg==' },
    ]), INACTIVE);
    expect(blocks).toEqual([
      {
        type: 'resource',
        resource: { uri: 'attachment://a6/data.csv', mimeType: 'text/csv', text: 'a,b\n1,2' },
      },
    ]);
  });

  it('maps a path-less generic binary file to an embedded resource with a blob (no text)', () => {
    const { blocks } = buildPromptContent('', asConfined([
      {
        id: 'a7',
        name: 'archive.bin',
        kind: 'file',
        mime: 'application/octet-stream',
        dataUri: 'data:application/octet-stream;base64,ZmFr',
      },
    ]), INACTIVE);
    expect(blocks).toEqual([
      {
        type: 'resource',
        resource: { uri: 'attachment://a7/archive.bin', mimeType: 'application/octet-stream', blob: 'ZmFr' },
      },
    ]);
  });
});

/**
 * A-03 (WS-AC): the degrade seam. INACTIVE reproduces today's embedded-
 * resource emission byte-for-byte against pinned Hermes's advertised caps
 * (`derivePromptCaps({ image: true })` — `acp_adapter/server.py:889`) —
 * that IS the ship-inactive characterization. ACTIVE (unit-tested in
 * isolation; nothing wires it live yet — see `promptCaps.ts`'s activation
 * contract) proves the degrade path itself is correct.
 */
describe('WS-AC A-03: the degrade seam — inactive is byte-identical, active degrades', () => {
  it('CHARACTERIZATION: derivePromptCaps(pinned-Hermes caps) keeps embedded resources exactly as before', () => {
    const caps = derivePromptCaps({ image: true });
    const { blocks } = buildPromptContent('t', asConfined([
      { id: 'a', name: 'inline.txt', kind: 'file', dataUri: 'data:text/plain;base64,aGV5' },
    ]), caps);
    expect(blocks).toEqual([
      { type: 'text', text: 't' },
      { type: 'resource', resource: { uri: 'attachment://a/inline.txt', mimeType: 'text/plain', text: 'hey' } },
    ]);
  });

  it('ACTIVE: a text-mime inline attachment degrades to a plain text block (content preserved)', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'a', name: 'inline.txt', kind: 'file', dataUri: 'data:text/plain;base64,aGV5' },
    ]), ACTIVE);
    expect(blocks).toEqual([{ type: 'text', text: '[attachment: inline.txt]\nhey' }]);
  });

  it('ACTIVE: a binary inline attachment degrades to a resource_link at the synthetic uri', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'b', name: 'pic.bin', kind: 'file', dataUri: 'data:application/octet-stream;base64,QUJD' },
    ]), ACTIVE);
    expect(blocks).toEqual([
      { type: 'resource_link', uri: 'attachment://b/pic.bin', name: 'pic.bin', mimeType: 'application/octet-stream' },
    ]);
  });

  it('ACTIVE: path-backed and image attachments are untouched by the degrade (already link/image form)', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'c', name: 'notes.txt', kind: 'file', path: '/repo/notes.txt', mime: 'text/plain' },
      { id: 'd', name: 'shot.png', kind: 'image', dataUri: 'data:image/png;base64,QUJD' },
    ]), ACTIVE);
    expect(blocks).toEqual([
      { type: 'resource_link', uri: 'file:///repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
  });
});

/**
 * V-19: `Attachment.path` was unconfined — `buildPromptContent` built a
 * `file:` URI straight from webview-supplied `path` with none of the
 * confinement the sibling mention path gets (`context/resolver.ts`'s
 * `resolveFileOrFolder`: confine FIRST, secret gate SECOND, both on the
 * CONFINED canonical path). `confineAttachmentPaths` is the fix — it reuses
 * the SAME ordering/primitives so an attachment whose path resolves outside
 * every workspace root, or whose canonical path is secret-classified, is
 * DROPPED before it ever reaches `buildPromptContent`.
 */
describe('confineAttachmentPaths — V-19 attachment path confinement', () => {
  /** Allows anything rooted at `/workspace`, denies everything else — mirrors
   *  `resolver.test.ts`'s `allowWorkspaceConfine` fake. */
  const allowWorkspaceConfine: AttachmentConfineFn = async (path) => (path.startsWith('/workspace') ? path : null);
  const denyConfine: AttachmentConfineFn = async () => null;

  it('RED: an attachment whose path resolves OUTSIDE every workspace root is dropped (droppedCount=1)', async () => {
    const attachment = { id: 'a1', name: 'notes.txt', kind: 'file' as const, path: '/outside/notes.txt' };

    const result = await confineAttachmentPaths([attachment], ['/workspace'], denyConfine);

    expect(result.attachments).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it('RED: an in-workspace, non-secret attachment is KEPT, with `.path` rewritten to the confined canonical path', async () => {
    const attachment = { id: 'a2', name: 'notes.txt', kind: 'file' as const, path: '/workspace/notes.txt' };

    const result = await confineAttachmentPaths([attachment], ['/workspace'], allowWorkspaceConfine);

    expect(result.droppedCount).toBe(0);
    expect(result.attachments).toEqual([attachment]);
  });

  it(
    'RED ORDERING: the secret gate runs on the CONFINED canonical path, not the raw one — a raw path that does not ' +
      'look secret is still dropped when confine resolves it to a secret-classified canonical path (e.g. a symlink)',
    async () => {
      const resolvesToSecret: AttachmentConfineFn = async () => '/workspace/.env';
      const attachment = { id: 'a3', name: 'innocuous-link', kind: 'file' as const, path: '/workspace/innocuous-link' };

      const result = await confineAttachmentPaths([attachment], ['/workspace'], resolvesToSecret);

      expect(result.attachments).toEqual([]);
      expect(result.droppedCount).toBe(1);
    },
  );

  it('RED: a secret-classified in-workspace attachment path is dropped', async () => {
    const attachment = { id: 'a4', name: '.env', kind: 'file' as const, path: '/workspace/.env' };

    const result = await confineAttachmentPaths([attachment], ['/workspace'], allowWorkspaceConfine);

    expect(result.attachments).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it('RED: attachments with NO path (dataUri-only) bypass confinement entirely — confine is never called for them', async () => {
    const confine: AttachmentConfineFn = async () => {
      throw new Error('confine must not be called for a path-less attachment');
    };
    const attachment = { id: 'a5', name: 'shot.png', kind: 'image' as const, dataUri: 'data:image/png;base64,QUJD' };

    const result = await confineAttachmentPaths([attachment], ['/workspace'], confine);

    expect(result.attachments).toEqual([attachment]);
    expect(result.droppedCount).toBe(0);
  });

  it('RED: droppedCount accumulates across multiple dropped attachments in a mixed batch', async () => {
    const attachments = [
      { id: 'a6', name: 'ok.txt', kind: 'file' as const, path: '/workspace/ok.txt' },
      { id: 'a7', name: 'outside.txt', kind: 'file' as const, path: '/outside/outside.txt' },
      { id: 'a8', name: '.env', kind: 'file' as const, path: '/workspace/.env' },
    ];

    const result = await confineAttachmentPaths(attachments, ['/workspace'], allowWorkspaceConfine);

    expect(result.attachments).toEqual([attachments[0]]);
    expect(result.droppedCount).toBe(2);
  });
});

describe('CA-M02 (WS-AC): file:// URIs are percent-encoded per segment', () => {
  it('CHARACTERIZATION: plain paths are unchanged (existing pins stay byte-identical)', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'p1', name: 'notes.txt', kind: 'file', path: '/repo/notes.txt', mime: 'text/plain' },
    ]), INACTIVE);
    expect(blocks).toEqual([
      { type: 'resource_link', uri: 'file:///repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
    ]);
  });

  it('encodes spaces and # (a raw # would truncate the path into a fragment)', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'p2', name: 'a b#c.txt', kind: 'file', path: '/repo/a b#c.txt', mime: 'text/plain' },
    ]), INACTIVE);
    expect(blocks).toEqual([
      { type: 'resource_link', uri: 'file:///repo/a%20b%23c.txt', name: 'a b#c.txt', mimeType: 'text/plain' },
    ]);
  });

  it('encodes a literal % so it cannot mis-decode', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'p3', name: '100%.txt', kind: 'file', path: '/repo/100%.txt', mime: 'text/plain' },
    ]), INACTIVE);
    expect(blocks[0]).toMatchObject({ uri: 'file:///repo/100%25.txt' });
  });

  it('encodes non-ASCII as UTF-8 percent-escapes', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'p4', name: '文.txt', kind: 'file', path: '/repo/文.txt', mime: 'text/plain' },
    ]), INACTIVE);
    expect(blocks[0]).toMatchObject({ uri: 'file:///repo/%E6%96%87.txt' });
  });

  it('a Windows drive path keeps its colon and forward-slashes', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'p5', name: 'f.txt', kind: 'file', path: 'C:\\w s\\f.txt', mime: 'text/plain' },
    ]), INACTIVE);
    expect(blocks[0]).toMatchObject({ uri: 'file:///C:/w%20s/f.txt' });
  });

  it('an input that is already a URI passes through untouched (existing early-return)', () => {
    const { blocks } = buildPromptContent('', asConfined([
      { id: 'p6', name: 'x', kind: 'file', path: 'https://example.com/a b', mime: 'text/plain' },
    ]), INACTIVE);
    expect(blocks[0]).toMatchObject({ uri: 'https://example.com/a b' });
  });
});

describe('CA-M03 (WS-AC): the ConfinedAttachment brand', () => {
  it('a raw Attachment[] is a COMPILE error at buildPromptContent', () => {
    const raw: Attachment[] = [{ id: 'x', name: 'n', kind: 'file', path: '/repo/n' }];
    // @ts-expect-error — unconfined attachments must not reach the builder (V-19 brand)
    void buildPromptContent('t', raw, INACTIVE);
    expect(true).toBe(true);
  });

  it('confineAttachmentPaths output feeds buildPromptContent without casts (the blessing point)', async () => {
    const confine: AttachmentConfineFn = async (p) => p;
    const { attachments } = await confineAttachmentPaths(
      [{ id: 'a', name: 'n.txt', kind: 'file', path: '/w/n.txt', mime: 'text/plain' }],
      ['/w'],
      confine,
    );
    const { blocks } = buildPromptContent('', attachments, INACTIVE);
    expect(blocks).toHaveLength(1);
  });
});

/**
 * WS-R1 R1-5 (L2-CA-25 🔵): `parseDataUri`'s strict regex
 * (`/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/s`) silently DROPPED any
 * data URI with extra media-type params (`;name=…`), a non-base64
 * (percent-encoded) payload, or the `data:,` shorthand — no log, no user
 * signal, the attachment just vanished from `session/prompt`. The tolerant
 * replacement (`/^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s`) parses all three; a
 * genuinely unparseable data URI (no comma, or a malformed percent-encoded
 * payload) is now COUNTED via `buildPromptContent`'s `droppedCount` so
 * `runTurn` can tell the user how many were dropped — see the "skips an
 * attachment with neither a path nor a data URI" golden above for the ONE
 * `undefined` that must NEVER be counted (no data URI at all is not a parse
 * failure, it is an intentional non-attachment skip).
 */
describe('WS-R1 R1-5 (L2-CA-25): RFC 2397-tolerant data-URI parse; unreadable attachments are counted', () => {
  it('tolerates an extra media-type param before `;base64,` (e.g. `;name=…`) — not counted as a drop', () => {
    const result = buildPromptContent('', asConfined([
      { id: 'r1', name: 'n.txt', kind: 'image', dataUri: 'data:text/plain;name=n.txt;base64,QUJD' },
    ]), INACTIVE);
    expect(result.blocks).toEqual([{ type: 'image', data: 'QUJD', mimeType: 'text/plain' }]);
    expect(result.droppedCount).toBe(0);
  });

  it('tolerates a non-base64 (percent-encoded) payload, re-encoding the decoded UTF-8 as base64 — not counted as a drop', () => {
    const result = buildPromptContent('', asConfined([
      { id: 'r2', name: 'n.txt', kind: 'image', dataUri: 'data:text/plain,hello%20world' },
    ]), INACTIVE);
    expect(result.blocks).toEqual([{ type: 'image', data: 'aGVsbG8gd29ybGQ=', mimeType: 'text/plain' }]);
    expect(result.droppedCount).toBe(0);
  });

  it('tolerates the `data:,` shorthand, defaulting the mime to text/plain — not counted as a drop', () => {
    const result = buildPromptContent('', asConfined([
      { id: 'r3', name: 'n.txt', kind: 'image', dataUri: 'data:,x' },
    ]), INACTIVE);
    expect(result.blocks).toEqual([{ type: 'image', data: 'eA==', mimeType: 'text/plain' }]);
    expect(result.droppedCount).toBe(0);
  });

  it('a data URI with no comma at all is genuinely unparseable — dropped AND counted', () => {
    const result = buildPromptContent('', asConfined([
      { id: 'r4', name: 'n.txt', kind: 'file', dataUri: 'data:garbage' },
    ]), INACTIVE);
    expect(result.blocks).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it('a malformed percent-encoded payload throws URIError inside the parse — caught, dropped, counted, and buildPromptContent itself never throws', () => {
    const result = buildPromptContent('', asConfined([
      { id: 'r5', name: 'n.txt', kind: 'file', dataUri: 'data:,%E0%A4%A' },
    ]), INACTIVE);
    expect(result.blocks).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it('droppedCount accumulates across a mixed batch of a genuine drop and an intentional non-attachment skip (only the genuine drop counts)', () => {
    const result = buildPromptContent('', asConfined([
      { id: 'r6', name: 'bad.txt', kind: 'file', dataUri: 'data:garbage' },
      { id: 'r7', name: 'ghost.txt', kind: 'file' },
      { id: 'r8', name: 'ok.txt', kind: 'image', dataUri: 'data:image/png;base64,QUJD' },
    ]), INACTIVE);
    expect(result.blocks).toEqual([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }]);
    expect(result.droppedCount).toBe(1);
  });
});
