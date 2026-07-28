import { describe, it, expect } from 'vitest';
import { diffIdentityFromDiffTabInput } from './diffDecision';

describe('diffIdentityFromDiffTabInput — W4-T3b: pure (sessionId, toolId) extraction from a diff tab\'s URIs', () => {
  it('extracts the (sessionId, toolId) from the "modified" side', () => {
    expect(
      diffIdentityFromDiffTabInput({
        original: { scheme: 'hermes-diff', authority: 'before', path: '/session-1/tool-1/src/a.ts' },
        modified: { scheme: 'hermes-diff', authority: 'after', path: '/session-1/tool-1/src/a.ts' },
      }),
    ).toEqual({ sessionId: 'session-1', toolId: 'tool-1' });
  });

  it('falls back to the "original" side when modified is absent', () => {
    expect(
      diffIdentityFromDiffTabInput({
        original: { scheme: 'hermes-diff', authority: 'before', path: '/session-1/tool-1/src/a.ts' },
      }),
    ).toEqual({ sessionId: 'session-1', toolId: 'tool-1' });
  });

  it('returns undefined when neither side is a hermes-diff: URI (an ordinary file compare tab)', () => {
    expect(
      diffIdentityFromDiffTabInput({
        original: { scheme: 'file', authority: '', path: '/repo/a.ts' },
        modified: { scheme: 'file', authority: '', path: '/repo/b.ts' },
      }),
    ).toBeUndefined();
  });

  it('returns undefined for undefined/empty input', () => {
    expect(diffIdentityFromDiffTabInput(undefined)).toBeUndefined();
    expect(diffIdentityFromDiffTabInput({})).toBeUndefined();
  });

  it('returns undefined when the URIs disagree on toolId (malformed/tampered — fail closed, not "pick one")', () => {
    expect(
      diffIdentityFromDiffTabInput({
        original: { scheme: 'hermes-diff', authority: 'before', path: '/session-1/tool-1/a.ts' },
        modified: { scheme: 'hermes-diff', authority: 'after', path: '/session-1/tool-2/a.ts' },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when the URIs disagree on sessionId (fail closed)', () => {
    expect(
      diffIdentityFromDiffTabInput({
        original: { scheme: 'hermes-diff', authority: 'before', path: '/session-1/tool-1/a.ts' },
        modified: { scheme: 'hermes-diff', authority: 'after', path: '/session-2/tool-1/a.ts' },
      }),
    ).toBeUndefined();
  });
});
