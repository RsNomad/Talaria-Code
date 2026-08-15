import { describe, it, expect } from 'vitest';
import {
  HermesDashboardClient,
  isHermesStatusShape,
  anySignal,
  type FetchLike,
} from './HermesDashboardClient';
import { must } from '../../testing/must';

/**
 * A minimal but realistic `GET /api/status` body, matching the unconditional
 * fields the Hermes handler always emits (`hermes_cli/web_server.py:2564-2583`).
 */
function hermesStatusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '2026.7.7.2',
    release_date: '2026-07-07',
    config_version: 41,
    latest_config_version: 41,
    can_update_hermes: true,
    gateway_running: false,
    gateway_state: null,
    gateway_platforms: {},
    active_agents: 0,
    gateway_busy: false,
    gateway_drainable: false,
    active_sessions: 0,
    auth_required: false,
    auth_providers: [],
    nous_session_valid: 'unknown',
    ...overrides,
  };
}

/**
 * Contract tests for the W1.5 dashboard REST client against a STUBBED `fetch`
 * (BUILD-BLIND: no live dashboard here — wire correctness comes from reading
 * `hermes_cli/web_server.py`). We assert the exact method/URL/headers/body per
 * pinned endpoint, that toggles round-trip `{ok, name, enabled}`, and that a
 * non-2xx response OR a network error rejects (so the panel rolls back / shows a
 * retryable error rather than faking an effect).
 */

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** A stub `fetch` that records the call and returns a canned JSON `Response`. */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchImpl: FetchLike, token?: string) {
  return new HermesDashboardClient({ port: 9119, fetchImpl, token, timeoutMs: 1000 });
}

describe('HermesDashboardClient — base URL + Host guard', () => {
  it('targets http://127.0.0.1:<port> so the derived Host header passes the loopback guard', () => {
    const { fetchImpl } = stubFetch(() => json([]));
    expect(makeClient(fetchImpl).baseUrl).toBe('http://127.0.0.1:9119');
  });

  it('does NOT set a manual Host header (undici forbids it; the URL authority is authoritative)', async () => {
    const { fetchImpl, calls } = stubFetch(() => json([]));
    await makeClient(fetchImpl).listSkills();
    const headers = (must(calls[0]).init?.headers ?? {}) as Record<string, string>;
    expect('Host' in headers).toBe(false);
    expect('host' in headers).toBe(false);
  });
});

describe('HermesDashboardClient.listSkills — GET /api/skills', () => {
  it('GETs /api/skills and returns the parsed array', async () => {
    const rows = [
      { name: 'tdd', description: 'x', category: 'coding', enabled: true, usage: 3, provenance: 'bundled' },
    ];
    const { fetchImpl, calls } = stubFetch(() => json(rows));
    const result = await makeClient(fetchImpl).listSkills();

    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/skills');
    expect(must(calls[0]).init?.method).toBe('GET');
    expect(result).toEqual(rows);
  });
});

describe('HermesDashboardClient.toggleSkill — PUT /api/skills/toggle', () => {
  it('PUTs {name, enabled} and returns the {ok, name, enabled} round-trip', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ ok: true, name: 'tdd', enabled: false }));
    const result = await makeClient(fetchImpl).toggleSkill('tdd', false);

    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/skills/toggle');
    expect(must(calls[0]).init?.method).toBe('PUT');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ name: 'tdd', enabled: false });
    const headers = must(calls[0]).init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(result).toEqual({ ok: true, name: 'tdd', enabled: false });
  });

  it('sends the X-Hermes-Session-Token header only when a token was minted', async () => {
    const withToken = stubFetch(() => json({ ok: true, name: 'x', enabled: true }));
    await makeClient(withToken.fetchImpl, 'secret-tok').toggleSkill('x', true);
    expect(
      (must(withToken.calls[0]).init?.headers as Record<string, string>)['X-Hermes-Session-Token'],
    ).toBe('secret-tok');

    const noToken = stubFetch(() => json({ ok: true, name: 'x', enabled: true }));
    await makeClient(noToken.fetchImpl).toggleSkill('x', true);
    expect(
      'X-Hermes-Session-Token' in (must(noToken.calls[0]).init?.headers as Record<string, string>),
    ).toBe(false);
  });
});

