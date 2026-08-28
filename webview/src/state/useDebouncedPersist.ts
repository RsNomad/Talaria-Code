import { useEffect, useRef, type DependencyList } from 'react';
import { bridge } from '../bridge';

/**
 * CA-10: coalesce per-render webview-state writes. `bridge.setState` has no
 * per-token durability contract — VS Code persists the LATEST state when the
 * webview is hidden / across editor restarts (Context7: vscode-api webview
 * state) — so writing on every streaming delta is wasted work. This schedules
 * a single trailing write `delayMs` after `deps` last changed, and flushes
 * IMMEDIATELY when the document becomes hidden (the exact moment VS Code
 * snapshots webview state) and on unmount — so no update is ever lost, only
 * coalesced. `deps` are threaded to the scheduling effect unchanged, so the
 * decision of WHEN to persist is byte-identical to the direct write; only the
 * execution is debounced.
 */
export function useDebouncedPersist<T>(
  buildSnapshot: () => T,
  deps: DependencyList,
  delayMs: number,
): void {
  const buildRef = useRef(buildSnapshot);
  buildRef.current = buildSnapshot;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flushRef = useRef<() => void>(() => undefined);
  flushRef.current = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    bridge.setState(buildRef.current());
  };

  // Trailing debounce keyed on the SAME deps the direct write used.
  useEffect(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      bridge.setState(buildRef.current());
    }, delayMs);
    return () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Immediate flush on hidden + unmount — the two moments a pending trailing
  // write must not be dropped. Mount-once; reads live refs.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      flushRef.current();
    };
  }, []);
}
