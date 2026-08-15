import { describe, it, expect } from 'vitest';
import { assertSkillIdentifier, validateSkillCreate, TRUSTED_SKILL_PREFIXES } from './skillSourceGate';

/**
 * Task B3 (features-add-mcp-skills-architecture.md :923-957) — the SECURITY
 * SPINE of T2: host-side re-validation of every skill-hub identifier and
 * skill-create param BEFORE any network call, modal, or log line (§3 Layer
 * 1 S-5 / §5.3). Written and watched RED before `skillSourceGate.ts` exists.
 *
 * Mirrors (read, never edited) `Main Agent(harness)/hermes-agent-2026.7.7.2/`:
 *   - `tools/skills_guard.py:40-49` TRUSTED_REPOS (the 4 trusted prefixes).
 *   - `tools/skills_guard.py:1035-1061` `skills-sh/` alias stripping — we
 *     DELIBERATELY do NOT mirror this (stricter than Hermes).
 *   - `tools/skill_manager_tool.py:475` VALID_NAME_RE, `:170` MAX_NAME_LENGTH,
 *     `:485-496` `_validate_name`, `:499-521` `_validate_category`,
 *     `:471` MAX_SKILL_CONTENT_CHARS.
 */

describe('TRUSTED_SKILL_PREFIXES', () => {
  it('is the exact 5-row data-diff allowlist', () => {
    expect(TRUSTED_SKILL_PREFIXES.map((r) => r.prefix)).toEqual([
      'official',
      'openai/skills',
      'anthropics/skills',
      'huggingface/skills',
      'NVIDIA/skills',
    ]);
    expect(TRUSTED_SKILL_PREFIXES.find((r) => r.prefix === 'official')?.tier).toBe('official');
    for (const row of TRUSTED_SKILL_PREFIXES.filter((r) => r.prefix !== 'official')) {
      expect(row.tier).toBe('trusted');
    }
    for (const row of TRUSTED_SKILL_PREFIXES) {
      expect(typeof row.label).toBe('string');
      expect(row.label.length).toBeGreaterThan(0);
    }
  });
});

describe('assertSkillIdentifier', () => {
  it.each([
    'official/web-summarizer',
    'official/mlops/training/trl-fine-tuning',
    'anthropics/skills/pdf',
    'openai/skills/x',
    'huggingface/skills/y',
    'NVIDIA/skills/cuda-tips',
  ])('accepts trusted identifier %s', (id) => {
    expect(assertSkillIdentifier(id).ok).toBe(true);
  });

  it('reports the correct tier for official vs trusted rows', () => {
    const official = assertSkillIdentifier('official/web-summarizer');
    expect(official).toMatchObject({ ok: true, tier: 'official' });
    const trusted = assertSkillIdentifier('anthropics/skills/pdf');
    expect(trusted).toMatchObject({ ok: true, tier: 'trusted' });
  });

  it.each([
    'random/repo/skill',
    'skills-sh/anthropics/skills/pdf',
    'clawhub/thing',
    'https://evil.example/SKILL.md',
    'official/../../../etc',
    'anthropics/skills/../x',
    'anthropics/skills',
    'official',
    // Segment-anchored prefix guards (B3 review Important): each of these
    // is charset-clean and would be WRONGLY accepted by a naive
    // `id.startsWith(prefix)` refactor or a case-insensitive segment
    // compare, but MUST be refused by the exact per-segment equality match
    // (skillSourceGate.ts:91-96). Pin them so that regression fails the
    // suite — mutation-proven non-vacuous against both bypass forms.
    'officialX/evil', // prefix is a substring of the first segment, not the whole segment
    'official-evil/x', // ditto, hyphenated
    'anthropics/skillsX/y', // second prefix segment is a substring, not equal
    'OFFICIAL/x', // case flip — exact match is case-sensitive
    '',
  ])('refuses %s fail-closed', (id) => {
    const r = assertSkillIdentifier(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.reason).toBe('string');
  });

  it('charset-checks every segment (homoglyph / percent / space killed)', () => {
    // Cyrillic for "skill" (5 code points, U+043D U+0430 U+0432 U+044B
    // U+043A), written as \uXXXX escapes per byte-hygiene discipline (never
    // paste a raw non-ASCII/invisible byte into source — a prior task
    // shipped raw NUL/RTL bytes; do not repeat it).
    const homoglyphSegment = '\u043D\u0430\u0432\u044B\u043A';
    for (const id of [`official/${homoglyphSegment}`, 'official/a%2e%2e', 'official/a b']) {
      expect(assertSkillIdentifier(id).ok).toBe(false);
    }
  });

  it('a refusal names the rule (no silent generic message)', () => {
    const r = assertSkillIdentifier('clawhub/thing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/official|trusted|allow/i);
  });

  // Task TE-6 (AU-27, CF-14 no-echo): a refusal must not reflect the raw,
  // unbounded webview-supplied identifier back into `reason` (which reaches
  // both the host log and, unmodified through ControlDispatcher, the
  // `control.response` sent back over the wire). The full identifier is
  // still available, CAPPED and control-char-stripped, on a separate
  // `detail` field for host-logger-only consumption (mirrors
  // `rejectCatalogInstall`'s detail-to-logger discipline).
  describe('AU-27 — refusal never echoes the raw identifier; capped detail for the logger only', () => {
    it('a 5MB identifier produces a short generic reason with no fragment of the input', () => {
      const marker = 'UNIQUE_MARKER_zzz999';
      const huge = marker + 'x'.repeat(5_000_000);
      const r = assertSkillIdentifier(huge);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason.length).toBeLessThan(256);
      expect(r.reason).not.toContain(marker);
      expect(r.reason).not.toContain('x'.repeat(50)); // no run of the input body either
      // The capped detail is bounded and still traceable to the input (for
      // the logger only — never returned to the caller as `reason`).
      expect(r.detail.length).toBeLessThanOrEqual(128);
      expect(r.detail.startsWith(marker)).toBe(true);
    });

    it('a control-char / newline identifier is not reflected raw on the wire message; the logger detail is stripped + capped', () => {
      const hostile = 'evil\x00\x1b[31mFAKE-LOG-LINE\x1b[0m\ninjected/segment';
      const r = assertSkillIdentifier(hostile);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).not.toContain('\x00');
      expect(r.reason).not.toContain('\x1b');
      expect(r.reason).not.toContain('\n');
      expect(r.reason).not.toContain('FAKE-LOG-LINE');
      // detail is capped+sanitised, never containing raw control bytes.
      expect(r.detail).not.toMatch(/[\x00-\x1f]/);
      expect(r.detail.length).toBeLessThanOrEqual(128);
    });

    it('the allow/refuse DECISION is unchanged by the message-shape fix', () => {
      // A valid trusted identifier still passes...
      const ok = assertSkillIdentifier('anthropics/skills/pdf');
      expect(ok).toMatchObject({ ok: true, tier: 'trusted' });
      // ...and an invalid one still refuses, generically.
      const refused = assertSkillIdentifier('clawhub/thing');
      expect(refused.ok).toBe(false);
    });
  });
});

