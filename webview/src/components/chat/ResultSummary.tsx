/*
 * End-of-turn summary card. The shared `result.summary` carries a recap `text`
 * plus a `usage` rollup (tokens / cost / duration) — rendered as a compact
 * monospace stat read-out.
 *
 * ARCH-1 (final review, UI I-4) — T4: the card's TONE is driven by
 * `item.status`, never hardcoded. A cancelled or errored turn must not
 * render the same green "success" treatment as a genuinely completed one —
 * that was the pre-fix defect (a turn stopped by the user, or one Hermes
 * refused, showed an identical pass-filled green card). The card is still
 * RENDERED for non-complete statuses rather than suppressed: the usage
 * rollup is still true, and visibility of true status is the point (NN/g
 * heuristic #1, visibility of system status).
 *
 * The two non-success tones are NOT invented for this task — they reuse the
 * codebase's own existing vocabulary for the identical semantic situation,
 * `SubagentsPanel.tsx`'s `STATUS` map:
 *   - `interrupted: { tone: 'warn', icon: 'circle-slash' }` — a delegation's
 *     turn ending early without an error (X4's own words: "terminal,
 *     non-error state"). Mirrored here for `status: 'cancelled'`.
 *   - `failed: { tone: 'del', icon: 'error' }`. Mirrored here for
 *     `status: 'error'`, and matches `ErrorBanner.tsx` / `ErrorBoundary.tsx`
 *     / `PanelShell.tsx`, which all pair the `error` codicon with `text-del`
 *     for a genuine failure.
 *
 * T4 review fix (Important, CONFIRMED): `bridge.ts` doesn't structurally
 * validate a host->webview message's `status` field — it only checks
 * `.type`. `TONE[item.status]` was indexed directly, so a malformed or
 * version-skewed `status` made the lookup `undefined`, and reading
 * `.border`/`.icon`/`.text`/`.label` off that threw mid-render — the chat
 * `ErrorBoundary` then blanks the WHOLE transcript for one bad message.
 * Every other status/kind-keyed render map in this codebase (`ToolCard.tsx`,
 * `SubagentsPanel.tsx`, `McpPanel.tsx`, `ToolsPanel.tsx`, `SkillsPanel.tsx`)
 * already guards this exact class of lookup through `lookup.ts`'s
 * `totalLookup` — this file was the lone exception. Fixed by routing through
 * the same helper with an `UNKNOWN_RESULT_STATUS` fallback below.
 *
 * Fallback tone choice: deliberately NOT the green `complete` tone (that
 * would resurrect the silent-green defect this whole card exists to fix —
 * see the file-header note above) and deliberately NOT the red `error`
 * tone either — claiming a confirmed failure for a status this client
 * doesn't recognize would be its own false claim about reality (an
 * out-of-contract status could just as easily be a NEWER non-error terminal
 * state this build predates). Instead this reuses the codebase's own
 * established "unrecognized enum value" vocabulary — the same neutral/muted
 * `question`-icon fallback every other guarded map here uses
 * (`UNKNOWN_TOOL_STATUS`, `UNKNOWN_SUBAGENT_STATUS`, …) — paired with the
 * honest, non-committal label "Turn ended": true regardless of what the
 * unrecognized status actually represents, and visibly distinct from all
 * three known tones (NN/g #1, visibility of system status, without
 * overclaiming in either direction).
 */
import type { ResultItem } from '../../types';
import type { UsageInfo } from '../../protocol';
import { totalLookup } from '../../lookup';
import { Icon } from '../Icon';

const TONE: Record<ResultItem['status'], { icon: string; text: string; border: string; label: string }> = {
  complete: { icon: 'pass-filled', text: 'text-add', border: 'border-l-add', label: 'Turn complete' },
  cancelled: { icon: 'circle-slash', text: 'text-warn', border: 'border-l-warn', label: 'Turn cancelled' },
  error: { icon: 'error', text: 'text-del', border: 'border-l-del', label: 'Turn ended with an error' },
};

/** T4 review fix: a `status` outside the known `ResultItem['status']` enum
 * (a version-skewed or buggy host — `bridge.ts` only checks `.type`) falls
 * back to this instead of `TONE[bad]` being `undefined` and `.border`/`.icon`
 * /`.text`/`.label` throwing mid-render. Exported so a test can assert on it
 * directly, matching `UNKNOWN_TOOL_STATUS` / `UNKNOWN_SUBAGENT_STATUS`. */
export const UNKNOWN_RESULT_STATUS: { icon: string; text: string; border: string; label: string } = {
  icon: 'question',
  text: 'text-muted',
  border: 'border-l-muted',
  label: 'Turn ended',
};

function stats(usage: UsageInfo): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [
    { label: 'in', value: usage.inputTokens.toLocaleString() },
    { label: 'out', value: usage.outputTokens.toLocaleString() },
    { label: 'total', value: usage.totalTokens.toLocaleString() },
  ];
  if (usage.costUsd !== undefined) out.push({ label: 'cost', value: `$${usage.costUsd.toFixed(3)}` });
  if (usage.durationMs !== undefined)
    out.push({ label: 'time', value: `${(usage.durationMs / 1000).toFixed(1)}s` });
  return out;
}

export function ResultSummary({ item }: { item: ResultItem }) {
  const tone = totalLookup(TONE, item.status, UNKNOWN_RESULT_STATUS);
  return (
    <div className={`rounded-card border border-border border-l-2 ${tone.border} bg-surface px-3 py-2.5`}>
      <div className="flex items-center gap-2">
        <Icon name={tone.icon} size={15} className={`flex-none ${tone.text}`} />
        <span className="text-[13px] font-semibold text-fg">{tone.label}</span>
      </div>

      {item.text && <p className="mt-2 text-xs leading-relaxed text-muted">{item.text}</p>}

      {item.usage && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {stats(item.usage).map((st) => (
            <span key={st.label} className="font-mono text-2xs">
              <span className="text-fg">{st.value}</span>{' '}
              <span className="uppercase tracking-wide text-faint">{st.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
