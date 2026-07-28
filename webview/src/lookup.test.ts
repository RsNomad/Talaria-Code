/*
 * RED-first tests for `totalLookup` (UI-I1): a host-controlled enum value
 * indexing a `Record<Enum, X>` render map must never resolve to `undefined`.
 * Today's un-guarded `STATUS[bad]` is `undefined`, so a caller's `.tone`
 * dereference throws mid-render with no error boundary — blanking the whole
 * webview (`.superpowers/sdd/reports/final-3way-2-ui.md` finding I1).
 */
import { describe, it, expect } from 'vitest';
import { totalLookup } from './lookup';

const STATUS = {
  pending: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'run', label: 'Running' },
} as const;

describe('totalLookup', () => {
  it('returns the mapped entry for a known key', () => {
    expect(totalLookup(STATUS, 'running', { tone: 'neutral', label: 'Unknown' })).toEqual({
      tone: 'run',
      label: 'Running',
    });
  });

  it('returns the caller-supplied fallback for an unrecognized key, not undefined', () => {
    const fallback = { tone: 'neutral', label: 'Unknown' };
    expect(totalLookup(STATUS, 'queued', fallback)).toBe(fallback);
  });

  it('never returns undefined, so a caller can safely dereference a property without throwing', () => {
    const fallback = { tone: 'neutral', label: 'Unknown' };
    const result = totalLookup(STATUS, 'bogus-status-from-a-version-skewed-host', fallback);
    expect(result).not.toBeUndefined();
    expect(() => result.tone).not.toThrow();
    expect(result.tone).toBe('neutral');
  });

  it("treats JS's inherited Object properties as unrecognized keys (not a prototype-pollution lookup hit)", () => {
    const fallback = { tone: 'neutral', label: 'Unknown' };
    expect(totalLookup(STATUS, 'toString', fallback)).toBe(fallback);
    expect(totalLookup(STATUS, 'constructor', fallback)).toBe(fallback);
  });
});
