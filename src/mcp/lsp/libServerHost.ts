/**
 * W3 (LIB) · T2 — `LibServerHost`: the bind-once / token-once loopback HTTP
 * MCP server singleton lifecycle (research doc §4.1). Headless (no `vscode`
 * import — real-socket testable in vitest as-is); the `vscode.Disposable`
 * wiring (`context.subscriptions`, trust gating) is T7's job. This module
 * owns:
 *  - the ONE bind (`server.listen(0, '127.0.0.1')` — host arg mandatory),
 *    with an assert that the resulting `server.address()` is IPv4-family
 *    loopback (else the start fails, no advertisement is ever produced);
 *  - the ONE token mint (`crypto.randomBytes(32).toString('base64url')` —
 *    the dashboard's exact mint, not the 128-bit `nonce.ts` helper);
 *  - the frozen `TransportExpectation` + cached `AcpMcpServerHttp`
 *    advertisement (idempotent `start()`);
 *  - the post-bind listener-error policy: exactly ONE same-port/same-token
 *    rebind, then permanently down for the session (no retry loop, never a
 *    new port — research doc §4.1, "a burned token that serves nothing is
 *    strictly safer" than resurrecting a server whose token a squatter may
 *    have captured during the outage window);
 *  - `dispose()`: closes the listener AND destroys every tracked open
 *    socket, so nothing (e.g. `deactivate()`) can ever hang on a keep-alive
 *    connection.
 *
 * Zero-race port discovery (implementer note): `createLibServer` (`./server.ts`)
 * needs a fully-known `TransportExpectation` — including the port — to wire
 * its request handler, but the port is only known AFTER a successful
 * `listen(0, ...)`. Rather than bind a throwaway probe server just to learn
 * a free port and then re-bind a second, real server on that same number
 * (a real TOCTOU, even if tiny), `start()` below binds ONE bare
 * `http.Server` first (no request handler yet), reads back the assigned
 * port, mints the token, freezes `expect`, and ONLY THEN attaches
 * `createLibRequestListener(...)` to that same, already-listening server via
 * `server.on('request', ...)`. Zero extra bind, zero race.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { Socket } from 'node:net';

import { createLibRequestListener } from './server';
import type { TransportExpectation } from './transportSecurity';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AcpHttpHeader, AcpMcpServerHttp } from '../../shared/acpMcpServerHttp';

// `AcpHttpHeader`/`AcpMcpServerHttp` used to be defined locally here (T2,
// before T3 existed), then reconciled by T3 into a single canonical home
// next to `AcpMcpServerStdio` in `host/backend/acp/acpClient.ts` — which put
// a real edge from `mcp/lsp/` back into `host/`, part of the `host` ⇄
// `mcp/lsp` directory cycle the architecture audit flagged (`host/lib/*`
// already imports FROM `mcp/lsp/*` the other way). T-19 (C1+C2) moved them
// again, to `src/shared/acpMcpServerHttp.ts` — a home neither `host/` nor
// `mcp/lsp/` needs to import THE OTHER for. This is a TYPE-ONLY import
// (erased at compile), so it introduces no runtime dependency either way and
// `libServerHost` stays headless (no `vscode` import, real-socket testable
// in vitest as-is).

export interface LibServerHost {
  /** Bind + mint once; idempotent — repeat calls return the SAME cached
   * result (including `undefined` if the first attempt failed) without
   * re-binding. */
  start(): Promise<AcpMcpServerHttp | undefined>;
  /** The frozen advertisement, or `undefined` before `start()`/after a
   * failed bind. Never re-minted; stays stable across a same-port rebind —
   * but is CLEARED to `undefined` once the host goes permanently-down or is
   * disposed (T-E1: never hand out the bearer for a port a squatter may own). */
  advertisement(): AcpMcpServerHttp | undefined;
  /** Closes the listener and destroys every open socket. Safe to call more
   * than once (idempotent no-op after the first call) and safe to call
   * before `start()` ever resolved. */
  dispose(): void;
}

