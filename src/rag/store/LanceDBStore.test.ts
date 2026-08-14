import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V-16 RAG-FTS-BLAST: `hybridSearch` must not depend on whichever behavior
 * the bundled `@lancedb/lancedb` native module exhibits for FTS-without-index
 * — lance THREW on this for at least two shipped generations
 * (lancedb/lance#3015: "Bad error when FTS index is missing but user
 * requests full_text_search"), softened to a flat-scan fallback only in lance
 * commit b54b3fe (PR #4859, 2025-10), and still errors in some cases. So
 * these tests mock `@lancedb/lancedb` entirely and drive our own
 * `Promise.allSettled`/degrade/repair logic deterministically — the fake
 * table can be made to reject on demand, independent of what the installed
 * native binary actually does.
 */

const { connectMock, ftsMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  ftsMock: vi.fn(() => 'FAKE_FTS_INDEX_CONFIG'),
}));

vi.mock('@lancedb/lancedb', () => ({
  connect: connectMock,
  Index: { fts: ftsMock },
}));

// eslint-disable-next-line import/first -- must follow the vi.mock call above.
import { IndexNotReadyError, LanceDBStore } from './LanceDBStore';

interface FakeQueryChain {
  where: (predicate: string) => FakeQueryChain;
  select: (columns: string[]) => FakeQueryChain;
  limit: (n: number) => FakeQueryChain;
  toArray: () => Promise<unknown[]>;
}

function makeChain(resolveRows: () => Promise<unknown[]>): FakeQueryChain {
  const chain: FakeQueryChain = {
    where: () => chain,
    select: () => chain,
    limit: () => chain,
    toArray: resolveRows,
  };
  return chain;
}

// TA-1 (AU-1): every column `LanceDBStore.init()`'s self-heal check
// requires present on a HEALTHY table — see `REQUIRED_COLUMNS` in
// `LanceDBStore.ts`. Kept in sync manually (small, stable, closed list).
const HEALTHY_SCHEMA_FIELD_NAMES = ['id', 'path', 'startLine', 'endLine', 'content', 'language', 'contentHash', 'vector'];

interface FakeTable {
  query: () => {
    nearestTo: (vector: number[]) => FakeQueryChain;
    nearestToText: (text: string) => FakeQueryChain;
  };
  createIndex: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  schema: ReturnType<typeof vi.fn>;
}

function makeFakeTable(opts: {
  vecRows: () => Promise<unknown[]>;
  ftsRows: () => Promise<unknown[]>;
}): FakeTable {
  return {
    query: () => ({
      nearestTo: () => makeChain(opts.vecRows),
      nearestToText: () => makeChain(opts.ftsRows),
    }),
    createIndex: vi.fn(async () => {}),
    close: vi.fn(),
    // TA-1: a HEALTHY table by default — these tests exercise hybridSearch/
    // close behavior, not the schema self-heal, so `init()` must never drop
    // this fake table out from under them.
    schema: vi.fn(async () => ({ fields: HEALTHY_SCHEMA_FIELD_NAMES.map((name) => ({ name })) })),
  };
}

function makeFakeDb(table: FakeTable) {
  return {
    openTable: vi.fn(async () => table),
    createTable: vi.fn(),
    close: vi.fn(),
  };
}

async function makeInitializedStore(table: FakeTable) {
  const db = makeFakeDb(table);
  connectMock.mockResolvedValue(db);
  const store = new LanceDBStore('/fake/index/dir');
  await store.init();
  return { store, db };
}

