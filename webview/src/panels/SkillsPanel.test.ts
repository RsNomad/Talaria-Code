/*
 * RED-first: UI-I1 sibling. `SkillsPanel` used to index
 * `PROVENANCE_LABEL[sk.provenance]` directly — a skill `provenance` outside
 * the known enum degrades gracefully today (`<Pill>{undefined}</Pill>`
 * renders no text, no throw) but is still an unguarded host-controlled
 * map-index of the same shape as the crash sites; guarded here for
 * honesty/consistency. Exercised directly (no jsdom).
 */
import { describe, it, expect } from 'vitest';
import { totalLookup } from '../lookup';
import { PROVENANCE_LABEL, UNKNOWN_PROVENANCE_LABEL } from './SkillsPanel';

describe('SkillsPanel provenance label lookup (UI-I1 sibling)', () => {
  it('resolves every known provenance to its real label (behavior-preserving)', () => {
    expect(totalLookup(PROVENANCE_LABEL, 'hub', UNKNOWN_PROVENANCE_LABEL)).toBe('hub');
    expect(totalLookup(PROVENANCE_LABEL, 'bundled', UNKNOWN_PROVENANCE_LABEL)).toBe('bundled');
    expect(totalLookup(PROVENANCE_LABEL, 'agent', UNKNOWN_PROVENANCE_LABEL)).toBe('local');
  });

  it('a malformed provenance resolves to the unknown-label fallback, not undefined', () => {
    expect(totalLookup(PROVENANCE_LABEL, 'community', UNKNOWN_PROVENANCE_LABEL)).toBe(
      UNKNOWN_PROVENANCE_LABEL,
    );
  });
});
