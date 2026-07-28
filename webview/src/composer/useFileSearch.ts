/*
 * `@file`/`@folder` async submenu — the React hook-core wiring the pure
 * pieces in `fileSearch.ts` (`FileSearchDebouncer`, `reduceFileSearch`)
 * together with the `context.searchFiles` RPC. Deliberately thin and NOT
 * separately unit tested (same split/justification as `useSuggest.ts`: this
 * repo's vitest has no jsdom/RTL environment, so a real hook render is
 * build-blind); its correctness follows from the pure, exhaustively-tested
 * functions it calls plus `npm run build`.
 */
import { useEffect, useReducer, useRef } from 'react';
import { FileSearchDebouncer, INITIAL_FILE_SEARCH_STATE, reduceFileSearch, type FileSearchState } from './fileSearch';

/** Debounce window before a path-pick query actually fires the RPC (§3.1: "~150-200ms"). */
export const FILE_SEARCH_DEBOUNCE_MS = 180;
/** Page size for the submenu — the host still hard-caps at 200 regardless (`SEARCH_FILES_HARD_CAP`). */
export const FILE_SEARCH_MAX_RESULTS = 30;

/**
 * `query`: the partial path typed after `@file:`/`@folder:` — `null` means
 * "not in path-pick mode right now", which resets to idle and fires nothing.
 * `searchFiles`: the `context.searchFiles` RPC, threaded down from `App.tsx`
 * (see `bridge.request` — kept as an injected function, not a direct bridge
 * import, so Composer.tsx stays testable/mockable in principle and the
 * bridge singleton isn't reached for from deep inside a leaf component).
 *
 * Held in a ref (not an effect dependency) so a caller re-rendering with a
 * behaviorally-identical but referentially-new `searchFiles` closure never
 * re-fires the effect on its own — only an actual `query` change does.
 */
export function useFileSearch(
  query: string | null,
  searchFiles: (query: string, maxResults?: number) => Promise<string[]>,
): FileSearchState {
  const [state, dispatch] = useReducer(reduceFileSearch, INITIAL_FILE_SEARCH_STATE);
  const seqRef = useRef(0);
  // `useRef`'s initial-value argument is only ever consumed on the FIRST
  // render (React discards it on every re-render), so this stays a single,
  // stable debouncer for the component's lifetime despite the `new` call
  // appearing in the render body.
  const debouncerRef = useRef(new FileSearchDebouncer());
  const searchFilesRef = useRef(searchFiles);
  searchFilesRef.current = searchFiles;

  useEffect(() => {
    if (query === null) {
      dispatch({ type: 'closed' });
      return;
    }
    const seq = ++seqRef.current;
    dispatch({ type: 'query-changed', query, seq });
    let cancelled = false;

    void debouncerRef.current.delayAndShouldDrop(FILE_SEARCH_DEBOUNCE_MS).then((shouldDrop) => {
      if (shouldDrop || cancelled) return;
      searchFilesRef
        .current(query, FILE_SEARCH_MAX_RESULTS)
        .then((results) => {
          if (!cancelled) dispatch({ type: 'resolved', seq, results });
        })
        .catch(() => {
          if (!cancelled) dispatch({ type: 'failed', seq });
        });
    });

    return () => {
      cancelled = true;
    };
  }, [query]);

  return state;
}
