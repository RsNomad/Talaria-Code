import { describe, expect, it } from 'vitest';

import { toPosixRelative } from './gitignore';

describe('toPosixRelative', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosixRelative('src\\rag\\indexer.ts')).toBe('src/rag/indexer.ts');
  });

  it('leaves posix paths untouched', () => {
    expect(toPosixRelative('src/rag/indexer.ts')).toBe('src/rag/indexer.ts');
  });
});
