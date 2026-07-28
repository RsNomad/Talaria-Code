/*
 * W2 T1 §3.2 — Hybrid A+B slash catalog: client templates (Approach A,
 * "Commands" section) + the ACP `available_commands` catalog (Approach B,
 * "Agent" section). TDD RED->GREEN for the catalog data + the sectioning/
 * collision/query-filter logic `Composer.tsx` wires into `SuggestMenu`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SLASH_TEMPLATES, buildSlashSections } from './slashCatalog';
import { must } from '../testing/must';
import type { SlashCommandInfo } from '../protocol';

describe('SLASH_TEMPLATES (§3.2 Approach A — client-side command templates)', () => {
  it('exposes exactly the v1 set, in order: explain, test, review, doc', () => {
    expect(SLASH_TEMPLATES.map((t) => t.id)).toEqual(['explain', 'test', 'review', 'doc']);
  });

  it('every template labels itself as a `/name` and expands to non-empty prompt text', () => {
    for (const t of SLASH_TEMPLATES) {
      expect(t.label).toBe(`/${t.id}`);
      expect(t.expand('')).toBeTruthy();
    }
  });
});

describe('buildSlashSections (§3.2 sectioned "Commands"/"Agent" menu)', () => {
  it('with no ACP catalog yet, only the "Commands" section is present (B degrades to A, the documented fallback)', () => {
    const sections = buildSlashSections(undefined, '');
    expect(sections.map((s) => s.heading)).toEqual(['Commands']);
    expect(must(sections[0]).items.map((i) => i.id)).toEqual(SLASH_TEMPLATES.map((t) => t.id));
  });

  it('adds an "Agent" section from the ACP catalog, mapping name -> label and description -> hint', () => {
    const commands: SlashCommandInfo[] = [
      { name: 'help', description: 'Show help' },
      { name: 'model', description: 'Switch model' },
    ];
    const sections = buildSlashSections(commands, '');
    expect(sections.map((s) => s.heading)).toEqual(['Commands', 'Agent']);
    const agent = must(sections[1]).items;
    expect(agent).toEqual([
      { id: 'help', name: 'help', label: '/help', hint: 'Show help', icon: expect.any(String) },
      { id: 'model', name: 'model', label: '/model', hint: 'Switch model', icon: expect.any(String) },
    ]);
  });

  it('hides (never duplicates) an agent command whose name collides with a client template — client templates win', () => {
    const commands: SlashCommandInfo[] = [
      { name: 'explain', description: 'agent-supplied, should be hidden' },
      { name: 'help', description: 'Show help' },
    ];
    const sections = buildSlashSections(commands, '');
    const agentIds = sections.find((s) => s.heading === 'Agent')?.items.map((i) => i.id);
    expect(agentIds).toEqual(['help']); // 'explain' dropped, not duplicated
    // the client template itself is untouched
    expect(must(sections[0]).items.find((i) => i.id === 'explain')).toBeDefined();
  });

  describe('collision logging (§3.2 "hidden + logged")', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('logs a console.warn naming the hidden command when an agent command collides with a client template', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const commands: SlashCommandInfo[] = [
          { name: 'explain', description: 'agent-supplied, should be hidden' },
          { name: 'help', description: 'Show help' },
        ];
        const sections = buildSlashSections(commands, '');
        expect(sections.find((s) => s.heading === 'Agent')?.items.map((i) => i.id)).toEqual(['help']);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/explain'));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('filters both sections by a case-insensitive query against id/label', () => {
    const commands: SlashCommandInfo[] = [
      { name: 'help', description: 'Show help' },
      { name: 'model', description: 'Switch model' },
    ];
    const sections = buildSlashSections(commands, 'mo');
    // "Commands": explain/test/review/doc — none match "mo"
    expect(sections.find((s) => s.heading === 'Commands')).toBeUndefined();
    expect(sections.find((s) => s.heading === 'Agent')?.items.map((i) => i.id)).toEqual(['model']);
  });

  it('omits a section entirely when it has zero matching items after filtering', () => {
    const sections = buildSlashSections([{ name: 'help', description: 'Show help' }], 'zzz-no-match');
    expect(sections).toEqual([]);
  });

  it('never throws even when the ACP catalog is empty', () => {
    expect(() => buildSlashSections([], '')).not.toThrow();
    expect(buildSlashSections([], '').map((s) => s.heading)).toEqual(['Commands']);
  });
});
