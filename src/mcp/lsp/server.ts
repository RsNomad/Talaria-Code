/**
 * W3 (LIB) · T2 — the impure `node:http` transport for the LIB HTTP MCP
 * server: the header-facts extractor, the duplicate-Host fail-closed
 * pre-check, the streaming body-byte-cap counter, and the per-request
 * stateless SDK transport. This module owns all the I/O the pure
 * {@link evaluateHeaders} guard (T1, `./transportSecurity.ts`) deliberately
 * does not: it is the ONLY caller of that guard, and it calls it BEFORE a
 * single body byte is read and BEFORE anything is handed to the
 * `@modelcontextprotocol/sdk` transport (research doc §3.1, §3.5).
 *
 * Headless by construction — no `vscode` import; `node:http`/`node:crypto`
 * (via T1)/the SDK only. `libServerHost.ts` (this same task) owns bind/
 * lifecycle; this module only wires ONE route's request handling given an
 * already-known {@link TransportExpectation}.
 *
 * Grounded (Context7 `/modelcontextprotocol/typescript-sdk`, at write-time,
 * against the INSTALLED `@modelcontextprotocol/sdk@1.29.0`):
 *  - The installed `StreamableHTTPServerTransport` (`server/streamableHttp.js`)
 *    is a thin Node-http wrapper around `WebStandardStreamableHTTPServerTransport`
 *    (`server/webStandardStreamableHttp.js`, via `@hono/node-server`). Its
 *    documented idiom for a pre-parsed body (mirrors Express body-parser
 *    usage in the SDK's own docs: "pass the pre-parsed body to avoid
 *    re-reading the stream") is `transport.handleRequest(req, res, parsedBody)`
 *    — exactly what this module does: it buffers+caps the body itself (the
 *    authoritative streaming counter), JSON-parses it, and passes the result
 *    as `parsedBody` so the SDK never attempts to re-read the (already
 *    consumed) Node request stream.
 *  - `enableJsonResponse: true` is passed so a stateless single-shot POST
 *    gets a plain JSON response, never an SSE stream (research doc §3.5:
 *    "answer each POST with JSON (no SSE)"); combined with our own guard's
 *    POST-only rule 6, the SDK's GET-SSE-stream code path is structurally
 *    unreachable here (never routed to).
 *  - `sessionIdGenerator: undefined` is the SDK's documented stateless mode
 *    (Context7-confirmed: "no Session ID is included in any responses...no
 *    session validation is performed" — `WebStandardStreamableHTTPServerTransport
 *    .validateSession` short-circuits entirely when `sessionIdGenerator` is
 *    undefined, verified by reading the installed `.js`). This is WHY a
 *    fresh per-request `McpServer`+transport pair (never having seen a
 *    prior `initialize` on THIS instance) can still correctly answer a
 *    later `tools/list`/`tools/call` POST: the low-level `Server`/`Protocol`
 *    class (`server/index.js`, read this pass) has no "reject before
 *    initialize" gate of its own — that ordering is a client-side courtesy,
 *    not a wire-level requirement in stateless mode. The real-socket test
 *    (b) proves this empirically against the real SDK client, not just by
 *    reading the source.
 *  - `enableDnsRebindingProtection`/`allowedHosts`/`allowedOrigins`
 *    (`WebStandardStreamableHTTPServerTransportOptions`, read from the
 *    installed `.d.ts` this pass): present in 1.29.0, but each is annotated
 *    `@deprecated "Use external middleware ... instead"` — which is
 *    *exactly* this module's architecture (`evaluateHeaders` + this file ARE
 *    that external middleware). Deliberately left OFF: our guard already
 *    enforces a narrower, exact-string Host/Origin match plus loopback-peer
 *    plus bearer BEFORE any request reaches the transport, so the SDK's own
 *    (deprecated, off-by-default) checks would be pure redundancy at best —
 *    and, per research doc §3.5's explicit warning, enabling a second,
 *    independently-formatted host/origin check risks a self-inflicted 403
 *    on legitimate Hermes traffic (a with-port-vs-without-port mismatch) for
 *    zero additional security (a request that reaches the transport has, by
 *    construction, already passed our own stricter check). Strictly
 *    wider-or-off, never out-voting our guard — here, "off".
 */
import * as http from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  evaluateHeaders,
  type RequestHeaderFacts,
  type TransportExpectation,
} from './transportSecurity';

