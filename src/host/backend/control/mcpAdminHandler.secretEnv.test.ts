import { describe, it, expect, vi } from 'vitest';

/** `ControlDispatcher.ts` pulls in `./customModes.ts`, which imports `vscode` at module scope — same `vi.mock` as `ControlDispatcher.golden.admin.test.ts`. */
vi.mock('vscode', () => ({}));

import { ControlDispatcher } from './ControlDispatcher';
import { makePort, registerMcpSourceWithNames, makeFakeAdminClient, makeFakeDashboard } from './ControlDispatcher.golden.harness';

/**
 * AU-59 (CF-13 parity for the manual add, ADR-023): `mcp.add` with
 * `secretEnvNames` — driven through the REAL `ControlDispatcher` →
 * `McpAdminHandler` with the golden harness's fakes. The suite pins the
 * ORDER (consent → masked prompts → POST with `${ref}` → PUT per secret →
 * GET ground-truth → reload), every decline/refusal point, both rollback
 * paths, and the one invariant everything rests on: a secret VALUE reaches
 * `setEnvVar` and NOTHING else (not the POST body, not the modal, not the
 * logger, not a gateway dispatch, not a thrown message).
 */

const STDIO_WITH_SECRETS = {
  name: 'gh',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', 'server-github'],
  env: { LOG_LEVEL: 'info' },
  secretEnvNames: ['GITHUB_TOKEN', 'OPENAI_API_KEY'],
};
const VALUES = ['ghp_live_value_1', 'sk_live_value_2'] as const;

interface Knobs {
  /** answers fed to `promptSecret` in order (default: the two live-looking VALUES) */
  answers?: ReadonlyArray<string | undefined>;
  /** the `.env` key whose PUT rejects (Hermes 400/500/network) */
  failSetEnvVarAt?: string;
  /** managed/container mode: PUT answers ok:true, GET shows nothing set */
  managedMode?: boolean;
  /** compensation's removeMcpServer rejects */
  removeServerFails?: boolean;
}

/** A real dispatcher over recording fakes; `order` records every observable step. */
function harness(knobs: Knobs = {}) {
  const order: string[] = [];
  const logs: string[] = [];
  const dispatched: Array<{ method: string; params: unknown }> = [];
  const addBodies: unknown[] = [];
  const setCalls: Array<{ key: string; value: string }> = [];
  const queue = [...(knobs.answers ?? VALUES)];
  let confirmDetail = '';
  const client = makeFakeAdminClient({
    addMcpServer: async (body) => {
      order.push('addMcpServer');
      addBodies.push(body);
      return {};
    },
    setEnvVar: async (key, value) => {
      order.push(`setEnvVar:${key}`);
      if (knobs.failSetEnvVarAt === key) throw new Error('Hermes dashboard PUT /api/env failed: 500 Internal Server Error');
      setCalls.push({ key, value });
      return { ok: true, key };
    },
    listEnvKeys: async () => {
      order.push('listEnvKeys');
      return knobs.managedMode ? {} : Object.fromEntries(setCalls.map((c) => [c.key, { is_set: true }]));
    },
    removeEnvVar: async (key) => {
      order.push(`removeEnvVar:${key}`);
      return { ok: true, key };
    },
    removeMcpServer: async (name) => {
      order.push(`removeMcpServer:${name}`);
      if (knobs.removeServerFails) throw new Error('Hermes dashboard DELETE /api/mcp/servers/gh failed: 500 Internal Server Error');
      return { ok: true };
    },
  });
  const { port, registry } = makePort({
    getDashboard: () => makeFakeDashboard(client),
    logger: { append: (line) => logs.push(line) },
    dispatch: async (method, params) => {
      order.push(`dispatch:${method}`);
      dispatched.push({ method, params });
      return { status: 'reloaded' };
    },
    confirm: async (_message, detail) => {
      order.push('confirm');
      confirmDetail = detail;
      return true;
    },
    promptSecret: async (prompt) => {
      order.push(`promptSecret:${prompt}`);
      return queue.shift();
    },
  });
  registerMcpSourceWithNames(registry, []); // the post-add `mcp` refetch resolves through this fake source (no gateway dispatch)
  const dispatcher = new ControlDispatcher(port);
  /** Every surface a value must NEVER reach, serialized for a single `not.toContain`. */
  const leakSurface = () => JSON.stringify({ order, logs, dispatched, addBodies, detail: confirmDetail });
  const invoke = () =>
    dispatcher.invokeControl('mcp.add', STDIO_WITH_SECRETS).then(
      (value) => ({ settled: 'resolved' as const, value }),
      (err: unknown) => ({ settled: 'rejected' as const, message: err instanceof Error ? err.message : String(err) }),
    );
  return { dispatcher, invoke, order, logs, dispatched, addBodies, setCalls, leakSurface };
}

