/*
 * ErrorBanner — the dismissible error strip shown above the transcript.
 * Extracted from App.tsx (Task 22): App.tsx rendered two near-identical
 * copies of this markup inline (the connection-wide `systemError` banner and
 * the per-tab `error` banner, the second with an optional Retry action for an
 * `'open-failed'` tab). One component removes the duplication.
 */
import { Icon } from './Icon';

export interface ErrorBannerRetry {
  label: string;
  onClick: () => void;
}

interface ErrorBannerProps {
  message: string;
  detail?: string;
  /** Audit G-6 (WCAG 2.2 SC 4.1.2): the dismiss button below contains only an
   * <Icon>, so without an explicit accessible name a screen reader announced
   * "button" and nothing else. Required (not optional) so a future caller
   * cannot reintroduce the gap by omission. */
  dismissLabel: string;
  onDismiss: () => void;
  /** Present only for the tab-error banner's `'open-failed'` case. */
  retry?: ErrorBannerRetry;
}

export function ErrorBanner({ message, detail, dismissLabel, onDismiss, retry }: ErrorBannerProps) {
  return (
    // UI I-6 (WCAG 2.2 SC 4.1.3): this banner is conditionally mounted by the
    // caller with its message already populated, so `role="alert"` is used
    // directly rather than the mounted-empty-then-filled `role="status"`
    // pattern — MDN Live_regions documents alert as the one live role that
    // announces content present at mount/injection time. No extra
    // `aria-live="assertive"` alongside it (MDN: doubles the announcement).
    // Precedent: ErrorBoundary.tsx's fallback uses the same bare role="alert".
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-del bg-del-soft px-3 py-2 text-xs text-fg"
    >
      <Icon name="error" size={14} className="mt-0.5 flex-none text-del" />
      <div className="min-w-0 flex-1">
        <div>{message}</div>
        {detail && <div className="text-2xs text-muted">{detail}</div>}
      </div>
      {retry && (
        <button
          type="button"
          onClick={retry.onClick}
          className="flex-none rounded border border-del px-1.5 py-0.5 text-2xs text-del hover:bg-del-soft"
        >
          {retry.label}
        </button>
      )}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="flex-none rounded p-0.5 text-faint hover:text-fg"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
