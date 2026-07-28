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
    default:
      return 'complete';
  }
}
