export interface ChunkRecord {
  /** Stable id, e.g. sha256(`${path}:${startLine}-${endLine}:${index}`). */
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Headered content that was actually embedded (path › symbol + code). */
  content: string;
  /** sha256 of the *source file's* full contents, for incremental diffing. */
  contentHash: string;
  language?: string;
  vector: number[];
}

export interface SearchFilter {
  pathGlobs?: string[];
  language?: string;
}

export interface SearchHit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  language?: string;
  score: number;
}

/**
 * Storage abstraction so pure retrieval/fusion logic and the MCP tool never
 * touch `@lancedb/lancedb` directly (spec: "Keep LanceDB ... usage behind
 * interfaces so the pure logic is testable without those native deps").
 * `LanceDBStore` is the only implementation today; a future swap (e.g.
 * Qdrant) is a new class behind this same interface.
 */
export interface VectorStore {
  init(): Promise<void>;
  upsert(records: ChunkRecord[]): Promise<void>;
  deleteByPath(path: string): Promise<void>;
  /** Distinct `path -> contentHash` for every currently-stored file — the
   * baseline the indexer diffs the workspace against (how-to §6). */
  listFileHashes(): Promise<Record<string, string>>;
  /** Runs dense (vector) + sparse (FTS/BM25) search and returns the RRF-fused top-k. */
  hybridSearch(
    queryText: string,
    queryVector: number[],
    k: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]>;
  close(): Promise<void>;
}
