import { describe, it, expect } from 'vitest';
import { buildPromptContent, confineAttachmentPaths } from './attachments';
import type { AttachmentConfineFn } from './attachments';

describe('buildPromptContent', () => {
  it('always leads with a text block when text is non-empty', () => {
    expect(buildPromptContent('hello', undefined)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('omits the text block for empty text', () => {
    expect(buildPromptContent('', undefined)).toEqual([]);
  });

  it('maps an image attachment with a data URI to an image content block', () => {
    const blocks = buildPromptContent('look', [
      { id: 'a1', name: 'shot.png', kind: 'image', dataUri: 'data:image/png;base64,QUJD' },
    ]);
    expect(blocks).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
  });

  it('maps a path-only image attachment to a resource_link', () => {
    const blocks = buildPromptContent('', [
      { id: 'a2', name: 'shot.png', kind: 'image', path: '/repo/shot.png', mime: 'image/png' },
    ]);
    expect(blocks).toEqual([{ type: 'resource_link', uri: 'file:///repo/shot.png', name: 'shot.png', mimeType: 'image/png' }]);
  });

  it('maps a file attachment with a workspace path to a resource_link', () => {
    const blocks = buildPromptContent('', [
      { id: 'a3', name: 'notes.txt', kind: 'file', path: '/repo/notes.txt', mime: 'text/plain' },
    ]);
    expect(blocks).toEqual([
      { type: 'resource_link', uri: 'file:///repo/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
    ]);
  });

  it('maps a pdf attachment with only inline bytes to an embedded resource', () => {
    const blocks = buildPromptContent('', [
      { id: 'a4', name: 'doc.pdf', kind: 'pdf', mime: 'application/pdf', dataUri: 'data:application/pdf;base64,ZmFr' },
    ]);
    expect(blocks).toEqual([
      {
        type: 'resource',
        resource: { uri: 'attachment://a4/doc.pdf', mimeType: 'application/pdf', blob: 'ZmFr' },
      },
    ]);
  });

  it('skips an attachment with neither a path nor a data URI', () => {
    expect(buildPromptContent('', [{ id: 'a5', name: 'ghost.txt', kind: 'file' }])).toEqual([]);
  });

  it('maps a path-less generic text file to an embedded resource with decoded text (no blob)', () => {
    // base64 of "a,b\n1,2"
    const blocks = buildPromptContent('', [
      { id: 'a6', name: 'data.csv', kind: 'file', mime: 'text/csv', dataUri: 'data:text/csv;base64,YSxiCjEsMg==' },
    ]);
    expect(blocks).toEqual([
      {
        type: 'resource',
        resource: { uri: 'attachment://a6/data.csv', mimeType: 'text/csv', text: 'a,b\n1,2' },
      },
    ]);
  });

  it('maps a path-less generic binary file to an embedded resource with a blob (no text)', () => {
    const blocks = buildPromptContent('', [
      {
        id: 'a7',
        name: 'archive.bin',
        kind: 'file',
        mime: 'application/octet-stream',
        dataUri: 'data:application/octet-stream;base64,ZmFr',
      },
    ]);
    expect(blocks).toEqual([
      {
        type: 'resource',
        resource: { uri: 'attachment://a7/archive.bin', mimeType: 'application/octet-stream', blob: 'ZmFr' },
      },
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
