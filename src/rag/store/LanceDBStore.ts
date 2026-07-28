import * as lancedb from '@lancedb/lancedb';

import { fuseHybridRows, type StoredRow } from './fuseHybridRows';
import type { ChunkRecord, SearchFilter, SearchHit, VectorStore } from './VectorStore';

const TABLE_NAME = 'chunks';
const RESULT_COLUMNS = ['id', 'path', 'startLine', 'endLine', 'content', 'language'];

/**
 * SQL string-literal escaping for the two predicates this store builds by
 * concatenation (`deleteByPath`, and `hybridSearch`'s `language` filter).
 *
 * Exported for test (audit B-11): it had no test at all, and the mutation
 * `return value;` was green — while `filter.language` arrives from
 * AGENT-SUPPLIED tool arguments. Doubling the single quote is the SQL standard
 * escape; the surrounding quotes are added by the caller.
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * LanceDB-backed `VectorStore` (embedded, no daemon — how-to §4 "#2
 * LanceDB", the same engine Continue.dev ships). All native-module usage is
 * confined to this file; everything it delegates to (`fuseHybridRows`,
 * `rrfFuse`) is pure and independently tested without `@lancedb/lancedb`
 * installed.
 *
 * Hybrid fan-out: LanceDB's own `RRFReranker.rerankHybrid` expects Arrow
 * `RecordBatch` inputs whose exact construction from `Query#toArray()`
 * varies across `@lancedb/lancedb` versions (how-to §5.3 flags this
 * explicitly: "confirm the exact hybrid chaining against your installed
 * version"). To stay deterministic across versions, `hybridSearch` runs the
 * dense and sparse queries separately and fuses with our **own** RRF
 * (`hybrid.ts` via `fuseHybridRows`) — exactly the "fusion happens inside
 * our tool" decision from the wave-1 brief. Swapping in the native
 * reranker later is a localized change to this one method (see report).
 */
export class LanceDBStore implements VectorStore {
  private db: lancedb.Connection | undefined;
  private table: lancedb.Table | undefined;
  /**
   * V-16 RAG-FTS-BLAST: flips true the first time the FTS leg of
   * `hybridSearch` rejects. Gates BOTH the one-time degrade-visibly log and
   * the one-shot lazy `createIndex` repair attempt, so a store instance
   * never spams the log or re-issues the repair on every subsequent search
   * once the first failure has been recorded.
   */
  private ftsRepairAttempted = false;

  constructor(private readonly indexDir: string) {}

  async init(): Promise<void> {
    this.db = await lancedb.connect(this.indexDir);
    try {
      this.table = await this.db.openTable(TABLE_NAME);
    } catch {
      // Table doesn't exist yet — created lazily on the first upsert() so
      // LanceDB can infer the schema from real data (how-to §5.3 pattern:
      // `db.createTable("myTable", [{ vector: [...], ... }])`).
      this.table = undefined;
    }
  }

  private requireDb(): lancedb.Connection {
    if (!this.db) throw new Error('LanceDBStore.init() must be called before use');
    return this.db;
  }

  async upsert(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = this.requireDb();
    // `@lancedb/lancedb`'s `Data` type is `Record<string, unknown>[] | TableLike`;
    // `ChunkRecord` is a closed interface (no index signature) so it isn't
    // structurally assignable even though every field is plain JSON-safe
    // data the native binding accepts fine at runtime. Narrow cast confined
    // to this file (the sole place that touches the native module).
    const rows = records as unknown as Record<string, unknown>[];

    if (!this.table) {
      this.table = await db.createTable(TABLE_NAME, rows);
      try {
        await this.table.createIndex('content', { config: lancedb.Index.fts() });
      } catch (err) {
        console.error(
          'hermes-codebase: failed to create FTS index (sparse search will be empty until this succeeds)',
          err,
        );
      }
      return;
    }

    await this.table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  }

