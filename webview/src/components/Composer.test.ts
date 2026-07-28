/*
 * W2 Bucket-1 F3 — consent-surface honesty guard for the preset picker copy.
 *
 * The permission gate only sees main-loop file edits (`write_file`/`patch`).
 * Ordinary shell commands auto-run Hermes-side, and subagent (`delegate_task`),
 * `execute_code`/`terminal`, and MCP-tool writes never reach the gate at all —
 * the post-turn checkpoint snapshot is what recovers those. The preset hints
 * are the human-facing consent surface, so they must never claim more coverage
 * than the gate delivers (no "everything", no "no edits", no "cannot bypass"),
 * and they must be English like the rest of the UI.
 */
import { describe, expect, it } from 'vitest';

import { PRESETS } from './Composer';

/**
 * Absolute-coverage phrasings the hints must never claim — each one would
 * promise a guarantee the Hermes boundary does not deliver.
 */
const OVERCLAIMS: RegExp[] = [
  /cannot bypass/i,
  /\bevery(thing)?\b/i,
  /\ball (edits|commands|files)\b/i,
  /\bno edits\b/i,
  /read[- ]?only/i,
];

describe('Composer preset copy (F3 consent-surface honesty)', () => {
  it('exposes exactly the four presets, in order', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['manual', 'normal', 'strict', 'plan']);
  });

  it('labels and hints are English (no Cyrillic in an English UI)', () => {
    for (const p of PRESETS) {
      expect(p.label, `label for ${p.id}`).not.toMatch(/[Ѐ-ӿ]/);
      expect(p.hint, `hint for ${p.id}`).not.toMatch(/[Ѐ-ӿ]/);
    }
  });

  it('hints make no absolute-coverage claims about the gate', () => {
    for (const p of PRESETS) {
      for (const banned of OVERCLAIMS) {
        expect(p.hint, `hint for "${p.id}" must not match ${banned}`).not.toMatch(banned);
      }
    }
  });

  it('pins the honest hint strings', () => {
    expect(Object.fromEntries(PRESETS.map((p) => [p.id, p.hint]))).toEqual({
      manual: 'ask before file edits',
      normal: 'auto-allow safe in-workspace edits',
      strict: 'deny risky edits; commands still auto-run',
      plan: 'discourage edits (not filesystem-enforced)',
    });
  });
});
