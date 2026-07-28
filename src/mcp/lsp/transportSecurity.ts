/**
 * W3 (LIB) · T1 — the pure, header-phase transport-security guard for the LIB
 * HTTP MCP server. This is the novel part of the deliverable (research doc
 * §3, "no surveyed harness authenticates an HTTP MCP server"): a fail-closed
 * 7-rule verdict decided over the request's HEADERS ALONE, before a single
 * body byte is consumed. The impure `server.ts` (T2) extracts
 * {@link RequestHeaderFacts} from `req.socket`/`req.headers`/the normalized
 * URL and streams the authoritative body-byte count for chunked bodies; this
 * module owns none of that I/O — `node:crypto` only, for
 * {@link import('node:crypto').timingSafeEqual}.
 *
 * Grounded (Context7, at write-time):
 *  - `/modelcontextprotocol/typescript-sdk` — the DNS-rebinding guides for
 *    every serving surface (`web-standard.md`, `express.md`, `hono.md`,
 *    `http.md`) converge on: Host/Origin validation must run BEFORE the MCP
 *    handler; a request with NO Origin header always passes (non-browser
 *    clients like Hermes/httpx send none); on a loopback bind, a non-loopback
 *    Host is the DNS-rebinding tell.
 *  - `/nodejs/node` (`doc/api/crypto.md`,
 *    `test/sequential/test-crypto-timing-safe-equal.js`) —
 *    `crypto.timingSafeEqual(a, b)` THROWS `RangeError`
 *    (`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`, "Input buffers must have the
 *    same byte length") when `a`/`b` differ in byte length. Hence the
 *    mandatory length-equality pre-check below: an unequal-length token is
 *    rejected WITHOUT ever calling `timingSafeEqual` — this leaks only the
 *    token's length (already public — it's advertised nowhere, but even if
 *    it were, length is not the secret), never the token itself, and never
 *    throws.
 *
 * Order is load-bearing (research doc §3.2 rationale) — DO NOT REORDER:
 * peer → host → origin → auth → path → method → body. Network-identity
 * checks (peer/host/origin) run before auth so a rebinding/cross-site
 * request is rejected even if it somehow carries a bearer; auth runs before
 * path/method so an unauthenticated probe learns only 401 — never a route,
 * a body, or a banner (404/405 are reserved for callers who already proved
 * the bearer). The default arm of {@link evaluateHeaders} is REJECT: every
 * rule is a guard that returns early on failure, and only falling through
 * all seven yields `{kind:'accept'}` — there is no accept branch anywhere
 * else in the function.
 *
 * Token discipline (R4.4/R7.4): the token value must NEVER appear in a
 * {@link RejectReason}, a {@link TransportVerdict}, or a thrown message.
 * Every reject below carries only a fixed reason string, a status, and (for
 * two rules) a fixed, non-secret header value — never header content, never
 * the captured/expected token.
 */
import { timingSafeEqual } from 'node:crypto';

/** The frozen, pinned expectation this request must satisfy. */
export interface TransportExpectation {
  readonly host: string; // pinned literal "127.0.0.1:<port>"
  readonly origin: string; // pinned literal "http://127.0.0.1:<port>"
  readonly path: string; // "/mcp"
  readonly token: string; // stable bearer, base64url (43 chars from 32 bytes)
  readonly maxBodyBytes: number; // hard cap; ALSO enforced by the T2 stream counter
}

/**
 * Honest optionality (research doc §3.1): every header is `string | undefined`,
 * and `undefined` FAILS its rule — it is never treated as "skip this check".
 * The two documented exceptions are Origin (absent ⇒ pass, rule 3) and
 * Content-Length (absent ⇒ pass to the T2 stream counter, rule 7).
 */
export interface RequestHeaderFacts {
  readonly method: string; // upper-cased by Node
  readonly path: string; // URL-normalized pathname, query removed
  readonly remoteAddress: string | undefined;
  readonly hostHeader: string | undefined;
  readonly originHeader: string | undefined;
  readonly authorizationHeader: string | undefined;
  readonly declaredContentLength: number | undefined; // parsed Content-Length; undefined if absent/NaN/chunked
}

export type RejectReason =
  | 'non-loopback-peer'
  | 'bad-host'
  | 'bad-origin'
  | 'bad-token'
  | 'not-found'
  | 'method-not-allowed'
  | 'body-too-large';

export type TransportVerdict =
  | { readonly kind: 'accept' }
  | {
      readonly kind: 'reject';
      readonly status: 401 | 403 | 404 | 405 | 413;
      readonly reason: RejectReason;
      readonly headers?: Readonly<Record<string, string>>;
    };