  async deleteByPath(path: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`path = '${escapeSqlLiteral(path)}'`);
  }

  async listFileHashes(): Promise<Record<string, string>> {
    if (!this.table) return {};
    const rows = (await this.table
      .query()
      .select(['path', 'contentHash'])
      .toArray()) as Array<{ path: string; contentHash: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.path] = row.contentHash;
    }
    return result;
  }

  async hybridSearch(
    queryText: string,
    queryVector: number[],
    k: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]> {
    if (!this.table) return [];

    // Overfetch: `language` is pushed down as SQL, but `path_globs` is
    // applied downstream (src/mcp/pathGlob.ts) after fusion, so fetch extra
    // candidates to leave headroom for that later filter.
    const candidateLimit = Math.max(k * 3, 50);
    const predicate = filter?.language ? `language = '${escapeSqlLiteral(filter.language)}'` : 'true';
    // Captured into a local so TypeScript keeps the not-undefined narrowing
    // from the guard above across the `await` below (`this.table` is a
    // mutable field; narrowing on `this.x` does not persist across an
    // `await` point).
    const table = this.table;

    // V-16 RAG-FTS-BLAST: the dense (vector) and sparse (FTS) legs are
    // INDEPENDENT outcomes — MDN documents `Promise.allSettled` as the tool
    // "when the tasks are not dependent on each other"
    // (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled).
    // A failed FTS leg (e.g. the table's FTS index was never successfully
    // built — see `upsert()`'s `createIndex` catch above) must degrade to
    // vector-only results, not kill the whole hybrid search. A failed VECTOR
    // leg is a real store failure and must stay loud. This design is
    // independent of whichever behavior the bundled `@lancedb/lancedb`
    // exhibits for FTS-without-index (it threw for at least two shipped
    // lance generations; softened to a flat-scan fallback only in a
    // late-2025 commit) — either way, a rejection here is handled the same.
    const [vecOutcome, ftsOutcome] = await Promise.allSettled([
      table.query().nearestTo(queryVector).where(predicate).select(RESULT_COLUMNS).limit(candidateLimit).toArray(),
      table
        .query()
        .nearestToText(queryText)
        .where(predicate)
        .select(RESULT_COLUMNS)
        .limit(candidateLimit)
        .toArray(),
    ]);

    if (vecOutcome.status === 'rejected') {
      // A real store failure (e.g. a corrupted vector index) must stay loud
      // — never silently degraded like the FTS leg below.
      throw vecOutcome.reason;
    }
    const vecRows = vecOutcome.value as StoredRow[];

    let ftsRows: StoredRow[] = [];
    if (ftsOutcome.status === 'fulfilled') {
      ftsRows = ftsOutcome.value as StoredRow[];
    } else if (!this.ftsRepairAttempted) {
      // Degrade-visibly-not-silently: log once per store instance (not once
      // per search — a broken FTS index would otherwise spam the log on
      // every subsequent query), then attempt a one-shot, fire-and-forget
      // self-heal so a transient first-build failure (`upsert()`'s
      // `createIndex` catch) can repair itself for later searches.
      this.ftsRepairAttempted = true;
      console.error(
        'hermes-codebase: sparse (FTS) search failed — degrading to vector-only results for this and future searches; attempting a one-time index repair',
        ftsOutcome.reason,
      );
      void table.createIndex('content', { config: lancedb.Index.fts() }).catch((err: unknown) => {
        console.error('hermes-codebase: FTS index repair attempt failed', err);
      });
    }

    return fuseHybridRows(vecRows, ftsRows, k);
  }

  async close(): Promise<void> {
    // RAG-3: `@lancedb/lancedb` documents `Connection#close`/`Table#close`
    // as SYNCHRONOUS native handle releases (`connection.d.ts`/`table.d.ts`:
    // `close(): void`) that are otherwise only reclaimed later via GC
    // ("closing is optional... will be closed when garbage collected") —
    // explicitly releasing them here avoids leaking native resources across
    // repeated index rebuilds/dispose cycles. Best-effort teardown: a close
    // failure must not prevent the references from being dropped.
    try {
      this.table?.close();
    } catch (err) {
      console.error('hermes-codebase: failed to close LanceDB table', err);
    }
    try {
      this.db?.close();
    } catch (err) {
      console.error('hermes-codebase: failed to close LanceDB connection', err);
    }
    this.db = undefined;
    this.table = undefined;
  }
}