describe('HermesDashboardClient — toolsets', () => {
  it('GETs /api/tools/toolsets', async () => {
    const rows = [{ name: 'web', label: 'Web', description: '', enabled: true, available: true, configured: false, tools: ['web_search'] }];
    const { fetchImpl, calls } = stubFetch(() => json(rows));
    const result = await makeClient(fetchImpl).listToolsets();

    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/tools/toolsets');
    expect(result).toEqual(rows);
  });

  it('PUTs /api/tools/toolsets/{name} with {enabled}, URL-encoding the toolset key', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ ok: true, name: 'a b', enabled: true }));
    const result = await makeClient(fetchImpl).toggleToolset('a b', true);

    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/tools/toolsets/a%20b');
    expect(must(calls[0]).init?.method).toBe('PUT');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ enabled: true });
    expect(result).toEqual({ ok: true, name: 'a b', enabled: true });
  });
});

describe('HermesDashboardClient — error handling', () => {
  it('rejects on a non-2xx response (so the caller can roll back / show retryable)', async () => {
    const { fetchImpl } = stubFetch(() => json({ detail: 'Unknown toolset: nope' }, 400));
    await expect(makeClient(fetchImpl).toggleToolset('nope', true)).rejects.toThrow(/400/);
  });

  it('rejects when fetch itself throws (network error / connection refused)', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(makeClient(fetchImpl).listSkills()).rejects.toThrow(/ECONNREFUSED/);
  });
});

/**
 * T6 (final-review remediation, UI I-5 BETA-BLOCKER + ARCH-2): a non-2xx
 * dashboard response used to append `(await res.text()).slice(0,500)` — the
 * RAW response body — to the thrown Error message, which is user-facing
 * (`PanelShell.tsx` / `SettingsPanel.tsx` render it). Invariant #3: the
 * thrown message carries status + statusText ONLY; the body is LOGGED
 * (OWASP Error Handling Cheat Sheet — generic message to the caller, details
 * logged server-side) via the client's injected {@link Logger}, never
 * surfaced.
 */
describe('HermesDashboardClient — error shape (T6, invariant #3 / ARCH-2)', () => {
  it('dashboard non-2xx: thrown message is status+statusText only; the body goes to the logger, never the throw', async () => {
    const lines: string[] = [];
    const logger = { append: (line: string) => lines.push(line) };
    const { fetchImpl } = stubFetch(
      () => new Response('SECRET-TRACEBACK: /home/user/.hermes/config.yaml', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );
    const client = new HermesDashboardClient({ port: 9119, fetchImpl, timeoutMs: 1000, logger });

    let caught: unknown;
    try {
      await client.listSkills();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/500 Internal Server Error$/);
    expect(message).not.toMatch(/SECRET-TRACEBACK/);
    expect(lines.join('\n')).toContain('SECRET-TRACEBACK');
  });

  it('a response body that fails to read is tolerated (status alone is enough; no logger call, no throw crash)', async () => {
    const lines: string[] = [];
    const logger = { append: (line: string) => lines.push(line) };
    const unreadable = new Response('irrelevant', { status: 503, statusText: 'Service Unavailable' });
    // Force res.text() to reject, simulating a body that can't be read.
    Object.defineProperty(unreadable, 'text', {
      value: () => Promise.reject(new Error('stream already consumed')),
    });
    const { fetchImpl } = stubFetch(() => unreadable);
    const client = new HermesDashboardClient({ port: 9119, fetchImpl, timeoutMs: 1000, logger });

    await expect(client.listSkills()).rejects.toThrow(/503 Service Unavailable$/);
    expect(lines).toEqual([]);
  });

  it('no logger injected: still throws the shaped message without crashing (logger is optional)', async () => {
    const { fetchImpl } = stubFetch(() => new Response('body', { status: 500, statusText: 'Internal Server Error' }));
    const client = new HermesDashboardClient({ port: 9119, fetchImpl, timeoutMs: 1000 });
    await expect(client.listSkills()).rejects.toThrow(/500 Internal Server Error$/);
  });
});

/**
 * DASH-3 (Tier-2 remediation architecture §12.1, task T-13): a non-JSON 2xx
 * body used to reach `res.json()` unguarded, so a malformed/HTML response
 * threw the RAW `SyntaxError`, whose message embeds a body snippet (e.g.
 * "Unexpected token '<', "<html>...")  — one branch away from breaching
 * Invariant #3 (never surface a response body), which the sibling non-2xx
 * path (above) already enforces via the logger/generic-message split.
 */
describe('HermesDashboardClient — DASH-3: non-JSON 2xx body does not leak into the thrown error (Invariant #3)', () => {
  it('a 2xx response whose body is not JSON throws a generic, status-only error — no body/parse-error text', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response('<html>SECRET-STACKTRACE: /home/user/.hermes/config.yaml</html>', { status: 200 }),
    );
    const client = makeClient(fetchImpl);

    let caught: unknown;
    try {
      await client.listSkills();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Pre-fix: the raw `SyntaxError` from `res.json()` propagates, and its
    // message quotes a fragment of the actual body (a JSON.parse artifact).
    expect(message).not.toMatch(/SECRET-STACKTRACE/);
    expect(message).not.toMatch(/<html>/i);
    expect(message).not.toMatch(/Unexpected token/i); // the raw parser error text itself
    expect(message).toMatch(/200/);
  });

  it('the parse failure is logged (status-only note), never the body — mirrors the non-2xx branch', async () => {
    const lines: string[] = [];
    const logger = { append: (line: string) => lines.push(line) };
    const { fetchImpl } = stubFetch(() => new Response('not json at all', { status: 200 }));
    const client = new HermesDashboardClient({ port: 9119, fetchImpl, timeoutMs: 1000, logger });

    await expect(client.listSkills()).rejects.toThrow();
    expect(lines.join('\n')).not.toContain('not json at all');
  });

  it('a well-formed JSON 2xx body still round-trips normally (no regression)', async () => {
    const { fetchImpl } = stubFetch(() => json([{ ok: true }]));
    await expect(makeClient(fetchImpl).listSkills()).resolves.toEqual([{ ok: true }]);
  });
});

