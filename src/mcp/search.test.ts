import { describe, expect, it, vi } from 'vitest';

import type { Embedder } from '../rag/embedder';
import type { SearchFilter, SearchHit, VectorStore } from '../rag/store/VectorStore';
import { buildEmbeddingQueryText, formatHitAsText, runCodebaseSearch } from './search';
import type { CodebaseSearchDeps } from './search';
import { compilePathGlobs } from './pathGlob';
import type { CodebaseSearchInput } from './toolSchema';

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
  // F6-7 (FI-29): `Embedder` now requires `batchSize` — mechanical fixture
  // extension, unused by `runCodebaseSearch` (a single-query embed, not a
  // batched index build), so the value is arbitrary.
  return { embed: vi.fn(async (texts: string[]) => texts.map(() => vector)), batchSize: 64 };
}

// `language` is widened to accept an explicit `undefined` HERE (test-helper-
// local override type, not `SearchHit` itself): :116 below passes
// `{ language: undefined }` to genuinely CLEAR this helper's own
// `language: 'typescript'` default (arm 2) — `Partial<SearchHit>` alone
// rejects that under exactOptionalPropertyTypes because `SearchHit.language`
// is already declared optional (no explicit `| undefined`).
type HitOverrides = Partial<Omit<SearchHit, 'language'>> & { readonly language?: string | undefined };

function hit(id: string, path: string, overrides: HitOverrides = {}): SearchHit {
  // `language` is pulled out of the spread and re-added conditionally: an
  // explicit `{ language: undefined }` override (arm 2, see `HitOverrides`
  // above) must CLEAR the 'typescript' default to an ABSENT key on the
  // returned `SearchHit` (its `language?: string` has no explicit
  // `| undefined`) rather than an explicit-undefined value.
  const { language, ...rest } = overrides;
  const resolvedLanguage = 'language' in overrides ? language : 'typescript';
  return {
    id,
    path,
    startLine: 0,
    endLine: 3,
    content: `content-${id}`,
    score: 1,
    ...rest,
    ...(resolvedLanguage !== undefined ? { language: resolvedLanguage } : {}),
  };
}

function fakeStore(hits: SearchHit[]): VectorStore & { lastCall?: { k: number; filter?: SearchFilter } } {
  const store: VectorStore & { lastCall?: { k: number; filter?: SearchFilter } } = {
    init: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    deleteByPath: vi.fn(async () => {}),
    listFileHashes: vi.fn(async () => ({})),
    hybridSearch: vi.fn(async (_q: string, _v: number[], k: number, filter?: SearchFilter) => {
      store.lastCall = { k, ...(filter !== undefined ? { filter } : {}) };
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
    const embedder: Embedder = { embed: vi.fn(async () => []), batchSize: 64 };

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

  it('LSP-02: formatHitAsText strips control characters from the snippet but keeps tabs and newlines', () => {
    const hitWithControlChars: SearchHit = {
      id: 'x',
      path: 'src/a.ts',
      startLine: 0,
      endLine: 2,
      score: 1,
      language: 'ts',
      content: 'line1\n\tindented\x07\x00 bell+nul\nline3',
    };
    const out = formatHitAsText(hitWithControlChars);
    expect(out).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/); // no control chars
    expect(out).toContain('\n\tindented bell+nul'); // \t and \n preserved, \x07/\x00 gone
  });

  it('LSP-02: formatHitAsText strips control characters from the hit path too (DiD parity)', () => {
    const hit: SearchHit = {
      id: 'x', path: 'src/a\x07\x00b.ts', startLine: 0, endLine: 2, score: 1, language: 'ts',
      content: 'clean\n',
    };
    const out = formatHitAsText(hit);
    expect(out).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/); // no control chars anywhere
    expect(out).toContain('src/ab.ts:1-3'); // \x07/\x00 gone from the path segment
  });
});

/**
 * A-05 [SECURITY]: Qwen3-Embedding (QwenLM/Qwen3-Embedding `get_detailed_instruct`,
 * confirmed against the HF card via Context7) is an instruction-aware retrieval
 * model — QUERIES get an `Instruct: {task}\nQuery:{query}` prefix (no space
 * after `Query:`), DOCUMENTS stay bare. The prefix is applied ONLY at the
 * query-EMBED choke, and ONLY when the configured embedder id names a
 * Qwen3-Embedding variant; the FTS leg (`store.hybridSearch`'s first
 * argument) and the document/index side are untouched — no re-index needed
 * when the instruction text changes.
 *
 * `embedder`/`store` below are hand-built objects that satisfy the full
 * `Embedder`/`VectorStore` interfaces (every required method stubbed, not
 * just the ones this test exercises) so `deps`/`input` type-check as the
 * real `CodebaseSearchDeps`/`CodebaseSearchInput` with no cast. The capture
 * arrays are plain array-push spies per the Global Constraint (no new
 * `vi.fn()`).
 */
describe('A-05: Qwen3-Embedding query instruction prefix', () => {
  it('prefixes the EMBED text for a Qwen3-Embedding model but leaves the FTS query raw', async () => {
    const embedTexts: string[][] = [];
    const ftsQueries: string[] = [];
    const embedder: Embedder = {
      embed: async (texts: string[]) => {
        embedTexts.push(texts);
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
      batchSize: 64,
    };
    const store: VectorStore = {
      init: async () => {},
      upsert: async () => {},
      deleteByPath: async () => {},
      listFileHashes: async () => ({}),
      hybridSearch: async (queryText: string) => {
        ftsQueries.push(queryText);
        return [];
      },
      close: async () => {},
    };
    const deps: CodebaseSearchDeps = { embedder, store, embedModel: 'qwen3-embedding:0.6b' };
    const input: CodebaseSearchInput = { query: 'find the parser', k: 5 };

    await runCodebaseSearch(deps, input);

    expect(embedTexts[0]).toEqual([
      'Instruct: Given a code search query, retrieve relevant code snippets that satisfy it.\nQuery:find the parser',
    ]);
    expect(ftsQueries[0]).toBe('find the parser'); // FTS leg raw
  });

  it('leaves the query raw for a non-Qwen3 model', async () => {
    const embedTexts: string[][] = [];
    const embedder: Embedder = {
      embed: async (texts: string[]) => {
        embedTexts.push(texts);
        return texts.map(() => [0.1]);
      },
      batchSize: 64,
    };
    const store: VectorStore = {
      init: async () => {},
      upsert: async () => {},
      deleteByPath: async () => {},
      listFileHashes: async () => ({}),
      hybridSearch: async () => [],
      close: async () => {},
    };
    const deps: CodebaseSearchDeps = { embedder, store, embedModel: 'nomic-embed-text' };
    const input: CodebaseSearchInput = { query: 'find the parser', k: 5 };

    await runCodebaseSearch(deps, input);

    expect(embedTexts[0]).toEqual(['find the parser']);
  });

  it('buildEmbeddingQueryText: undefined model ⇒ raw', () => {
    expect(buildEmbeddingQueryText('q', undefined)).toBe('q');
    expect(buildEmbeddingQueryText('q', 'Qwen/Qwen3-Embedding-8B')).toBe(
      'Instruct: Given a code search query, retrieve relevant code snippets that satisfy it.\nQuery:q',
    );
  });
});
