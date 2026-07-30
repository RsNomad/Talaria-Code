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

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="h-eyebrow mb-1.5 mt-3 first:mt-0">{children}</div>;
}

interface RemotePanelProps<T> {
  /** The panel's RemoteData; `undefined` is treated as idle (not yet fetched). */
  remote: RemoteData<T> | undefined;
  /** Hint shown while idle/loading (e.g. "Loading tools…"). */
  loadingHint: string;
  /** Re-invoke the fetch (wired to `fetchPanel` for this panel). */
  onRetry: () => void;
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
export function RemotePanel<T>({ remote, loadingHint, onRetry, children }: RemotePanelProps<T>) {
  const status = remote?.status ?? 'idle';
  if (status === 'error' && remote?.status === 'error') {
    return <PanelError message={remote.error.message} retryable={remote.error.retryable} onRetry={onRetry} />;
  }
  if (remote?.status === 'success') {
    return <>{children(remote.data)}</>;
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
