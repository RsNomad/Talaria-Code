import { describe, it, expect } from 'vitest';
import { PANEL_SCOPE } from './protocol';
import type { DataPanel, Scope } from './protocol';

/**
 * W6-FE Part 2 (3-way ARCH I-3a) — proves the explicit `PANEL_SCOPE` map
 * (which replaced the old `GlobalPanel = Exclude<DataPanel, ...>` silent
 * default) is BOTH exhaustive at compile time AND behavior-preserving at
 * runtime (every panel keeps its pre-refactor scope).
 */

describe('protocol — PANEL_SCOPE pins every panel\'s runtime scope UNCHANGED by the classification refactor', () => {
  it('matches the exact pre-refactor scope assignment (subagents:session, checkpoints:root, sessions:cwd, rest:global)', () => {
    expect(PANEL_SCOPE).toEqual({
      subagents: 'session',
      checkpoints: 'root',
      sessions: 'cwd',
      tools: 'global',
      mcp: 'global',
      skills: 'global',
      models: 'global',
      settings: 'global',
    });
  });

  it('covers every DataPanel — no panel is silently omitted from the classification', () => {
    const panels: DataPanel[] = [
      'tools',
      'mcp',
      'skills',
      'checkpoints',
      'subagents',
      'sessions',
      'models',
      'settings',
    ];
    expect(Object.keys(PANEL_SCOPE).sort()).toEqual([...panels].sort());
  });
});

describe('protocol — PANEL_SCOPE is a COMPILE-TIME-exhaustive Record<DataPanel, Scope> (non-vacuous proof)', () => {
  it('a panel missing from the map fails `satisfies Record<DataPanel, Scope>` — the actual guarantee `PANEL_SCOPE`\'s own declaration enforces on every real edit', () => {
    // 'settings' is deliberately omitted below. This is the SAME compiler
    // check that fires against the real `PANEL_SCOPE` declaration
    // (protocol.ts) the moment a new panel is added to `PanelDataMap`
    // without a matching scope entry — a COMPILE error, not the old silent
    // global default. If this file ever fails to typecheck because the
    // `@ts-expect-error` below became unused, the exhaustiveness guarantee
    // itself has regressed.
    const incomplete = {
      subagents: 'session',
      checkpoints: 'root',
      sessions: 'cwd',
      tools: 'global',
      mcp: 'global',
      skills: 'global',
      models: 'global',
      // @ts-expect-error — TS2741 "Property 'settings' is missing in type
      // ... but required in type 'Record<DataPanel, Scope>'."
    } satisfies Record<DataPanel, Scope>;
    expect(incomplete).toBeDefined();
  });

  it('a panel with an invalid Scope value also fails to compile (non-vacuous on the VALUE side too)', () => {
    const invalidValue = {
      subagents: 'session',
      checkpoints: 'root',
      sessions: 'cwd',
      tools: 'global',
      mcp: 'global',
      skills: 'global',
      models: 'global',
      // @ts-expect-error — 'connection' is not a member of `Scope`.
      settings: 'connection',
    } satisfies Record<DataPanel, Scope>;
    expect(invalidValue).toBeDefined();
  });
});
