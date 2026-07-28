export interface RankedItem {
  id: string;
}

export interface RrfOptions {
  /** RRF damping constant; higher = flatter weighting of top ranks.
   * Standard default is 60 (how-to §5). */
  k?: number;
  /** Per-list weight, same length/order as `lists`. Defaults to 1 for every list. */
  weights?: number[];
}

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion across N pre-ranked (best-first) result lists —
 * the "fusion happens inside our tool" decision (dense vector search +
 * sparse/BM25 search are run separately, then combined here) rather than
 * depending on any one vector store's native reranker.
 *
 * `score(doc) = Σ_list  weight_list · 1 / (k + rank_list(doc))`, `k = 60`
 * (how-to §5.1/§5.3). Rank-based, so no score normalization is needed
 * across dense/sparse lists whose raw scores aren't comparable. An item
 * missing from a list simply contributes 0 for that list.
 */
export function rrfFuse(
  lists: ReadonlyArray<ReadonlyArray<RankedItem>>,
  opts: RrfOptions = {},
): FusedResult[] {
  const k = opts.k ?? 60;
  const weights = opts.weights;
  const scores = new Map<string, number>();
  const firstSeenOrder: string[] = [];

  lists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    list.forEach((item, i) => {
      const rank = i + 1; // 1-based
      const contribution = weight * (1 / (k + rank));
      if (!scores.has(item.id)) {
        scores.set(item.id, 0);
        firstSeenOrder.push(item.id);
      }
      scores.set(item.id, (scores.get(item.id) as number) + contribution);
    });
  });

  return firstSeenOrder
    .map((id) => ({ id, score: scores.get(id) as number }))
    .sort((a, b) => b.score - a.score);
}