export interface LibServerHostDeps {
  readonly buildMcpServer: () => McpServer;
  /** Output-channel sink (DEBUG-only reject reasons, lifecycle notices).
   * Never receives a header value or the token — see `server.ts`. */
  readonly log?: (msg: string) => void;
  /** Pinned `vscode_lsp` by default (research doc §4.3). Overridable for
   * tests; production callers should not need to. */
  readonly serverName?: string;
  /** Default 4 MiB (research doc §3.2 rule 7 note: "generous for JSON-RPC
   * tool calls"). */
  readonly maxBodyBytes?: number;
  /** The bare-`http.Server` constructor, defaulting to `http.createServer`.
   * A thin, standard DI seam (the same "keep dep-touching code behind an
   * interface" pattern as `AcpClientLike` in `acpClient.ts`) — its only
   * purpose is letting a test capture a REFERENCE to the real, live server
   * object `libServerHost` binds, so the post-bind listener-error wiring
   * (`onServerError`) can be driven with a genuine `EventEmitter.emit('error',
   * ...)` on the actual object under test, rather than only exercising the
   * pure {@link decideRebindAction} table. Never overridden in production. */
  readonly createServer?: () => http.Server;
  /** T-9 (squatter full closure, following up T-E1): fired at MOST ONCE,
   * exactly when the host transitions to permanently-down (guarded by the
   * same `permanentlyDown` flip that clears `cachedAdvertisement` — never
   * on the one allowed rebind, never again once already down). T-E1 already
   * burns the ACCESSOR (`advertisement()` returns `undefined` from this
   * point on), but `extension.ts` reads `advertisement()` ONCE at start and
   * hands the captured copy to `backend.setMcpServer('vscode_lsp',
   * advertisement)` — every FUTURE `session/new`/`session/load`/
   * `session/resume` re-sends that stale copy (token included) to whatever
   * now owns the port. This hook is `extension.ts`'s seam to withdraw that
   * registration (`backend.setMcpServer('vscode_lsp', undefined)`) so no
   * future session ever hears about the dead server again. Invoked
   * try/caught — a throwing caller must never affect this host's own state
   * machine. Never overridden in tests other than to observe the call. */
  readonly onPermanentDown?: () => void;
}

const DEFAULT_SERVER_NAME = 'vscode_lsp';
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MCP_PATH = '/mcp';

/**
 * The post-bind listener-error policy, extracted as a PURE decision so it is
 * unit-testable without any socket at all (process guidance: "the
 * rebind-policy state machine should be unit-testable where extractable").
 * `libServerHost`'s imperative wiring below is the only caller.
 */
export type RebindDecision = 'rebind' | 'permanent-down' | 'ignore';

export function decideRebindAction(state: {
  readonly rebindAttempted: boolean;
  readonly down: boolean;
}): RebindDecision {
  if (state.down) return 'ignore'; // already permanently down — nothing more to do, ever
  if (state.rebindAttempted) return 'permanent-down'; // the one rebind already happened and this is a second failure
  return 'rebind'; // first-ever post-bind error — the one allowed attempt
}

/** Wrap `server.listen(port, '127.0.0.1')` as a promise settling on the
 * FIRST `'error'`/`'listening'` event, cleaning up whichever listener didn't
 * fire so it can't leak into later use of the same server object. */