/** Injected deps for one route's request handling — see module doc. */
export interface LibServerDeps {
  readonly expect: TransportExpectation;
  readonly buildMcpServer: () => McpServer;
  /** Output-channel sink. Reject reasons go here at DEBUG only — never a
   * header value, never the token (R4.4/R7.4). Omit to log nothing. */
  readonly log?: (msg: string) => void;
}

/** The minimal reject-body error text per HTTP status (research doc §3.2:
 * "minimal JSON body ... no HTML/banner/route list"). */
const REJECT_ERROR_TEXT: Readonly<Record<401 | 403 | 404 | 405 | 413, string>> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  405: 'method not allowed',
  413: 'payload too large',
};

function logDebug(log: ((msg: string) => void) | undefined, reason: string): void {
  // Fixed, non-secret reason strings only — see module doc token discipline.
  log?.(`[debug] LIB transport reject: ${reason}`);
}

/**
 * Rule-0 fail-closed pre-check (research doc §3.1/§3.2, ahead of
 * `evaluateHeaders`): a request carrying more than one `Host` header must be
 * rejected before the guard even runs, because Node's OWN folding of
 * duplicate singleton headers into `req.headers.host` is version-dependent
 * and not to be trusted for a security decision. `req.rawHeaders` is the
 * flat, unfolded `[name0, value0, name1, value1, ...]` list Node always
 * provides regardless of folding — scanned case-insensitively here.
 */
function countHostHeaderOccurrences(rawHeaders: readonly string[]): number {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (name !== undefined && name.toLowerCase() === 'host') count += 1;
  }
  return count;
}

/**
 * URL-normalize `req.url` to its pathname, query stripped. Handles the
 * absolute-form request-target case (research doc §3.1: a full URI as the
 * request-target yields its full-URI pathname, compared as-is against
 * `expect.path` by rule 5 — NOT auto-accepted). A malformed/unparseable
 * `req.url` is defensively treated as a path that can never match `/mcp`
 * (fails rule 5 closed) rather than throwing out of the request handler —
 * untrusted network input reaching an unparseable state is an EXPECTED
 * adversarial case here, not a "should never happen" bug (typescript-error-
 * handling: recoverable use-error over untrusted input), so the deliberate
 * fallback below is a fail-closed sentinel, not a silent swallow.
 */
function extractPathname(rawUrl: string | undefined): string {
  if (rawUrl === undefined) return '';
  try {
    return new URL(rawUrl, 'http://lib-internal.invalid').pathname;
  } catch {
    return '';
  }
}

/** Parsed Content-Length: a non-negative integer, else `undefined` (covers
 * absent, NaN, negative, and — because chunked requests carry no
 * Content-Length at all — chunked, per research doc §3.1). */
function parseDeclaredContentLength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Fill {@link RequestHeaderFacts} straight from Node's request object.
 * IMPORTANT (T1 carry-note #2): `originHeader`/`hostHeader`/
 * `authorizationHeader` are passed through EXACTLY as Node hands them —
 * `undefined` only when the header is truly absent. A present-but-empty
 * value (`''`) or the literal string `'null'` must stay a STRING here so
 * `evaluateHeaders` rejects it (rule 3); coercing it to `undefined` would
 * wrongly turn a present-and-bad Origin into a pass. There is no `||`/`??`
 * anywhere in this function for exactly that reason.
 */
function extractHeaderFacts(req: http.IncomingMessage): RequestHeaderFacts {
  return {
    method: (req.method ?? '').toUpperCase(),
    path: extractPathname(req.url),
    remoteAddress: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    originHeader: req.headers.origin,
    authorizationHeader: req.headers.authorization,
    declaredContentLength: parseDeclaredContentLength(req.headers['content-length']),
  };
}

/** Write a JSON body and gracefully close the connection once the response
 * has fully flushed (research doc §3.2: no HTML, no header echo, never the
 * token). `res.once('finish', () => res.socket?.end())` — a GRACEFUL
 * (FIN-after-flush) close, not an abortive `req.destroy()`/`socket.destroy()`
 * — because `req.socket === res.socket` on a non-upgraded HTTP/1.1
 * connection, and `finish` only guarantees the data was handed to the
 * underlying stream, not that the peer has read it yet; an abortive destroy
 * racing that hand-off can RST the connection before the client finishes
 * reading, surfacing as a client-side ECONNRESET even though the full
 * response was in fact written (reproduced while writing this module's
 * tests — `socket.end()` avoids it because it waits for the queued write to
 * drain before sending FIN). */
function writeJsonAndClose(
  res: http.ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> | undefined,
  bodyObj: Readonly<Record<string, unknown>>,
): void {
  const body = JSON.stringify(bodyObj);
  const finalHeaders: http.OutgoingHttpHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (headers !== undefined) Object.assign(finalHeaders, headers);
  res.writeHead(status, finalHeaders);
  res.once('finish', () => res.socket?.end());
  res.end(body);
}

function sendJsonAndClose(
  res: http.ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> | undefined,
  errorText: string,
): void {
  writeJsonAndClose(res, status, headers, { error: errorText });
}

/** Same shape as {@link sendJsonAndClose} but for a malformed-JSON body,
 * mirroring the SDK's own `createJsonErrorResponse(400, -32700, ...)`
 * JSON-RPC parse-error contract (read from the installed SDK this pass) so
 * a caller sees the same error shape whether the SDK or we caught it. */
function sendJsonRpcParseError(res: http.ServerResponse): void {
  writeJsonAndClose(res, 400, undefined, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error' },
  });
}

