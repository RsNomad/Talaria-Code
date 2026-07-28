import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * Audit A-3 (task 7). `AcpClient.loadSession` used to turn a `{}` agent reply
 * into `{ currentModeId: 'default' }` — indistinguishable from a genuine
 * successful load of an empty conversation. Hermes answers an UNKNOWN session
 * id with `None` (`acp_adapter/server.py:1141-1143`: `if state is None: ...
 * return None`), which the JSON-RPC layer serializes as `"result": null`; the
 * installed SDK's `loadSession()` then does `?? {}` (`dist/acp.js:484`) before
 * handing it back to us. This is the crash-recovery path: kill Hermes
 * mid-session and the client re-`session/load`s it on respawn
 * (`ConnectionSupervisor.recoverOneSession` -> `SessionController.loadReplay`
 * -> `client.loadSession`) — if that comes back `None`, the restored
 * conversation must not silently look like an empty-but-successful load.
 *
 * TEST-SEAM CHOICE (task-7-brief correction 1): the brief's own suggested
 * technique — "assign a stub to `AcpClient`'s private `connection`" — is
 * exactly the seam that let audit C-1 survive an entire branch: stubbing the
 * SDK connection only proves the wrapper forwards a call, never what the
 * REAL SDK does with the REAL wire bytes Hermes sends back. This file
 * instead reuses `acpClient.wire.test.ts`'s proven harness verbatim: mock
 * `node:child_process`, drive the REAL production `AcpClient` over a fake
 * `ChildProcess` wired to genuine `PassThrough` streams, and — the one
 * extension that harness's own tests didn't need — write a real JSON-RPC
 * response frame onto the fake child's `stdout`, so the SDK's own `?? {}`
 * line actually runs. This proves what Hermes' answer does to us, not what
 * our code does to a stub we built ourselves.
 */
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { AcpClient, type AcpClientCallbacks, type AcpLoadSessionResult } from './acpClient';

const NOOP_CALLBACKS: AcpClientCallbacks = {
  onSessionUpdate: () => {},
  onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  onReadTextFile: async () => '',
};

/** Same minimal fake `ChildProcess` as `acpClient.wire.test.ts` — see that file's doc. */
function makeFakeChild(): { child: ChildProcess; stdin: PassThrough; stdout: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fake = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    killed: false,
    exitCode: null,
  });
  return { child: fake as unknown as ChildProcess, stdin, stdout };
}

/** Connects a real `AcpClient` over a fake child process. */
async function connectClient(): Promise<{ client: AcpClient; stdout: PassThrough }> {
  const { child, stdout } = makeFakeChild();
  vi.mocked(spawn).mockReturnValue(child);

  const client = new AcpClient({
    spawn: { command: 'hermes', args: ['acp'] },
    cwd: '/workspace',
    callbacks: NOOP_CALLBACKS,
  });
  await client.connect();

  return { client, stdout };
}

/**
 * Writes one JSON-RPC response frame to the fake child's stdout, exactly as
 * Hermes' own `acp/connection.py` would over the real pipe (newline-delimited
 * JSON — see `ndJsonStream`, `@agentclientprotocol/sdk/dist/stream.js`).
 * `id: 0` because each test connects a FRESH `AcpClient` (-> a fresh
 * `ClientSideConnection` -> a fresh `Connection`, whose own `#nextRequestId`
 * starts at 0 per-instance, confirmed at `dist/acp.js:712`), and each test
 * issues exactly one request before responding — the same assumption
 * `acpClient.wire.test.ts`'s own `id: 0` assertions already rely on.
 */
