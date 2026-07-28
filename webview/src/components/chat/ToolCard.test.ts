/*
 * RED-first: UI-I1. `ToolCard` used to index `STATUS[item.status]` /
 * `KIND_ICON[item.toolKind]` directly — a wire `status`/`toolKind` outside
 * the known enum (a version-skewed or buggy host) made the lookup
 * `undefined`, and `.tone` threw mid-render (no error boundary anywhere ->
 * blank webview). These maps are now consulted only via `totalLookup`
 * (`../../lookup`), which is exercised directly here — no jsdom needed
 * (this repo's webview convention).
 */
import { describe, it, expect } from 'vitest';
import { totalLookup } from '../../lookup';
import { STATUS, UNKNOWN_TOOL_STATUS, KIND_ICON, UNKNOWN_KIND_ICON } from './ToolCard';

describe('ToolCard status lookup (UI-I1)', () => {
  it('resolves every known ToolStatus to its real entry (behavior-preserving)', () => {
    expect(totalLookup(STATUS, 'pending', UNKNOWN_TOOL_STATUS)).toBe(STATUS.pending);
    expect(totalLookup(STATUS, 'running', UNKNOWN_TOOL_STATUS)).toBe(STATUS.running);
    expect(totalLookup(STATUS, 'done', UNKNOWN_TOOL_STATUS)).toBe(STATUS.done);
    expect(totalLookup(STATUS, 'failed', UNKNOWN_TOOL_STATUS)).toBe(STATUS.failed);
    expect(totalLookup(STATUS, 'interrupted', UNKNOWN_TOOL_STATUS)).toBe(STATUS.interrupted);
  });

  it('a malformed/out-of-contract status normalizes to the safe default, not undefined', () => {
    const result = totalLookup(STATUS, 'queued', UNKNOWN_TOOL_STATUS);
    expect(result).toBe(UNKNOWN_TOOL_STATUS);
    // The historical crash: `STATUS[bad].tone` throws because `STATUS[bad]`
    // is `undefined`. The fixed accessor must never do that.
    expect(() => result.tone).not.toThrow();
    expect(result.tone).toBe('neutral');
  });
});

describe('ToolCard toolKind icon lookup (UI-I1 sibling)', () => {
  it('resolves every known ToolKind to its real icon (behavior-preserving)', () => {
    expect(totalLookup(KIND_ICON, 'read', UNKNOWN_KIND_ICON)).toBe('file');
    expect(totalLookup(KIND_ICON, 'execute', UNKNOWN_KIND_ICON)).toBe('terminal');
  });

  it('a malformed toolKind resolves to the unknown-icon fallback, not undefined', () => {
    expect(totalLookup(KIND_ICON, 'summarize', UNKNOWN_KIND_ICON)).toBe(UNKNOWN_KIND_ICON);
  });
});
