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

  it('defaults unknown/missing to complete', () => {
    expect(mapStopReasonToStatus(undefined)).toBe('complete');
    expect(mapStopReasonToStatus('something_new')).toBe('complete');
  });
});
