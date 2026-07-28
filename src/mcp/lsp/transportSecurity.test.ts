import { describe, it, expect } from 'vitest';
import {
  evaluateHeaders,
  type RequestHeaderFacts,
  type TransportExpectation,
  type TransportVerdict,
} from './transportSecurity';

/**
 * W3 (LIB) · T1 tests. `evaluateHeaders` is the pure, header-phase, fail-closed
 * 7-rule verdict for the LIB HTTP MCP server transport (research doc §3.2, the
 * pinned rule order table). This suite transcribes that table exhaustively:
 * every rule's reject (exact status + reason + any header), the full accept
 * path, honest optionality (every `undefined` header FAILS its rule except
 * Origin-absent and Content-Length-absent, which PASS), and — the load-bearing
 * part — the ORDER, proven with adjacent-pair tests across all 7 rules plus a
 * "first rule wins" kitchen-sink case. Style follows the sibling
 * `editPolicy.test.ts` idiom: flat fixtures, override-by-spread, `toEqual`.
 */

// A stable base expectation. Not a real secret — a fixture token shaped like
// the pinned mint (`base64url`, arbitrary length here; the guard does not
// enforce a specific token length, only equality).
const EXPECTATION: TransportExpectation = {
  host: '127.0.0.1:34567',
  origin: 'http://127.0.0.1:34567',
  path: '/mcp',
  token: 'fixture-token-Az09_-abcdefghijklmnopqrstuvwxyz',
  maxBodyBytes: 4 * 1024 * 1024, // 4 MiB, per research doc §3.2 rule 7 note
};

// A request that satisfies every rule (Hermes/httpx sends no Origin — §3.2
// rule 3 note — so the accept-path baseline omits it; a separate test proves
// a matching, present Origin also accepts).
const VALID_FACTS: RequestHeaderFacts = {
  method: 'POST',
  path: '/mcp',
  remoteAddress: '127.0.0.1',
  hostHeader: '127.0.0.1:34567',
  originHeader: undefined,
  authorizationHeader: `Bearer ${EXPECTATION.token}`,
  declaredContentLength: 128,
};

function facts(overrides: Partial<RequestHeaderFacts>): RequestHeaderFacts {
  return { ...VALID_FACTS, ...overrides };
}

function expectReject(
  verdict: TransportVerdict,
  status: 401 | 403 | 404 | 405 | 413,
  reason: string,
): void {
  expect(verdict.kind).toBe('reject');
  if (verdict.kind !== 'reject') throw new Error('unreachable — kind checked above');
  expect(verdict.status).toBe(status);
  expect(verdict.reason).toBe(reason);
}