function respond(stdout: PassThrough, result: unknown): void {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result })}\n`);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('AcpClient.loadSession — audit A-3: a lost session must not look like a successful load', () => {
  it('reports found:false when Hermes answers null for an unknown session id (the crash-recovery path)', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.loadSession('/w', 'gone-session');
    await flush();
    // acp_adapter/server.py:1141-1143 — `if state is None: return None`,
    // which the wire carries as a literal JSON-RPC `"result": null`.
    respond(stdout, null);

    const result = await resultPromise;

    expect(result.found).toBe(false);
  });

  it('reports found:true for a real load, and keeps the mode id', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.loadSession('/w', 'live-session');
    await flush();
    respond(stdout, { modes: { currentModeId: 'architect' }, models: { available: [] } });

    const result = await resultPromise;

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('unreachable — asserted above');
    expect(result.currentModeId).toBe('architect');
  });

  it('a real load that omits currentModeId still counts as found, defaulting the mode', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.loadSession('/w', 'live-session');
    await flush();
    respond(stdout, { modes: {} });

    const result = await resultPromise;

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('unreachable — asserted above');
    expect(result.currentModeId).toBe('default');
  });

  it('ARCH-3/E2: currentModeId is unrepresentable on found:false (discriminated union guard)', () => {
    // @ts-expect-error currentModeId does not exist on found:false
    const impossible: AcpLoadSessionResult = { found: false, currentModeId: 'default' };
    void impossible;
  });
});

/**
 * A7 (Tier-2 remediation architecture §12.1, task T-13): `NewSessionResponse.
 * models.currentModelId`/`LoadSessionResponse.models.currentModelId` used to
 * be discarded entirely — the webview showed the generic "Model" placeholder
 * until the user's FIRST manual switch, even though the harness already told
 * us the bound model at session start. This only captures what the wire
 * already carries (the SDK schema's `SessionModelState.currentModelId`,
 * `types.gen.d.ts:2991`, alongside the already-captured `currentModeId`
 * sibling) — the id-namespace contract question (whether this id always
 * matches what the Models panel's own list uses) stays DEFERRED.
 */
describe('AcpClient.newSession/loadSession — A7: capture the harness-bound currentModelId at bind', () => {
  it('newSession captures models.currentModelId from the wire response', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.newSession('/w');
    await flush();
    respond(stdout, {
      sessionId: 's1',
      modes: { currentModeId: 'default' },
      models: { currentModelId: 'claude-sonnet-5', availableModels: [] },
    });

    const result = await resultPromise;

    expect(result.currentModelId).toBe('claude-sonnet-5');
  });

  it('newSession tolerates a response with no models field (currentModelId stays undefined, not a crash)', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.newSession('/w');
    await flush();
    respond(stdout, { sessionId: 's1', modes: { currentModeId: 'default' } });

    const result = await resultPromise;

    expect(result.currentModelId).toBeUndefined();
  });

  it('loadSession captures models.currentModelId on a live (found:true) load', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.loadSession('/w', 'live-session');
    await flush();
    respond(stdout, {
      modes: { currentModeId: 'architect' },
      models: { currentModelId: 'gpt-5', availableModels: [] },
    });

    const result = await resultPromise;

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('unreachable — asserted above');
    expect(result.currentModelId).toBe('gpt-5');
  });
});

/**
 * A8 (Tier-2 remediation architecture §12.1, task T-13) — INVESTIGATED, NOT
 * CLOSEABLE at this layer. The brief: Hermes answers `set_session_model` for
 * a MISSING session with a JSON-RPC null result
 * (`acp_adapter/server.py:2026-2036`), which should be treated as a refusal.
 * Traced end to end (see `AcpClient.setSessionModel`'s own doc): the
 * installed SDK unconditionally coerces `null`/`undefined` to `{}` INSIDE
 * `unstable_setSessionModel` before this class ever sees it
 * (`@agentclientprotocol/sdk/dist/acp.js:576-578`), and
 * `SetSessionModelResponse`'s schema has zero required fields — so a
 * genuine empty success and a coerced null-refusal are byte-identical by
 * the time any caller could inspect them. This test proves that collapse is
 * real (driving the REAL SDK over the wire harness, not a stub) rather than
 * asserting a rejection this codebase cannot actually produce today.
 */
describe('AcpClient.setSessionModel — A8: investigated (SDK swallows the null-vs-empty distinction)', () => {
  it('DOCUMENTS the SDK-level blocker: a wire null result and a real empty response both resolve identically (no distinguishing signal reaches the caller)', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.setSessionModel('gone-session', 'm1');
    await flush();
    // acp_adapter/server.py:2026-2036 — the harness sends a literal
    // JSON-RPC `"result": null` for a missing session. The SDK's
    // `unstable_setSessionModel` normalizes this to `{}` internally
    // (`?? {}`), so this call resolves (not rejects) exactly like a real
    // success would — there is no wire-level signal left to act on here.
    respond(stdout, null);

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it('resolves normally for a real switch (a genuine SetSessionModelResponse, non-null)', async () => {
    const { client, stdout } = await connectClient();
    const resultPromise = client.setSessionModel('live-session', 'm1');
    await flush();
    respond(stdout, {});

    await expect(resultPromise).resolves.toBeUndefined();
  });
});
