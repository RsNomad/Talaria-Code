import { rrfFuse } from '../hybrid';
import type { SearchHit } from './VectorStore';

/** A raw row as returned by a LanceDB `.toArray()` query — the columns
 * `LanceDBStore` persisted in its table schema. */
export interface StoredRow {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  language?: string;
}

/**
 * Fuses a dense (vector) result page and a sparse (FTS/BM25) result page —
 * each already sorted best-first by the store — into the top-`k` list via
 * RRF (k=60 by default). This is the pure core behind `LanceDBStore`'s
 * `hybridSearch`, kept independent of any native reranker's row-shape
 * contract (how-to §5.3 flags that `RRFReranker.rerankHybrid`'s exact
 * `RecordBatch` chaining varies by `@lancedb/lancedb` version) — matching
 * the wave-1 decision that fusion happens **inside our tool**.
 */
export function fuseHybridRows(
  vecRows: readonly StoredRow[],
  ftsRows: readonly StoredRow[],
  k: number,
  rrfK = 60,
): SearchHit[] {
  const byId = new Map<string, StoredRow>();
  for (const row of vecRows) byId.set(row.id, row);
  for (const row of ftsRows) if (!byId.has(row.id)) byId.set(row.id, row);

  const fused = rrfFuse([vecRows, ftsRows], { k: rrfK });

  return fused.slice(0, k).map((f) => {
    const row = byId.get(f.id) as StoredRow;
    return {
      id: row.id,
      path: row.path,
      startLine: row.startLine,
      endLine: row.endLine,
      content: row.content,
      language: row.language,
      score: f.score,
    };
  });
}