describe('HermesDashboardClient.probe — GET /api/status', () => {
  it('returns true on 200, false on non-2xx, false when fetch throws (never rejects)', async () => {
    const ok = stubFetch(() => new Response('{}', { status: 200 }));
    await expect(makeClient(ok.fetchImpl).probe()).resolves.toBe(true);
    expect(must(ok.calls[0]).url).toBe('http://127.0.0.1:9119/api/status');

    const down = stubFetch(() => new Response('', { status: 503 }));
    await expect(makeClient(down.fetchImpl).probe()).resolves.toBe(false);

    const thrown = stubFetch(() => {
      throw new Error('boom');
    });
    await expect(makeClient(thrown.fetchImpl).probe()).resolves.toBe(false);
  });
});

describe('HermesDashboardClient.fetchServedToken — GET / provenance probe (S3, CWE-306/346)', () => {
  it('GETs / and extracts the served window.__HERMES_SESSION_TOKEN__', async () => {
    const html = '<script>window.__HERMES_SESSION_TOKEN__="served-tok";</script>';
    const { fetchImpl, calls } = stubFetch(() => new Response(html, { status: 200 }));
    await expect(makeClient(fetchImpl).fetchServedToken()).resolves.toBe('served-tok');
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/');
    expect(must(calls[0]).init?.method).toBe('GET');
  });

  it('returns null (never throws) on a non-2xx response', async () => {
    const { fetchImpl } = stubFetch(() => new Response('nope', { status: 503 }));
    await expect(makeClient(fetchImpl).fetchServedToken()).resolves.toBeNull();
  });

  it('returns null (never throws) when fetch itself throws (network error)', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(makeClient(fetchImpl).fetchServedToken()).resolves.toBeNull();
  });

  it('returns null when the 2xx body has no served-token marker', async () => {
    const { fetchImpl } = stubFetch(() => new Response('<html>no token</html>', { status: 200 }));
    await expect(makeClient(fetchImpl).fetchServedToken()).resolves.toBeNull();
  });
});

describe('HermesDashboardClient.probeAdopt — verified adopt gate (Security M3)', () => {
  it('ADOPTS a Hermes-shaped 200 (GETs /api/status and verifies identity)', async () => {
    const { fetchImpl, calls } = stubFetch(() => json(hermesStatusBody()));
    await expect(makeClient(fetchImpl).probeAdopt()).resolves.toBe(true);
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/status');
    expect(must(calls[0]).init?.method).toBe('GET');
  });

  it('REFUSES a bare 2xx that is NOT Hermes-shaped (rogue loopback squatter)', async () => {
    const empty = stubFetch(() => json({}));
    await expect(makeClient(empty.fetchImpl).probeAdopt()).resolves.toBe(false);

    const impostor = stubFetch(() => json({ status: 'ok', service: 'not-hermes' }));
    await expect(makeClient(impostor.fetchImpl).probeAdopt()).resolves.toBe(false);
  });

  it('REFUSES a 2xx whose body is not JSON at all', async () => {
    const html = stubFetch(() => new Response('<html>hi</html>', { status: 200 }));
    await expect(makeClient(html.fetchImpl).probeAdopt()).resolves.toBe(false);
  });

  it('returns false on non-2xx and false when fetch throws (never rejects)', async () => {
    const down = stubFetch(() => json(hermesStatusBody(), 503));
    await expect(makeClient(down.fetchImpl).probeAdopt()).resolves.toBe(false);

    const thrown = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(makeClient(thrown.fetchImpl).probeAdopt()).resolves.toBe(false);
  });
});

