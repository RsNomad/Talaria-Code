/* Shared scaffolding for side panels: a telemetry header + scroll body. */
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon';
import type { RemoteData } from '../state/remoteData';

interface PanelShellProps {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}

export function PanelShell({ title, meta, children }: PanelShellProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between px-3 py-2.5">
        <span className="h-eyebrow">{title}</span>
        {meta && <span className="font-mono text-2xs text-faint">{meta}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">{children}</div>
    </div>
  );
}

export function EmptyPanel({ hint }: { hint: string }) {
  return <div className="px-1 py-6 text-center text-xs text-faint">{hint}</div>;
}

/**
 * `id`, when given, is ALSO applied as `tabIndex={-1}` — beta.6 T18 (§3.5,
 * B-F6): the recs strip's `Set up →` jump moves focus to the owning card's
 * heading after `scrollIntoView`, and a heading needs to be programmatically
 * focusable to receive it. Every existing caller omits `id` and is
 * byte-for-byte unaffected (optional, defaults to `undefined`).
 */
export function SectionLabel({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div id={id} tabIndex={id !== undefined ? -1 : undefined} className="h-eyebrow mb-1.5 mt-3 first:mt-0">
      {children}
    </div>
  );
}

/**
 * TI-3 (AU-42 Part B): a background-refresh failure over data already
 * showing — never a first-load failure (that's still `PanelError` below).
 * `message` is the failure text (`AppState.refreshError[panel]`); `onRetry`
 * re-runs the panel fetch (the SAME handler `RemotePanelProps.onRetry`
 * already carries — callers reuse it); `onDismiss` clears the side-map entry.
 */
export interface RefreshErrorBanner {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}

interface RemotePanelProps<T> {
  /** The panel's RemoteData; `undefined` is treated as idle (not yet fetched). */
  remote: RemoteData<T> | undefined;
  /** Hint shown while idle/loading (e.g. "Loading tools…"). */
  loadingHint: string;
  /** Re-invoke the fetch (wired to `fetchPanel` for this panel). */
  onRetry: () => void;
  /**
   * TI-3 (AU-42 Part B): when set AND `remote.status === 'success'`, renders
   * a dismissible banner above the resolved children instead of silently
   * showing nothing about the background failure. Omitted (or `undefined`)
   * renders exactly as before — every existing caller that doesn't pass this
   * prop is byte-for-byte unaffected.
   */
  refreshError?: RefreshErrorBanner;
  /** Rendered ONLY in the success state, with the resolved data. */
  children: (data: T) => ReactNode;
}

/**
 * Centralized loading/error/retry gate for every data panel (Part X2). Panels
 * no longer each hand-roll a `if (!data) return <Loading/>` — they render their
 * success body inside this wrapper, which honestly shows Loading (idle/loading)
 * or an Error card + Retry (error) instead of spinning forever when an invoke
 * rejects. Modelled on the "map query state → UI once" pattern (TanStack Query
 * `matchQueryStatus`). Success delegates entirely to `children(data)`, so each
 * panel keeps its own `PanelShell` header/meta.
 */
export function RemotePanel<T>({ remote, loadingHint, onRetry, refreshError, children }: RemotePanelProps<T>) {
  const status = remote?.status ?? 'idle';
  if (status === 'error' && remote?.status === 'error') {
    return <PanelError message={remote.error.message} retryable={remote.error.retryable} onRetry={onRetry} />;
  }
  if (remote?.status === 'success') {
    return (
      <>
        {refreshError && (
          <RefreshErrorNotice
            message={refreshError.message}
            onRetry={refreshError.onRetry}
            onDismiss={refreshError.onDismiss}
          />
        )}
        {children(remote.data)}
      </>
    );
  }
  // idle | loading
  // B5 (M-4): announce "busy" for screen readers while the fetch is in
  // flight — this wrapper is local to the loading branch; success/error
  // paths and `EmptyPanel` itself (shared by genuine non-loading empty
  // states) are untouched.
  return (
    <div role="status" aria-busy="true">
      <EmptyPanel hint={loadingHint} />
    </div>
  );
}

/**
 * TI-3 (AU-42 Part B): the dismissible "stale data, refresh failed" banner —
 * same tokens-only vocabulary as `PanelError` below (border-del/bg-del-soft
 * for the message, a bordered Retry button), not a restyle. `role="status"`
 * directly on the container (no separate `LiveRegion`, matching this file's
 * own loading-branch idiom just above) — the banner mounts/unmounts with
 * `refreshError` itself, so there is no stable "permanently mounted" slot to
 * route through a text-swapping LiveRegion the way a per-row notice does.
 */
function RefreshErrorNotice({ message, onRetry, onDismiss }: RefreshErrorBanner) {
  return (
    <div
      role="status"
      className="mx-3 mb-2 mt-2 flex flex-none items-start gap-2 rounded-card border border-del bg-del-soft px-3 py-2 text-2xs text-fg"
    >
      <Icon name="error" size={13} className="mt-0.5 flex-none text-del" />
      <span className="min-w-0 flex-1">
        <div className="break-words">Couldn’t refresh — showing last loaded data.</div>
        {/* The underlying reason, same "never hide the real message" posture
            as `PanelError`'s own two-line headline+detail grammar below. */}
        <div className="mt-0.5 font-mono text-2xs text-faint break-words">{message}</div>
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="flex-none rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:border-accent hover:text-accent"
      >
        Retry
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="flex-none rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted hover:border-accent hover:text-accent"
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

function PanelError({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
      <Icon name="error" size={20} className="text-del" />
      <div className="text-xs text-fg">Couldn’t load this panel</div>
      <div className="max-w-[26rem] font-mono text-2xs text-faint">{message}</div>
      {retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 flex items-center gap-1.5 rounded border border-border px-2.5 py-1 font-mono text-2xs text-muted hover:border-accent hover:text-accent"
        >
          <Icon name="refresh" size={12} />
          Retry
        </button>
      )}
    </div>
  );
}
