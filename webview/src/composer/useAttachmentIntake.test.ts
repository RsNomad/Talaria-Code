/*
 * Truth-table tests for the file-shape pure helpers extracted from
 * Composer.tsx into `useAttachmentIntake.ts` (WS-F5 F5-4, FI-05 part 2/2 +
 * close). These functions had ZERO direct unit coverage before this move —
 * the four Composer DOM suites only ever exercised them indirectly, through
 * a full render + simulated file/drag/paste event. Node 24's global `File`
 * makes them directly testable here, in the `webview-pure` (node-env)
 * vitest project, with no jsdom needed.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveMime,
  kindOf,
  maxInlineBytes,
  fileUriToFsPath,
  MAX_FILE_BYTES,
  MAX_MEDIA_BYTES,
} from './useAttachmentIntake';

describe('resolveMime — the file-shape MIME resolver', () => {
  it("a file's own non-empty type wins outright, regardless of extension", () => {
    const file = new File(['{}'], 'weird.bin', { type: 'application/zip' });
    expect(resolveMime(file)).toBe('application/zip');
  });

  it("falls back to the extension table for a known text-ish extension the browser reports as ''", () => {
    const file = new File(['# notes'], 'notes.md');
    expect(file.type).toBe('');
    expect(resolveMime(file)).toBe('text/markdown');
  });

  it('an unrecognized extension falls to the binary default', () => {
    const file = new File(['data'], 'archive.xyz');
    expect(resolveMime(file)).toBe('application/octet-stream');
  });

  it('a name with no real extension (trailing dot, empty ext segment) also falls to the binary default', () => {
    const file = new File(['data'], 'notes.');
    expect(resolveMime(file)).toBe('application/octet-stream');
  });
});

describe('kindOf — the attachment kind classifier', () => {
  it('an image/* MIME type wins outright, regardless of extension', () => {
    const file = new File(['x'], 'photo.bin', { type: 'image/png' });
    expect(kindOf(file)).toBe('image');
  });

  it("an application/pdf MIME type is a pdf", () => {
    const file = new File(['x'], 'report.bin', { type: 'application/pdf' });
    expect(kindOf(file)).toBe('pdf');
  });

  it('a .PDF extension (case-insensitive) is a pdf even with no MIME type at all', () => {
    const file = new File(['x'], 'REPORT.PDF');
    expect(file.type).toBe('');
    expect(kindOf(file)).toBe('pdf');
  });

  it('anything else falls to a plain file', () => {
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    expect(kindOf(file)).toBe('file');
  });
});

describe('maxInlineBytes — the per-kind inline-read cap', () => {
  it('images get the loose 20 MB media cap', () => {
    expect(maxInlineBytes('image')).toBe(MAX_MEDIA_BYTES);
    expect(maxInlineBytes('image')).toBe(20 * 1024 * 1024);
  });

  it('pdfs get the same loose 20 MB media cap as images', () => {
    expect(maxInlineBytes('pdf')).toBe(MAX_MEDIA_BYTES);
  });

  it('plain files get the tight 512 KB cap', () => {
    expect(maxInlineBytes('file')).toBe(MAX_FILE_BYTES);
    expect(maxInlineBytes('file')).toBe(512 * 1024);
  });
});

describe('fileUriToFsPath — the Explorer-drag file:// decoder (CF-07)', () => {
  it('a plain file:// URI decodes to its fsPath', () => {
    expect(fileUriToFsPath('file:///a/b.ts')).toBe('/a/b.ts');
  });

  it('percent-encoded spaces AND non-ASCII (UTF-8) path segments both decode', () => {
    expect(fileUriToFsPath('file:///hello%20world/%E4%BD%A0.txt')).toBe('/hello world/你.txt');
  });

  it("an explicit 'localhost' host is a valid LOCAL alias for an empty authority", () => {
    expect(fileUriToFsPath('file://localhost/x')).toBe('/x');
  });

  it('a genuinely different, non-localhost host is a REMOTE/UNC form — rejected (uncovered before this move)', () => {
    expect(fileUriToFsPath('file://otherhost/x')).toBeUndefined();
  });

  it('a string that is not a file:// URI at all is rejected before any URL parse is attempted (uncovered before this move)', () => {
    expect(fileUriToFsPath('not-a-uri-at-all')).toBeUndefined();
    expect(fileUriToFsPath('/plain/path')).toBeUndefined();
  });

  it('a string matching the file:// prefix but unparseable by the WHATWG URL constructor is caught and rejected (uncovered before this move)', () => {
    expect(fileUriToFsPath('file://%')).toBeUndefined();
  });
});
