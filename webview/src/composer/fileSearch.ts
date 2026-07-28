/*
 * `@file`/`@folder` async submenu — pure helpers (architecture doc §2b
 * "async item sources with loading/debounce state" / §3.1 "host-served
 * `context.searchFiles` with debounce in the webview; results rendered in
 * the same `SuggestMenu` as a drill-in list"). The React wiring
 * (`useFileSearch.ts`) is a thin, untested hook-core built on top of the
 * pure pieces here — same split as `useSuggest.ts`.
 *
 * Two INDEPENDENT guards compose to make the submenu race-safe end to end:
 *  1. {@link FileSearchDebouncer} suppresses firing the RPC at all for a
 *     query superseded before its delay elapses (perf: don't spam the host
 *     while the user is still typing).
 *  2. {@link reduceFileSearch} is the request-race/result-state guard: even
 *     an RPC that DID fire can still resolve LATE, after a newer query's RPC
 *     already resolved (ordinary network jitter, no debounce failure
 *     involved). Its `resolved`/`failed` actions carry the sequence number
 *     that was current when the request was FIRED; the reducer drops the
 *     action unless that sequence is STILL current — this is the actual
 *     "stale response can never overwrite a newer one" invariant.
 */

// ---- path-pick detection ---------------------------------------------------

export interface PathPick {
  kind: 'file' | 'folder';
  /** The partial path typed so far after the colon (possibly empty = browse-all). */
  search: string;
}

/**
 * Detect whether the currently open `@`-query (as tracked by `useSuggest`,
 * which guarantees a whitespace-free query — see `useSuggest.ts`) has
 * entered file/folder path-pick mode. Reachable two ways in `Composer.tsx`:
 * typing `@file:`/`@folder:` by hand, or picking "File"/"Folder" from the
 * top catalog (which inserts the same `@<kind>:` token and keeps the menu
 * open). A bare `file`/`folder` query with NO colon yet is still the top
 * catalog — returns `null`, same as any unrelated query.
 */
export function parsePathPick(query: string): PathPick | null {
  const m = /^(file|folder):(.*)$/.exec(query);
  if (!m) return null;
  // Neither capture group is optional in the pattern above, so both are
  // always present when `m` itself is non-null — but noUncheckedIndexedAccess
  // can't see into the regex literal, so this narrows for real instead of
  // asserting past it.
  const kind = m[1];
  const search = m[2];
  if (kind !== 'file' && kind !== 'folder') return null;
  if (search === undefined) return null;
  return { kind, search };
}

// ---- folder derivation ------------------------------------------------------

/**
 * Reduce a flat file-path list (as returned by `context.searchFiles` — the
 * host RPC only searches FILES, §2e; there is no folder-search entry point)
 * to its unique parent-directory paths, in first-appearance order. This is
 * what makes the `@folder` submenu offer real folder paths instead of
 * silently mislabeling a file's own path.
 */
export function filesToFolders(paths: string[]): string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const p of paths) {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (idx <= 0) continue; // no parent segment (bare filename, or a root-only path) — nothing to offer
    const dir = p.slice(0, idx);
    if (!seen.has(dir)) {
      seen.add(dir);
      folders.push(dir);
    }
  }
  return folders;
}

// ---- request-race/result-state reducer -------------------------------------

export type FileSearchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface FileSearchState {
  status: FileSearchStatus;
  /** The query the current state reflects (loading/success/error target). */
  query: string;
  /** The sequence number of the request this state corresponds to. */
  seq: number;
  results: string[];
}

export const INITIAL_FILE_SEARCH_STATE: FileSearchState = {
  status: 'idle',
  query: '',
  seq: 0,
  results: [],
};

export type FileSearchAction =
  | { type: 'query-changed'; query: string; seq: number }
  | { type: 'resolved'; seq: number; results: string[] }
  | { type: 'failed'; seq: number }
  | { type: 'closed' };

/**
 * Pure reducer. `resolved`/`failed` are gated by `seq`: an action tagged
 * with anything other than the CURRENT sequence means a newer query has
 * already superseded it — dropped as a no-op (same state reference
 * returned, so no wasted re-render either).
 */
export function reduceFileSearch(state: FileSearchState, action: FileSearchAction): FileSearchState {
  switch (action.type) {
    case 'query-changed':
      return { status: 'loading', query: action.query, seq: action.seq, results: [] };
    case 'resolved':
      if (action.seq !== state.seq) return state;
      return { ...state, status: 'success', results: action.results };
    case 'failed':
      if (action.seq !== state.seq) return state;
      return { ...state, status: 'error', results: [] };
    case 'closed':
      return INITIAL_FILE_SEARCH_STATE;
    default:
      return state;
  }
}

// ---- debounce gate -----------------------------------------------------

/**
 * Sequence-tagged debounce gate — the same shape as
 * `src/autocomplete/debouncer.ts`'s `AutocompleteDebouncer` (Continue's
 * `AutocompleteDebouncer`), reproduced here (not imported) so the webview
 * bundle stays self-contained and never reaches across into host-side
 * `src/autocomplete/*`. Each call is tagged with a monotonically increasing
 * sequence number; after `delayMs` it resolves `true` ("you were superseded
 * — do not fire") unless it is STILL the most recent call, in which case it
 * resolves `false` ("proceed, fire the RPC now").
 */
export class FileSearchDebouncer {
  private sequence = 0;

  async delayAndShouldDrop(delayMs: number): Promise<boolean> {
    const mine = ++this.sequence;
    return new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(mine !== this.sequence), delayMs);
    });
  }
}
