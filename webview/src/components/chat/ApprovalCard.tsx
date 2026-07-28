/*
 * Permission prompt. Warn-tinted so it stands out in the transcript. Once the
 * user picks an option (or the card SETTLES some other way) it locks and
 * shows the outcome.
 * ------------------------------------------------------------------
 * The shared `ApprovalOption.kind` is a PERMISSION kind (allow_once / deny / …),
 * not a visual emphasis — so button styling is derived from it here: deny*
 * reads as destructive, allow_once as the primary action, the rest as
 * neutral.
 * ------------------------------------------------------------------
 * T-A2 (audit-2 Cluster A, closes V-6/V-7 user-visible; renders the settled
 * state T-A0/T-A1 already ship). RENDER PRECEDENCE (wave-3 architect
 * refinement, exact — `settledOutcome` is checked FIRST, ahead of the
 * optimistic `resolvedOptionId`, so a host settlement can never be shadowed
 * by a stale optimistic value):
 *   ① settledOutcome === 'selected'     -> "Responded: {label}"
 *   ② any OTHER settledOutcome          -> terminal copy, ZERO buttons
 *   ③ resolvedOptionId set (optimistic) -> "Responded: {label}"
 *   ④ component-local one-shot expiry   -> expired copy, ZERO buttons
 *   ⑤ else                              -> live buttons + static deadline line
 * Buttons render ONLY at ⑤. A settled/expired card REPLACES the buttons with
 * outcome text rather than leaving a disabled-looking-but-present control row
 * (MDN aria-disabled: disabled semantics must not hide state from AT).
 *
 * The deadline line is STATIC — no ticking counter. A 100 ms re-render inside
 * the `role="log"` transcript is the exact WCAG 2.2.2 / uiux-F7 anti-pattern
 * (ARIA's own `timer` role implies `aria-live="off"` for the same reason: a
 * ticking value must not announce). The component-local `setTimeout` below
 * is DISPLAY-ONLY and one-shot: it exists only so the buttons still disappear
 * on time even if the host's `approval.settle` push is late or the webview
 * throttled its own clock while hidden — the host push remains the sole
 * authority and always overrides this local guess the instant it lands
 * (③/② out-rank ④ in the precedence above).
 *
 * WCAG 2.2.1 (Timing Adjustable) note (T-20 hygiene sweep): the timeout this
 * deadline line announces is HARNESS-FIXED at 60s
 * (`DEFAULT_APPROVAL_TIMEOUT_MS`, `host/backend/acp/permission.ts`) and
 * security-essential — it is the fail-closed consent boundary (no response
 * within the window = deny), not a UI convenience, so this component offers
 * no way to extend or turn it off. Full SC 2.2.1 conformance would require
 * the harness itself to put an adjustable/extendable deadline on the wire;
 * that is an owner/harness item, documented here rather than silently
 * ignored.
 */
import { useEffect, useState } from 'react';
import type { ApprovalItem } from '../../types';
import type { ApprovalOption } from '../../protocol';
import { Icon } from '../Icon';
import type { ReactNode } from 'react';

interface ApprovalCardProps {
  item: ApprovalItem;
  onRespond: (optionId: string) => void;
}

function emphasis(kind: ApprovalOption['kind']): 'primary' | 'danger' | 'default' {
  if (kind === 'deny' || kind === 'deny_always') return 'danger';
  if (kind === 'allow_once') return 'primary';
  return 'default';
}

/** "1 second" / "60 seconds" — correct singular/plural for the deadline copy
 * (review A2-M1: the ratified template read "{s} seconds", wrong at 1 s). */
function secondsPhrase(timeoutMs: number): string {
  const s = Math.round(timeoutMs / 1000);
  return `${s} second${s === 1 ? '' : 's'}`;
}

/** `Expired — automatically denied after {n seconds} without a response`;
 * falls back to a deadline-free sentence if the wire never carried
 * `timeoutMs` (never fabricate a number the host didn't send). */
function expiredCopy(timeoutMs?: number): string {
  if (timeoutMs === undefined) return 'Expired — automatically denied without a response';
  return `Expired — automatically denied after ${secondsPhrase(timeoutMs)} without a response`;
}

/** Terminal copy for every settled outcome OTHER than 'selected' (precedence
 * ②) — exact strings from the wave-3 architect's Exa/VS-Code/NN.g-grounded
 * copy pass. */
function terminalCopy(outcome: 'cancelled' | 'expired' | 'superseded', timeoutMs?: number): string {
  switch (outcome) {
    case 'cancelled':
      return 'Cancelled — the turn ended before a response';
    case 'expired':
      return expiredCopy(timeoutMs);
    case 'superseded':
      return 'No longer awaiting a response';
  }
}

