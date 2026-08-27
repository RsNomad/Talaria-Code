import { describe, it, expect } from 'vitest';
import { InMemoryCompletionCache } from './cache';

const CTX = 'hash-a';
const CTX_B = 'hash-b';

describe('InMemoryCompletionCache — two-part key, longest-prefix within a context partition', () => {
  it('returns undefined on a cold cache', () => {
    const cache = new InMemoryCompletionCache();
    expect(cache.get(CTX, 'const x = ')).toBeUndefined();
  });

  it('returns the exact completion for an exact key match', () => {
    const cache = new InMemoryCompletionCache();
    cache.put(CTX, 'const x = ', '1;');
    expect(cache.get(CTX, 'const x = ')).toBe('1;');
  });

  it('serves a typed-forward prefix from a shorter cached key (longest-prefix match)', () => {
    const cache = new InMemoryCompletionCache();
    cache.put(CTX, 'const x = ', '1234;');
    expect(cache.get(CTX, 'const x = 1')).toBe('234;');
  });

  it('picks the LONGEST matching cached key when multiple keys are prefixes', () => {
    const cache = new InMemoryCompletionCache();
    cache.put(CTX, 'const ', 'x = 1;');
    cache.put(CTX, 'const x = ', '1;');
    expect(cache.get(CTX, 'const x = 1')).toBe(';');
  });

  it('misses when the cached completion does not continue with the typed text', () => {
    const cache = new InMemoryCompletionCache();
    cache.put(CTX, 'const x = ', '1;');
    expect(cache.get(CTX, 'const x = 2')).toBeUndefined();
  });

  it('never crosses context partitions (different contextKey = different world)', () => {
    const cache = new InMemoryCompletionCache();
    cache.put(CTX, 'const x = ', '1;');
    expect(cache.get(CTX_B, 'const x = ')).toBeUndefined();
  });

  it('F1-10: an empty prefix is never stored and never a hit', () => {
    const cache = new InMemoryCompletionCache();
    cache.put(CTX, '', 'phantom completion');
    expect(cache.get(CTX, '')).toBeUndefined();
    expect(cache.get(CTX, 'anything')).toBeUndefined();
  });

  it('CA-M12: evicts the least-recently-USED entry at capacity — recency by operation order, no clock', () => {
    const cache = new InMemoryCompletionCache(2);
    cache.put(CTX, 'aaa', '1');
    cache.put(CTX, 'bbb', '2');
    cache.get(CTX, 'aaa'); // refresh 'aaa'
    cache.put(CTX, 'ccc', '3'); // evicts 'bbb' (LRU), not 'aaa'
    expect(cache.get(CTX, 'bbb')).toBeUndefined();
    expect(cache.get(CTX, 'aaa')).toBe('1');
    expect(cache.get(CTX, 'ccc')).toBe('3');
  });

  it('re-putting an existing key refreshes its recency', () => {
    const cache = new InMemoryCompletionCache(2);
    cache.put(CTX, 'aaa', '1');
    cache.put(CTX, 'bbb', '2');
    cache.put(CTX, 'aaa', '1-new'); // refresh via re-put
    cache.put(CTX, 'ccc', '3'); // evicts 'bbb'
    expect(cache.get(CTX, 'bbb')).toBeUndefined();
    expect(cache.get(CTX, 'aaa')).toBe('1-new');
  });
});
