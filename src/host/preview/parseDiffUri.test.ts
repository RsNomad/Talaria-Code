import { describe, it, expect } from 'vitest';
import { parseDiffUri, buildDiffUriParts } from './parseDiffUri';

/** Minimal structural stand-in for `vscode.Uri` — `parseDiffUri` is pure and
 * headless-tested, so it must accept this shape without importing `vscode`. */
function uri(scheme: string, authority: string, path: string): { scheme: string; authority: string; path: string } {
  return { scheme, authority, path };
}

describe('parseDiffUri — W2 T4 F-D: pure hermes-diff: URI parser', () => {
  it('parses a well-formed "before" URI', () => {
    expect(parseDiffUri(uri('hermes-diff', 'before', '/session-1/tool-1/src/a.ts'))).toEqual({
      side: 'before',
      sessionId: 'session-1',
      toolId: 'tool-1',
      path: 'src/a.ts',
    });
  });

  it('parses a well-formed "after" URI', () => {
    expect(parseDiffUri(uri('hermes-diff', 'after', '/session-1/tool-1/src/a.ts'))).toEqual({
      side: 'after',
      sessionId: 'session-1',
      toolId: 'tool-1',
      path: 'src/a.ts',
    });
  });

  it('preserves interior slashes in the path (nested directories)', () => {
    expect(parseDiffUri(uri('hermes-diff', 'before', '/session-1/tool-1/src/deep/nested/file.ts'))).toEqual({
      side: 'before',
      sessionId: 'session-1',
      toolId: 'tool-1',
      path: 'src/deep/nested/file.ts',
    });
  });

  it('rejects a wrong scheme', () => {
    expect(parseDiffUri(uri('file', 'before', '/session-1/tool-1/src/a.ts'))).toBeNull();
  });

  it('rejects an authority that is neither "before" nor "after" (oracle-y side smuggling)', () => {
    expect(parseDiffUri(uri('hermes-diff', 'sideways', '/session-1/tool-1/src/a.ts'))).toBeNull();
  });

  it('rejects a missing sessionId segment', () => {
    expect(parseDiffUri(uri('hermes-diff', 'before', '/'))).toBeNull();
    expect(parseDiffUri(uri('hermes-diff', 'before', ''))).toBeNull();
  });

  it('rejects a missing toolId segment', () => {
    expect(parseDiffUri(uri('hermes-diff', 'before', '/session-1'))).toBeNull();
    expect(parseDiffUri(uri('hermes-diff', 'before', '/session-1/'))).toBeNull();
  });

  it('rejects a toolId with no path segment after it', () => {
    expect(parseDiffUri(uri('hermes-diff', 'before', '/session-1/tool-1'))).toBeNull();
    expect(parseDiffUri(uri('hermes-diff', 'before', '/session-1/tool-1/'))).toBeNull();
  });

  it('rejects an empty sessionId segment (a lone leading "//" collapsing it to empty)', () => {
    expect(parseDiffUri(uri('hermes-diff', 'before', '//tool-1/src/a.ts'))).toBeNull();
  });

  it('rejects an empty toolId segment between two slashes', () => {
    expect(parseDiffUri(uri('hermes-diff', 'before', '/session-1//src/a.ts'))).toBeNull();
  });

  it('is a pure structural function — never throws on garbage input shapes', () => {
    expect(() => parseDiffUri(uri('', '', ''))).not.toThrow();
    expect(parseDiffUri(uri('', '', ''))).toBeNull();
  });
});

describe('buildDiffUriParts — W2 T4 F-D: pure hermes-diff: URI builder (parseDiffUri\'s inverse)', () => {
  it('builds the {scheme, authority, path} parts for a "before" URI', () => {
    expect(buildDiffUriParts('before', 'session-1', 'tool-1', 'src/a.ts')).toEqual({
      scheme: 'hermes-diff',
      authority: 'before',
      path: '/session-1/tool-1/src/a.ts',
    });
  });

  it('builds the {scheme, authority, path} parts for an "after" URI', () => {
    expect(buildDiffUriParts('after', 'session-1', 'tool-1', 'src/a.ts')).toEqual({
      scheme: 'hermes-diff',
      authority: 'after',
      path: '/session-1/tool-1/src/a.ts',
    });
  });

  it('round-trips through parseDiffUri for a variety of sessionId/toolId/path values', () => {
    const cases: Array<['before' | 'after', string, string, string]> = [
      ['before', 'session-1', 'tool-1', 'a.ts'],
      ['after', 'session-2', 'edit-42', 'src/deep/nested/file.ts'],
      ['before', 'session-3', 'appr-abc123', 'a b/c.ts'], // spaces are legal in a workspace-relative path
    ];
    for (const [side, sessionId, toolId, path] of cases) {
      expect(parseDiffUri(buildDiffUriParts(side, sessionId, toolId, path))).toEqual({ side, sessionId, toolId, path });
    }
  });
});
