/*
 * Sessions / history panel: browse past ACP sessions (title / cwd / relative
 * age); clicking a row issues a `tab.load` round trip (W4-T5b — replaces the
 * legacy tabId-less `session.load` control invocation) — the host calls ACP
 * `session/load` INTO the caller's active tab, and the replayed transcript
 * arrives through the EXISTING `session/update` -> chat-transcript streaming
 * pipeline (no new payload type for the transcript itself; this panel only
 * ever renders the browsable list).
 */
import { useRef, useState } from 'react';
import type { SessionSummary, SessionsData, WebviewToHost } from '../protocol';
import { busyInteraction } from '../components/busyInteraction';
import { ConfirmStrip } from '../components/ConfirmStrip';
import { Icon } from '../components/Icon';
import { Pill } from '../components/Pill';
import { EmptyPanel, PanelShell } from './PanelShell';
import { loadMoreFooterState } from '../state/panels';
import { relativeAge } from '../relativeAge';

/** beta.7 B1: the one untitled-session display string — the row render AND
 *  loadTabMessage send the SAME text, so the tab chip always shows exactly
 *  what the user clicked. */
const UNTITLED_SESSION_LABEL = 'Untitled session';

/** W4-T5b: the `tab.load` message a History row's click posts — routes the
 * load through the ACTIVE tab (`tabId`) instead of the legacy tabId-less
 * `session.load` invocation, so History-load-into-a-CHOSEN-tab is reachable.
 * Pure (no host calls) so the click's payload is unit-testable without a DOM. */
export function loadTabMessage(
  tabId: string,
  session: Pick<SessionSummary, 'id' | 'cwd' | 'title'>,
): Extract<WebviewToHost, { type: 'tab.load' }> {
  return {
    type: 'tab.load',
    tabId,
    sessionId: session.id,
    cwd: session.cwd,
    title: session.title || UNTITLED_SESSION_LABEL,
  };
}

interface SessionsPanelProps {
  data: SessionsData;
  /** The tab a History row's load targets — always the caller's currently active tab. */
  activeTabId: string;
  /**
   * C4: every session id currently bound to an open tab (`TabState.sessionId`
   * across `state.tabs`). A row whose session is already loaded somewhere
   * gets an "Open" {@link Pill} + `aria-current="true"` — this is a DISPLAY
   * marker only, never a click gate (loading an already-open session into a
   * DIFFERENT tab is a legitimate action; only a live turn in the ACTIVE tab
   * blocks the click, see {@link activeTabHasLiveTurn}).
   */
  boundSessionIds: ReadonlySet<string>;
  /**
   * C4: whether the active tab (the one a row's load targets, per
   * {@link activeTabId}) has a turn in flight. When true, a row click no
   * longer calls {@link onLoad} directly — it opens an inline "Load anyway"
   * confirm strip first, so a click cannot silently replace a live
   * conversation (CheckpointsPanel's dirty-worktree confirm precedent).
   */
  activeTabHasLiveTurn: boolean;
  /** Row click -> `tab.load` for {@link activeTabId} (fire-and-forget; the transcript replays via streaming). */
  onLoad: (message: Extract<WebviewToHost, { type: 'tab.load' }>) => void;
  /**
   * TI-1 (AU-39): the session id of the ONE row currently mid-load
   * (`AppState.pendingSessionLoad.sessionId`), or `undefined` when nothing is
   * loading. Drives that row's `busyInteraction` posture — set the moment
   * `onLoad` actually fires (never on just opening the confirm strip below),
   * cleared by the App-level reducer once the host's terminal `tab.bound`/
   * `tab.error` for that load's tabId lands.
   */
  loadingSessionId?: string | undefined;
  /** A#7: "Load more" over the CORRELATED path (loading state + failure surfaces). */
  onLoadMore: (cursor: string) => void;
  /** Whether a "Load more" request is currently in flight. */
  loadingMore: boolean;
  /** BF-A: the most recent "Load more" failure, if any — kept OUT of `data`'s
   *  RemoteData so a failed append never wipes the list above. `undefined`
   *  when idle or after a successful retry. */
  loadMoreError?: string;
}

