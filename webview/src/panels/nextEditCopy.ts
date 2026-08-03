/*
 * The single source for the two owner-approved «Next Edit Suggestions» row
 * descriptions (W5.1 Task 13 / R5, originally authored in `SettingsPanel.tsx`).
 *
 * Task 10 (Setup / Talaria Config panel) extracted this out of
 * `SettingsPanel.tsx` into its own module: the NEXT card now needs the exact
 * same frozen copy, and Task 12 (§5.5 — "SettingsPanel -> Agent config")
 * DELETES the NEXT rows from `SettingsPanel.tsx` entirely (NEXT lives in
 * Talaria Config now). Keeping the literal here, imported by BOTH panels
 * (today) and by SetupPanel alone (after Task 12), means Task 12's removal
 * can never orphan a consumer that still needs this text — there is exactly
 * one place the copy lives, independent of which panel currently renders it.
 *
 * This copy is OWNER-APPROVED and FROZEN (`08` §8's table, carried
 * character-for-character) and is locked by `SettingsPanel.test.ts` /
 * `SetupPanel.test.ts`. The honesty clauses are the point of it, not
 * decoration: NEXT has no published benchmark score and says so outright
 * rather than borrowing a number, and Generic's only number carries the
 * "vendor-reported, unreplicated" qualifier plus the "review every
 * suggestion" instruction. Do not tighten, summarise, or "improve" these
 * strings.
 */
import type { NextEditToggleSource } from '../protocol';

export interface NextEditRowCopy {
  source: NextEditToggleSource;
  label: string;
  description: string;
}

/**
 * The two R5 rows, NEXT first — the dedicated model is the flagship, Generic
 * is the fallback (`08` §8).
 */
export const NEXT_EDIT_ROWS: ReadonlyArray<NextEditRowCopy> = [
  {
    source: 'next',
    label: 'Next Edit — dedicated model',
    description:
      'Uses sweep-next-edit-v2-7B on its own endpoint (talaria.nextEdit.endpoint). No published benchmark score exists for this model. Mutually exclusive with Generic.',
  },
  {
    source: 'generic',
    label: 'Next Edit — Generic via your FIM model',
    description:
      'Reuses your FIM model and endpoint with a different request shape. Quality ~55.62% (vendor-reported, unreplicated) — review every suggestion. Below 23 GiB VRAM set OLLAMA_CONTEXT_LENGTH=16384 on your server (see docs). Mutually exclusive with NEXT.',
  },
];
