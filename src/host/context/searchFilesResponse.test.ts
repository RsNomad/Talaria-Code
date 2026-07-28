import { describe, it, expect, vi } from 'vitest';

import { buildSearchFilesResponse, SEARCH_FILES_DEFAULT_MAX_RESULTS, SEARCH_FILES_HARD_CAP } from './searchFilesResponse';
import type { FindFilesFn } from './searchFilesResponse';

function fakeFindFiles(results: string[]): FindFilesFn {
  return vi.fn(async () => results);
}

describe('buildSearchFilesResponse — pure context.searchFiles response builder (fed a fake findFiles)', () => {
  it('passes a string query straight through to the injected findFiles', async () => {
    const findFiles = fakeFindFiles([]);
    await buildSearchFilesResponse(findFiles, { query: 'foo' });
    expect(findFiles).toHaveBeenCalledWith('foo', SEARCH_FILES_DEFAULT_MAX_RESULTS);
  });

  it('coerces a non-string/missing query to "" (never trusts the webview-supplied type)', async () => {
    const findFiles = fakeFindFiles([]);
    await buildSearchFilesResponse(findFiles, { query: 42 as unknown as string });
    expect(findFiles).toHaveBeenCalledWith('', SEARCH_FILES_DEFAULT_MAX_RESULTS);
  });

  it('defaults maxResults when omitted', async () => {
    const findFiles = fakeFindFiles([]);
    await buildSearchFilesResponse(findFiles, { query: 'x' });
    expect(findFiles).toHaveBeenCalledWith('x', SEARCH_FILES_DEFAULT_MAX_RESULTS);
  });

  it('honors a caller-supplied maxResults under the hard cap', async () => {
    const findFiles = fakeFindFiles([]);
    await buildSearchFilesResponse(findFiles, { query: 'x', maxResults: 10 });
    expect(findFiles).toHaveBeenCalledWith('x', 10);
  });

  it('clamps a maxResults above the hard cap down to SEARCH_FILES_HARD_CAP (§7 B9)', async () => {
    const findFiles = fakeFindFiles([]);
    await buildSearchFilesResponse(findFiles, { query: 'x', maxResults: 100_000 });
    expect(findFiles).toHaveBeenCalledWith('x', SEARCH_FILES_HARD_CAP);
  });

  it('floors a fractional maxResults', async () => {
    const findFiles = fakeFindFiles([]);
    await buildSearchFilesResponse(findFiles, { query: 'x', maxResults: 5.9 });
    expect(findFiles).toHaveBeenCalledWith('x', 5);
  });

  it('a negative maxResults clamps to 0 and short-circuits WITHOUT calling findFiles', async () => {
    const findFiles = fakeFindFiles(['/should/not/appear']);
    const result = await buildSearchFilesResponse(findFiles, { query: 'x', maxResults: -5 });
    expect(result).toEqual([]);
    expect(findFiles).not.toHaveBeenCalled();
  });

  it('a non-finite (NaN/Infinity) maxResults falls back to the default rather than propagating garbage', async () => {
    const findFiles = fakeFindFiles([]);
    await buildSearchFilesResponse(findFiles, { query: 'x', maxResults: Number.NaN });
    expect(findFiles).toHaveBeenCalledWith('x', SEARCH_FILES_DEFAULT_MAX_RESULTS);
  });

  it('returns the raw results unchanged when none are secret-classified', async () => {
    const findFiles = fakeFindFiles(['/repo/src/a.ts', '/repo/src/b.ts']);
    const result = await buildSearchFilesResponse(findFiles, { query: 'a' });
    expect(result).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
  });

  it('filters out secret-classified paths before they reach the caller (§2d/§7 B9 — no free secret-path enumeration)', async () => {
    const findFiles = fakeFindFiles(['/repo/src/a.ts', '/repo/.env', '/repo/.ssh/id_rsa', '/repo/src/b.ts']);
    const result = await buildSearchFilesResponse(findFiles, { query: '' });
    expect(result).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
  });

  it('all-secret results yield an empty (not error) response', async () => {
    const findFiles = fakeFindFiles(['/repo/.env', '/repo/.ssh/id_rsa']);
    const result = await buildSearchFilesResponse(findFiles, {});
    expect(result).toEqual([]);
  });
});
