/*
 * RED-first truth-table tests for the 3 derived-UI-state pure helpers
 * extracted from Composer.tsx (WS-F5 F5-1, FI-37). Each function replaces a
 * deep nested ternary at a named call site in Composer.tsx; these tables
 * pin every arm — including the precedence order a flattened switch/
 * early-return chain could otherwise silently reorder — so the extraction
 * is provably behaviour-preserving.
 */
import { describe, it, expect } from 'vitest';
import { filePickHeading, openPopupId, activeOptionOf } from './composerDerive';

describe('filePickHeading — the @file/@folder submenu heading (Composer.tsx ~:662-671)', () => {
  // Precedence, checked in this exact order: loading beats error beats
  // empty-result beats the folder/file distinction. Every row below pins one
  // arm AND, where two conditions could both apply, proves which one wins.
  it('loading beats everything, even an empty result and a folder pick', () => {
    expect(filePickHeading('loading', 0, false)).toBe('Searching…');
    expect(filePickHeading('loading', 0, true)).toBe('Searching…');
  });

  it('loading beats a non-empty result too', () => {
    expect(filePickHeading('loading', 5, true)).toBe('Searching…');
    expect(filePickHeading('loading', 5, false)).toBe('Searching…');
  });

  it('error beats an empty result and a folder pick (but loses to loading)', () => {
    expect(filePickHeading('error', 0, false)).toBe('Search failed');
    expect(filePickHeading('error', 0, true)).toBe('Search failed');
  });

  it('error beats a non-empty result too', () => {
    expect(filePickHeading('error', 5, true)).toBe('Search failed');
    expect(filePickHeading('error', 5, false)).toBe('Search failed');
  });

  it('an empty result beats the folder/file distinction (idle status)', () => {
    expect(filePickHeading('idle', 0, true)).toBe('No matches');
    expect(filePickHeading('idle', 0, false)).toBe('No matches');
  });

  it('an empty result beats the folder/file distinction (success status)', () => {
    expect(filePickHeading('success', 0, true)).toBe('No matches');
    expect(filePickHeading('success', 0, false)).toBe('No matches');
  });

  it('a non-empty folder pick reads "Folders"', () => {
    expect(filePickHeading('success', 3, true)).toBe('Folders');
    expect(filePickHeading('idle', 1, true)).toBe('Folders');
  });

  it('a non-empty file pick reads "Files"', () => {
    expect(filePickHeading('success', 3, false)).toBe('Files');
    expect(filePickHeading('idle', 1, false)).toBe('Files');
  });
});

describe('openPopupId — first-match precedence over the 3 suggest popups (Composer.tsx ~:695-701)', () => {
  it('returns undefined when no popup is open', () => {
    expect(openPopupId(false, false, false)).toBeUndefined();
  });

  it('mention alone', () => {
    expect(openPopupId(true, false, false)).toBe('mention');
  });

  it('filePick alone', () => {
    expect(openPopupId(false, true, false)).toBe('filepick');
  });

  it('slash alone', () => {
    expect(openPopupId(false, false, true)).toBe('slash');
  });

  it('mention beats filePick when both are (impossibly, in practice) true', () => {
    expect(openPopupId(true, true, false)).toBe('mention');
  });

  it('mention beats slash when both are true', () => {
    expect(openPopupId(true, false, true)).toBe('mention');
  });

  it('mention beats filePick AND slash when all three are true', () => {
    expect(openPopupId(true, true, true)).toBe('mention');
  });

  it('filePick beats slash when both are true (mention false)', () => {
    expect(openPopupId(false, true, true)).toBe('filepick');
  });
});

describe('activeOptionOf — the aria-activedescendant id for whichever popup is open (Composer.tsx ~:708-715)', () => {
  // NB the real invariant this exists to prove: 'mention' AND 'filepick' both
  // read `mentionActiveIndex` — only 'slash' reads its own `slashActiveIndex`.
  const MENTION_IDX = 2;
  const SLASH_IDX = 7;

  it('undefined popup id always yields undefined, regardless of counts', () => {
    expect(activeOptionOf(undefined, 5, 5, 5, MENTION_IDX, SLASH_IDX)).toBeUndefined();
  });

  it('mention popup with options renders using mentionActiveIndex', () => {
    expect(activeOptionOf('mention', 3, 0, 0, MENTION_IDX, SLASH_IDX)).toBe('mention-opt-2');
  });

  it('mention popup with ZERO options suppresses activedescendant (a11y count-guard)', () => {
    expect(activeOptionOf('mention', 0, 3, 3, MENTION_IDX, SLASH_IDX)).toBeUndefined();
  });

  it('filepick popup with options renders using mentionActiveIndex (NOT its own count-derived index)', () => {
    expect(activeOptionOf('filepick', 0, 3, 0, MENTION_IDX, SLASH_IDX)).toBe('filepick-opt-2');
  });

  it('filepick popup with ZERO options suppresses activedescendant (a11y count-guard)', () => {
    expect(activeOptionOf('filepick', 3, 0, 3, MENTION_IDX, SLASH_IDX)).toBeUndefined();
  });

  it('slash popup with options renders using slashActiveIndex (NOT mentionActiveIndex)', () => {
    expect(activeOptionOf('slash', 0, 0, 4, MENTION_IDX, SLASH_IDX)).toBe('slash-opt-7');
  });

  it('slash popup with ZERO options suppresses activedescendant (a11y count-guard)', () => {
    expect(activeOptionOf('slash', 3, 3, 0, MENTION_IDX, SLASH_IDX)).toBeUndefined();
  });

  it('the mention/filepick vs slash index distinction holds even with distinct index values', () => {
    // Same popup ids, swapped active indices — proves each arm reads its OWN
    // pinned source, not "whichever index happens to be passed first".
    expect(activeOptionOf('mention', 1, 0, 0, 9, 1)).toBe('mention-opt-9');
    expect(activeOptionOf('filepick', 0, 1, 0, 9, 1)).toBe('filepick-opt-9');
    expect(activeOptionOf('slash', 0, 0, 1, 9, 1)).toBe('slash-opt-1');
  });
});
