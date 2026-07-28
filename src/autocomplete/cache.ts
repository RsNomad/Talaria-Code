import type { CompletionCache } from './types';

interface CacheEntry {
  value: string;
  timestamp: number;
}

/**
 * In-memory LRU completion cache with longest-prefix matching, per how-to §2.3
 * (Continue's `AutocompleteLruCache`, minus SQLite persistence — "For v1 a pure
 * in-memory Map LRU ... is enough").
 *
 * Design note vs. the how-to's skeleton wording: the how-to's §4.1 comment says
 * "keyed on a hash of (prefix, suffix, model)", but its own §2.3 walkthrough (and
 * Continue's actual implementation) requires the key to be the literal prefix
 * STRING so `query.startsWith(key)` can find the longest match — hashing the key
 * would make that impossible and silently degrade this into a plain exact-match
 * cache. This class follows §2.3 (the literal, tested behavior) and keys purely on
 * the pruned prefix text. The engine is responsible for keeping the cache scoped to
 * one model (Continue does this implicitly since `selectedModelByRole.autocomplete`
 * rarely changes mid-session); `FimEngine` gets a fresh cache whenever the user
 * changes `talaria.autocomplete.model`/`backend` (see `index.ts`).
 */
export class InMemoryCompletionCache implements CompletionCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly capacity = 1000) {}

  get(prefixKey: string): string | undefined {
    let bestKey: string | undefined;
    for (const key of this.cache.keys()) {
      if (
        prefixKey.startsWith(key) &&
        (bestKey === undefined || key.length > bestKey.length)
      ) {
        bestKey = key;
      }
    }
    if (bestKey === undefined) {
      return undefined;
    }

    const entry = this.cache.get(bestKey);
    if (!entry) {
      return undefined;
    }

    const remainder = prefixKey.slice(bestKey.length);
    if (!entry.value.startsWith(remainder)) {
      return undefined;
    }

    entry.timestamp = Date.now();
    return entry.value.slice(remainder.length);
  }

  put(prefixKey: string, completion: string): void {
    this.cache.set(prefixKey, { value: completion, timestamp: Date.now() });

    if (this.cache.size > this.capacity) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of this.cache.entries()) {
        if (entry.timestamp < oldestTime) {
          oldestTime = entry.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }
}
