/*
 * RED-first tests for the `@file`/`@folder` async submenu's pure helpers
 * (architecture doc §2b "async item sources with loading/debounce state").
 * Two independent guards compose to make the submenu race-safe:
 *  - `FileSearchDebouncer` — suppresses firing the RPC at all for a query
 *    that gets superseded before its delay elapses (same sequence-tag shape
 *    as `src/autocomplete/debouncer.ts`'s `AutocompleteDebouncer`).
 *  - `reduceFileSearch` — the request-race/result-state guard: even an RPC
 *    that DID fire can still resolve late (after a newer query's RPC already
 *    resolved); its response is tagged with the sequence number active when
 *    it was fired, and the reducer drops it unless that sequence is still
 *    current. THIS is what pins "a stale response for an older query must
 *    never overwrite a newer one".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FileSearchDebouncer,
  INITIAL_FILE_SEARCH_STATE,
  filesToFolders,
  parsePathPick,
  reduceFileSearch,
} from './fileSearch';

describe('parsePathPick — detects @file:/@folder: path-pick mode from the open @-query', () => {
  it('detects file mode with a partial path', () => {
    expect(parsePathPick('file:src/co')).toEqual({ kind: 'file', search: 'src/co' });
  });

  it('detects folder mode with a partial path', () => {
    expect(parsePathPick('folder:src')).toEqual({ kind: 'folder', search: 'src' });
  });

  it('detects an EMPTY search right after the colon (browse-all mode)', () => {
    expect(parsePathPick('file:')).toEqual({ kind: 'file', search: '' });
  });

  it('returns null for a bare "file"/"folder" query (no colon yet — still the top catalog)', () => {
    expect(parsePathPick('file')).toBeNull();
    expect(parsePathPick('folder')).toBeNull();
  });

  it('returns null for other kinds and unrelated queries', () => {
    expect(parsePathPick('problems')).toBeNull();
    expect(parsePathPick('')).toBeNull();
    expect(parsePathPick('fil')).toBeNull();
  });
});

describe('filesToFolders — derives unique parent-directory options from file search results', () => {
  it('reduces file paths to their unique parent directories, in first-appearance order', () => {
    expect(
      filesToFolders(['src/components/Composer.tsx', 'src/components/Pill.tsx', 'src/rpc.ts']),
    ).toEqual(['src/components', 'src']);
  });

  it('dedups repeated parent directories', () => {
    expect(filesToFolders(['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual(['src']);
  });

  it('handles both POSIX and Windows separators', () => {
    expect(filesToFolders(['src\\components\\Composer.tsx'])).toEqual(['src\\components']);
  });

  it('skips a bare filename with no parent segment at all', () => {
    expect(filesToFolders(['README.md'])).toEqual([]);
  });

  it('empty input yields an empty list', () => {
    expect(filesToFolders([])).toEqual([]);
  });
});

describe('reduceFileSearch — request-race/result-state reducer (the stale-response guard)', () => {
  it('starts idle', () => {
    expect(INITIAL_FILE_SEARCH_STATE).toEqual({ status: 'idle', query: '', seq: 0, results: [] });
  });

  it('a query-changed action moves to loading and clears prior results', () => {
    const next = reduceFileSearch(INITIAL_FILE_SEARCH_STATE, { type: 'query-changed', query: 'co', seq: 1 });
    expect(next).toEqual({ status: 'loading', query: 'co', seq: 1, results: [] });
  });

  it('a resolved action matching the current seq applies its results', () => {
    const loading = reduceFileSearch(INITIAL_FILE_SEARCH_STATE, { type: 'query-changed', query: 'co', seq: 1 });
    const next = reduceFileSearch(loading, { type: 'resolved', seq: 1, results: ['src/a.ts'] });
    expect(next).toEqual({ status: 'success', query: 'co', seq: 1, results: ['src/a.ts'] });
  });

  it('THE PIN: a resolved action for a STALE (superseded) seq is dropped, never overwriting newer state', () => {
    // Query 1 fires (seq 1) ...
    const afterQuery1 = reduceFileSearch(INITIAL_FILE_SEARCH_STATE, { type: 'query-changed', query: 'a', seq: 1 });
    // ... user keeps typing before query 1's RPC resolves: query 2 fires (seq 2).
    const afterQuery2 = reduceFileSearch(afterQuery1, { type: 'query-changed', query: 'ab', seq: 2 });
    // Query 2's RPC resolves first (fast network).
    const afterQuery2Resolves = reduceFileSearch(afterQuery2, {
      type: 'resolved',
      seq: 2,
      results: ['src/ab.ts'],
    });
    expect(afterQuery2Resolves).toEqual({ status: 'success', query: 'ab', seq: 2, results: ['src/ab.ts'] });

    // Query 1's RPC (older, slower) resolves LATE, after query 2 already won.
    const afterStaleQuery1Resolves = reduceFileSearch(afterQuery2Resolves, {
      type: 'resolved',
      seq: 1,
      results: ['src/a-STALE.ts'],
    });
    // Must be a complete no-op: query 2's fresher state is untouched.
    expect(afterStaleQuery1Resolves).toEqual(afterQuery2Resolves);
    expect(afterStaleQuery1Resolves).toBe(afterQuery2Resolves); // same object identity — no wasted re-render either
  });

  it('a failed action matching the current seq moves to error with empty results', () => {
    const loading = reduceFileSearch(INITIAL_FILE_SEARCH_STATE, { type: 'query-changed', query: 'co', seq: 1 });
    const next = reduceFileSearch(loading, { type: 'failed', seq: 1 });
    expect(next).toEqual({ status: 'error', query: 'co', seq: 1, results: [] });
  });

  it('a failed action for a stale seq is also dropped', () => {
    const afterQuery1 = reduceFileSearch(INITIAL_FILE_SEARCH_STATE, { type: 'query-changed', query: 'a', seq: 1 });
    const afterQuery2 = reduceFileSearch(afterQuery1, { type: 'query-changed', query: 'ab', seq: 2 });
    const stillLoadingQuery2 = reduceFileSearch(afterQuery2, { type: 'failed', seq: 1 });
    expect(stillLoadingQuery2).toBe(afterQuery2);
  });

  it('a closed action resets to idle regardless of prior state', () => {
    const loaded = reduceFileSearch(INITIAL_FILE_SEARCH_STATE, { type: 'query-changed', query: 'co', seq: 7 });
    expect(reduceFileSearch(loaded, { type: 'closed' })).toEqual(INITIAL_FILE_SEARCH_STATE);
  });
});

describe('FileSearchDebouncer — sequence-tagged debounce gate (mirrors AutocompleteDebouncer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not drop a single isolated call', async () => {
    const debouncer = new FileSearchDebouncer();
    const promise = debouncer.delayAndShouldDrop(180);
    vi.advanceTimersByTime(180);
    expect(await promise).toBe(false);
  });

  it('drops an earlier call once superseded by a later one before its delay elapses', async () => {
    const debouncer = new FileSearchDebouncer();
    const first = debouncer.delayAndShouldDrop(180);
    vi.advanceTimersByTime(50);
    const second = debouncer.delayAndShouldDrop(180);
    vi.advanceTimersByTime(180);

    expect(await first).toBe(true); // superseded -> drop
    expect(await second).toBe(false); // most recent -> proceed
  });

  it('of several rapid calls, only the last one proceeds', async () => {
    const debouncer = new FileSearchDebouncer();
    const a = debouncer.delayAndShouldDrop(180);
    vi.advanceTimersByTime(40);
    const b = debouncer.delayAndShouldDrop(180);
    vi.advanceTimersByTime(40);
    const c = debouncer.delayAndShouldDrop(180);
    vi.advanceTimersByTime(180);

    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(await c).toBe(false);
  });
});
