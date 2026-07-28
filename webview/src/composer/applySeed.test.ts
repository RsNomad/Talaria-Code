/*
 * W2 T3 (F-A code actions, §2e/§3.3) — `applySeed`, the PURE "append a
 * `composer.seed` push to the current draft" transform behind Composer's
 * seed handling. Text stays the single source of truth (T2e invariant): a
 * seed's `mentions` are rendered as their canonical `@file:<path>` tokens via
 * `formatMentionToken` so `parseMentions(text)` re-derives them on the next
 * render — there is no tracked mention side-array anywhere in this flow.
 *
 * Security posture this transform enforces structurally: its signature is
 * `(currentDraft, seed) => string` — a pure string transform with no access
 * to `onSubmit`/the bridge. It can only ever change what's IN the textarea;
 * it has no channel through which a seed could auto-submit (review-first —
 * doc §3.3 "NEVER auto-submit a seeded prompt").
 *
 * `tabId` (audit C-3) plays no role in this transform — `applySeed` never
 * reads it, only `Composer`'s effect does (to gate which tab a seed may
 * apply to) — so every seed literal below carries a placeholder `tabId`
 * purely to satisfy `ComposerSeed`'s shape.
 */
import { describe, it, expect } from 'vitest';

import { applySeed } from './applySeed';

describe('applySeed — append composer.seed to the draft (never clobber, §2e)', () => {
  it('an EMPTY draft is replaced outright by the seed text', () => {
    expect(applySeed('', { tabId: 'tab-1', text: 'Explain this code.' })).toBe('Explain this code.');
  });

  it('a NON-EMPTY draft keeps its own text and gets the seed appended (never clobbered)', () => {
    const result = applySeed('my question so far', { tabId: 'tab-1', text: 'Explain this code.' });
    expect(result).toContain('my question so far');
    expect(result).toContain('Explain this code.');
    expect(result.indexOf('my question so far')).toBeLessThan(result.indexOf('Explain this code.'));
  });

  it('inserts a separating newline when the existing draft does not already end in whitespace', () => {
    expect(applySeed('abc', { tabId: 'tab-1', text: 'def' })).toBe('abc\n\ndef');
  });

  it('does NOT insert an extra separator when the draft already ends in whitespace', () => {
    expect(applySeed('abc\n', { tabId: 'tab-1', text: 'def' })).toBe('abc\ndef');
    expect(applySeed('abc ', { tabId: 'tab-1', text: 'def' })).toBe('abc def');
  });

  it('renders a `file` mention as its canonical @file:<path> token, ahead of the seed text', () => {
    const result = applySeed('', {
      tabId: 'tab-1',
      text: 'Explain this code.',
      mentions: [{ id: 'file:src/a.ts', kind: 'file', path: 'src/a.ts' }],
    });
    expect(result).toBe('@file:src/a.ts Explain this code.');
  });

  it('renders a `folder` mention as its canonical @folder:<path> token', () => {
    const result = applySeed('', {
      tabId: 'tab-1',
      text: 'Add this for context.',
      mentions: [{ id: 'folder:src', kind: 'folder', path: 'src' }],
    });
    expect(result).toBe('@folder:src Add this for context.');
  });

  it('quotes a path containing whitespace so it round-trips through parseMentions', () => {
    const result = applySeed('', {
      tabId: 'tab-1',
      text: 'Explain this code.',
      mentions: [{ id: 'file:my file.ts', kind: 'file', path: 'my file.ts' }],
    });
    expect(result).toBe('@file:"my file.ts" Explain this code.');
  });

  it('renders multiple mentions in order, all ahead of the seed text', () => {
    const result = applySeed('', {
      tabId: 'tab-1',
      text: 'Explain these.',
      mentions: [
        { id: 'file:a.ts', kind: 'file', path: 'a.ts' },
        { id: 'file:b.ts', kind: 'file', path: 'b.ts' },
      ],
    });
    expect(result).toBe('@file:a.ts @file:b.ts Explain these.');
  });

  it('ignores non-path mention kinds (problems/selection/terminal/git have no path to render)', () => {
    const result = applySeed('', {
      tabId: 'tab-1',
      text: 'Explain this.',
      mentions: [{ id: 'problems', kind: 'problems' }],
    });
    expect(result).toBe('Explain this.');
  });

  it('omitted `mentions` renders no token at all', () => {
    expect(applySeed('', { tabId: 'tab-1', text: 'Explain this.' })).toBe('Explain this.');
  });

  it('empty `mentions` array renders no token at all', () => {
    expect(applySeed('', { tabId: 'tab-1', text: 'Explain this.', mentions: [] })).toBe('Explain this.');
  });

  it('a mention token survives re-derivation by parseMentions (round-trip proof of the T2e invariant)', async () => {
    const { parseMentions } = await import('./parseMentions');
    const result = applySeed('', {
      tabId: 'tab-1',
      text: 'Explain this code.',
      mentions: [{ id: 'file:src/a.ts', kind: 'file', path: 'src/a.ts' }],
    });
    expect(parseMentions(result)).toEqual([{ id: 'file:src/a.ts', kind: 'file', path: 'src/a.ts' }]);
  });

  it('returns only a string — never a value the caller could mistake for a submit signal', () => {
    const result = applySeed('draft so far', { tabId: 'tab-1', text: 'seed text' });
    expect(typeof result).toBe('string');
  });
});
