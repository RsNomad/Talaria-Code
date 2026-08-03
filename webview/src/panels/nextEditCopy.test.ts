/*
 * W5.1 Task 13 (R5) — the two «Next Edit Suggestions» rows.
 *
 * The row LABELS and DESCRIPTIONS are owner-approved, frozen copy. They
 * are exported as data (`NEXT_EDIT_ROWS`) rather than buried in JSX precisely
 * so this file can lock them character-for-character: the honesty disclaimers
 * ("No published benchmark score exists for this model.", "vendor-reported,
 * unreplicated") are the whole point of the copy, and a well-meaning future
 * edit that "tightens" them would silently un-say them.
 *
 * The vendor-number discipline is a Global Constraint
 * (`09-jobB-final-plan.md`): every benchmark number reaching user-facing copy
 * carries "vendor-reported, unreplicated", NEXT has no published score at all,
 * and 81.28% belongs to an unreleased model and is quoted NOWHERE.
 *
 * Relocated here from `SettingsPanel.test.ts` by Task 12 (§5.1/§5.2):
 * `nextEditCopy.ts` is the single source both `SetupPanel.tsx` (its sole
 * consumer since Task 12) and `MockBackend.ts` read from, so its own lock
 * belongs beside it rather than in the panel that no longer renders the
 * rows. The `NEXT_EDIT_SECTION_LABEL` heading test from the old location is
 * NOT carried over — that constant was SettingsPanel-local UI chrome (the
 * section heading it rendered NEXT_EDIT_ROWS under), not part of the frozen
 * row copy itself, and Task 12 deleted it along with the section.
 */
import { describe, it, expect } from 'vitest';
import { must } from '../testing/must';
import { NEXT_EDIT_ROWS } from './nextEditCopy';

describe('Next Edit Suggestions rows — frozen owner-approved copy (08 §8)', () => {
  it('renders NEXT first (the dedicated model is the flagship; Generic is the fallback) and exactly two rows', () => {
    expect(NEXT_EDIT_ROWS.map((r) => r.source)).toEqual(['next', 'generic']);
  });

  it('carries the NEXT row label + description verbatim', () => {
    const next = must(NEXT_EDIT_ROWS[0]);
    expect(next.label).toBe('Next Edit — dedicated model');
    expect(next.description).toBe(
      'Uses sweep-next-edit-v2-7B on its own endpoint (talaria.nextEdit.endpoint). No published benchmark score exists for this model. Mutually exclusive with Generic.',
    );
  });

  it('carries the Generic row label + description verbatim, including the vendor qualifier and the OLLAMA_CONTEXT_LENGTH pointer', () => {
    const generic = must(NEXT_EDIT_ROWS[1]);
    expect(generic.label).toBe('Next Edit — Generic via your FIM model');
    expect(generic.description).toBe(
      'Reuses your FIM model and endpoint with a different request shape. Quality ~55.62% (vendor-reported, unreplicated) — review every suggestion. Below 23 GiB VRAM set OLLAMA_CONTEXT_LENGTH=16384 on your server (see docs). Mutually exclusive with NEXT.',
    );
  });

  it('states plainly that NEXT has NO published score — never invents one', () => {
    expect(must(NEXT_EDIT_ROWS[0]).description).toContain('No published benchmark score exists for this model.');
  });

  it('never quotes 81.28% (an unreleased model’s number — quoted nowhere in shipped copy)', () => {
    for (const row of NEXT_EDIT_ROWS) {
      expect(row.description).not.toContain('81.28');
      expect(row.label).not.toContain('81.28');
    }
  });

  it('every benchmark number in the copy carries the vendor-reported qualifier', () => {
    for (const row of NEXT_EDIT_ROWS) {
      const quotesANumber = /\d+\.\d+%/.test(row.description);
      if (quotesANumber) expect(row.description).toContain('(vendor-reported, unreplicated)');
    }
  });

  it('names the mutual exclusion on BOTH rows — the refusal can then never be a surprise', () => {
    expect(must(NEXT_EDIT_ROWS[0]).description).toContain('Mutually exclusive with Generic.');
    expect(must(NEXT_EDIT_ROWS[1]).description).toContain('Mutually exclusive with NEXT.');
  });

  it('mentions no banned model family (no Devstral / zeta / sweep-v1 may appear in shipped copy)', () => {
    for (const row of NEXT_EDIT_ROWS) {
      const copy = `${row.label} ${row.description}`.toLowerCase();
      expect(copy).not.toContain('devstral');
      expect(copy).not.toContain('zeta');
      expect(copy).not.toContain('sweep-v1');
    }
  });
});
