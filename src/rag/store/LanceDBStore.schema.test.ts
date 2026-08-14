import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as lancedb from '@lancedb/lancedb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTableNotFoundError, LanceDBStore } from './LanceDBStore';
import type { ChunkRecord } from './VectorStore';

/**
 * TA-1 (AU-1, Critical) — Index bricked on docs-first repos.
 *
 * Real `@lancedb/lancedb`, real tmp dir — deliberately NOT mocked, unlike
 * `LanceDBStore.test.ts`'s `hybridSearch`/`close` suites. The defect this
 * task fixes lives in the native package's OWN schema-INFERENCE behavior
 * (an all-undefined `language` column is silently dropped from a table
 * created via `db.createTable(name, rows)` with no explicit schema — see
 * `docs_claude/audit-fix-architecture.md` TA-1, evidence V1/V2/V7/V9), which
 * a hand-rolled fake table cannot reproduce.
 */

function makeRecord(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    id: 'id-1',
    path: 'a.ts',
    startLine: 1,
    endLine: 2,
    content: 'const a = 1;',
    contentHash: 'hash1',
    language: 'typescript',
    vector: [0.1, 0.2, 0.3],
    ...overrides,
  };
}

describe('LanceDBStore — TA-1 (AU-1): pinned schema, real @lancedb/lancedb', () => {
  let dir: string;
  let store: LanceDBStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'talaria-lancedb-ta1-'));
    store = new LanceDBStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('docs-first first batch keeps the language column', async () => {
    // Pre-fix indexer output for an unmapped extension (e.g. a README.md) —
    // `language` arrives undefined at the store boundary. V1: a table
    // created by schema INFERENCE from an all-undefined-language batch
    // drops the `language` column entirely.
    await store.upsert([makeRecord({ id: 'md-1', path: 'README.md', language: undefined })]);

    // A second, real-language batch into the now-existing table. At HEAD
    // this throws `Found field not in schema: language` (V1) because the
    // table was born without the column.
    await expect(
      store.upsert([makeRecord({ id: 'ts-1', path: 'a.ts', language: 'typescript' })]),
    ).resolves.toBeUndefined();

    // A hybridSearch-shaped select including `language` must also succeed —
    // at HEAD this throws `No field named language`.
    const rows = await (
      await lancedb.connect(dir, { readConsistencyInterval: 0 })
    )
      .openTable('chunks')
      .then((table) =>
        table.query().select(['id', 'path', 'startLine', 'endLine', 'content', 'language']).toArray(),
      );
    expect((rows as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(['md-1', 'ts-1']);
  });

  it('init drops a language-less legacy table and recreates on next upsert', async () => {
    // Close the store's own connection first — LanceDB's local (file-based)
    // backend does not allow one process to hold two live connections to
    // the same directory while a second one drops/creates a table in it.
    await store.close();

    // Simulate a table built by a PRE-FIX version of this store: bare
    // `createTable(name, rows)` with no explicit schema, all rows carrying
    // an undefined `language` — mirrors V1's exact repro.
    const rawDb = await lancedb.connect(dir, { readConsistencyInterval: 0 });
    await rawDb.createTable('chunks', [
      { ...makeRecord({ language: undefined }), language: undefined },
    ] as unknown as Record<string, unknown>[]);
    const legacyFields = (await (await rawDb.openTable('chunks')).schema()).fields.map((f) => f.name);
    expect(legacyFields).not.toContain('language'); // sanity: the fixture really is language-less
    await rawDb.close();

    // A fresh store instance's init() must self-heal: detect the missing
    // column and drop the legacy table.
    const healedStore = new LanceDBStore(dir);
    await healedStore.init();

    // The next upsert recreates the table with the pinned schema — must
    // succeed and the recreated table must have the language column.
    await healedStore.upsert([makeRecord({ id: 'ts-1', language: 'typescript' })]);
    const db = await lancedb.connect(dir, { readConsistencyInterval: 0 });
    const fields = (await (await db.openTable('chunks')).schema()).fields.map((f) => f.name);
    expect(fields).toContain('language');
    await healedStore.close();
  });

  it('init leaves a healthy (already-migrated) table alone', async () => {
    await store.upsert([makeRecord({ id: 'ts-1', language: 'typescript' })]);
    await store.close();

    // Re-init against the same directory — a healthy table (created by the
    // fixed store, with every required column) must NOT be dropped.
    const reopened = new LanceDBStore(dir);
    await reopened.init();
    const db = await lancedb.connect(dir, { readConsistencyInterval: 0 });
    const names = await db.tableNames();
    expect(names).toContain('chunks');
    // The pre-existing row must still be there — a false-positive self-heal
    // would have dropped it (Top risk #1 in the design doc).
    const rows = await (await db.openTable('chunks')).query().select(['id']).toArray();
    expect((rows as Array<{ id: string }>).map((r) => r.id)).toEqual(['ts-1']);
    await reopened.close();
  });

  it('create batch with an empty vector is refused before createTable', async () => {
    await expect(store.upsert([makeRecord({ vector: [] })])).rejects.toThrow();

    // No table must have been created — not even a broken one.
    const db = await lancedb.connect(dir, { readConsistencyInterval: 0 });
    expect(await db.tableNames()).not.toContain('chunks');
  });

  it('create batch with mixed-width vectors is refused before createTable', async () => {
    await expect(
      store.upsert([
        makeRecord({ id: 'a', vector: [0.1, 0.2, 0.3] }),
        makeRecord({ id: 'b', vector: [0.1, 0.2] }),
      ]),
    ).rejects.toThrow();

    const db = await lancedb.connect(dir, { readConsistencyInterval: 0 });
    expect(await db.tableNames()).not.toContain('chunks');
  });
});

/**
 * TA-4 (AU-22, Med) — `openTableIfExists`'s bare catch converted ANY open
 * failure (permissions, corruption, version mismatch) into "table doesn't
 * exist yet". Real `@lancedb/lancedb`, real tmp dir for the not-found
 * predicate pin (mirrors the file's own top-of-file rationale for staying
 * unmocked); the real-failure-propagates case is driven through the
 * `connectImpl` seam (Rev-1 A5) with a FAKE connection so this file's OTHER
 * describe block above keeps exercising the real package undisturbed in the
 * same suite.
 */
describe('LanceDBStore — TA-4 (AU-22): openTableIfExists distinguishes not-found from real failures', () => {
  it('pins the not-found predicate against the installed @lancedb/lancedb package (V9/Rev-1 A4)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'talaria-lancedb-ta4-pin-'));
    const db = await lancedb.connect(dir, { readConsistencyInterval: 0 });
    let caught: unknown;
    try {
      await db.openTable('chunks');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // The pin: a future lancedb bump that rewords this message fails HERE,
    // not by silently misclassifying a real error as not-found.
    expect(isTableNotFoundError(caught)).toBe(true);
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('propagates a real (non-not-found) openTable failure out of init(), instead of swallowing it into an undefined table', async () => {
    const permissionError = new Error("EACCES: permission denied, open 'chunks.lance'");
    const fakeDb = {
      openTable: async () => {
        throw permissionError;
      },
      dropTable: async () => undefined,
      createTable: async () => {
        throw new Error('createTable must not be called — init() should have rejected first');
      },
      close: () => undefined,
    };
    const connectImpl = async () => fakeDb as unknown as lancedb.Connection;

    const store = new LanceDBStore('/fake/dir/irrelevant-connectImpl-takes-over', { connectImpl });

    await expect(store.init()).rejects.toThrow(permissionError.message);
  });
});
