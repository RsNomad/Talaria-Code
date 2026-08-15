import { describe, it, expect } from 'vitest';
import { redactControlResponse } from './redactControlResponse';

/**
 * SEC-4 (audit-3 B-3) / TE-5 (AU-26, INV-16) RED tests for the pure
 * control-response redactor. `redactControlResponse` is the last host-side
 * stop before a control-relay result crosses the host->webview boundary
 * (wired at `TalariaViewProvider.ts:959`); these tests exercise the pure
 * function directly, no vscode, no mocks — see `test-antipatterns` (real
 * function, real fixture).
 *
 * TE-5 inverted the posture from an allowlist of 3 methods (fail-OPEN — a
 * method missing from that short list escaped redaction entirely) to
 * default-redact with an explicit, justified `REDACTION_EXEMPT` safe-list.
 * The tests below marked "TE-5"
 * exercise that inversion; the tests above them are the original SEC-4
 * suite and stay green under both postures (they only ever exercised
 * methods that were — and remain — walked).
 */
describe('redactControlResponse', () => {
  it('redacts a nested credential-shaped key (mcp_servers[].env) under config.show, leaving siblings untouched', () => {
    const result = {
      mcp_servers: [{ name: 'x', command: 'run', env: { API_KEY: 'sk-secret-123', PATH: '/usr/bin' } }],
      theme: 'dark',
    };

    const redacted = redactControlResponse('config.show', result) as {
      mcp_servers: Array<{ name: string; command: string; env: unknown }>;
      theme: string;
    };

    expect(redacted.mcp_servers[0]?.env).toBe('[redacted]');
    expect(redacted.mcp_servers[0]?.name).toBe('x');
    expect(redacted.mcp_servers[0]?.command).toBe('run');
    expect(redacted.theme).toBe('dark');
  });

  it('redacts every deny-list key variant (any casing/separator) while sparing non-secret siblings', () => {
    const result = {
      authorization: 'Bearer abc',
      token: 'tok-1',
      apiKey: 'key-1',
      api_key: 'key-2',
      password: 'hunter2',
      secret: 'shh',
      name: 'my-model',
      model: 'gpt-x',
      endpoint: 'https://example.com',
    };

    const redacted = redactControlResponse('model.options', result) as Record<string, unknown>;

    expect(redacted.authorization).toBe('[redacted]');
    expect(redacted.token).toBe('[redacted]');
    expect(redacted.apiKey).toBe('[redacted]');
    expect(redacted.api_key).toBe('[redacted]');
    expect(redacted.password).toBe('[redacted]');
    expect(redacted.secret).toBe('[redacted]');
    expect(redacted.name).toBe('my-model');
    expect(redacted.model).toBe('gpt-x');
    expect(redacted.endpoint).toBe('https://example.com');
  });

  // TE-5 (AU-26): this used to assert the OLD fail-open behavior — a method
  // outside the 3-item allowlist crossed unredacted. That is the exact bug
  // AU-26 flags (a new credential-bearing method escapes redaction by
  // default). Inverted: a non-exempt method is now redacted by DEFAULT.
  it('TE-5: a method NOT on the explicit safe-list is redacted by default (inverted posture)', () => {
    const result = { token: 'tok-1', env: { API_KEY: 'sk-secret-123' } };

    const redacted = redactControlResponse('nextEdit.toggle', result) as Record<string, unknown>;

    expect(redacted.token).toBe('[redacted]');
    expect(redacted.env).toBe('[redacted]');
  });

  it('returns non-object results as-is without crashing (string, null, number)', () => {
    expect(redactControlResponse('config.show', 'a string')).toBe('a string');
    expect(redactControlResponse('config.show', null)).toBe(null);
    expect(redactControlResponse('config.show', 42)).toBe(42);
    expect(redactControlResponse('model.options', undefined)).toBe(undefined);
  });

  // Task A5 (§4.5 item 8, plan lines 753-756): 'mcp.add' joins the gated set
  // as a belt over the host-side redaction discipline.
  it('scrubs env in an mcp.add result (belt over the server-side redaction)', () => {
    const out = redactControlResponse('mcp.add', { name: 'gh', env: { TOKEN: 'x' } }) as { env: unknown };
    expect(out.env).toBe('[redacted]');
  });

  it('is pure: the input object is not mutated by redaction', () => {
    const input = {
      mcp_servers: [{ name: 'x', env: { API_KEY: 'sk-secret-123' } }],
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;

    redactControlResponse('config.show', input);

    expect(input).toEqual(snapshot);
    expect(input.mcp_servers[0]?.env.API_KEY).toBe('sk-secret-123');
  });
});

describe('TE-5 (AU-26): default-redact — an unanticipated FUTURE method is covered for free', () => {
  it('a made-up method never on any allowlist still gets its credential-shaped fields redacted', () => {
    const result = { nested: { api_key: 'x', private_key: 'y' } };

    const redacted = redactControlResponse('agents.someFutureMethodNoOneWroteYet', result) as {
      nested: { api_key: unknown; private_key: unknown };
    };

    expect(redacted.nested.api_key).toBe('[redacted]');
    expect(redacted.nested.private_key).toBe('[redacted]');
  });
});

describe('TE-5 (AU-26): tightened SECRET_KEY — the under-matches the audit names', () => {
  // Root cause (audit-fix-architecture.md TE-5): "`/env/i` also under-matches
  // (`credential`, `bearer`, `cookie`, `private_key` miss)." Each of these
  // now redacts on a non-exempt method (fails at HEAD: passes through).
  it.each([
    ['credential', 'credential', 'cred-abc'],
    ['bearer', 'bearer', 'Bearer xyz'],
    ['cookie', 'cookie', 'sessionid=abc123'],
    ['passphrase', 'passphrase', 'correct horse battery staple'],
    ['private_key (snake_case)', 'private_key', '-----BEGIN KEY-----'],
    ['privateKey (camelCase)', 'privateKey', '-----BEGIN KEY-----'],
  ])('redacts a %s-named key', (_label, key, value) => {
    const result: Record<string, unknown> = { [key]: value, harmless: 'kept' };

    const redacted = redactControlResponse('reload.mcp', result) as Record<string, unknown>;

    expect(redacted[key]).toBe('[redacted]');
    expect(redacted.harmless).toBe('kept');
  });
});

describe('TE-5 (AU-26): explicit, justified REDACTION_EXEMPT safe-list', () => {
  it("'panel.data' is exempt: a panel payload is not over-redacted into uselessness", () => {
    // Realistic shape: McpCatalogEntry.required_env, the exact field the
    // Catalog install form iterates to render one TextField per required
    // credential NAME (McpPanel.tsx) — never a secret VALUE.
    const result = {
      entries: [{ name: 'n8n', required_env: [{ name: 'N8N_KEY', prompt: 'API key', required: true }] }],
    };

    const untouched = redactControlResponse('panel.data', result) as {
      entries: Array<{ required_env: unknown }>;
    };

    expect(untouched.entries[0]?.required_env).toEqual([{ name: 'N8N_KEY', prompt: 'API key', required: true }]);
  });

  // Over-match this exemption exists for: `SetupData` (SetupController.status(),
  // the SAME projection `panel.data{panel:'setup'}` pushes) carries
  // `agent.options[].remote.apiKeySet: boolean` and `fim.tuning.
  // maxPromptTokens: number` — both substring-match the (intentionally kept
  // broad) SECRET_KEY deny-list, but neither is a secret: `apiKeySet` is a
  // presence FLAG (the real key is entered via a native `showInputBox` and
  // never crosses this boundary — see `model.save_key`'s doc), and
  // `maxPromptTokens` is a tuning number. Redacting either would corrupt the
  // Setup panel's rendered state (a boolean literally becomes the string
  // '[redacted]', which is always truthy).
  it("'setup.status' is exempt: apiKeySet / maxPromptTokens survive (the audit's over-match class)", () => {
    const result = {
      agent: { options: [{ id: 'hermes', remote: { apiKeySet: false } }] },
      fim: { tuning: { maxPromptTokens: 1024 } },
    };

    const untouched = redactControlResponse('setup.status', result) as {
      agent: { options: Array<{ remote: { apiKeySet: unknown } }> };
      fim: { tuning: { maxPromptTokens: unknown } };
    };

    expect(untouched.agent.options[0]?.remote.apiKeySet).toBe(false);
    expect(untouched.fim.tuning.maxPromptTokens).toBe(1024);
  });

  it("'mcp.catalog' is exempt: required_env survives (the exact over-match named above), a real secret VALUE elsewhere would still be caught", () => {
    const result = {
      entries: [{ name: 'n8n', required_env: [{ name: 'N8N_KEY', prompt: 'API key', required: true }] }],
    };

    const untouched = redactControlResponse('mcp.catalog', result) as {
      entries: Array<{ required_env: unknown }>;
    };

    expect(untouched.entries[0]?.required_env).toEqual([{ name: 'N8N_KEY', prompt: 'API key', required: true }]);
  });

  it('the safe-list is a CLOSED set: a lookalike method name is NOT exempt (no prefix/substring matching)', () => {
    const result = { api_key: 'sk-should-be-redacted' };

    const redacted = redactControlResponse('mcp.catalogInstall', result) as Record<string, unknown>;

    expect(redacted.api_key).toBe('[redacted]');
  });

  it('the original 3-method regression stays fixed: model.options/config.show/mcp.add are NOT on the safe-list (unchanged behavior)', () => {
    for (const method of ['config.show', 'model.options', 'mcp.add']) {
      const redacted = redactControlResponse(method, { token: 't' }) as Record<string, unknown>;
      expect(redacted.token).toBe('[redacted]');
    }
  });
});
