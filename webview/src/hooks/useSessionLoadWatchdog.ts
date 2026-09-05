import { useEffect } from 'react';

export const SESSION_LOAD_WATCHDOG_MS = 130_000;

/** UX-04b: pendingSessionLoad's spinner had NO deadline — a wedged tab.load
 * spun forever. One timer per pending load; the host's terminal
 * (tab.bound/tab.error) clears pendingSessionLoad and thereby disarms us. */
export function useSessionLoadWatchdog(
  pending: { tabId: string; sessionId: string } | undefined,
  onTimeout: () => void,
  ms: number = SESSION_LOAD_WATCHDOG_MS,
): void {
  useEffect(() => {
    if (pending === undefined) return;
    const t = setTimeout(onTimeout, ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the
    // load's IDENTITY, not the callback (App recreates onTimeout per render).
  }, [pending?.tabId, pending?.sessionId, ms]);
}
