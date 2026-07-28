import { describe, it, expect, vi } from 'vitest';
import { InMemoryCompletionCache } from './cache';

describe('InMemoryCompletionCache', () => {
  it('returns undefined on a cold cache', () => {
    const cache = new InMemoryCompletionCache();
    expect(cache.get('const x = ')).toBeUndefined();
  });

  it('returns the exact completion for an exact key match', () => {
    const cache = new InMemoryCompletionCache();
    cache.put('const x = ', '1;');
    expect(cache.get('const x = ')).toBe('1;');
  });

  it('serves a longer, typed-forward prefix from a shorter cached key (longest-prefix match)', () => {
    const cache = new InMemoryCompletionCache();
    cache.put('const x = ', '1234;');
    // User typed one more char ("1") within the previously suggested completion.
    expect(cache.get('const x = 1')).toBe('234;');
  });

  it('picks the LONGEST matching cached key when multiple keys are prefixes', () => {
    const cache = new InMemoryCompletionCache();
    cache.put('const ', 'x = 1;');
    cache.put('const x = ', '1;');
    expect(cache.get('const x = 1')).toBe(';');
  });

  it('misses when the cached completion does not actually continue with the typed text', () => {
    const cache = new InMemoryCompletionCache();
    cache.put('const x = ', '1;');
    // Typed something that diverges from what was cached ("2" vs cached "1;").
    expect(cache.get('const x = 2')).toBeUndefined();
  });

  it('misses when no cached key is a prefix of the query', () => {
    const cache = new InMemoryCompletionCache();
    cache.put('function foo(', ') {}');
    expect(cache.get('const x = ')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once capacity is exceeded', () => {
    const cache = new InMemoryCompletionCache(2);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    cache.put('aaa', '1');
    now.mockReturnValue(2000);
    cache.put('bbb', '2');
    now.mockReturnValue(3000);
    cache.put('ccc', '3'); // capacity 2 -> evicts oldest ('aaa', ts=1000)

    expect(cache.get('aaa')).toBeUndefined();
    expect(cache.get('bbb')).toBe('2');
    expect(cache.get('ccc')).toBe('3');
    now.mockRestore();
  });

  it('refreshes an entry timestamp on get, protecting it from eviction', () => {
    const cache = new InMemoryCompletionCache(2);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    cache.put('aaa', '1');
    now.mockReturnValue(2000);
    cache.put('bbb', '2');
    now.mockReturnValue(2500);
    cache.get('aaa'); // refresh 'aaa' so it is now the most recently used
    now.mockReturnValue(3000);
    cache.put('ccc', '3'); // should evict 'bbb' (least recently used now), not 'aaa'

    expect(cache.get('bbb')).toBeUndefined();
    expect(cache.get('aaa')).toBe('1');
    expect(cache.get('ccc')).toBe('3');
    now.mockRestore();
  });
});
