import { describe, it, expect } from 'vitest';
import { mentionBlocks } from './mentions';
import type { ResolvedContext } from '../../context/types';

describe('mentionBlocks', () => {
  it('returns [] for empty input', () => {
    expect(mentionBlocks([])).toEqual([]);
  });

  it('returns [] when every ref is skipped', () => {
    const resolved: ResolvedContext[] = [
      {
        ref: { id: '1', kind: 'file', path: '/repo/secret.env' },
        uri: 'file:///repo/secret.env',
        title: 'secret.env',
        skipped: { reason: 'secret', detail: 'classified as a secret path' },
      },
      {
        ref: { id: '2', kind: 'git' },
        uri: 'git://working-tree',
        title: 'git',
        skipped: { reason: 'unavailable', detail: 'no git extension' },
      },
    ];
    expect(mentionBlocks(resolved)).toEqual([]);
  });

  it('maps a link-only file ref to a bare resource_link with no bytes', () => {
    const resolved: ResolvedContext[] = [
      {
        ref: { id: '1', kind: 'file', path: '/repo/src/foo.ts' },
        uri: 'file:///repo/src/foo.ts',
        title: 'foo.ts',
        linkOnly: true,
      },
    ];
    expect(mentionBlocks(resolved)).toEqual([{ type: 'resource_link', uri: 'file:///repo/src/foo.ts', name: 'foo.ts' }]);
  });

  it('maps a link-only folder ref to a bare resource_link', () => {
    const resolved: ResolvedContext[] = [
      {
        ref: { id: '1', kind: 'folder', path: '/repo/src' },
        uri: 'file:///repo/src',
        title: 'src',
        linkOnly: true,
      },
    ];
    expect(mentionBlocks(resolved)).toEqual([{ type: 'resource_link', uri: 'file:///repo/src', name: 'src' }]);
  });

  it('maps a non-link ref with text to an embedded text/plain resource', () => {
    const resolved: ResolvedContext[] = [
      {
        ref: { id: '1', kind: 'selection' },
        uri: 'selection://active',
        title: 'selection',
        text: '```src/foo.ts:1-1\nconst x = 1;\n```',
      },
    ];
    expect(mentionBlocks(resolved)).toEqual([
      {
        type: 'resource',
        resource: { uri: 'selection://active', mimeType: 'text/plain', text: '```src/foo.ts:1-1\nconst x = 1;\n```' },
      },
    ]);
  });

  it('emits no block for a non-link ref with no text and not skipped', () => {
    const resolved: ResolvedContext[] = [{ ref: { id: '1', kind: 'terminal' }, uri: 'terminal://capture', title: 'terminal' }];
    expect(mentionBlocks(resolved)).toEqual([]);
  });

  it('maps a mixed batch: skipped dropped, link-only and embedded both emitted, in order', () => {
    const resolved: ResolvedContext[] = [
      {
        ref: { id: '1', kind: 'file', path: '/repo/a.ts' },
        uri: 'file:///repo/a.ts',
        title: 'a.ts',
        linkOnly: true,
      },
      {
        ref: { id: '2', kind: 'problems' },
        uri: 'diagnostics://workspace',
        title: 'problems',
        skipped: { reason: 'error', detail: 'diagnostics unavailable' },
      },
      {
        ref: { id: '3', kind: 'git' },
        uri: 'git://working-tree',
        title: 'git',
        text: 'staged  a.ts\n\ndiff --git ...',
      },
    ];
    expect(mentionBlocks(resolved)).toEqual([
      { type: 'resource_link', uri: 'file:///repo/a.ts', name: 'a.ts' },
      {
        type: 'resource',
        resource: { uri: 'git://working-tree', mimeType: 'text/plain', text: 'staged  a.ts\n\ndiff --git ...' },
      },
    ]);
  });
});
