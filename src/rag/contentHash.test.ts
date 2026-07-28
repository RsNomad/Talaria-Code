import { describe, expect, it } from 'vitest';

import { diffContentHashes, hashContent } from './contentHash';

describe('hashContent', () => {
  it('is deterministic', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
  });

  it('differs for different content', () => {
    expect(hashContent('hello')).not.toBe(hashContent('world'));
  });

  it('is a 64-char hex sha256 digest', () => {
    expect(hashContent('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('diffContentHashes', () => {
  it('reports nothing for an unchanged file set', () => {
    const stored = { 'a.ts': 'hash-a' };
    const current = { 'a.ts': 'hash-a' };
    expect(diffContentHashes(current, stored)).toEqual({ toCompute: [], toDelete: [] });
  });

  it('marks a brand-new file for compute', () => {
    const stored = {};
    const current = { 'a.ts': 'hash-a' };
    expect(diffContentHashes(current, stored)).toEqual({ toCompute: ['a.ts'], toDelete: [] });
  });

  it('marks a changed-hash file for compute', () => {
    const stored = { 'a.ts': 'hash-old' };
    const current = { 'a.ts': 'hash-new' };
    expect(diffContentHashes(current, stored)).toEqual({ toCompute: ['a.ts'], toDelete: [] });
  });

  it('marks a removed file for delete', () => {
    const stored = { 'a.ts': 'hash-a', 'b.ts': 'hash-b' };
    const current = { 'a.ts': 'hash-a' };
    expect(diffContentHashes(current, stored)).toEqual({ toCompute: [], toDelete: ['b.ts'] });
  });

  it('handles a mix of unchanged, changed, new, and removed in one diff', () => {
    const stored = { unchanged: 'h1', changed: 'h2-old', removed: 'h3' };
    const current = { unchanged: 'h1', changed: 'h2-new', added: 'h4' };

    const diff = diffContentHashes(current, stored);

    expect(diff.toCompute.sort()).toEqual(['added', 'changed']);
    expect(diff.toDelete).toEqual(['removed']);
  });
});