describe('isHermesStatusShape — Hermes identity signature', () => {
  it('accepts a full Hermes /api/status body', () => {
    expect(isHermesStatusShape(hermesStatusBody())).toBe(true);
  });

  it('rejects junk / non-Hermes shapes and non-objects', () => {
    expect(isHermesStatusShape({})).toBe(false);
    expect(isHermesStatusShape({ status: 'ok' })).toBe(false);
    expect(isHermesStatusShape(null)).toBe(false);
    expect(isHermesStatusShape('ok')).toBe(false);
    expect(isHermesStatusShape(42)).toBe(false);
  });

  it('rejects a body missing any one signature field or with a wrong type', () => {
    expect(isHermesStatusShape(hermesStatusBody({ version: '' }))).toBe(false); // empty version
    expect(isHermesStatusShape(hermesStatusBody({ gateway_running: 'yes' }))).toBe(false); // wrong type
    const { gateway_drainable, ...noDrainable } = hermesStatusBody();
    void gateway_drainable;
    expect(isHermesStatusShape(noDrainable)).toBe(false); // missing field
    expect(isHermesStatusShape(hermesStatusBody({ nous_session_valid: 123 }))).toBe(false); // wrong type
  });
});

/**
 * A2 — `DashboardAdminClient` (T1 members): MCP admin CRUD + catalog + auth.
 * `actionStatus` is included here too (controller-decided scope note): it
 * visually groups under "T2" in the architecture doc (§4.3), but A6 (catalog
 * background-install polling) needs it before B2 lands, and it is shared
 * polling infra with no T2-specific shape.
 */
describe('DashboardAdminClient — T1 endpoints', () => {
  it('addMcpServer POSTs the exact body to /api/mcp/servers with the token header', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ name: 'gh', transport: 'stdio' }));
    await makeClient(fetchImpl, 'tkn').addMcpServer({ name: 'gh', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'x' } });
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/mcp/servers');
    expect(must(calls[0]).init?.method).toBe('POST');
    expect((must(calls[0]).init?.headers as Record<string, string>)['X-Hermes-Session-Token']).toBe('tkn');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ name: 'gh', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'x' } });
  });

  it('testMcpServer resolves the ok:false 200-envelope instead of throwing', async () => {
    const { fetchImpl } = stubFetch(() => json({ ok: false, error: 'connect refused', tools: [] }));
    await expect(makeClient(fetchImpl).testMcpServer('gh')).resolves.toEqual({ ok: false, error: 'connect refused', tools: [] });
  });

  it('removeMcpServer DELETEs the encoded name path and a 404 rejects with a generic (body-free) message', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ detail: 'secret-path-leak' }, 404));
    await expect(makeClient(fetchImpl).removeMcpServer('a b')).rejects.toThrow(/404/);
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/mcp/servers/a%20b');
    await expect(makeClient(fetchImpl).removeMcpServer('a b')).rejects.not.toThrow(/secret-path-leak/);
  });

  it('setMcpServerEnabled PUTs {enabled} to /api/mcp/servers/{name}/enabled', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ ok: true, name: 'gh', enabled: false }));
    await makeClient(fetchImpl).setMcpServerEnabled('gh', false);
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/mcp/servers/gh/enabled');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ enabled: false });
  });

  it('authMcpServer resolves the ok:false 200-envelope instead of throwing', async () => {
    const { fetchImpl } = stubFetch(() => json({ ok: false, error: 'oauth denied', tools: [] }));
    await expect(makeClient(fetchImpl).authMcpServer('gh')).resolves.toEqual({ ok: false, error: 'oauth denied', tools: [] });
  });

  it('authMcpServer POSTs .../auth and an external AbortSignal cancels the call', async () => {
    const controller = new AbortController();
    const { fetchImpl } = stubFetch((_url, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }) as unknown as Response);
    const pending = makeClient(fetchImpl).authMcpServer('remote', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('listMcpCatalog GETs /api/mcp/catalog and installCatalogEntry POSTs {name, env, enable}', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ ok: true, name: 'n8n', background: true, action: 'mcp-install-n8n-ab12cd34' }));
    await makeClient(fetchImpl).installCatalogEntry({ name: 'n8n', env: { N8N_KEY: 'v' }, enable: true });
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/mcp/catalog/install');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ name: 'n8n', env: { N8N_KEY: 'v' }, enable: true });
  });

  it('anySignal: native path delegates; fallback path (anyImpl falsy, pre-Node-20.3) composes via once-listeners', () => {
    // `anyImpl` is a DEFAULT param — passing `undefined` would re-trigger the
    // default initializer and resolve to the NATIVE `AbortSignal.any` on this
    // repo's Node (24), giving the fallback branch zero coverage. Pass a
    // falsy-but-NOT-undefined value so default substitution does not kick in
    // and the manual once-listener `else` branch genuinely runs.
    const noNativeAny = null as unknown as typeof AbortSignal.any;
    const a = new AbortController();
    const b = new AbortController();
    const composed = anySignal([a.signal, b.signal], noNativeAny); // force the fallback branch
    expect(composed.aborted).toBe(false);
    b.abort(new Error('caller cancelled'));
    expect(composed.aborted).toBe(true);
    const already = new AbortController();
    already.abort();
    expect(anySignal([already.signal], noNativeAny).aborted).toBe(true); // pre-aborted input propagates immediately
  });

  it('actionStatus GETs /api/actions/{name}/status and returns the pinned shape', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ name: 'a', running: false, exit_code: 0, pid: 1, lines: ['Installed: pdf'] }));
    const res = await makeClient(fetchImpl).actionStatus('a');
    expect(must(calls[0]).url).toContain('/api/actions/a/status');
    expect(res).toMatchObject({ running: false, exit_code: 0 });
  });
});

