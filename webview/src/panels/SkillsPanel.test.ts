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
import {
  PROVENANCE_LABEL,
  UNKNOWN_PROVENANCE_LABEL,
  verdictTone,
  policyTone,
  findingSeverityTone,
  severityCountsSummary,
  identifierHint,
  skillTemplate,
} from './SkillsPanel';

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

/*
 * Task B6 (§5.6): pure helpers behind the Create/Install-from-hub
 * disclosures + hub-row Remove. Exercised directly (no jsdom), same posture
 * as the provenance-lookup tests above and `McpPanel.test.ts`'s A7/A8
 * helpers — the wiring is covered separately in `SkillsPanel.dom.test.tsx`.
 */
describe('SkillsPanel hub helpers (B6)', () => {
  it('verdictTone is total: safe->add, caution->neutral, dangerous->del, unknown->neutral', () => {
    expect(verdictTone('safe')).toBe('add');
    expect(verdictTone('caution')).toBe('neutral');
    expect(verdictTone('dangerous')).toBe('del');
    expect(verdictTone('quarantined')).toBe('neutral');
  });

  it('identifierHint explains the allowlist for unknown prefixes and stays silent for trusted ones', () => {
    expect(identifierHint('clawhub/x')).toMatch(/official|trusted/i);
    expect(identifierHint('anthropics/skills/pdf')).toBeUndefined();
  });

  it('identifierHint matches trusted prefixes by anchored segment, not substring', () => {
    // 'officialX/foo' must NOT be treated as trusted merely because it starts
    // with the literal characters 'official' — same segment-anchoring the
    // host's own `assertSkillIdentifier` uses (mirrored here as a hint only).
    expect(identifierHint('officialX/foo')).toMatch(/official|trusted/i);
    // A bare prefix with nothing after it names a repo, not a skill — also
    // not trusted for the hint's purposes.
    expect(identifierHint('anthropics/skills')).toMatch(/official|trusted/i);
  });

  it('skillTemplate seeds valid frontmatter with the typed name', () =>
    expect(skillTemplate('my-skill').startsWith('---\nname: my-skill\n')).toBe(true));

  it('policyTone is total: allow->neutral, ask->warn, block->del, unknown->neutral', () => {
    expect(policyTone('allow')).toBe('neutral');
    expect(policyTone('ask')).toBe('warn');
    expect(policyTone('block')).toBe('del');
    expect(policyTone('mystery')).toBe('neutral');
  });

  it('findingSeverityTone is total: dangerous/high->del, medium/caution->warn, low->neutral, unknown->neutral', () => {
    expect(findingSeverityTone('dangerous')).toBe('del');
    expect(findingSeverityTone('high')).toBe('del');
    expect(findingSeverityTone('medium')).toBe('warn');
    expect(findingSeverityTone('caution')).toBe('warn');
    expect(findingSeverityTone('low')).toBe('neutral');
    expect(findingSeverityTone('info')).toBe('neutral');
  });
});

/*
 * Fix 5a/5b (TH-2 follow-up, AU-38): `severityCountsSummary` pure-unit
 * coverage. `findings.length` is the source of truth for the all-clear —
 * NOT the four fixed `severity_counts` buckets, since `HubScan.findings[]
 * .severity` is a free-form string those buckets don't fully cover (see
 * `SkillsPanel.dom.test.tsx`'s "Fix 5a" wiring test for the reachable-via-UI
 * case).
 */
describe('severityCountsSummary (TH-2 / Fix 5a-5b)', () => {
  it('orders non-zero buckets worst-first: critical, then high, then medium, then low', () => {
    expect(severityCountsSummary({ critical: 1, high: 2, medium: 0, low: 3 }, 6)).toBe(
      '1 critical · 2 high · 3 low',
    );
  });

  it('zero findings -> the literal "No findings"', () => {
    expect(severityCountsSummary({ critical: 0, high: 0, medium: 0, low: 0 }, 0)).toBe('No findings');
  });

  it('findings exist but every bucket is zero (out-of-vocabulary severities) -> the honest bare count, never "No findings"', () => {
    expect(severityCountsSummary({ critical: 0, high: 0, medium: 0, low: 0 }, 2)).toBe('2 findings');
    expect(severityCountsSummary({ critical: 0, high: 0, medium: 0, low: 0 }, 1)).toBe('1 finding');
  });
});
