import type { CompletionCache } from './types';

interface CacheEntry {
  contextKey: string;
  prefix: string;
  value: string;
}

/**
 * In-memory LRU completion cache with longest-prefix matching WITHIN a
 * context partition, per how-to §2.3 (Continue's `AutocompleteLruCache`).
 *
 * CA-M12: recency is the Map's own insertion order — a hit (or re-put)
 * moves the entry to the back via delete+set, eviction takes the front via
 * `keys().next()`. No timestamps, no `Date.now()`, no O(capacity) eviction
 * scan. The longest-prefix iteration in `get` is retained deliberately: it
 * IS the prefix-match feature (a trie is out of scope — see the WS-FIM
 * plan's Non-Goals), bounded at `capacity` with an O(1) contextKey reject
 * per entry.
 *
 * F1-10: an entry with an EMPTY prefix can never be a legitimate hit —
 * prefix matching has nothing to match on, and serving one suppressed real
 * requests. Refused at BOTH ends (put refuses to store, get refuses to
 * serve), with the engine additionally skipping the cache for an empty
 * pruned prefix.
 *
 * Internal Map key: `${contextKey}\u0000${prefix}` — `contextKey` is
 * engine-built from hex hashes + spaces and can never contain \u0000, so
 * the composite is unambiguous even though document-derived prefixes may
 * contain any character.
 */
export class InMemoryCompletionCache implements CompletionCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly capacity = 1000) {}

  get(contextKey: string, prefix: string): string | undefined {
    if (prefix === '') return undefined; // F1-10

    let bestKey: string | undefined;
    let bestEntry: CacheEntry | undefined;
    for (const [key, entry] of this.cache) {
      if (entry.contextKey !== contextKey) continue;
      if (entry.prefix === '') continue; // F1-10 belt
      if (!prefix.startsWith(entry.prefix)) continue;
      if (bestEntry === undefined || entry.prefix.length > bestEntry.prefix.length) {
        bestKey = key;
        bestEntry = entry;
      }
    }
    if (bestKey === undefined || bestEntry === undefined) return undefined;

    const remainder = prefix.slice(bestEntry.prefix.length);
    if (!bestEntry.value.startsWith(remainder)) return undefined;

    // CA-M12: refresh recency — delete+set moves the entry to the back.
    this.cache.delete(bestKey);
    this.cache.set(bestKey, bestEntry);
    return bestEntry.value.slice(remainder.length);
  }

  put(contextKey: string, prefix: string, completion: string): void {
    if (prefix === '') return; // F1-10: never store an unmatchable entry

    const key = `${contextKey}\u0000${prefix}`;
    this.cache.delete(key); // re-put refreshes recency
    this.cache.set(key, { contextKey, prefix, value: completion });

    if (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}
