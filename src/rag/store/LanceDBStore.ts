import * as lancedb from '@lancedb/lancedb';
// TA-1 (AU-1, Critical) / V9 (settled, Rev-1 A4): the installed
// `@lancedb/lancedb@0.33.0` exposes NO `./arrow` subpath in its `package.json`
// `exports` map (only `.`, `./embedding`, `./embedding/*`) — its own
// `dist/arrow.d.ts` merely does `export * from "apache-arrow"` (a TYPE
// re-export, not a value one), so the Arrow constructors below MUST come
// from `apache-arrow` directly, lancedb's own hoisted dependency (confirmed
// installed, `apache-arrow@18.1.0`). esbuild bundles it — only lancedb and
// web-tree-sitter are externals (`esbuild.js`) — and lancedb's own
// `SchemaLike`/`FieldLike` inputs are duck-typed, so this cross-copy import
// identity is safe by design.
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';

import { fuseHybridRows, type StoredRow } from './fuseHybridRows';
import type { ChunkRecord, SearchFilter, SearchHit, VectorStore } from './VectorStore';

const TABLE_NAME = 'chunks';
const RESULT_COLUMNS = ['id', 'path', 'startLine', 'endLine', 'content', 'language'];
// TA-1: the store-boundary invariant (INV-1) is "every RESULT_COLUMNS name +
// contentHash + vector must exist on the table" — used by both the schema
// this file pins at createTable and the init()-time self-heal check below.
const REQUIRED_COLUMNS = [...RESULT_COLUMNS, 'contentHash', 'vector'];

/**
 * TA-1 (AU-1, Critical): the explicit Arrow schema pinned at `createTable` —
 * never inferred. Root cause (V1, reproduced): `db.createTable(name, rows)`
 * with no schema INFERS one from the first batch, and LanceDB drops a column
 * whose value is `undefined` (JS) in every row of that batch. A docs-first
 * repo (README sorts first in the walk) makes the first upsert batch
 * all-undefined `language` (no `EXTENSION_TO_LANGUAGE_ID` entry for md/json/
 * yml/…) — the table is born without `language`, and every later
 * real-language upsert throws `Found field not in schema: language` forever.
 *
 * Verified empirically against the installed package (this task's own
 * write-time probe, mirroring V1/V7): passing an explicit `schema` option to
 * `createTable` is NOT by itself sufficient — `makeArrowTable`'s internal
 * `inferSchema` still walks the ROW DATA to decide which of the schema's
 * fields actually ended up in the table, and treats a JS `undefined` value
 * as "field absent from this row" for every row it sees (`arrow.js`'s own
 * comment: "Skip undefined values - they should be treated the same as
 * missing fields"). A field with an all-`undefined` value across the WHOLE
 * create batch is therefore still dropped even with this schema passed,
 * unless every row supplies an explicit value for it. `toStoreRow` below
 * closes that gap by coercing a missing `language` to `null` (a real, typed,
 * schema-observed value meaning "no language"), not `undefined`.
 *
 * `language` stays nullable — the STORE must not assume the indexer's own
 * `?? 'text'` default (indexer.ts) always ran; this is TA-1's own,
 * independent layer of defense-in-depth (Rev-1 A1's framing).
 */
function buildChunksSchema(vectorWidth: number): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('path', new Utf8(), false),
    new Field('content', new Utf8(), false),
    new Field('contentHash', new Utf8(), false),
    new Field('language', new Utf8(), true),
    new Field('startLine', new Int32(), false),
    new Field('endLine', new Int32(), false),
    // `item` is the Arrow list-child field name LanceDB's own examples and
    // internal vector-column construction use (`arrow.js`:
    // `new Field("item", floatType, true)`) — matched here for consistency.
    new Field('vector', new FixedSizeList(vectorWidth, new Field('item', new Float32(), true)), false),
  ]);
}

/**
 * TA-1: the one place a `ChunkRecord` becomes a row object sent to the
 * native binding. `language` is coerced `undefined -> null` — see
 * `buildChunksSchema`'s doc comment for why that coercion (not a bare
 * `record.language`) is load-bearing for the create-batch path.
 */
function toStoreRow(record: ChunkRecord): Record<string, unknown> {
  return {
    id: record.id,
    path: record.path,
    startLine: record.startLine,
    endLine: record.endLine,
    content: record.content,
    contentHash: record.contentHash,
    language: record.language ?? null,
    vector: record.vector,
  };
}

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
 * CF-04 / L5 F-7: thrown by `hybridSearch` when the `chunks` table has never
 * been created — the MCP child's ONE `init()` call at spawn raced the first
 * index build (registration deliberately precedes it, how-to §7.1) — and the
 * bounded lazy re-`openTable` attempt below still didn't find it. Exported
 * so `codebaseSearchHandler.ts` can special-case this into an honest
 * "(index not ready)" response, instead of either folding it into the
 * generic D-3 failure text or a `content: []` a caller could misread as "the
 * search ran and found nothing". Carries no path/detail in its message —
 * same "status/reason only" rule as the rest of this file's error surface.
 */