describe('LanceDBStore.hybridSearch — V-16 RAG-FTS-BLAST', () => {
  beforeEach(() => {
    connectMock.mockReset();
    ftsMock.mockClear();
  });

  it('degrades to vector-only results when the FTS leg rejects, instead of killing the whole search', async () => {
    const vecRows = [
      { id: 'v1', path: 'a.ts', startLine: 1, endLine: 2, content: 'const a = 1;', language: 'typescript' },
    ];
    const table = makeFakeTable({
      vecRows: async () => vecRows,
      ftsRows: async () => {
        throw new Error('FTS index missing');
      },
    });
    const { store } = await makeInitializedStore(table);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const hits = await store.hybridSearch('needle', [0.1, 0.2], 5);

    expect(hits.map((h) => h.id)).toEqual(['v1']);
    errSpy.mockRestore();
  });

  it('rethrows loudly when the VECTOR leg rejects — a real store failure must not be swallowed', async () => {
    const table = makeFakeTable({
      vecRows: async () => {
        throw new Error('vector index corrupted');
      },
      ftsRows: async () => [],
    });
    const { store } = await makeInitializedStore(table);

    await expect(store.hybridSearch('needle', [0.1, 0.2], 5)).rejects.toThrow('vector index corrupted');
  });

  it('attempts the lazy createIndex repair at most once across two searches, even when both fail', async () => {
    const table = makeFakeTable({
      vecRows: async () => [],
      ftsRows: async () => {
        throw new Error('FTS still broken');
      },
    });
    const { store } = await makeInitializedStore(table);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await store.hybridSearch('needle', [0.1], 5);
    await store.hybridSearch('needle', [0.1], 5);
    // Let the fire-and-forget repair attempt's microtasks flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(table.createIndex).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('logs the FTS failure exactly once per store instance, not once per search', async () => {
    const table = makeFakeTable({
      vecRows: async () => [],
      ftsRows: async () => {
        throw new Error('FTS still broken');
      },
    });
    const { store } = await makeInitializedStore(table);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await store.hybridSearch('needle', [0.1], 5);
    await store.hybridSearch('needle', [0.1], 5);
    await store.hybridSearch('needle', [0.1], 5);

    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

/**
 * CF-04 / L5 F-7: the MCP `codebase_search` child calls `store.init()` ONCE
 * at spawn. Tool registration deliberately precedes the first index build
 * (how-to §7.1), so on a first-ever run `db.openTable` rejects inside
 * `init()` and `table` is set `undefined` — and stayed that way for the
 * WHOLE process lifetime, because `hybridSearch` just checked `!this.table`
 * and returned `[]` without ever looking again. These tests drive the fix:
 * a bounded, per-query lazy re-`openTable` attempt (so a table that appears
 * AFTER `init()` gets picked up), an honest `IndexNotReadyError` instead of
 * a silent `[]` when it's still missing after that attempt, and a
 * `readConsistencyInterval` passed to `connect()` so a long-lived child sees
 * a live file-watcher's incremental writes (a stale `Table` handle
 * otherwise never observes another process's commits — how-to's own
 * `ConnectionOptions.readConsistencyInterval` doc: "For performance
 * reasons, [no consistency check] is the default").
 */
describe('LanceDBStore.hybridSearch — CF-04 lazy openTable + honest not-ready', () => {
  beforeEach(() => {
    connectMock.mockReset();
    ftsMock.mockClear();
  });

  it('retries openTable when a query arrives with table===undefined, and returns hits once the table exists', async () => {
    const vecRows = [
      { id: 'v1', path: 'a.ts', startLine: 1, endLine: 2, content: 'const a = 1;', language: 'typescript' },
    ];
    const table = makeFakeTable({ vecRows: async () => vecRows, ftsRows: async () => [] });
    const db = {
      // init() finds no table yet (first-ever run, index not built)...
      openTable: vi.fn().mockRejectedValueOnce(new Error('table not found')).mockResolvedValueOnce(table),
      createTable: vi.fn(),
      close: vi.fn(),
    };
    connectMock.mockResolvedValue(db);

    const store = new LanceDBStore('/fake/index/dir');
    await store.init();

    // ...but by the time the query runs, the indexer has created it.
    const hits = await store.hybridSearch('needle', [0.1, 0.2], 5);

    expect(db.openTable).toHaveBeenCalledTimes(2);
    expect(hits.map((h) => h.id)).toEqual(['v1']);
  });

  it('throws IndexNotReadyError (not a silent empty array) when the table still does not exist after the retry', async () => {
    const db = {
      openTable: vi.fn().mockRejectedValue(new Error('table not found')),
      createTable: vi.fn(),
      close: vi.fn(),
    };
    connectMock.mockResolvedValue(db);

    const store = new LanceDBStore('/fake/index/dir');
    await store.init();

    await expect(store.hybridSearch('needle', [0.1, 0.2], 5)).rejects.toBeInstanceOf(IndexNotReadyError);
    expect(db.openTable).toHaveBeenCalledTimes(2); // init() + exactly one bounded retry
  });

  it('does not hammer openTable on repeated queries while the table remains missing (bounded retry)', async () => {
    const db = {
      openTable: vi.fn().mockRejectedValue(new Error('table not found')),
      createTable: vi.fn(),
      close: vi.fn(),
    };
    connectMock.mockResolvedValue(db);

    const store = new LanceDBStore('/fake/index/dir');
    await store.init();

    await expect(store.hybridSearch('needle', [0.1], 5)).rejects.toBeInstanceOf(IndexNotReadyError);
    await expect(store.hybridSearch('needle', [0.1], 5)).rejects.toBeInstanceOf(IndexNotReadyError);
    await expect(store.hybridSearch('needle', [0.1], 5)).rejects.toBeInstanceOf(IndexNotReadyError);

    // init() (1) + exactly ONE retry attempt per search (3) = 4 — never a
    // spin/unbounded retry within a single call.
    expect(db.openTable).toHaveBeenCalledTimes(4);
  });

  it('connects with readConsistencyInterval so a live process observes writes made by another process', async () => {
    const table = makeFakeTable({ vecRows: async () => [], ftsRows: async () => [] });
    const db = makeFakeDb(table);
    connectMock.mockResolvedValue(db);

    const store = new LanceDBStore('/fake/index/dir');
    await store.init();

    expect(connectMock).toHaveBeenCalledWith(
      '/fake/index/dir',
      expect.objectContaining({ readConsistencyInterval: 0 }),
    );
  });
});

describe('LanceDBStore.close — RAG-3', () => {
  afterEach(() => {
    connectMock.mockReset();
  });

  it('closes both the native table and connection handles before releasing references', async () => {
    const table = makeFakeTable({ vecRows: async () => [], ftsRows: async () => [] });
    const { store, db } = await makeInitializedStore(table);

    await store.close();

    expect(table.close).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it('does not throw when a native close() itself throws (best-effort teardown)', async () => {
    const table = makeFakeTable({ vecRows: async () => [], ftsRows: async () => [] });
    table.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    const { store, db } = await makeInitializedStore(table);
    db.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(store.close()).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});
