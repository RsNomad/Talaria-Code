import { describe, it, expect } from 'vitest';
import { mapUsage, mapStopReasonToStatus } from './usage';

describe('mapUsage', () => {
  it('maps camelCase usage fields', () => {
    expect(mapUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it('falls back to snake_case fields', () => {
    expect(mapUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('derives totalTokens when absent', () => {
    expect(mapUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('returns undefined for null/non-object/empty usage', () => {
    expect(mapUsage(null)).toBeUndefined();
    expect(mapUsage(undefined)).toBeUndefined();
    expect(mapUsage('nope')).toBeUndefined();
    expect(mapUsage({})).toBeUndefined();
  });
});

describe('mapStopReasonToStatus', () => {
  it('maps cancelled and refusal', () => {
    expect(mapStopReasonToStatus('cancelled')).toBe('cancelled');
    expect(mapStopReasonToStatus('refusal')).toBe('error');
  });

  it('maps end_turn/max_tokens/max_turn_requests to complete', () => {
    expect(mapStopReasonToStatus('end_turn')).toBe('complete');
    expect(mapStopReasonToStatus('max_tokens')).toBe('complete');
    expect(mapStopReasonToStatus('max_turn_requests')).toBe('complete');
  });

  it('maps unknown/missing stopReason to error (fail-closed, CA-4)', () => {
    // CA-4 (audit-3, F-4 — RATIFIED overturn): this test used to assert
    // 'complete' here, which pinned a fail-open bug — an unrecognized or
    // missing stopReason silently read as a successful turn. Per V-17
    // ("undefined is never success"), an unknown/missing stopReason must
    // surface as an error instead.
    expect(mapStopReasonToStatus(undefined)).toBe('error');
    expect(mapStopReasonToStatus('something_new')).toBe('error');
  });
});