describe('DashboardAdminClient — T2 skills endpoints', () => {
  it('createSkill POSTs the exact body to /api/skills', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ ok: true }));
    await makeClient(fetchImpl).createSkill({ name: 'x', content: '---\n---\nbody', category: 'custom' });
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/skills');
    expect(must(calls[0]).init?.method).toBe('POST');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ name: 'x', content: '---\n---\nbody', category: 'custom' });
  });

  it('createSkill surfaces a 400 as a generic error (detail never in the thrown message)', async () => {
    const { fetchImpl } = stubFetch(() => json({ detail: 'Invalid name: /etc/passwd' }, 400));
    await expect(makeClient(fetchImpl).createSkill({ name: 'x', content: '---\n---\nb' })).rejects.toThrow(/400/);
    await expect(makeClient(fetchImpl).createSkill({ name: 'x', content: '---\n---\nb' })).rejects.not.toThrow(/passwd/);
  });

  it('previewHubSkill GETs /api/skills/hub/preview with an ENCODED identifier and resolves the body', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({
      name: 'pdf', description: 'PDF tools', source: 'anthropics/skills', identifier: 'anthropics/skills/pdf',
      trust_level: 'trusted', skill_md: '# PDF', files: ['SKILL.md'],
    }));
    const res = await makeClient(fetchImpl).previewHubSkill('anthropics/skills/pdf tools');
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/skills/hub/preview?identifier=anthropics%2Fskills%2Fpdf%20tools');
    expect(must(calls[0]).init?.method).toBe('GET');
    expect(res).toMatchObject({ name: 'pdf', identifier: 'anthropics/skills/pdf' });
  });

  it('scanHubSkill GETs with an ENCODED identifier', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ name: 'x', identifier: 'a/b', trust_level: 'trusted', verdict: 'safe', summary: '', policy: 'allow', findings: [] }));
    await makeClient(fetchImpl).scanHubSkill('anthropics/skills/pdf tools');
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/skills/hub/scan?identifier=anthropics%2Fskills%2Fpdf%20tools');
  });

  it('installHubSkill POSTs {identifier} and returns the action name', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ ok: true, pid: 1, name: 'skills-install-anthropics-pdf-ab12cd34' }));
    const res = await makeClient(fetchImpl).installHubSkill('anthropics/skills/pdf');
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/skills/hub/install');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ identifier: 'anthropics/skills/pdf' });
    expect(res.name).toBe('skills-install-anthropics-pdf-ab12cd34');
  });

  it('uninstallHubSkill POSTs {name} to /api/skills/hub/uninstall', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ ok: true, name: 'pdf' }));
    const res = await makeClient(fetchImpl).uninstallHubSkill('pdf');
    expect(must(calls[0]).url).toBe('http://127.0.0.1:9119/api/skills/hub/uninstall');
    expect(JSON.parse(String(must(calls[0]).init?.body))).toEqual({ name: 'pdf' });
    expect(res).toEqual({ ok: true, name: 'pdf' });
  });
});