export function SessionsPanel({
  data,
  activeTabId,
  boundSessionIds,
  activeTabHasLiveTurn,
  onLoad,
  loadingSessionId,
  onLoadMore,
  loadingMore,
  loadMoreError,
}: SessionsPanelProps) {
  /**
   * C4: which row (by session id) is currently asking "Load anyway?" — at
   * most one at a time (mirrors CheckpointsPanel's `confirming` state).
   * Clicking a DIFFERENT row's confirm-gated button simply reassigns this,
   * which implicitly collapses whichever strip was open before.
   */
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined);
  /** A11Y-07 (task-8-brief.md): the row button `returnFocus` lands on — only
   *  ONE row can be confirming at a time (`confirmingId` above), so a single
   *  ref conditionally attached to whichever row is confirming (`ref={isConfirming
   *  ? confirmTriggerRef : undefined}` below) is enough; the busy posture
   *  (TI-1/AU-39) keeps that row's button focusable even once `loadingSessionId`
   *  marks it after confirm fires the load. */
  const confirmTriggerRef = useRef<HTMLButtonElement | null>(null);

  if (data.sessions.length === 0) {
    return (
      <PanelShell title="History">
        <EmptyPanel hint="No past sessions yet." />
      </PanelShell>
    );
  }

  const loadSession = (session: SessionSummary) => onLoad(loadTabMessage(activeTabId, session));

  /** A live turn in the active tab means the click asks first instead of
   *  loading straight away — replacing an in-progress conversation is the
   *  serious-consequence case a confirmation exists for (NN/g: "Use a
   *  confirmation dialog before committing to actions with serious
   *  consequences — such as destroying users' work",
   *  https://www.nngroup.com/articles/confirmation-dialog/, fetched this
   *  run). With no live turn, behavior is unchanged. */
  const handleRowClick = (session: SessionSummary) => {
    if (activeTabHasLiveTurn) {
      setConfirmingId(session.id);
      return;
    }
    loadSession(session);
  };

  const confirmLoad = (session: SessionSummary) => {
    setConfirmingId(undefined);
    loadSession(session);
  };

  return (
    <PanelShell title="History" meta={`${data.sessions.length} sessions`}>
      {/* Task 19 (WCAG 1.3.1, WV4-MIN): the row collection was `div` soup —
          no `role="list"`/`role="listitem"` at all, so AT could not count or
          navigate rows as a set. The "Load more" footer below is a distinct,
          non-row control and stays OUTSIDE this list element. */}
      <div role="list">
        {data.sessions.map((s) => {
          const age = relativeAge(s.updatedAt);
          const isBound = boundSessionIds.has(s.id);
          const isConfirming = confirmingId === s.id;
          // TI-1 (AU-39): busy, never natively disabled — a loading row must
          // stay focusable (busyInteraction.ts's own rationale) and the
          // click-guard below (`interactive`) is what actually blocks a
          // double-post, not the native attribute (which stays permanently
          // `false` here, mirroring the "Load more" footer button above).
          const isLoading = loadingSessionId === s.id;
          const rowInteraction = busyInteraction(false, isLoading);
          return (
            <div key={s.id} role="listitem" className="mb-1.5">
              <button
                type="button"
                ref={isConfirming ? confirmTriggerRef : undefined}
                onClick={() => {
                  if (!rowInteraction.interactive) return;
                  handleRowClick(s);
                }}
                disabled={rowInteraction.nativeDisabled}
                aria-disabled={rowInteraction.ariaDisabled}
                aria-busy={rowInteraction.ariaBusy}
                aria-current={isBound ? 'true' : undefined}
                className="flex w-full items-start gap-2 rounded-card border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-accent disabled:cursor-default disabled:opacity-60 aria-disabled:cursor-default aria-disabled:opacity-60"
              >
                <Icon
                  name={isLoading ? 'loading' : 'comment-discussion'}
                  size={15}
                  spin={isLoading}
                  className="mt-0.5 flex-none text-muted"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-[12.5px] font-semibold text-fg">
                      {s.title || UNTITLED_SESSION_LABEL}
                    </span>
                    {isBound && (
                      <span className="ml-auto flex-none">
                        <Pill tone="accent">Open</Pill>
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 font-mono text-2xs text-faint">
                    <span className="min-w-0 truncate">{s.cwd}</span>
                    {age && (
                      <>
                        <span className="flex-none">·</span>
                        <span className="flex-none">{age}</span>
                      </>
                    )}
                  </div>
                </div>
              </button>

              {isConfirming && (
                <ConfirmStrip
                  className="mt-1"
                  ariaLabel="Confirm load"
                  message="Loading this will replace the conversation currently running in this tab."
                  confirmLabel="Load anyway"
                  onConfirm={() => confirmLoad(s)}
                  onCancel={() => setConfirmingId(undefined)}
                  returnFocus={() => confirmTriggerRef.current?.focus()}
                />
              )}
            </div>
          );
        })}
      </div>

      {(() => {
        // BF-A: the footer's tri-state (+hidden) is decided by the pure
        // `loadMoreFooterState` (state/panels.ts) — a failed append (`error`)
        // renders BELOW the still-intact list above, never in place of it.
        const footer = loadMoreFooterState(!!data.nextCursor, loadingMore, loadMoreError);
        if (footer === 'hidden') return null;

        if (footer === 'error') {
          return (
            <div className="mt-1 flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => data.nextCursor && onLoadMore(data.nextCursor)}
                className="flex w-full items-center justify-center gap-2 rounded-card border border-del py-2.5 font-mono text-2xs uppercase tracking-wide text-del hover:bg-del-soft"
              >
                <Icon name="refresh" size={13} />
                Retry
              </button>
              <span className="max-w-full truncate font-mono text-2xs text-faint">
                Couldn’t load more — {loadMoreError}
              </span>
            </div>
          );
        }

        const loading = footer === 'loading';
        // AU-40: purely in-flight — nothing genuinely-indefinite gates this
        // button (the footer's `hidden`/`error` states render different JSX
        // entirely, above).
        const loadMoreInteraction = busyInteraction(false, loading);
        return (
          <button
            type="button"
            disabled={loadMoreInteraction.nativeDisabled}
            aria-disabled={loadMoreInteraction.ariaDisabled}
            aria-busy={loadMoreInteraction.ariaBusy}
            onClick={() => {
              // AU-40: guard replacing the native `disabled` this button
              // used to rely on to block a second click while in flight.
              if (!loadMoreInteraction.interactive) return;
              if (data.nextCursor) onLoadMore(data.nextCursor);
            }}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60 disabled:hover:border-border disabled:hover:text-muted aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:border-border aria-disabled:hover:text-muted"
          >
            <Icon name={loading ? 'loading' : 'chevron-down'} size={13} spin={loading} />
            {loading ? 'Loading…' : 'Load more'}
          </button>
        );
      })()}
    </PanelShell>
  );
}
