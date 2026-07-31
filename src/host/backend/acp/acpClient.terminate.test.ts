import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * W1-T1 (CF-01/A-2): the central terminate-race at the `AcpClient` seam.
 *
 * The pinned ACP SDK never rejects an in-flight request when the child's
 * stdio stream closes (child death) — a request in flight when the Hermes
 * child dies hangs forever (`@agentclientprotocol/sdk`'s `#pendingRequests`
 * map, populated on send, is only ever resolved/rejected by a matching
 * response frame; a dead child sends none). Every `AcpClient` request method
 * used to hand that raw SDK promise straight back, so a caller with no
 * MANUAL race of its own (unlike `SessionController.runControlUtterance`'s
 * wall-clock `Promise.race`, or `ConnectionSupervisor.raceAgainstChildExit`'s
 * `onExit`-based race) hung forever on child death.
 *
 * This file proves the fix at the SEAM: `AcpClient` itself now races every
 * request-shaped method against a per-connection termination promise that
 * rejects from the SAME `terminate()` choke `child.on('exit'|'error')`
 * already funnels through (`acpClient.ts`'s `connect()`-local `terminate`
 * closure, ~:360) — no caller-side plumbing required. Mirrors
 * `acpClient.wire.test.ts`'s mock-child pattern:
 * a fake `ChildProcess` (`EventEmitter` + real `PassThrough` stdio) drives
 * the REAL, production `AcpClient`; `child.stdout` never emits a byte, so a
 * request's underlying SDK promise would stay pending forever on its own —
 * exactly the "never resolves without a response frame" behavior this test
 * needs to prove `AcpClient` now settles anyway.
 *
 * RED (pre-fix): `client.prompt(...)`/`client.listSessions(...)` never
 * settle after `child.emit('exit', ...)` — `expect(...).rejects` times out
 * (vitest's 5s default), not a clean assertion failure. GREEN (post-fix):
 * both reject within a tick with a "terminated" message.
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
 * Same minimal fake `ChildProcess` as `acpClient.wire.test.ts`'s
 * `makeFakeChild` (duplicated rather than imported — that file's helper is
 * module-private and this file needs no wire-frame capture), except it also
 * returns the concrete `stdout` `PassThrough` — `ChildProcess.stdout` types
 * as `Readable | null` (no `.write`), so the happy-path test below needs the
 * un-widened reference to push a fake response frame in.
 */
function makeFakeChild(): { child: ChildProcess; stdout: PassThrough } {
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
  return { child: fake as unknown as ChildProcess, stdout };
}

/** Connects a real `AcpClient` over a fake child and returns both. */
async function connectClient(): Promise<{ client: AcpClient; child: ChildProcess; stdout: PassThrough }> {
  const { child, stdout } = makeFakeChild();
  vi.mocked(spawn).mockReturnValue(child);

  const client = new AcpClient({
    spawn: { command: 'hermes', args: ['acp'] },
    cwd: '/workspace',
    callbacks: NOOP_CALLBACKS,
  });
  await client.connect();

  return { client, child, stdout };
}

describe('AcpClient — central terminate-race (CF-01/A-2)', () => {
  it('prompt() rejects with a "terminated" message when the child exits mid-request, instead of hanging forever', async () => {
    const { client, child } = await connectClient();

    // `child.stdout` never emits a byte, so the SDK's own promise for this
    // request never settles on its own (no response frame ever arrives) —
    // proving the REJECTION below can only come from AcpClient's own race,
    // never from the SDK settling the underlying request.
    const promptResult = client.prompt('s1', []);

    child.emit('exit', 1);

    await expect(promptResult).rejects.toThrow(/terminated/i);
  });

  it('listSessions() rejects with a "terminated" message when the child exits mid-request, instead of hanging forever', async () => {
    const { client, child } = await connectClient();

    const listResult = client.listSessions();

    child.emit('exit', 1);

    await expect(listResult).rejects.toThrow(/terminated/i);
  });

  it('both prompt() and listSessions() reject off the SAME termination event when both are in flight together', async () => {
    const { client, child } = await connectClient();

    const promptResult = client.prompt('s1', []);
    const listResult = client.listSessions();

    child.emit('exit', 137);

    await expect(promptResult).rejects.toThrow(/terminated/i);
    await expect(listResult).rejects.toThrow(/terminated/i);
  });

  it('the happy path is unaffected: a resolving request still resolves normally through the race', async () => {
    const { client, stdout } = await connectClient();

    const listResult = client.listSessions();

    // Answer the in-flight `session/list` request directly on the fake
    // child's stdout with a well-formed JSON-RPC response — the id is `0`,
    // the connection's first request on a fresh client (same convention
    // `acpClient.wire.test.ts` relies on for its own frame assertions).
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { sessions: [] } })}\n`);

    await expect(listResult).resolves.toEqual({ sessions: [] });
  });

  /**
   * CF-01/A fix wave (arch Important): `terminate()` used to clear ONLY
   * `this.child`, not `this.connection` — a request issued on a STALE
   * captured `client` reference (e.g. `SessionController.runTurn`'s
   * `client` local, read once and reused across an `await`) AFTER
   * termination fell through `raceTermination`'s `op()`-only passthrough
   * (no live `terminationPromise` left to race against) straight into
   * `requireConnection()`, which found `this.connection` still set and
   * handed back a dead `ClientSideConnection` — the exact same "SDK never
   * rejects on stream close" hang this whole file exists to close, just
   * reopened for the post-terminate window. Fixed by clearing
   * `this.connection` in the SAME synchronous block that clears
   * `this.child`, so `requireConnection()` now throws synchronously
   * (surfaced here as the returned promise rejecting) regardless of
   * whether any external `dispose()` ever ran.
   *
   * RED (pre-fix): this assertion's `rejects.toThrow(/not connected/i)`
   * fails — the promise instead hangs (child.stdout never emits a byte, so
   * nothing ever answers the SDK's request) until vitest's timeout.
   */
  it('a request issued on a STALE client reference AFTER termination fails fast (requireConnection), not hangs, even with no dispose() in between', async () => {
    const { client, child } = await connectClient();

    child.emit('exit', 1);
    // Let the termination promise's own rejection reaction (already marked
    // "handled" via `.catch(() => {})` in `connect()`) drain — this test
    // deliberately issues the NEXT call only after termination has fully
    // settled, simulating a caller that re-enters on a stale ref sometime
    // later, not one racing the exit event itself.
    await Promise.resolve();

    await expect(client.listSessions()).rejects.toThrow(/not connected/i);
  });

  /**
   * [Minor] hardening (both review lenses): `ConnectionSupervisor` already
   * guarantees "one `connect()` per `AcpClient` instance" by CONVENTION
   * (`createClient` mints a brand-new instance per connect/respawn) — this
   * makes the single-lifecycle invariant SELF-enforcing instead of relying
   * on every future caller obeying that convention.
   */
  it('connect() throws if the client is already connected (double-invocation guard)', async () => {
    const { client } = await connectClient();

    await expect(client.connect()).rejects.toThrow(/already connected/i);
  });

  it('AUDIT-5 ARCH-4: dispose() settles the termination pair — an in-flight RPC rejects promptly instead of dangling until the webview 30s timeout', async () => {
    const { client } = await connectClient();
    const listResult = client.listSessions(); // stdout never answers — only the pair can settle this

    client.dispose(); // intentional teardown: Restart Agent Connection / deactivate / backend swap

    await expect(listResult).rejects.toThrow(/terminated/i);
  });

  it('regression pin: dispose() keeps suppressing the exitHandlers fan-out when the SIGTERMed child eventually exits', async () => {
    const { client, child } = await connectClient();
    const exits: Array<number | null> = [];
    client.onExit((code) => exits.push(code));

    client.dispose();
    child.emit('exit', 0);

    expect(exits).toEqual([]); // terminate()'s identity guard still eats the late exit — intentional
  });
});
