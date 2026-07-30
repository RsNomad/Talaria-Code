import type { UsageInfo } from '../../../shared/protocol';
import type { AcpStopReason, AcpUsageLike } from './types';

/**
 * ACP `Usage` -> protocol {@link UsageInfo} (token counts only; `costUsd` is
 * never available from ACP and `durationMs` is filled in by the caller from
 * its own turn-start timestamp). Reads both camelCase (`inputTokens`, the
 * documented TS SDK wire aliasing convention) and snake_case
 * (`input_tokens`) defensively — see the version-skew note on
 * {@link AcpUsageLike}.
 */
export function mapUsage(raw: unknown): Pick<UsageInfo, 'inputTokens' | 'outputTokens' | 'totalTokens'> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as AcpUsageLike;
  const inputTokens = firstNumber(r.inputTokens, r.input_tokens);
  const outputTokens = firstNumber(r.outputTokens, r.output_tokens);
  const totalTokens = firstNumber(r.totalTokens, r.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: totalTokens ?? input + output,
  };
}

function firstNumber(...values: (number | undefined)[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * Already-warned unrecognized/missing stopReason ids (CA-4) — a module-level
 * `Set`, not a per-call one, so the warning is truly once-per-unique-id for
 * the process lifetime, matching every other `warnOnce` in this codebase.
 */
const warnedStopReasons = new Set<string>();

/**
 * CA-4 (audit-3, F-4): warns ONCE per unique unrecognized/missing stopReason
 * id. The message names ONLY the reason id (`String(stopReason)`, so
 * `undefined` -> `"undefined"`) — never a payload/body, matching every other
 * warn-once in this codebase.
 */
function warnOnceUnknownStopReason(stopReason: AcpStopReason | string | undefined): void {
  const key = String(stopReason);
  if (warnedStopReasons.has(key)) return;
  warnedStopReasons.add(key);
  console.warn(`[talaria] unrecognized ACP stopReason "${key}" — treating turn as error (fail-closed).`);
}

/**
 * ACP `PromptResponse.stopReason` -> protocol `turn.end.status`.
 * `refusal` is treated as an error (the model declined); `max_tokens` /
 * `max_turn_requests` still count as a completed turn (it ended, just
 * truncated) since the protocol has no dedicated "truncated" status.
 */
export function mapStopReasonToStatus(stopReason: AcpStopReason | string | undefined): 'complete' | 'cancelled' | 'error' {
  switch (stopReason) {
    case 'cancelled':
      return 'cancelled';
    case 'refusal':
      return 'error';
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
      return 'complete';           // truncated-but-ended is still a completed turn (documented)
    default:
      // CA-4 (audit-3, F-4): an unknown or missing stopReason is NOT success.
      // Fail closed (V-17: "undefined is never success") — surface it as an
      // error rather than silently reporting complete. warn-once names the
      // unrecognized reason id only (no payload).
      warnOnceUnknownStopReason(stopReason);
      return 'error';
  }
}