/**
 * Stream the accepted request's body, counting bytes as they arrive and
 * aborting with 413 the INSTANT the running total exceeds `maxBodyBytes`
 * (research doc §3.1: this is what catches chunked `Transfer-Encoding`
 * bodies and any body with no/understated Content-Length — the header
 * pre-reject in `evaluateHeaders` rule 7 cannot see those). Only once the
 * full body lands within the cap is it handed (as a pre-parsed JSON value)
 * to a brand-new per-request `McpServer`+`StreamableHTTPServerTransport`
 * pair, closed on response finish/close.
 */
async function handleAcceptedBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expect: TransportExpectation,
  buildMcpServer: () => McpServer,
  log: ((msg: string) => void) | undefined,
): Promise<void> {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  // Explicit outcome — NOT inferred from `req.destroyed`/`res.writableEnded`
  // after the fact: Node's Readable streams auto-destroy (`autoDestroy`,
  // default since Node 14) shortly after a NORMAL 'end', so `req.destroyed`
  // is `true` on the ordinary success path too and cannot distinguish
  // "body fully and cleanly received" from "client vanished mid-body".
  let outcome: 'ended' | 'aborted-cap' | 'client-error' = 'ended';

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      total += chunk.length;
      if (total > expect.maxBodyBytes) {
        settled = true;
        outcome = 'aborted-cap';
        cleanup();
        logDebug(log, 'body-too-large');
        sendJsonAndClose(res, 413, undefined, REJECT_ERROR_TEXT[413]);
        resolve();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      outcome = 'ended';
      cleanup();
      resolve();
    };
    const onError = (): void => {
      // Client dropped mid-body (e.g. connection reset). Nothing to answer —
      // the socket is already broken; just stop listening and let the
      // caller see the request never resolved further.
      if (settled) return;
      settled = true;
      outcome = 'client-error';
      cleanup();
      resolve();
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });

  if (outcome !== 'ended') {
    // Either the 413 abort already responded, or the client vanished
    // mid-body before EOF — nothing left to do.
    return;
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  let parsedBody: unknown;
  try {
    parsedBody = raw.length === 0 ? undefined : JSON.parse(raw);
  } catch {
    // Malformed JSON from an already-authenticated caller — a real but
    // expected-shape failure, not a "should never happen" bug. Answer with
    // the SDK's own parse-error contract rather than passing garbage
    // further down or hanging.
    logDebug(log, 'malformed-json');
    sendJsonRpcParseError(res);
    return;
  }

  // AU-21: `transport`/`mcpServer` construction moved INSIDE the try below
  // (was previously OUTSIDE it) — a constructor throw here used to escape
  // uncaught, and the `void`-shaped caller in `createLibRequestListener`
  // had no `.catch`, so it became an unhandled promise rejection instead of
  // an answered request (the client hangs to its own ~300s read-timeout).
  // Declared here (not `const` inside the try) so the catch below can close
  // whichever of the two got constructed before a later step threw.
  let transport: StreamableHTTPServerTransport | undefined;
  let mcpServer: McpServer | undefined;
  let closed = false;
  const closeBoth = (): void => {
    if (closed) return;
    closed = true;
    // Fire-and-forget cleanup: nothing meaningful to do with a teardown
    // error here, and there is no caller left to propagate it to. Logged as
    // a fixed, non-secret string only (never the error's own message —
    // token discipline applies to every log line in this module, not just
    // the reject path).
    mcpServer?.close().catch(() => logDebug(log, 'mcp-server-close-error'));
    transport?.close().catch(() => logDebug(log, 'transport-close-error'));
  };

  try {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — see module doc
      enableJsonResponse: true, // plain JSON reply, never SSE — see module doc
    });
    mcpServer = buildMcpServer();

    // "Closed on response finish" (research doc §3.5) — 'close' is an
    // extra, defensive net for an abnormally dropped connection (client
    // vanishes mid-handling, before 'finish' would ever fire), so a
    // per-request pair can never leak past an aborted request either.
    // Registered only once both objects exist — a construction throw above
    // never reaches here, so `closeBoth()` in the catch below is the only
    // cleanup path for that case.
    res.once('finish', closeBoth);
    res.once('close', closeBoth);

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch {
    // S2 (AU-36 tail): this is the genuine-defect catch — the SDK itself
    // answers ordinary protocol errors with a proper JSON-RPC error
    // response, so reaching here means something genuinely unexpected
    // failed (a construction throw, or `connect()`/`handleRequest()`
    // throwing before any response was sent). This used to log nothing at
    // all; now it logs a fixed, non-secret line — never the caught error's
    // own message (could in principle wrap request content).
    logDebug(log, 'handle-accepted-body-error');
    // Close whatever got constructed before the throw (AU-21) — explicit,
    // not left to the 'finish'/'close' listeners above, because a
    // construction-time throw means those listeners were never registered.
    closeBoth();
    if (!res.headersSent) {
      sendJsonAndClose(res, 500, undefined, 'internal error');
    }
  }
}

