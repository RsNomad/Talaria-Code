import { describe, expect, it, vi } from 'vitest';

import type { Embedder } from '../rag/embedder';
import type { SearchFilter, SearchHit, VectorStore } from '../rag/store/VectorStore';
import { formatHitAsText, runCodebaseSearch } from './search';
import { compilePathGlobs } from './pathGlob';

/**
 * V-21 pathGlob amplifier fold-in (tier2-remediation-architecture.md §8):
 * `compilePathGlobs` must be hoisted out of the per-hit filter loop in
 * `runCodebaseSearch` — one compile per CALL, not one per candidate hit.
 * Spying on the real export (not a hand-rolled fake) proves the production
 * call graph, not just a reimplementation of it.
 */
vi.mock('./pathGlob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pathGlob')>();
  return { ...actual, compilePathGlobs: vi.fn(actual.compilePathGlobs) };
});

function fakeEmbedder(vector: number[] = [0.1, 0.2, 0.3]): Embedder {
  return { embed: vi.fn(async (texts: string[]) => texts.map(() => vector)) };
}

function hit(id: string, path: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return { id, path, startLine: 0, endLine: 3, content: `content-${id}`, language: 'typescript', score: 1, ...overrides };
}

function fakeStore(hits: SearchHit[]): VectorStore & { lastCall?: { k: number; filter?: SearchFilter } } {
  const store: VectorStore & { lastCall?: { k: number; filter?: SearchFilter } } = {
    init: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    deleteByPath: vi.fn(async () => {}),
    listFileHashes: vi.fn(async () => ({})),
    hybridSearch: vi.fn(async (_q: string, _v: number[], k: number, filter?: SearchFilter) => {
      store.lastCall = { k, filter };
      return hits;
    }),
    close: vi.fn(async () => {}),
  };
  return store;
}

describe('runCodebaseSearch', () => {
  it('embeds the query and returns the store hits, truncated to k', async () => {
    const hits = [hit('a', 'src/a.ts'), hit('b', 'src/b.ts'), hit('c', 'src/c.ts')];
    const store = fakeStore(hits);
    const embedder = fakeEmbedder();

    const result = await runCodebaseSearch({ embedder, store }, { query: 'find auth', k: 2 });

    expect(result.hits).toHaveLength(2);
    expect(embedder.embed).toHaveBeenCalledWith(['find auth']);
  });

  it('passes the language filter through to the store', async () => {
    const store = fakeStore([]);
    const embedder = fakeEmbedder();

    await runCodebaseSearch({ embedder, store }, { query: 'x', k: 10, language: 'python' });

    expect(store.lastCall?.filter).toEqual({ language: 'python' });
  });

  it('overfetches when path_globs is present, then filters and re-truncates to k', async () => {
    const hits = [hit('a', 'src/a.ts'), hit('b', 'lib/b.ts'), hit('c', 'src/c.ts')];
    const store = fakeStore(hits);
    const embedder = fakeEmbedder();

    const result = await runCodebaseSearch(
      { embedder, store },
      { query: 'x', k: 10, path_globs: ['src/**'] },
    );

    expect(store.lastCall?.k).toBeGreaterThan(10); // overfetched
    expect(result.hits.map((h) => h.id)).toEqual(['a', 'c']); // lib/b.ts filtered out
  });

  it('returns no hits when the embedder yields nothing for the query', async () => {
    const store = fakeStore([hit('a', 'src/a.ts')]);
    const embedder: Embedder = { embed: vi.fn(async () => []) };

    const result = await runCodebaseSearch({ embedder, store }, { query: '', k: 10 });

    expect(result.hits).toEqual([]);
  });

  it('V-21: compiles path_globs exactly once per call, regardless of hit count (pathGlob amplifier fold-in)', async () => {
    const hits = [
      hit('a', 'src/a.ts'),
      hit('b', 'src/b.ts'),
      hit('c', 'src/c.ts'),
      hit('d', 'src/d.ts'),
      hit('e', 'src/e.ts'),
    ];
    const store = fakeStore(hits);
    const embedder = fakeEmbedder();
    const compileSpy = vi.mocked(compilePathGlobs);
    compileSpy.mockClear();

    await runCodebaseSearch({ embedder, store }, { query: 'x', k: 10, path_globs: ['src/**'] });

    // Today `matchesPathGlobs` recompiles the glob set on EVERY hit it is
    // called with (once per candidate), so this fires len(hits) times
    // instead of once.
    expect(compileSpy).toHaveBeenCalledTimes(1);
  });
});

describe('formatHitAsText', () => {
  it('renders path:1-based-line-range and a fenced code block', () => {
    const text = formatHitAsText(hit('a', 'src/a.ts', { startLine: 4, endLine: 9, content: 'const x = 1;', language: 'typescript' }));
    expect(text).toBe('src/a.ts:5-10\n```typescript\nconst x = 1;\n```');
  });

  it('uses an empty fence tag when language is absent', () => {
    const text = formatHitAsText(hit('a', 'src/a.ts', { language: undefined }));
    expect(text.startsWith('src/a.ts:1-4\n```\n')).toBe(true);
  });

  it('V-21: sanitizes a fence-header-injection language tag to an empty fence (only /^[A-Za-z0-9_+-]{1,32}$/ survives)', () => {
    const text = formatHitAsText(hit('a', 'src/a.ts', { language: 'python"><evil' }));
    expect(text.startsWith('src/a.ts:1-4\n```\n')).toBe(true);
    expect(text).not.toContain('python"><evil');
  });
});