/** Rule 1's accepted peer identities (loopback in every form Node reports). */
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

/** Rule 4's scheme match — case-sensitive "Bearer", exactly one space, ≥1 char captured. */
const BEARER_PATTERN = /^Bearer (.+)$/;

function reject(
  status: 401 | 403 | 404 | 405 | 413,
  reason: RejectReason,
  headers?: Readonly<Record<string, string>>,
): TransportVerdict {
  return headers === undefined
    ? { kind: 'reject', status, reason }
    : { kind: 'reject', status, reason, headers };
}

/**
 * Phase 1 — pure, header-only, runs BEFORE body consumption. Fail-closed:
 * the default (fall-through) arm is `{kind:'reject', ...}` for whichever rule
 * fires first; only clearing all 7 rules yields `{kind:'accept'}`.
 */
export function evaluateHeaders(
  facts: RequestHeaderFacts,
  expect: TransportExpectation,
): TransportVerdict {
  // Rule 1 — peer: remoteAddress must be a loopback form. Absent ⇒ reject.
  // Defense-in-depth under the 127.0.0.1 bind; fires only if the bind is ever
  // misconfigured to listen on all interfaces.
  if (facts.remoteAddress === undefined || !LOOPBACK_ADDRESSES.has(facts.remoteAddress)) {
    return reject(403, 'non-loopback-peer');
  }

  // Rule 2 — host: exact match after trim+lowercase. Absent/mismatch ⇒ reject.
  // Exact string equality is duplicate-header-safe (a folded "a, b" value
  // fails) and never accepts "localhost" (avoids the localhost→::1
  // divergence) since the pinned expectation is always the literal IP:port.
  const normalizedHost = facts.hostHeader?.trim().toLowerCase();
  if (normalizedHost === undefined || normalizedHost !== expect.host) {
    return reject(403, 'bad-host');
  }

  // Rule 3 — origin: ABSENT PASSES (Hermes/httpx sends none — the one rule
  // where undefined does not fail). Present ⇒ exact match after
  // trim+lowercase, else reject. Kills forged browser Origin (rebinding/CSRF)
  // and the opaque-origin sentinel "null".
  if (facts.originHeader !== undefined) {
    const normalizedOrigin = facts.originHeader.trim().toLowerCase();
    if (normalizedOrigin !== expect.origin) {
      return reject(403, 'bad-origin');
    }
  }

  // Rule 4 — auth: `^Bearer (.+)$` (single space, case-sensitive scheme) AND
  // the captured token equals expect.token via a constant-time compare.
  // MANDATORY length pre-check: crypto.timingSafeEqual THROWS RangeError on
  // unequal-length buffers, so an unequal length is rejected WITHOUT ever
  // calling it — never the token value in the reject, only the fixed reason.
  const authMatch = facts.authorizationHeader?.match(BEARER_PATTERN);
  const capturedToken = authMatch?.[1];
  if (capturedToken === undefined) {
    return reject(401, 'bad-token', { 'WWW-Authenticate': 'Bearer' });
  }
  const capturedBuf = Buffer.from(capturedToken, 'utf8');
  const expectedBuf = Buffer.from(expect.token, 'utf8');
  if (capturedBuf.length !== expectedBuf.length || !timingSafeEqual(capturedBuf, expectedBuf)) {
    return reject(401, 'bad-token', { 'WWW-Authenticate': 'Bearer' });
  }

  // Rule 5 — path: exact match against the single pinned route.
  if (facts.path !== expect.path) {
    return reject(404, 'not-found');
  }

  // Rule 6 — method: only POST. HEAD/GET/DELETE/OPTIONS/anything else 405s —
  // this is what makes Hermes's HEAD-then-GET preflight land on a
  // deterministic non-2xx (research doc §3.2 rule 6 note).
  if (facts.method !== 'POST') {
    return reject(405, 'method-not-allowed', { Allow: 'POST' });
  }

  // Rule 7 — declared body length: a NUMBER over the cap rejects; undefined
  // (absent/chunked) and NaN (an unparseable Content-Length) both PASS — the
  // T2 streaming byte counter is the authoritative bound for those.
  if (
    typeof facts.declaredContentLength === 'number' &&
    facts.declaredContentLength > expect.maxBodyBytes
  ) {
    return reject(413, 'body-too-large');
  }

  // All 7 rules cleared.
  return { kind: 'accept' };
}