/** Precedence ① and ③: "Responded: {label}" — the pre-existing resolved
 * grammar, now shared by both the authoritative-selected and the
 * still-optimistic paths. */
function RespondedRow({ optionId, options }: { optionId: string; options: ApprovalOption[] }) {
  const chosen = options.find((o) => o.id === optionId);
  return (
    <div className="flex items-center gap-1.5 font-mono text-2xs text-muted">
      <Icon name="check" size={12} className="text-add" />
      Responded: {chosen?.label ?? optionId}
    </div>
  );
}

/** Precedence ② and ④: a terminal outcome the user never chose — no green
 * check (nothing was "responded"), a neutral/warn icon depending on tone. */
function TerminalRow({ text, icon, tone }: { text: string; icon: string; tone: string }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-2xs text-muted">
      <Icon name={icon} size={12} className={tone} />
      {text}
    </div>
  );
}

/** Precedence ⑤: the live action buttons plus the STATIC deadline line
 * (omitted entirely when `timeoutMs` is absent). */
function LiveRow({
  options,
  timeoutMs,
  onRespond,
}: {
  options: ApprovalOption[];
  timeoutMs: number | undefined;
  onRespond: (optionId: string) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const emp = emphasis(opt.kind);
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onRespond(opt.id)}
              className={`rounded border px-2.5 py-1 text-2xs font-semibold ${
                emp === 'primary'
                  ? 'border-accent bg-accent text-accent-fg hover:opacity-90'
                  : emp === 'danger'
                    ? 'border-border text-del hover:bg-del-soft'
                    : 'border-border text-muted hover:bg-overlay'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {timeoutMs !== undefined && (
        <div className="font-mono text-2xs text-faint">
          Auto-denies if not answered (about {secondsPhrase(timeoutMs)})
        </div>
      )}
    </>
  );
}

export function ApprovalCard({ item, onRespond }: ApprovalCardProps) {
  const [expiredLocal, setExpiredLocal] = useState(false);
  const isLive = item.settledOutcome === undefined && item.resolvedOptionId === undefined;

  // T-A2 (V-6): a one-shot, display-only local deadline. Armed ONLY while
  // the card is genuinely live and a timeout is known; cleared on unmount
  // and re-evaluated (cleanup + no re-arm) the instant the card stops being
  // live — StrictMode-safe (pure effect, no wall-clock read on the reducer
  // side per T-A1's doc) and leak-free (cleared on every path out).
  useEffect(() => {
    if (!isLive || item.timeoutMs === undefined) return;
    const timer = setTimeout(() => setExpiredLocal(true), item.timeoutMs);
    return () => clearTimeout(timer);
  }, [isLive, item.timeoutMs]);

  let body: ReactNode;
  if (item.settledOutcome === 'selected') {
    // ① authoritative "selected" — resolvedOptionId is always set alongside
    // it by the reducer, but fall back to the raw id if it somehow isn't.
    body = <RespondedRow optionId={item.resolvedOptionId ?? ''} options={item.options} />;
  } else if (
    item.settledOutcome === 'cancelled' ||
    item.settledOutcome === 'expired' ||
    item.settledOutcome === 'superseded'
  ) {
    // ② any other authoritative settlement out-ranks a stale optimistic
    // resolvedOptionId (the reducer already cleared it, but the component
    // must not depend on that reducer courtesy — this check comes first).
    const outcome = item.settledOutcome;
    const icon = outcome === 'expired' ? 'warning' : outcome === 'cancelled' ? 'close' : 'info';
    const tone = outcome === 'expired' ? 'text-warn' : 'text-faint';
    body = <TerminalRow text={terminalCopy(outcome, item.timeoutMs)} icon={icon} tone={tone} />;
  } else if (item.resolvedOptionId !== undefined) {
    // ③ optimistic, no settle yet.
    body = <RespondedRow optionId={item.resolvedOptionId} options={item.options} />;
  } else if (expiredLocal) {
    // ④ zero-click local expiry — display-only interim; the host echo
    // converges to the same string once it lands (no visible flash).
    body = <TerminalRow text={expiredCopy(item.timeoutMs)} icon="warning" tone="text-warn" />;
  } else {
    // ⑤ genuinely live.
    body = <LiveRow options={item.options} timeoutMs={item.timeoutMs} onRespond={onRespond} />;
  }

  return (
    <div className="flex flex-col gap-2 rounded-card border border-warn bg-warn-soft px-3 py-2.5">
      <div className="flex items-start gap-2 text-[12.5px] text-fg">
        <Icon name="shield" size={15} className="mt-0.5 flex-none text-warn" />
        <div className="min-w-0">
          <div>{item.title}</div>
          {item.detail && <div className="mt-0.5 text-2xs leading-snug text-muted">{item.detail}</div>}
        </div>
      </div>
      {body}
    </div>
  );
}
