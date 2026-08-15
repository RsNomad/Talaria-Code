/*
 * TG-4 (AU-54) / INV-18 lock: `APPLIES_NEXT_SESSION` is the ONE canonical
 * effect-latency sentence — "every UI surface that persists config the live
 * ACP session cannot observe carries the effect-latency sentence" (INV-18).
 * Grep-style structural test (same family as the repo's existing lock
 * tests, e.g. `busyInteraction`-shaped sweeps): it reads each consuming
 * panel's SOURCE and asserts the identifier is actually referenced there —
 * catching a future refactor that reintroduces a hand-typed near-duplicate
 * sentence instead of importing the shared constant.
 *
 * Scope (T-G architecture, `## T-G · TG-4`):
 *  - MCP admin (TG-2, `McpPanel.tsx`) and Skills (shipped C3, `SkillsPanel.tsx`)
 *    both ADOPT the constant — asserted positively below.
 *  - Tools (TG-1, `ToolsPanel.tsx`) is a DELIBERATE exclusion: its note
 *    communicates SCOPE (which sessions the toggles govern at all), not
 *    effect-latency, and keeps its own two-sentence copy — asserted as a
 *    negative (does NOT reference the constant) plus a positive check that
 *    its own scope-note text is present, so this file still covers all
 *    three surfaces the architecture names (MCP + Skills + Tools) without
 *    contradicting TG-4's explicit "NOT this constant" call for Tools.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APPLIES_NEXT_SESSION } from './copy';

const panelsDir = join(dirname(fileURLToPath(import.meta.url)), 'panels');

function readPanelSource(fileName: string): string {
  return readFileSync(join(panelsDir, fileName), 'utf8');
}

describe('TG-4 (AU-54, INV-18): APPLIES_NEXT_SESSION is the one canonical effect-latency sentence', () => {
  it('is the exact Rev-1 B6 canonical sentence, verbatim', () => {
    expect(APPLIES_NEXT_SESSION).toBe('Takes effect in new chats; chats already open keep their current setup.');
  });

  it('is referenced by the MCP admin success surface (TG-2, McpPanel.tsx)', () => {
    expect(readPanelSource('McpPanel.tsx')).toContain('APPLIES_NEXT_SESSION');
  });

  it('is referenced by the Skills panel scope note (shipped C3, now migrated onto the shared constant)', () => {
    expect(readPanelSource('SkillsPanel.tsx')).toContain('APPLIES_NEXT_SESSION');
  });

  it('is deliberately NOT referenced by the Tools panel note (TG-1: scope, not latency) — which instead carries its own scope-note text', () => {
    const src = readPanelSource('ToolsPanel.tsx');
    expect(src).not.toContain('APPLIES_NEXT_SESSION');
    expect(src).toContain("These toggles govern Hermes' CLI and desktop sessions.");
  });
});
