/*
 * FI-36 (feeds FI-04): the shared chrome behind App.tsx's 3 duplicated
 * standing status/recovery rows — openFailed/Reconnect (G-9), sessionLost/
 * History (ARCH-1), and newSessionPending (UX-04a, no action). Each caller
 * keeps its own visibility GATE inline (they are different `tab` predicates,
 * not this component's concern); this component owns only the shared div/
 * icon/message/[button] shape so the three rows cannot drift from one
 * another one className at a time. BEHAVIOUR-PRESERVING extraction — the
 * rendered DOM is byte-identical to the 3 rows this replaces.
 *
 * `icon.className` is REQUIRED (not optional): all 3 real call sites always
 * supply one, and Icon's own `className?: string` prop (`Icon.tsx`) is not
 * itself typed `string | undefined`, so forwarding a possibly-`undefined`
 * value into it would fail under `exactOptionalPropertyTypes` (this project
 * runs it, `webview/tsconfig.json`) — matching App.tsx's own documented
 * precedent for this exact class of problem (`App.tsx`, the `hiddenCount`/
 * `loadNotice` comments). Making the field honestly required, rather than
 * reaching for a banned `{ ...x }` conditional spread, sidesteps the issue
 * without any coercion. `icon.spin` stays optional and forwards straight
 * through: Icon's own `spin` prop is already explicitly typed
 * `boolean | undefined`, so no adapter is needed there either.
 */
import { Icon } from './Icon';

export function RecoveryRow({
  icon,
  message,
  action,
}: {
  icon: { name: string; spin?: boolean | undefined; className: string };
  message: string;
  /** Omitted entirely (key omission, not `undefined`) for the newSessionPending row — it has no action. */
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-2xs text-muted">
      <Icon name={icon.name} size={12} spin={icon.spin} className={icon.className} />
      <span className="min-w-0 flex-1">{message}</span>
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onClick}
          className="flex-none rounded border border-border px-1.5 py-0.5 text-2xs text-fg hover:bg-overlay"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