/** One route's request-handling logic, given an already-known
 * {@link TransportExpectation}. Exported separately from
 * {@link createLibServer} so `libServerHost.ts` can bind first (learning its
 * ephemeral port) and attach this listener afterward — avoiding a second,
 * throwaway bind just to discover a port number ahead of constructing
 * `expect`. */
export function createLibRequestListener(deps: LibServerDeps): http.RequestListener {
  const { expect, buildMcpServer, log } = deps;
  return (req, res) => {
    if (countHostHeaderOccurrences(req.rawHeaders) > 1) {
      logDebug(log, 'duplicate-host');
      sendJsonAndClose(res, 400, undefined, 'bad request');
      return;
    }

    const facts = extractHeaderFacts(req);
    const verdict = evaluateHeaders(facts, expect);

    if (verdict.kind === 'reject') {
      logDebug(log, verdict.reason);
      sendJsonAndClose(res, verdict.status, verdict.headers, REJECT_ERROR_TEXT[verdict.status]);
      return;
    }

    // Only an accepted request (headers passed all 7 rules) ever reaches
    // body consumption or the SDK — the guard runs BEFORE both.
    //
    // AU-21 last-resort net: `handleAcceptedBody` already fails closed with
    // its own 500 on every caught error (see its own try/catch), but this
    // call site is fire-and-forget by design (no caller ever awaits a
    // `http.RequestListener`) — without this `.catch`, ANY escape from that
    // function would surface as an unhandled promise rejection instead of
    // an answered request, hanging the client to its own read-timeout.
    // Logs a fixed, non-secret string only — never the caught error's own
    // message (token discipline, same as every other log line in this
    // module).
    handleAcceptedBody(req, res, expect, buildMcpServer, log).catch(() => {
      logDebug(log, 'handle-accepted-body-unhandled');
      if (!res.headersSent) {
        sendJsonAndClose(res, 500, undefined, 'internal error');
      }
    });
  };
}

/**
 * Factory: a fresh `http.Server` wired to the single `/mcp` route's
 * request-handling logic, given a fully-known {@link TransportExpectation}.
 * Does NOT call `.listen()` — the caller (a real-socket test, or
 * `libServerHost.ts` internally via {@link createLibRequestListener}
 * directly) owns bind/lifecycle (research doc §4.1: `listen(0,'127.0.0.1')`,
 * host arg mandatory, is `libServerHost`'s job).
 */
export function createLibServer(deps: LibServerDeps): http.Server {
  return http.createServer(createLibRequestListener(deps));
}