describe('mcp.add with secretEnvNames — AU-59 config-first, fail-closed orchestration (ADR-023)', () => {
  it('happy path ORDER: consent → masked prompts → POST (refs only) → PUT per secret → GET ground-truth → reload; values reach ONLY setEnvVar', async () => {
    const h = harness();
    const result = await h.dispatcher.invokeControl('mcp.add', STDIO_WITH_SECRETS);
    expect(result).toEqual({ ok: true, name: 'gh', transport: 'stdio' });
    expect(h.order).toEqual([
      'confirm',
      'promptSecret:"gh": value for GITHUB_TOKEN (saved to ~/.hermes/.env as MCP_GH_GITHUB_TOKEN)',
      'promptSecret:"gh": value for OPENAI_API_KEY (saved to ~/.hermes/.env as MCP_GH_OPENAI_API_KEY)',
      'addMcpServer',
      'setEnvVar:MCP_GH_GITHUB_TOKEN',
      'setEnvVar:MCP_GH_OPENAI_API_KEY',
      'listEnvKeys',
      'dispatch:reload.mcp',
    ]);
    expect(h.addBodies).toEqual([
      {
        name: 'gh',
        command: 'npx',
        args: ['-y', 'server-github'],
        env: { LOG_LEVEL: 'info', GITHUB_TOKEN: '${MCP_GH_GITHUB_TOKEN}', OPENAI_API_KEY: '${MCP_GH_OPENAI_API_KEY}' },
      },
    ]);
    expect(h.setCalls).toEqual([
      { key: 'MCP_GH_GITHUB_TOKEN', value: 'ghp_live_value_1' },
      { key: 'MCP_GH_OPENAI_API_KEY', value: 'sk_live_value_2' },
    ]);
    for (const v of VALUES) expect(h.leakSurface()).not.toContain(v);
    expect(JSON.stringify(h.addBodies)).not.toContain('secretEnvNames'); // the names-only field never reaches the REST body either
    expect(h.dispatched).toEqual([{ method: 'reload.mcp', params: { confirm: true } }]);
  });

  it('the consent modal DETAIL discloses the prompt + destinations BEFORE anything is asked (names only)', async () => {
    const h = harness();
    await h.dispatcher.invokeControl('mcp.add', STDIO_WITH_SECRETS);
    expect(h.leakSurface()).toContain(
      "Will prompt for: GITHUB_TOKEN, OPENAI_API_KEY — saved to Hermes' .env store (~/.hermes/.env) as MCP_GH_GITHUB_TOKEN, MCP_GH_OPENAI_API_KEY",
    );
  });

  it('no secretEnvNames → the pre-AU-59 path byte-for-byte: POST with the plaintext env, no env-store calls, no prompts', async () => {
    const h = harness();
    await h.dispatcher.invokeControl('mcp.add', { ...STDIO_WITH_SECRETS, secretEnvNames: [] });
    expect(h.order).toEqual(['confirm', 'addMcpServer', 'dispatch:reload.mcp']);
    expect(h.addBodies).toEqual([{ name: 'gh', command: 'npx', args: ['-y', 'server-github'], env: { LOG_LEVEL: 'info' } }]);
  });

  it('a DISMISSED prompt for the SECOND secret declines the WHOLE add — nothing was POSTed or PUT, the first value went nowhere', async () => {
    const h = harness({ answers: ['ghp_live_value_1', undefined] });
    const outcome = await h.invoke();
    expect(outcome).toEqual({ settled: 'rejected', message: 'Adding MCP server "gh" was declined or cancelled.' });
    expect(h.order.filter((s) => !s.startsWith('promptSecret'))).toEqual(['confirm']);
    expect(h.leakSurface()).not.toContain('ghp_live_value_1');
  });

  it('a BLANK answer is a decline too', async () => {
    const h = harness({ answers: [''] });
    const outcome = await h.invoke();
    expect(outcome).toEqual({ settled: 'rejected', message: 'Adding MCP server "gh" was declined or cancelled.' });
    expect(h.order.filter((s) => !s.startsWith('promptSecret'))).toEqual(['confirm']);
  });

  it('a non-ASCII secret value is refused BEFORE any network call; the refusal names the env NAME, never the value', async () => {
    const bad = 'ghp_ábc';
    const h = harness({ answers: [bad] });
    const outcome = await h.invoke();
    expect(outcome.settled).toBe('rejected');
    if (outcome.settled !== 'rejected') return;
    expect(outcome.message).toMatch(/^Refusing the value for GITHUB_TOKEN: secret value must be printable ASCII/);
    expect(outcome.message).toMatch(/Nothing was saved\.$/);
    expect(outcome.message).not.toContain(bad);
    expect(h.order.filter((s) => !s.startsWith('promptSecret'))).toEqual(['confirm']);
    expect(h.leakSurface()).not.toContain(bad);
  });

  it('PUT failure on the 2nd secret → rollback: DELETE the already-written key, then DELETE the server; keys only; no reload', async () => {
    const h = harness({ failSetEnvVarAt: 'MCP_GH_OPENAI_API_KEY' });
    const outcome = await h.invoke();
    expect(outcome).toEqual({
      settled: 'rejected',
      message: 'Adding MCP server "gh" was rolled back: Hermes did not store its secret env — see the Talaria output log. Nothing was saved.',
    });
    expect(h.order.slice(3)).toEqual([
      'addMcpServer',
      'setEnvVar:MCP_GH_GITHUB_TOKEN',
      'setEnvVar:MCP_GH_OPENAI_API_KEY',
      'removeEnvVar:MCP_GH_GITHUB_TOKEN',
      'removeMcpServer:gh',
    ]);
    expect(h.dispatched).toEqual([]); // no reload.mcp after a rollback
    expect(h.logs.join('\n')).toContain('PUT /api/env failed: 500'); // the cause goes to the output channel…
    for (const v of VALUES) expect(h.leakSurface()).not.toContain(v); // …and never a value
  });

  it('Layer 6: managed-mode {ok:true} with nothing on disk → rolled back (both keys + the server); the message names the missing KEYS', async () => {
    const h = harness({ managedMode: true });
    const outcome = await h.invoke();
    expect(outcome).toEqual({
      settled: 'rejected',
      message:
        'Adding MCP server "gh" was rolled back: Hermes answered ok but ~/.hermes/.env does not contain MCP_GH_GITHUB_TOKEN, MCP_GH_OPENAI_API_KEY (managed/container mode?). Nothing was saved.',
    });
    expect(h.order.slice(-3)).toEqual(['removeEnvVar:MCP_GH_GITHUB_TOKEN', 'removeEnvVar:MCP_GH_OPENAI_API_KEY', 'removeMcpServer:gh']);
    expect(h.dispatched).toEqual([]);
  });

  it('compensation itself failing is DISCLOSED, not swallowed: the leftover server entry (refs only) is named for manual removal', async () => {
    const h = harness({ managedMode: true, removeServerFails: true });
    const outcome = await h.invoke();
    expect(outcome.settled).toBe('rejected');
    if (outcome.settled !== 'rejected') return;
    expect(outcome.message).toContain('Adding MCP server "gh" was rolled back: Hermes answered ok but ~/.hermes/.env does not contain');
    expect(outcome.message).toContain(
      'The server entry "gh" could NOT be removed automatically — remove it from the MCP panel (it holds only ${…} references, no secret).',
    );
    expect(h.logs.join('\n')).toContain('could not remove the server entry');
  });
});
