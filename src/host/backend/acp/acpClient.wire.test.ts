import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * Task-5 review F-1 (Important): `acpWireNames.test.ts` proves that
 * `@agentclientprotocol/sdk`'s own `ClientSideConnection` sends bare wire
 * names. It builds that connection itself — `AcpClient` is never imported,
 * never instantiated. That left a real gap: C-1 (routing a call through
 * `extMethod('_session/…', …)`, the exact defect that made `session/list`,
 * `session/set_model` and `session/close` die with -32601 on Hermes) could be
 * reintroduced verbatim inside `AcpClient` and the full gate would stay
 * green, `tsc` included. Reproduced and recorded in the Task 5 review and in
 * this task's fix report.
 *
 * This file closes that gap. It mocks `node:child_process`'s `spawn` with a
 * fake `ChildProcess` (an `EventEmitter` standing in for the process handle,
 * wired to real `PassThrough` streams for stdin/stdout/stderr — the streams
 * are real Node stream objects, not faked, so `Writable.toWeb`/`Readable.toWeb`
 * inside `AcpClient.connect()` behave exactly as they do against a real
 * child), drives the REAL, production `AcpClient.connect()` /
 * `.listSessions()` / `.setSessionModel()` / `.closeSession()`, and captures
 * the literal bytes the SDK writes to the fake child's stdin. Each assertion
 * `JSON.parse`s the captured ndjson line and checks the FULL parsed
 * JSON-RPC frame with `toEqual` — a deep-equality check, not a substring
 * check — so a `_`-prefixed method name (or any other shape change) fails
 * the assertion outright rather than merely failing to match a ban-scan.
 *
 * `child.stdout` is a `PassThrough` that never receives any bytes, so every
 * request stays pending forever (the same "never emits" trick
 * `acpWireNames.test.ts` uses for its fake input stream) — this file only
 * needs the outbound request, never a response.
 *
 * Task 5 re-review N-1: the three `it`s above lock `session/list`,
 * `session/set_model` and `session/close`, but `connect()` never calls
 * `initialize()` — a separate method — so the `initialize` frame (pinned
 * `protocolVersion`, `fs` capabilities, `terminal: false`) had no wire lock
 * at all, and `listSessions()`'s bare no-arg case never exercises the
 * `cwd`/`cursor` conditional branches. Both gaps closed below with the same
 * harness: an `initialize()` frame assertion, and a `listSessions(cwd,
 * cursor)` case with both arguments supplied.
 */
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { AcpClient, type AcpClientCallbacks } from './acpClient';

const NOOP_CALLBACKS: AcpClientCallbacks = {
  onSessionUpdate: () => {},
  onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  onReadTextFile: async () => '',
};

/**
 * A minimal fake `ChildProcess`: an `EventEmitter` for `.on('exit'|'error')`
 * plus a no-op `.kill()` (both called by `AcpClient.connect()`/`.dispose()`),
 * and real `PassThrough` streams for stdin/stdout/stderr — `PassThrough` is a
 * genuine `Duplex`, so `Writable.toWeb(child.stdin)`/`Readable.toWeb(child.stdout)`
 * get real Node stream instances to wrap, not a hand-rolled substitute.
 */
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
  // The fake only needs to satisfy the surface AcpClient actually touches
  // (.stdin/.stdout/.stderr, .on('exit'|'error'), .kill()) — not the full
  // ChildProcess interface, hence the cast.
  return { child: fake as unknown as ChildProcess, stdin, stdout };
}

/**
 * Connects a real `AcpClient` over a fake child process and returns a reader
 * for the parsed JSON-RPC frames written to the fake stdin so far, plus
 * (Task 13) a `respond` writer that feeds one JSON-RPC frame back through the
 * fake child's stdout — the ndjson response path the SDK's request
 * correlation reads — so a test can let an in-flight request RESOLVE (the
 * pre-Task-13 tests only ever needed the outbound frame and left every
 * request pending forever).
 */
async function connectClient(): Promise<{
  client: AcpClient;
  wireFrames: () => unknown[];
  respond: (frame: unknown) => void;
}> {
  const { child, stdin, stdout } = makeFakeChild();
  vi.mocked(spawn).mockReturnValue(child);

  const chunks: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

  const client = new AcpClient({
    spawn: { command: 'hermes', args: ['acp'] },
    cwd: '/workspace',
    callbacks: NOOP_CALLBACKS,
  });
  await client.connect();

  return {
    client,
    wireFrames: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown),
    respond: (frame) => {
      stdout.write(`${JSON.stringify(frame)}\n`);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('AcpClient — real client, real stdin bytes (Task 5 review F-1)', () => {
  it('listSessions() writes an unprefixed "session/list" request frame', async () => {
    const { client, wireFrames } = await connectClient();
    void client.listSessions();
    await flush();
    expect(wireFrames()).toEqual([{ jsonrpc: '2.0', id: 0, method: 'session/list', params: {} }]);
  });

  it('listSessions(cwd, cursor) attaches both params to the request frame', async () => {
    const { client, wireFrames } = await connectClient();
    void client.listSessions('/workspace', 'cur-1');
    await flush();
    expect(wireFrames()).toEqual([
      { jsonrpc: '2.0', id: 0, method: 'session/list', params: { cwd: '/workspace', cursor: 'cur-1' } },
    ]);
  });

  it('setSessionModel() writes an unprefixed "session/set_model" request frame', async () => {
    const { client, wireFrames } = await connectClient();
    void client.setSessionModel('s1', 'm1');
    await flush();
    expect(wireFrames()).toEqual([
      { jsonrpc: '2.0', id: 0, method: 'session/set_model', params: { sessionId: 's1', modelId: 'm1' } },
    ]);
  });

  it('closeSession() writes an unprefixed "session/close" request frame', async () => {
    const { client, wireFrames } = await connectClient();
    void client.closeSession('s1');
    await flush();
    expect(wireFrames()).toEqual([{ jsonrpc: '2.0', id: 0, method: 'session/close', params: { sessionId: 's1' } }]);
  });

  it('initialize() writes the pinned protocolVersion + capabilities frame', async () => {
    const { client, wireFrames } = await connectClient();
    void client.initialize();
    await flush();
    expect(wireFrames()).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
          },
        },
      },
    ]);
  });
});

