/*
 * RED-first: UI-I1. `McpPanel` used to index `STATUS[srv.status]` directly —
 * a server `status` outside the known `McpStatus` enum made the lookup
 * `undefined`, and `.tone` threw mid-render (no error boundary -> blank
 * webview). Exercised directly (no jsdom).
 */
import { describe, it, expect } from 'vitest';
import { totalLookup } from '../lookup';
import type { McpCatalogEntry } from '../protocol';
import {
  STATUS,
  UNKNOWN_MCP_STATUS,
  parseArgsLines,
  parseEnvLines,
  testNotice,
  catalogRowBadges,
  authNotice,
} from './McpPanel';

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

/* Task A7 (§4.9): pure helpers behind the Add-server form + Test button.
 * Exercised directly (no jsdom) per this file's own `totalLookup` style —
 * the wiring is covered separately in `McpPanel.dom.test.tsx`. */
describe('McpPanel Add-server helpers (A7)', () => {
  it('parseArgsLines: one arg per line, trimmed, empties dropped, never shell-split', () =>
    expect(parseArgsLines(' -y \n @scope/pkg \n\n')).toEqual(['-y', '@scope/pkg']));

  it('parseEnvLines: KEY=VALUE per line; first "=" splits; malformed lines reported', () => {
    expect(parseEnvLines('A=1\nB=x=y')).toEqual({ ok: true, env: { A: '1', B: 'x=y' } });
    expect(parseEnvLines('noequals').ok).toBe(false);
  });

  it('testNotice maps envelopes honestly', () => {
    expect(testNotice({ ok: true, tools: [{ name: 't', description: '' }] })).toMatchObject({ tone: 'ok' });
    expect(testNotice({ ok: false, error: 'boom', tools: [] })).toMatchObject({
      tone: 'error',
      text: expect.stringContaining('boom'),
    });
  });
});

/* Task A8 (§4.7/§4.8): pure helpers behind the Catalog disclosure + Login
 * button. Exercised directly (no jsdom), same style as the A7 helpers above —
 * the wiring is covered separately in `McpPanel.dom.test.tsx`. */
const catalogRowFixture: McpCatalogEntry = {
  name: 'builder',
  description: 'Builds things from source.',
  source: 'nous',
  transport: 'stdio',
  auth_type: 'none',
  required_env: [],
  command: 'npx',
  args: ['-y', 'builder-mcp'],
  url: null,
  install_url: null,
  install_ref: null,
  bootstrap: [],
  default_enabled: null,
  post_install: '',
  needs_install: false,
  installed: false,
  enabled: false,
};

describe('McpPanel Catalog + Login helpers (A8)', () => {
  it('catalogRowBadges flags needs_install rows and installed rows', () => {
    expect(catalogRowBadges({ ...catalogRowFixture, needs_install: true }).build).toBe(true);
    expect(catalogRowBadges({ ...catalogRowFixture, installed: true }).installed).toBe(true);
    expect(catalogRowBadges(catalogRowFixture)).toEqual({ build: false, installed: false });
  });

  it('authNotice maps the auth envelope (ok / error / cancel text passthrough)', () => {
    expect(authNotice({ ok: true, tools: [{ name: 't', description: '' }] }).tone).toBe('ok');
    const cancelText = 'Cancelled. The browser sign-in may still be completing — run Test after finishing it.';
    const result = authNotice({ ok: false, error: cancelText, tools: [] });
    expect(result.tone).toBe('error');
    expect(result.text).toBe(cancelText);
  });
});
