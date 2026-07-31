/*
 * W4-T6 (UI#8, state-parity): `relativeAge` used to be a PRIVATE copy living
 * only inside `SessionsPanel.tsx` — `SubagentsPanel.tsx` had no shared source
 * to reuse and rendered a delegation's raw ISO `startedAt` verbatim instead
 * of a human relative age, a state-parity gap between the two panels that
 * both show a "when" column. Extracted here (byte-identical logic to the
 * original SessionsPanel copy) so every panel that shows a relative
 * timestamp reads it the same way, and is independently unit-testable
 * without a DOM.
 */
import { describe, it, expect } from 'vitest';
import { relativeAge } from './relativeAge';

describe('relativeAge', () => {
  it('returns undefined for an absent timestamp', () => {
    expect(relativeAge(undefined)).toBeUndefined();
  });

  it('falls back to the raw string when it does not parse as a date (contract: format is NOT pinned)', () => {
    expect(relativeAge('not-a-date')).toBe('not-a-date');
  });

  it('renders "just now" under a minute', () => {
    expect(relativeAge(new Date(Date.now() - 10_000).toISOString())).toBe('just now');
  });

  it('renders minutes ago under an hour', () => {
    expect(relativeAge(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
  });

  it('renders hours ago under a day', () => {
    expect(relativeAge(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });

  it('renders days ago under a month', () => {
    expect(relativeAge(new Date(Date.now() - 5 * 86_400_000).toISOString())).toBe('5d ago');
  });

  it('renders months ago beyond 30 days', () => {
    expect(relativeAge(new Date(Date.now() - 65 * 86_400_000).toISOString())).toBe('2mo ago');
  });
});