function listenAsync(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    function cleanup(): void {
      server.off('error', onError);
      server.off('listening', onListening);
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** Research doc §3.2/§3.3: the bind's host argument is mandatory and the
 * result MUST be asserted IPv4-family loopback — a bare `listen(0)` (no
 * host) would bind all interfaces, defeating the transport guard's rule 1
 * premise. Returns the bound `{address,port}` only when that assertion
 * holds. */
function assertLoopbackIPv4(server: http.Server): { address: string; port: number } | undefined {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') return undefined;
  if (addr.family !== 'IPv4' || addr.address !== '127.0.0.1') return undefined;
  return { address: addr.address, port: addr.port };
}

/** AU-32: a rejected, pre-settled `startPromise` used to poison every FUTURE
 * `start()` call once the host is disposed/permanently-down (module doc
 * §AU-32 — see the two call sites below). Attaching a no-op `.catch` to the
 * INTERNAL reference right away is what keeps this from tripping Node's
 * `unhandledRejection` detector on its own — a caller's own `await`/`.catch()`
 * on the SAME promise object still observes the rejection normally, since a
 * settled promise supports any number of independent handlers. */
function makePoisonedStartPromise(message: string): Promise<AcpMcpServerHttp | undefined> {
  const poisoned = Promise.reject<AcpMcpServerHttp | undefined>(new Error(message));
  poisoned.catch(() => {
    // Intentionally empty — see doc comment above.
  });
  return poisoned;
}

export function createLibServerHost(deps: LibServerHostDeps): LibServerHost {
  const serverName = deps.serverName ?? DEFAULT_SERVER_NAME;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = deps.log;

  let startPromise: Promise<AcpMcpServerHttp | undefined> | undefined;
  let cachedAdvertisement: AcpMcpServerHttp | undefined;
  let server: http.Server | undefined;
  let boundPort: number | undefined;
  let rebindAttempted = false;
  let permanentlyDown = false;
  let disposed = false;
  const activeSockets = new Set<Socket>();

  /** T-9: fire the (optional) permanent-down hook exactly once, at the
   * point the caller flips `permanentlyDown = true`. try/caught — a
   * throwing `onPermanentDown` must never propagate back through the
   * `'error'` `EventEmitter` listener (which would otherwise crash the
   * process) nor leave this host's own state machine (already-latched
   * `permanentlyDown`/cleared `cachedAdvertisement`) in any different
   * shape. */
  function firePermanentDown(): void {
    try {
      deps.onPermanentDown?.();
    } catch (err) {
      log?.(`[debug] LIB onPermanentDown callback threw — swallowed: ${String(err)}`);
    }
  }

  function trackSockets(s: http.Server): void {
    s.on('connection', (socket: Socket) => {
      activeSockets.add(socket);
      socket.once('close', () => activeSockets.delete(socket));
    });
  }

  function destroyActiveSockets(): void {
    for (const socket of activeSockets) socket.destroy();
    activeSockets.clear();
  }

  /** Post-bind `'error'` handler — armed only AFTER the initial bind
   * succeeds (research doc §4.1: "Listener-error policy (post-bind
   * 'error')"). Wires {@link decideRebindAction}'s verdict to the real
   * close+relisten. */
  function onServerError(): void {
    if (disposed) return;
    const decision = decideRebindAction({ rebindAttempted, down: permanentlyDown });
    if (decision === 'ignore') return;
    if (decision === 'permanent-down') {
      permanentlyDown = true;
      // T-E1: stop handing out `Bearer <our token>` for a port another
      // process may now own — a burned token that serves nothing is
      // strictly safer than resurrecting a server whose token a squatter
      // may have captured during the outage window (module doc :14-18).
      cachedAdvertisement = undefined;
      // AU-32: poison the cached start() promise too — otherwise a LATER
      // start() call (startPromise already cached from the earlier
      // successful bind) would keep returning that SAME resolved promise,
      // handing back a stale advertisement for a token/port this host no
      // longer owns (only the advertisement() accessor used to burn).
      startPromise = makePoisonedStartPromise(
        'LibServerHost: permanently down after a failed rebind',
      );
      // T-9: withdraw the registration for FUTURE sessions too — the
      // accessor above only protects a read AFTER this point; without this,
      // extension.ts's already-captured advertisement copy keeps being
      // re-sent on every subsequent session/new|load|resume.
      firePermanentDown();
      log?.(
        '[debug] LIB listener permanently down after a failed same-port rebind — no further attempts this session.',
      );
      return;
    }
    // decision === 'rebind'
    rebindAttempted = true;
    log?.('[debug] LIB listener error — attempting the one allowed same-port rebind.');
    const currentServer = server;
    const currentPort = boundPort;
    if (currentServer === undefined || currentPort === undefined) {
      permanentlyDown = true;
      // Unreachable by construction (server/boundPort are assigned before any
      // onServerError can fire) — but keep the permanent-down invariant
      // consistent: a burned host never advertises a reusable token (review E1-M).
      cachedAdvertisement = undefined;
      // AU-32: same reasoning as the other permanent-down transition above —
      startPromise = makePoisonedStartPromise(
        'LibServerHost: permanently down after a failed rebind',
      );
      // T-9: same reasoning as the other permanent-down transition above —
      // consistent even on this defensively-unreachable branch.
      firePermanentDown();
      return;
    }
    destroyActiveSockets();
    currentServer.close(() => {
      // dispose() may have raced this close — never resurrect a listener an
      // explicit dispose() already tore down.
      if (disposed) return;
      currentServer.listen(currentPort, '127.0.0.1');
    });
  }

  async function doStart(): Promise<AcpMcpServerHttp | undefined> {
    const bareServer = (deps.createServer ?? (() => http.createServer()))();
    try {
      await listenAsync(bareServer, 0);
    } catch (err) {
      // S3 (AU-36 tail): an initial bind failure (e.g. port exhaustion)
      // used to resolve `start()` to `undefined` silently — no throw, no
      // log, indistinguishable from "trust not granted yet". Fail closed
      // and LOUD instead, matching `transportSecurity`'s own fail-closed
      // posture without touching that file: nothing to clean up beyond the
      // (never-listening) server object itself, but the caller must never
      // be able to miss this. The original error is preserved as `.cause`
      // for diagnostics; the message itself stays a fixed, non-secret
      // string (token discipline — same posture as every `log?.()` line in
      // this module).
      log?.('[debug] LIB initial bind failed — startup aborted.');
      throw new Error('LibServerHost: initial bind failed', { cause: err });
    }

    const loopback = assertLoopbackIPv4(bareServer);
    if (loopback === undefined) {
      bareServer.close();
      // S4 (AU-36 tail): same fail-closed-and-loud posture as S3 above — a
      // bind that somehow did not yield an IPv4 loopback address must never
      // silently resolve `start()` to `undefined`; the transport guard's
      // rule 1 premise (every accepted request is loopback-only) would
      // otherwise be unverifiable with nothing to show for it.
      log?.('[debug] LIB bind did not yield an IPv4 loopback address — startup aborted.');
      throw new Error('LibServerHost: bind did not yield an IPv4 loopback address');
    }

    // I-1: a dispose() that lands while the bind above was pending sees
    // `server === undefined` (it's only assigned below) and no-ops except
    // for latching `disposed = true`. Re-check here, before this function
    // wires the request handler / mints the token / builds the
    // advertisement — otherwise an explicit dispose() during the bind
    // window would be silently overridden by a live, authenticated
    // loopback listener that nothing ever closes.
    if (disposed) {
      bareServer.close();
      return undefined;
    }

    server = bareServer;
    boundPort = loopback.port;
    trackSockets(server);

    const token = crypto.randomBytes(32).toString('base64url');
    // T1 carry-note #1: Host/Origin are compared AS-IS by evaluateHeaders
    // (only the INCOMING value is lowercased) — these literals must already
    // be lowercase. Harmless for the numeric port here, but pinned per the
    // carry-note so a future change to a non-numeric literal can't reopen
    // the gap silently.
    const expect: TransportExpectation = Object.freeze({
      host: `127.0.0.1:${boundPort}`.toLowerCase(),
      origin: `http://127.0.0.1:${boundPort}`.toLowerCase(),
      path: MCP_PATH,
      token,
      maxBodyBytes,
    });

    server.on('request', createLibRequestListener({ expect, buildMcpServer: deps.buildMcpServer, log }));
    server.on('error', onServerError);

    // Built as plain (mutable-typed) values first, then deep-frozen via
    // separate statements — `AcpMcpServerHttp`/`AcpHttpHeader` (canonical
    // home: `acpClient.ts`, matching the installed ACP SDK's `McpServer`/
    // `HttpHeader` shape) declare plain, non-`readonly` fields, and a
    // `readonly T[]` inferred from a nested `Object.freeze([...])` call is
    // NOT assignable to a mutable `T[]` — so the freeze calls are split out
    // rather than nested inline. `Object.freeze` mutates and returns the SAME
    // reference, so this achieves the identical deep-frozen end state (header
    // frozen, then its array, then the advertisement object) as a single
    // nested expression would, just via statements instead of expressions.
    const authHeader: AcpHttpHeader = { name: 'Authorization', value: `Bearer ${token}` };
    const headers: AcpHttpHeader[] = [authHeader];
    const advertisement: AcpMcpServerHttp = {
      type: 'http',
      name: serverName,
      url: `http://127.0.0.1:${boundPort}${MCP_PATH}`,
      headers,
    };
    Object.freeze(authHeader);
    Object.freeze(headers);
    Object.freeze(advertisement);
    cachedAdvertisement = advertisement;
    return advertisement;
  }

  function start(): Promise<AcpMcpServerHttp | undefined> {
    if (startPromise === undefined) {
      startPromise = doStart();
    }
    return startPromise;
  }

  function advertisement(): AcpMcpServerHttp | undefined {
    return cachedAdvertisement;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // T-E1: same reasoning as the permanent-down transition above — once
    // disposed, this host must never keep handing out `Bearer <our token>`
    // for a port that is no longer bound (or that another process may go
    // on to claim).
    cachedAdvertisement = undefined;
    // AU-32: poison the cached start() promise so a LATER start() call —
    // whether start() already ran before dispose() (previously: kept
    // returning the SAME resolved promise, handing back a stale
    // advertisement) or never ran at all (previously: `doStart()` would run
    // afresh, performing a real bind attempt only to discard it via the I-1
    // disposed-check deep inside `doStart()`) — REJECTS immediately
    // instead, matching `advertisement()`'s own post-dispose fail-closed
    // posture above. A pending start() already in flight when dispose()
    // lands is unaffected (I-1): its own already-returned promise reference
    // still resolves via `doStart()`'s own disposed-check.
    startPromise = makePoisonedStartPromise('LibServerHost: start() called after dispose()');
    if (server !== undefined) {
      // Stop the rebind machinery — this is an intentional shutdown, not a
      // listener error to react to.
      server.removeAllListeners('error');
      destroyActiveSockets();
      server.close();
    }
  }

  return { start, advertisement, dispose };
}
