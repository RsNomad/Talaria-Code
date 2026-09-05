/*
 * A11Y-07 (WCAG 4.1.3 / APG dialog): the ONE inline destructive-consent
 * strip. Before this component, every confirm strip (SessionsPanel C4,
 * CheckpointsPanel restore/redo, GatewayHealthBanner 12b) mounted silently:
 * no dialog role, no focus move — an SR user perceived a dead click at a
 * CONSENT surface. Contract: role="alertdialog" (assertive by definition —
 * this interrupts precisely because proceeding destroys work), named by
 * `ariaLabel`, described by the message; focus moves to the confirm control
 * on mount; Escape cancels. ADR-UX-P2-1: EVERY way out (confirm, cancel,
 * Escape) hands focus to the TRIGGER via `returnFocus` — the trigger must
 * stay focusable while its request is in flight (busyInteraction posture),
 * so confirm's landing reads "…ing" + aria-busy. aria-modal is deliberately
 * NOT set: nothing outside the strip is inert (this is an inline, page-flow
 * dialog), and claiming modality we don't enforce would be a lie to AT.
 * Visual grammar: byte-identical warn-strip tokens the inline copies used.
 */
import { useEffect, useId, useRef } from 'react';
import { Icon } from './Icon';
import { busyInteraction } from './busyInteraction';

export function ConfirmStrip({
  message,
  confirmLabel,
  ariaLabel,
  onConfirm,
  onCancel,
  returnFocus,
  confirmBusy,
  className,
}: {
  message: string;
  confirmLabel: string;
  ariaLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** ADR-UX-P2-1: hand focus back to the strip's TRIGGER control — called on
   *  confirm, cancel, and Escape alike. The trigger must be busy-focusable. */
  returnFocus: () => void;
  /** Optional in-flight gate for the confirm button (CheckpointsPanel rows). */
  confirmBusy?: boolean | undefined;
  className?: string | undefined;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const msgId = useId();
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  const confirmInteraction = busyInteraction(false, confirmBusy);
  return (
    <div
      role="alertdialog"
      aria-label={ariaLabel}
      aria-describedby={msgId}
      className={`rounded border border-warn bg-warn-soft px-2 py-1.5 ${className ?? ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
          returnFocus();
        }
      }}
    >
      <div className="flex items-start gap-1.5 text-2xs text-fg">
        <Icon name="warning" size={12} className="mt-0.5 flex-none text-warn" />
        <span id={msgId}>{message}</span>
      </div>
      <div className="mt-1.5 flex gap-2">
        <button
          ref={confirmRef}
          type="button"
          disabled={confirmInteraction.nativeDisabled}
          aria-disabled={confirmInteraction.ariaDisabled}
          aria-busy={confirmInteraction.ariaBusy}
          onClick={() => {
            if (!confirmInteraction.interactive) return;
            onConfirm();
            returnFocus();
          }}
          className="rounded border border-warn px-2 py-0.5 font-mono text-2xs text-warn hover:bg-overlay aria-disabled:cursor-default aria-disabled:opacity-50"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            onCancel();
            returnFocus();
          }}
          className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