export class IndexNotReadyError extends Error {
  constructor() {
    super('LanceDB codebase index is not ready yet (no chunks table)');
    this.name = 'IndexNotReadyError';
    Object.setPrototypeOf(this, IndexNotReadyError.prototype);
  }
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
    // CF-04: `readConsistencyInterval: 0` is LanceDB's STRONG-consistency
    // setting — "every read will check for updates from other processes"
    // (`ConnectionOptions.readConsistencyInterval` doc, grounded against the
    // installed `@lancedb/lancedb@0.31.0` typings —
    // `node_modules/@lancedb/lancedb/dist/native.d.ts`). Without it the
    // default is NO consistency check ("for performance reasons"), so a
    // long-lived MCP child's `Table` handle never observes the file
    // watcher's incremental writes (mergeInsert/createTable) made from the
    // extension host process. Correctness over the (local-filesystem, cheap)
    // per-read staleness check.
    this.db = await lancedb.connect(this.indexDir, { readConsistencyInterval: 0 });
    this.table = await this.openTableIfExists();
    // TA-1 (AU-1, Critical) self-heal: a table built by a PRE-FIX version of
    // this store (or otherwise missing a required column) is bricked forever
    // — every upsert into it throws `Found field not in schema`, every
    // `hybridSearch` throws too, and nothing before this fix ever detected
    // or repaired it (V1). Column-NAME-only check (never types): the inline
    // width guard in `upsert()` below makes a 0-width `vector` column
    // unreachable going forward, so the only malformed shape that can exist
    // on disk is a MISSING column — name presence is sufficient (Rev-1 A1).
    // Checking types too would risk a false-positive drop of a healthy table
    // (design doc, Top risk #1) for no added protection.
    if (this.table) {
      const fields = (await this.table.schema()).fields.map((f) => f.name);
      const missing = REQUIRED_COLUMNS.filter((name) => !fields.includes(name));
      if (missing.length > 0) {
        console.error(
          `hermes-codebase: dropping a legacy '${TABLE_NAME}' table missing required column(s) [${missing.join(', ')}] — the next index build recreates it with the current pinned schema`,
        );
        await this.db.dropTable(TABLE_NAME);
        this.table = undefined;
      }
    }
  }

  private requireDb(): lancedb.Connection {
    if (!this.db) throw new Error('LanceDBStore.init() must be called before use');
    return this.db;
  }

  /** Table doesn't exist yet — created lazily on the first upsert(), with an
   * explicit PINNED schema (TA-1 — never inferred, see `buildChunksSchema`).
   * Returns `undefined` rather than throwing so both `init()` and the lazy
   * per-query retry below can share this without their own try/catch. */
  private async openTableIfExists(): Promise<lancedb.Table | undefined> {
    if (!this.db) return undefined;
    try {
      return await this.db.openTable(TABLE_NAME);
    } catch {
      return undefined;
    }
  }

  /**
   * CF-04: `init()` runs ONCE at MCP-child spawn, before the first index
   * build necessarily completes — so `this.table` can still be `undefined`
   * long after a real table exists. BOUNDED: exactly one `openTable` attempt
   * per call (no loop/spin) — "still undefined → try once, cache success".
   * A table that appears is cached in `this.table` forever after (LanceDB's
   * own `readConsistencyInterval` then keeps THAT handle fresh); a table
   * that's still missing is retried again on the NEXT query, not in a tight
   * loop within this one.
   */
  private async tryReopenTable(): Promise<void> {
    if (this.table) return;
    this.table = await this.openTableIfExists();
  }

  async upsert(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = this.requireDb();

    if (!this.table) {
      // TA-1 (AU-1, Critical) / Rev-1 A1 — load-bearing, THIS guard's own,
      // NOT delegated to TA-2's later per-row validation: refuse to create
      // the table at all from a first (create) batch whose vectors are
      // empty or non-uniform width, BEFORE building/pinning a schema from
      // that width. A pinned `FixedSizeList(0)` column would be a table the
      // init() self-heal above CANNOT repair by name-presence alone (the
      // column exists) — V2 showed a wrong/empty-width vector is then
      // accepted silently and kills every subsequent `nearestTo`, strictly
      // WORSE than HEAD (where an empty first-batch vector at least fails
      // `createTable` loudly, V1). This is the order-independent
      // defense-in-depth belt under INV-1 that makes a 0-width pinned
      // column unreachable regardless of task sequencing or future
      // refactors — see `docs_claude/audit-fix-architecture.md` TA-1.
      const width = records[0]?.vector.length ?? 0;
      if (width === 0 || records.some((r) => r.vector.length !== width)) {
        // Status/reason only (this file's error-surface rule, see
        // `IndexNotReadyError`'s doc comment) — no record content/path.
        throw new Error(
          'LanceDBStore.upsert: refused to create the chunks table — every vector in the first (create) batch must be non-empty and the same width',
        );
      }
      const schema = buildChunksSchema(width);
      this.table = await db.createTable(TABLE_NAME, records.map(toStoreRow), { schema });
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

    await this.table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(records.map(toStoreRow));
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
    if (!this.table) {
      // CF-04: the table may have appeared since `init()` (or since the
      // previous query) — one bounded attempt to pick it up before giving up.
      await this.tryReopenTable();
    }
    if (!this.table) {
      throw new IndexNotReadyError();
    }

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