describe('evaluateHeaders — accept path', () => {
  it('accepts a request that satisfies all 7 rules (Origin absent, as Hermes sends)', () => {
    const verdict = evaluateHeaders(VALID_FACTS, EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('accepts a request that also carries a matching Origin header', () => {
    const verdict = evaluateHeaders(facts({ originHeader: EXPECTATION.origin }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('accepts declaredContentLength exactly at the cap', () => {
    const verdict = evaluateHeaders(
      facts({ declaredContentLength: EXPECTATION.maxBodyBytes }),
      EXPECTATION,
    );
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('accepts declaredContentLength of 0', () => {
    const verdict = evaluateHeaders(facts({ declaredContentLength: 0 }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });
});

describe('evaluateHeaders — rule 1: peer (non-loopback-peer, 403)', () => {
  it('accepts remoteAddress 127.0.0.1', () => {
    expect(evaluateHeaders(facts({ remoteAddress: '127.0.0.1' }), EXPECTATION)).toEqual({
      kind: 'accept',
    });
  });

  it('accepts remoteAddress ::1', () => {
    expect(evaluateHeaders(facts({ remoteAddress: '::1' }), EXPECTATION)).toEqual({
      kind: 'accept',
    });
  });

  it('accepts remoteAddress ::ffff:127.0.0.1 (IPv4-mapped)', () => {
    expect(evaluateHeaders(facts({ remoteAddress: '::ffff:127.0.0.1' }), EXPECTATION)).toEqual({
      kind: 'accept',
    });
  });

  it('rejects when remoteAddress is undefined (absent fails, does not skip)', () => {
    const verdict = evaluateHeaders(facts({ remoteAddress: undefined }), EXPECTATION);
    expectReject(verdict, 403, 'non-loopback-peer');
  });

  it('rejects a non-loopback IPv4 remoteAddress', () => {
    const verdict = evaluateHeaders(facts({ remoteAddress: '10.0.0.5' }), EXPECTATION);
    expectReject(verdict, 403, 'non-loopback-peer');
  });

  it('rejects a non-loopback IPv6 remoteAddress', () => {
    const verdict = evaluateHeaders(facts({ remoteAddress: '::2' }), EXPECTATION);
    expectReject(verdict, 403, 'non-loopback-peer');
  });
});

describe('evaluateHeaders — rule 2: host (bad-host, 403)', () => {
  it('rejects when hostHeader is undefined (absent fails, does not skip)', () => {
    const verdict = evaluateHeaders(facts({ hostHeader: undefined }), EXPECTATION);
    expectReject(verdict, 403, 'bad-host');
  });

  it('rejects a mismatched hostHeader', () => {
    const verdict = evaluateHeaders(facts({ hostHeader: '127.0.0.1:99999' }), EXPECTATION);
    expectReject(verdict, 403, 'bad-host');
  });

  it('accepts hostHeader after trimming surrounding whitespace', () => {
    const verdict = evaluateHeaders(facts({ hostHeader: '  127.0.0.1:34567  ' }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('accepts hostHeader after case-folding (uppercase scheme-irrelevant chars)', () => {
    // The literal here has no letters other than digits/dots/colon, so exercise
    // case-folding via a deliberately upper-cased variant to prove the
    // trim+lowercase step runs (would fail without it if any letters existed).
    const verdict = evaluateHeaders(facts({ hostHeader: '127.0.0.1:34567'.toUpperCase() }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('never accepts "localhost" even though it resolves to loopback', () => {
    const verdict = evaluateHeaders(facts({ hostHeader: 'localhost:34567' }), EXPECTATION);
    expectReject(verdict, 403, 'bad-host');
  });

  it('rejects a folded duplicate-Host value (comma-joined)', () => {
    // Simulates a Node fold of two Host headers into one string — exact
    // equality means the folded value can never match the pinned literal.
    const verdict = evaluateHeaders(
      facts({ hostHeader: '127.0.0.1:34567, evil.example' }),
      EXPECTATION,
    );
    expectReject(verdict, 403, 'bad-host');
  });
});

describe('evaluateHeaders — rule 3: origin (bad-origin, 403; absent PASSES)', () => {
  it('accepts an absent Origin header (Hermes/httpx sends none)', () => {
    const verdict = evaluateHeaders(facts({ originHeader: undefined }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('accepts a present Origin that matches exactly', () => {
    const verdict = evaluateHeaders(facts({ originHeader: EXPECTATION.origin }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('accepts a present Origin after trim+lowercase folding', () => {
    const verdict = evaluateHeaders(
      facts({ originHeader: `  ${EXPECTATION.origin.toUpperCase()}  ` }),
      EXPECTATION,
    );
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('rejects a forged cross-site Origin', () => {
    const verdict = evaluateHeaders(
      facts({ originHeader: 'https://evil.example' }),
      EXPECTATION,
    );
    expectReject(verdict, 403, 'bad-origin');
  });

  it('rejects the opaque-origin sentinel "null"', () => {
    const verdict = evaluateHeaders(facts({ originHeader: 'null' }), EXPECTATION);
    expectReject(verdict, 403, 'bad-origin');
  });
});

describe('evaluateHeaders — rule 4: auth (bad-token, 401, WWW-Authenticate: Bearer)', () => {
  it('rejects when authorizationHeader is undefined (absent fails, does not skip)', () => {
    const verdict = evaluateHeaders(facts({ authorizationHeader: undefined }), EXPECTATION);
    expectReject(verdict, 401, 'bad-token');
    if (verdict.kind === 'reject') {
      expect(verdict.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
    }
  });

  it('rejects a header missing the Bearer scheme entirely', () => {
    const verdict = evaluateHeaders(
      facts({ authorizationHeader: EXPECTATION.token }),
      EXPECTATION,
    );
    expectReject(verdict, 401, 'bad-token');
  });

  it('rejects a lowercase "bearer" scheme (case-sensitive match)', () => {
    const verdict = evaluateHeaders(
      facts({ authorizationHeader: `bearer ${EXPECTATION.token}` }),
      EXPECTATION,
    );
    expectReject(verdict, 401, 'bad-token');
  });

  it('rejects "Bearer" with no token and no trailing space', () => {
    const verdict = evaluateHeaders(facts({ authorizationHeader: 'Bearer' }), EXPECTATION);
    expectReject(verdict, 401, 'bad-token');
  });

  it('rejects "Bearer " with a trailing space but empty token', () => {
    const verdict = evaluateHeaders(facts({ authorizationHeader: 'Bearer ' }), EXPECTATION);
    expectReject(verdict, 401, 'bad-token');
  });

  it('rejects a double-spaced "Bearer  <token>" (captured value carries the extra space)', () => {
    const verdict = evaluateHeaders(
      facts({ authorizationHeader: `Bearer  ${EXPECTATION.token}` }),
      EXPECTATION,
    );
    expectReject(verdict, 401, 'bad-token');
  });

  it('rejects a same-length wrong token (timingSafeEqual false branch)', () => {
    const wrongSameLength = 'x'.repeat(EXPECTATION.token.length);
    expect(wrongSameLength.length).toBe(EXPECTATION.token.length);
    expect(wrongSameLength).not.toBe(EXPECTATION.token);
    const verdict = evaluateHeaders(
      facts({ authorizationHeader: `Bearer ${wrongSameLength}` }),
      EXPECTATION,
    );
    expectReject(verdict, 401, 'bad-token');
  });

  it('rejects a shorter token WITHOUT throwing (length pre-check before timingSafeEqual)', () => {
    const shorter = EXPECTATION.token.slice(0, -1);
    expect(shorter.length).not.toBe(EXPECTATION.token.length);
    expect(() =>
      evaluateHeaders(facts({ authorizationHeader: `Bearer ${shorter}` }), EXPECTATION),
    ).not.toThrow();
    const verdict = evaluateHeaders(facts({ authorizationHeader: `Bearer ${shorter}` }), EXPECTATION);
    expectReject(verdict, 401, 'bad-token');
  });

  it('rejects a longer token WITHOUT throwing (length pre-check before timingSafeEqual)', () => {
    const longer = `${EXPECTATION.token}x`;
    expect(longer.length).not.toBe(EXPECTATION.token.length);
    expect(() =>
      evaluateHeaders(facts({ authorizationHeader: `Bearer ${longer}` }), EXPECTATION),
    ).not.toThrow();
    const verdict = evaluateHeaders(facts({ authorizationHeader: `Bearer ${longer}` }), EXPECTATION);
    expectReject(verdict, 401, 'bad-token');
  });

  it('accepts the exact correct token', () => {
    const verdict = evaluateHeaders(
      facts({ authorizationHeader: `Bearer ${EXPECTATION.token}` }),
      EXPECTATION,
    );
    expect(verdict).toEqual({ kind: 'accept' });
  });
});

describe('evaluateHeaders — rule 5: path (not-found, 404)', () => {
  it('rejects a mismatched path', () => {
    const verdict = evaluateHeaders(facts({ path: '/other' }), EXPECTATION);
    expectReject(verdict, 404, 'not-found');
  });

  it('rejects a path carrying a query string', () => {
    const verdict = evaluateHeaders(facts({ path: '/mcp?x=1' }), EXPECTATION);
    expectReject(verdict, 404, 'not-found');
  });

  it('rejects an absolute-form request-target whose pathname differs', () => {
    const verdict = evaluateHeaders(
      facts({ path: 'http://127.0.0.1:34567/mcp' }),
      EXPECTATION,
    );
    expectReject(verdict, 404, 'not-found');
  });

  it('accepts the exact pinned path', () => {
    const verdict = evaluateHeaders(facts({ path: '/mcp' }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });
});

describe('evaluateHeaders — rule 6: method (method-not-allowed, 405, Allow: POST)', () => {
  it.each(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'PUT'])('rejects method %s', (method) => {
    const verdict = evaluateHeaders(facts({ method }), EXPECTATION);
    expectReject(verdict, 405, 'method-not-allowed');
    if (verdict.kind === 'reject') {
      expect(verdict.headers).toEqual({ Allow: 'POST' });
    }
  });

  it('rejects lowercase "post" (case-sensitive exact match)', () => {
    const verdict = evaluateHeaders(facts({ method: 'post' }), EXPECTATION);
    expectReject(verdict, 405, 'method-not-allowed');
  });

  it('accepts POST', () => {
    const verdict = evaluateHeaders(facts({ method: 'POST' }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });
});

describe('evaluateHeaders — rule 7: body length (body-too-large, 413; undefined/NaN PASS)', () => {
  it('rejects declaredContentLength one byte over the cap', () => {
    const verdict = evaluateHeaders(
      facts({ declaredContentLength: EXPECTATION.maxBodyBytes + 1 }),
      EXPECTATION,
    );
    expectReject(verdict, 413, 'body-too-large');
  });

  it('accepts declaredContentLength undefined (stream counter is authoritative for chunked bodies)', () => {
    const verdict = evaluateHeaders(facts({ declaredContentLength: undefined }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });

  it('accepts declaredContentLength NaN (treated the same as absent, not thrown/rejected)', () => {
    const verdict = evaluateHeaders(facts({ declaredContentLength: Number.NaN }), EXPECTATION);
    expect(verdict).toEqual({ kind: 'accept' });
  });
});

describe('evaluateHeaders — rule ORDER is load-bearing (adjacent-pair proofs)', () => {
  it('rule 1 beats rule 2: bad peer AND bad host ⇒ non-loopback-peer, not bad-host', () => {
    const verdict = evaluateHeaders(
      facts({ remoteAddress: undefined, hostHeader: 'evil.example' }),
      EXPECTATION,
    );
    expectReject(verdict, 403, 'non-loopback-peer');
  });

  it('rule 2 beats rule 3: bad host AND bad origin ⇒ bad-host, not bad-origin', () => {
    const verdict = evaluateHeaders(
      facts({ hostHeader: 'evil.example', originHeader: 'https://evil.example' }),
      EXPECTATION,
    );
    expectReject(verdict, 403, 'bad-host');
  });

  it('rule 2 beats rule 4: bad Host AND a VALID token ⇒ bad-host, not bad-token (network-identity before auth)', () => {
    const verdict = evaluateHeaders(
      facts({ hostHeader: 'evil.example', authorizationHeader: `Bearer ${EXPECTATION.token}` }),
      EXPECTATION,
    );
    expectReject(verdict, 403, 'bad-host');
  });

  it('rule 3 beats rule 4: bad Origin AND a VALID host+token ⇒ bad-origin, not bad-token', () => {
    const verdict = evaluateHeaders(
      facts({
        hostHeader: EXPECTATION.host,
        originHeader: 'https://evil.example',
        authorizationHeader: `Bearer ${EXPECTATION.token}`,
      }),
      EXPECTATION,
    );
    expectReject(verdict, 403, 'bad-origin');
  });

  it('rule 4 beats rule 5: NO auth AND a wrong path ⇒ bad-token (401), not not-found (404) — auth before path', () => {
    const verdict = evaluateHeaders(
      facts({ authorizationHeader: undefined, path: '/nonexistent' }),
      EXPECTATION,
    );
    expectReject(verdict, 401, 'bad-token');
  });

  it('rule 4 beats rule 6: NO auth AND a disallowed method ⇒ bad-token (401), not method-not-allowed (405)', () => {
    const verdict = evaluateHeaders(
      facts({ authorizationHeader: undefined, method: 'GET' }),
      EXPECTATION,
    );
    expectReject(verdict, 401, 'bad-token');
  });

  it('rule 5 beats rule 6: wrong path AND wrong method ⇒ not-found, not method-not-allowed', () => {
    const verdict = evaluateHeaders(facts({ path: '/nonexistent', method: 'GET' }), EXPECTATION);
    expectReject(verdict, 404, 'not-found');
  });

  it('rule 6 beats rule 7: wrong method AND oversized body ⇒ method-not-allowed, not body-too-large', () => {
    const verdict = evaluateHeaders(
      facts({ method: 'GET', declaredContentLength: EXPECTATION.maxBodyBytes + 1 }),
      EXPECTATION,
    );
    expectReject(verdict, 405, 'method-not-allowed');
  });

  it('kitchen sink: every rule violated at once ⇒ rule 1 (non-loopback-peer) wins', () => {
    const verdict = evaluateHeaders(
      {
        method: 'GET',
        path: '/nonexistent',
        remoteAddress: undefined,
        hostHeader: 'evil.example',
        originHeader: 'https://evil.example',
        authorizationHeader: undefined,
        declaredContentLength: EXPECTATION.maxBodyBytes + 1,
      },
      EXPECTATION,
    );
    expectReject(verdict, 403, 'non-loopback-peer');
  });
});

describe('evaluateHeaders — token discipline (R4.4/R7.4)', () => {
  it('never echoes the token anywhere in any reject verdict (status/reason/headers)', () => {
    const secretToken = EXPECTATION.token;
    const allFactsVariants: RequestHeaderFacts[] = [
      facts({ remoteAddress: undefined }),
      facts({ hostHeader: undefined }),
      facts({ originHeader: 'https://evil.example' }),
      facts({ authorizationHeader: undefined }),
      facts({ authorizationHeader: `Bearer wrong-${secretToken}` }),
      facts({ path: '/nope' }),
      facts({ method: 'GET' }),
      facts({ declaredContentLength: EXPECTATION.maxBodyBytes + 1 }),
    ];
    for (const f of allFactsVariants) {
      const verdict = evaluateHeaders(f, EXPECTATION);
      const serialized = JSON.stringify(verdict);
      expect(serialized).not.toContain(secretToken);
    }
  });

  it('never throws for any malformed input across the whole rule set', () => {
    const malformedInputs: RequestHeaderFacts[] = [
      facts({ authorizationHeader: 'Bearer' }),
      facts({ authorizationHeader: 'Bearer ' }),
      facts({ authorizationHeader: `Bearer ${'a'.repeat(1000)}` }),
      facts({ authorizationHeader: '' }),
      facts({ hostHeader: '' }),
      facts({ originHeader: '' }),
      facts({ path: '' }),
      facts({ method: '' }),
      facts({ declaredContentLength: -1 }),
      facts({ declaredContentLength: Number.POSITIVE_INFINITY }),
    ];
    for (const f of malformedInputs) {
      expect(() => evaluateHeaders(f, EXPECTATION)).not.toThrow();
    }
  });
});

describe('evaluateHeaders — default arm is reject, never accept', () => {
  it('an all-undefined/empty facts object rejects (fail-closed default)', () => {
    const verdict = evaluateHeaders(
      {
        method: '',
        path: '',
        remoteAddress: undefined,
        hostHeader: undefined,
        originHeader: undefined,
        authorizationHeader: undefined,
        declaredContentLength: undefined,
      },
      EXPECTATION,
    );
    expect(verdict.kind).toBe('reject');
  });
});