describe('validateSkillCreate', () => {
  it('validateSkillCreate mirrors Hermes VALID_NAME_RE exactly (skill_manager_tool.py:475) — no false rejections', () => {
    // Hermes-valid names our earlier stricter draft would have wrongly refused (critic IMPORTANT-4):
    expect(validateSkillCreate({ name: '3d-modeling', content: '---\nname: 3d-modeling\n---\nbody' }).ok).toBe(true);
    expect(validateSkillCreate({ name: 'v2.summary', content: '---\nname: v2.summary\n---\nbody' }).ok).toBe(true);
    expect(validateSkillCreate({ name: 'my-skill', content: '---\nname: my-skill\n---\nbody' }).ok).toBe(true);
    // Hermes-invalid stays invalid: uppercase, leading dot/hyphen, over-length, bad category.
    expect(validateSkillCreate({ name: 'My-Skill', content: '---\n---\nx' }).ok).toBe(false);
    expect(validateSkillCreate({ name: '.hidden', content: '---\n---\nx' }).ok).toBe(false);
    expect(validateSkillCreate({ name: '-lead', content: '---\n---\nx' }).ok).toBe(false);
    expect(validateSkillCreate({ name: 'a'.repeat(65), content: '---\n---\nx' }).ok).toBe(false);
    expect(validateSkillCreate({ name: 'ok', category: 'a/b', content: '---\n---\nx' }).ok).toBe(false);
  });

  it('validateSkillCreate enforces size + frontmatter fence', () => {
    expect(validateSkillCreate({ name: 'ok', content: 'no fence' }).ok).toBe(false);
    expect(validateSkillCreate({ name: 'ok', content: '---\n---\n' + 'x'.repeat(100_001) }).ok).toBe(false);
  });

  it('accepts a name at exactly the 64-char boundary', () => {
    expect(validateSkillCreate({ name: 'a'.repeat(64), content: '---\n---\nbody' }).ok).toBe(true);
  });

  it('accepts content at exactly the 100_000-char boundary', () => {
    const content = '---\n---\n' + 'x'.repeat(100_000 - 8);
    expect(content.length).toBe(100_000);
    expect(validateSkillCreate({ name: 'ok', content }).ok).toBe(true);
  });

  it('rejects empty content', () => {
    expect(validateSkillCreate({ name: 'ok', content: '' }).ok).toBe(false);
  });

  it('accepts a valid single-segment category', () => {
    expect(validateSkillCreate({ name: 'ok', category: 'writing', content: '---\n---\nbody' }).ok).toBe(true);
  });

  it('rejects a category exceeding 64 characters', () => {
    expect(validateSkillCreate({ name: 'ok', category: 'a'.repeat(65), content: '---\n---\nbody' }).ok).toBe(false);
  });

  it('rejects a category with a backslash', () => {
    expect(validateSkillCreate({ name: 'ok', category: 'a\\b', content: '---\n---\nbody' }).ok).toBe(false);
  });

  it('rejects non-string / missing name and content', () => {
    expect(validateSkillCreate({ content: '---\n---\nx' }).ok).toBe(false);
    expect(validateSkillCreate({ name: 'ok' }).ok).toBe(false);
    expect(validateSkillCreate({ name: 1, content: '---\n---\nx' }).ok).toBe(false);
    expect(validateSkillCreate({ name: 'ok', content: 1 }).ok).toBe(false);
  });

  it('rejects a completely off-shape param (not an object)', () => {
    expect(validateSkillCreate('nope').ok).toBe(false);
    expect(validateSkillCreate(null).ok).toBe(false);
    expect(validateSkillCreate(undefined).ok).toBe(false);
  });

  it('on success returns the exact validated body (name, content, and category only when provided)', () => {
    const withoutCategory = validateSkillCreate({ name: 'ok', content: '---\n---\nbody' });
    expect(withoutCategory).toMatchObject({ ok: true, body: { name: 'ok', content: '---\n---\nbody' } });
    const withCategory = validateSkillCreate({ name: 'ok', category: 'writing', content: '---\n---\nbody' });
    expect(withCategory).toMatchObject({ ok: true, body: { name: 'ok', category: 'writing', content: '---\n---\nbody' } });
  });
});
