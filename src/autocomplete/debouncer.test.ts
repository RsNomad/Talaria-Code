import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutocompleteDebouncer } from './debouncer';

describe('AutocompleteDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not debounce a single isolated call', async () => {
    const debouncer = new AutocompleteDebouncer();
    const promise = debouncer.delayAndShouldDebounce(350);
    vi.advanceTimersByTime(350);
    expect(await promise).toBe(false);
  });

  it('marks an earlier call as "should debounce" when superseded by a later one', async () => {
    const debouncer = new AutocompleteDebouncer();
    const first = debouncer.delayAndShouldDebounce(350);
    vi.advanceTimersByTime(100);
    const second = debouncer.delayAndShouldDebounce(350);
    vi.advanceTimersByTime(350);

    expect(await first).toBe(true); // superseded -> should debounce (drop it)
    expect(await second).toBe(false); // most recent -> should NOT debounce (proceed)
  });

  it('treats three rapid calls as: only the last one proceeds', async () => {
    const debouncer = new AutocompleteDebouncer();
    const a = debouncer.delayAndShouldDebounce(350);
    vi.advanceTimersByTime(50);
    const b = debouncer.delayAndShouldDebounce(350);
    vi.advanceTimersByTime(50);
    const c = debouncer.delayAndShouldDebounce(350);
    vi.advanceTimersByTime(350);

    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(await c).toBe(false);
  });
});