/**
 * Task 13: `initialize()` must RETAIN the response's `authMethods`
 * (`InitializeResponse.authMethods?: Array<AuthMethod>` — the installed
 * `@agentclientprotocol/sdk@0.17.1`'s `dist/schema/types.gen.d.ts:1506`;
 * every `AuthMethod` union variant carries `{id, name}`) and expose the
 * `{id, name}` projection via `getAdvertisedAuthMethods()`. The fixtures
 * below mirror what Hermes actually builds in
 * `acp_adapter/auth.py::build_auth_methods`: an agent-managed `<provider>`
 * `AuthMethodAgent` (id = the resolved provider) iff credentials resolve,
 * and ALWAYS the `hermes-setup` TerminalAuthMethod (`type:'terminal'`,
 * `args:['--setup']`) — extra wire fields (`description`/`type`/`args`)
 * prove the projection strips down to exactly `{id, name}`.
 */
describe('AcpClient — Task 13: initialize retains the advertised authMethods', () => {
  const PROVIDER_METHOD = {
    id: 'openrouter',
    name: 'openrouter runtime credentials',
    description: 'Authenticate Hermes using the currently configured openrouter runtime credentials.',
  };
  const HERMES_SETUP_METHOD = {
    id: 'hermes-setup',
    name: 'Configure Hermes provider',
    description: 'Open Hermes interactive model/provider setup in a terminal.',
    type: 'terminal',
    args: ['--setup'],
  };

  it('getAdvertisedAuthMethods() is undefined before initialize, then the {id, name} projection of the response authMethods', async () => {
    const { client, respond } = await connectClient();
    expect(client.getAdvertisedAuthMethods()).toBeUndefined();

    const init = client.initialize();
    await flush();
    respond({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [PROVIDER_METHOD, HERMES_SETUP_METHOD],
      },
    });
    await init;

    expect(client.getAdvertisedAuthMethods()).toEqual([
      { id: 'openrouter', name: 'openrouter runtime credentials' },
      { id: 'hermes-setup', name: 'Configure Hermes provider' },
    ]);
  });

  it('a response with NO authMethods field yields [] (initialized, zero advertised) — not undefined', async () => {
    const { client, respond } = await connectClient();
    const init = client.initialize();
    await flush();
    respond({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: {} } });
    await init;
    expect(client.getAdvertisedAuthMethods()).toEqual([]);
  });

  it('FIX 4 (T13 M-1): a null entry inside authMethods is dropped, not dereferenced — no throw', async () => {
    const { client, respond } = await connectClient();
    const init = client.initialize();
    await flush();
    respond({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        // A malformed wire payload (unparsed per this module's own doc
        // comment) — the null entry must be dropped by the `m?.id`/`m?.name`
        // filter guard, not dereferenced (`typeof null.id` throws).
        authMethods: [null, PROVIDER_METHOD],
      },
    });
    await expect(init).resolves.toBeUndefined();
    expect(client.getAdvertisedAuthMethods()).toEqual([{ id: 'openrouter', name: 'openrouter runtime credentials' }]);
  });

  it('FIX 4 (T13 M-1): a null `result` never throws reading .authMethods off it — resolves to []', async () => {
    const { client, respond } = await connectClient();
    const init = client.initialize();
    await flush();
    respond({ jsonrpc: '2.0', id: 0, result: null });
    await expect(init).resolves.toBeUndefined();
    expect(client.getAdvertisedAuthMethods()).toEqual([]);
  });

  it('onAuthMethodsChanged fires once initialize has retained the methods (getter already fresh inside the handler)', async () => {
    const { client, respond } = await connectClient();
    const seen: Array<ReturnType<AcpClient['getAdvertisedAuthMethods']>> = [];
    client.onAuthMethodsChanged(() => seen.push(client.getAdvertisedAuthMethods()));

    const init = client.initialize();
    await flush();
    respond({
      jsonrpc: '2.0',
      id: 0,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [HERMES_SETUP_METHOD] },
    });
    await init;

    expect(seen).toEqual([[{ id: 'hermes-setup', name: 'Configure Hermes provider' }]]);
  });
});
