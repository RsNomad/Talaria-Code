/*
 * RED-first tests for `describeMention` — the pure view derivation behind
 * the composer's `Pill` mention chips. Chips are rendered from
 * `parseMentions(text)` on every change (§2b: chips are a VIEW, never a
 * tracked side-array) — this module is the last pure step, turning one
 * `ContextRef` into display strings.
 */
import { describe, it, expect } from 'vitest';
import { describeMention } from './mentionChip';
import type { ContextRef } from '../protocol';

describe('describeMention — singleton kinds use the mention catalog label/icon', () => {
  it('describes @problems', () => {
    expect(describeMention({ id: 'problems', kind: 'problems' })).toEqual({
      icon: 'warning',
      text: 'Problems',
      title: 'Problems',
    });
  });

  it('describes @git', () => {
    expect(describeMention({ id: 'git', kind: 'git' })).toEqual({
      icon: 'git-commit',
      text: 'Git',
      title: 'Git',
    });
  });
});

describe('describeMention — file/folder refs show the path basename, title carries the full path', () => {
  it('describes a @file ref with a nested POSIX path', () => {
    const ref: ContextRef = { id: 'file:src/components/Composer.tsx', kind: 'file', path: 'src/components/Composer.tsx' };
    expect(describeMention(ref)).toEqual({
      icon: 'file',
      text: 'Composer.tsx',
      title: 'File: src/components/Composer.tsx',
    });
  });

  it('describes a @folder ref', () => {
    const ref: ContextRef = { id: 'folder:src/components', kind: 'folder', path: 'src/components' };
    expect(describeMention(ref)).toEqual({
      icon: 'folder',
      text: 'components',
      title: 'Folder: src/components',
    });
  });

  it('handles a Windows-separated path', () => {
    const ref: ContextRef = { id: 'file:src\\a.ts', kind: 'file', path: 'src\\a.ts' };
    expect(describeMention(ref)).toEqual({ icon: 'file', text: 'a.ts', title: 'File: src\\a.ts' });
  });

  it('a bare filename with no directory component shows itself', () => {
    const ref: ContextRef = { id: 'file:README.md', kind: 'file', path: 'README.md' };
    expect(describeMention(ref)).toEqual({ icon: 'file', text: 'README.md', title: 'File: README.md' });
  });
});
