/*
 * RED-first: UI-I1. `McpPanel` used to index `STATUS[srv.status]` directly —
 * a server `status` outside the known `McpStatus` enum made the lookup
 * `undefined`, and `.tone` threw mid-render (no error boundary -> blank
 * webview). Exercised directly (no jsdom).
 */
import { describe, it, expect } from 'vitest';
import { totalLookup } from '../lookup';
import { STATUS, UNKNOWN_MCP_STATUS } from './McpPanel';

describe('McpPanel status lookup (UI-I1)', () => {
  it('resolves every known McpStatus to its real entry (behavior-preserving)', () => {
    expect(totalLookup(STATUS, 'connected', UNKNOWN_MCP_STATUS)).toBe(STATUS.connected);
    expect(totalLookup(STATUS, 'disconnected', UNKNOWN_MCP_STATUS)).toBe(STATUS.disconnected);
  });

  it('a malformed/out-of-contract status normalizes to the safe default, not undefined', () => {
    const result = totalLookup(STATUS, 'error', UNKNOWN_MCP_STATUS);
    expect(result).toBe(UNKNOWN_MCP_STATUS);
    expect(() => result.tone).not.toThrow();
    expect(result.tone).toBe('neutral');
  });
});
