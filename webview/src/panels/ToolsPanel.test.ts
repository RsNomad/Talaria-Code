/*
 * RED-first: UI-I1 sibling. `ToolsPanel` used to index `KIND_ICON[t.kind]`
 * directly — a tool `kind` outside the known `ToolKind` enum degrades
 * gracefully today (`codicon-undefined` renders no glyph, no throw) but is
 * still an unguarded host-controlled map-index of the same shape as the
 * crash sites; guarded here for honesty/consistency. Exercised directly (no
 * jsdom).
 */
import { describe, it, expect } from 'vitest';
import { totalLookup } from '../lookup';
import { KIND_ICON, UNKNOWN_KIND_ICON } from './ToolsPanel';

describe('ToolsPanel toolKind icon lookup (UI-I1 sibling)', () => {
  it('resolves every known ToolKind to its real icon (behavior-preserving)', () => {
    expect(totalLookup(KIND_ICON, 'read', UNKNOWN_KIND_ICON)).toBe('file');
    expect(totalLookup(KIND_ICON, 'other', UNKNOWN_KIND_ICON)).toBe('tools');
  });

  it('a malformed toolKind resolves to the unknown-icon fallback, not undefined', () => {
    expect(totalLookup(KIND_ICON, 'summarize', UNKNOWN_KIND_ICON)).toBe(UNKNOWN_KIND_ICON);
  });
});
