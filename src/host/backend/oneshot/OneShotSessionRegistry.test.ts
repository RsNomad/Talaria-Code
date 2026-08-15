import { describe, it, expect } from 'vitest';
import {
  OneShotSessionRegistry,
  MAX_ONESHOT_SESSION_IDS,
  ONESHOT_SESSION_IDS_STORAGE_KEY,
} from './OneShotSessionRegistry';

describe('OneShotSessionRegistry (TG-5 / AU-51 layer 1)', () => {
  it('starts empty: has() false, size 0, toArray/ids empty', () => {
    const registry = new OneShotSessionRegistry();
    expect(registry.has('a')).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.toArray()).toEqual([]);
    expect(registry.ids().size).toBe(0);
  });

  it('record() adds a fresh id, has()/ids() see it immediately, returns true', () => {
    const registry = new OneShotSessionRegistry();
    expect(registry.record('ephemeral-1')).toBe(true);
    expect(registry.has('ephemeral-1')).toBe(true);
    expect(registry.ids().has('ephemeral-1')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('re-recording the SAME id is a no-op: returns false, size unchanged', () => {
    const registry = new OneShotSessionRegistry();
    expect(registry.record('dup')).toBe(true);
    expect(registry.record('dup')).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('toArray() is oldest-first insertion order', () => {
    const registry = new OneShotSessionRegistry();
    registry.record('a');
    registry.record('b');
    registry.record('c');
    expect(registry.toArray()).toEqual(['a', 'b', 'c']);
  });

  it('MAX_ONESHOT_SESSION_IDS is pinned to 200 (TG-5 spec value)', () => {
    expect(MAX_ONESHOT_SESSION_IDS).toBe(200);
  });

  it('ONESHOT_SESSION_IDS_STORAGE_KEY is pinned to the spec-verbatim workspaceState key', () => {
    expect(ONESHOT_SESSION_IDS_STORAGE_KEY).toBe('talaria.oneshot.sessionIds');
  });

  it('bounds at MAX_ONESHOT_SESSION_IDS: recording one past the cap evicts the OLDEST id, not the newest', () => {
    const registry = new OneShotSessionRegistry();
    for (let i = 0; i < MAX_ONESHOT_SESSION_IDS; i++) registry.record(`id-${i}`);
    expect(registry.size).toBe(MAX_ONESHOT_SESSION_IDS);
    expect(registry.has('id-0')).toBe(true);

    registry.record('id-overflow');

    expect(registry.size).toBe(MAX_ONESHOT_SESSION_IDS); // still bounded, never exceeds the cap
    expect(registry.has('id-0')).toBe(false); // the oldest was evicted
    expect(registry.has('id-1')).toBe(true); // its neighbor survives
    expect(registry.has('id-overflow')).toBe(true); // the newest entry is present
  });

  it('recording MANY ids past the cap keeps evicting the oldest — never grows unbounded', () => {
    const registry = new OneShotSessionRegistry();
    const total = MAX_ONESHOT_SESSION_IDS + 50;
    for (let i = 0; i < total; i++) registry.record(`id-${i}`);

    expect(registry.size).toBe(MAX_ONESHOT_SESSION_IDS);
    // The 50 oldest are gone; the most recent 200 remain, newest-last.
    for (let i = 0; i < 50; i++) expect(registry.has(`id-${i}`)).toBe(false);
    for (let i = 50; i < total; i++) expect(registry.has(`id-${i}`)).toBe(true);
    expect(registry.toArray().at(-1)).toBe(`id-${total - 1}`);
  });

  it('constructor(initial) re-seeds from a persisted (oldest-first) array — a simulated reload rehydrates the same ids', () => {
    const persisted = ['old-1', 'old-2', 'old-3'];
    const registry = new OneShotSessionRegistry(persisted);
    expect(registry.toArray()).toEqual(persisted);
    expect(registry.has('old-1')).toBe(true);
    expect(registry.has('old-3')).toBe(true);
  });

  it('constructor(initial) bounds a persisted array longer than the cap the same way record() does (defensive)', () => {
    const persisted = Array.from({ length: MAX_ONESHOT_SESSION_IDS + 10 }, (_, i) => `old-${i}`);
    const registry = new OneShotSessionRegistry(persisted);
    expect(registry.size).toBe(MAX_ONESHOT_SESSION_IDS);
    expect(registry.has('old-0')).toBe(false); // the 10 oldest were evicted on seed
    expect(registry.has(`old-${MAX_ONESHOT_SESSION_IDS + 9}`)).toBe(true);
  });
});
