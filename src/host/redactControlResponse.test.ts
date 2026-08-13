import { describe, it, expect } from 'vitest';
import { redactControlResponse } from './redactControlResponse';

/**
 * SEC-4 (audit-3 B-3) RED tests for the pure, method-gated control-response
 * redactor. `redactControlResponse` is the last host-side stop before a
 * `config.show` / `model.options` control-relay result crosses the
 * host->webview boundary (wired at `TalariaViewProvider.ts:627`); these
 * tests exercise the pure function directly, no vscode, no mocks — see
 * `test-antipatterns` (real function, real fixture).
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

  it('leaves the result byte-for-byte unchanged for a method outside the gated set (scoped, not global)', () => {
    const result = { token: 'tok-1', env: { API_KEY: 'sk-secret-123' } };

    const untouched = redactControlResponse('nextEdit.toggle', result) as Record<string, unknown>;

    expect(untouched.token).toBe('tok-1');
    expect((untouched.env as Record<string, unknown>).API_KEY).toBe('sk-secret-123');
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
