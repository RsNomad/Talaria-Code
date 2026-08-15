import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createLibServer } from './server';
import type { TransportExpectation } from './transportSecurity';

/**
 * W3 (LIB) · T2 — real-socket integration tests for `createLibServer`
 * (research doc §3.6-2, the (a)-(h) matrix; (h) — dispose mid-request — is
 * covered in `libServerHost.test.ts` where `dispose()` actually lives). No
 * `vscode` import anywhere in this file — proves the module under test is
 * genuinely headless, not just import-headless.
 *
 * Every test in this file drives a REAL loopback TCP socket against a REAL
 * `http.Server` returned by `createLibServer` — no mocked transport, no
 * mocked `evaluateHeaders`. The stub `McpServer` (`buildStubMcpServer`) is
 * the one seam the brief explicitly allows ("T2 uses a stub" for
 * `buildLibMcpServer`).
 */

const TOKEN = `test-token-${crypto.randomBytes(24).toString('base64url')}`;

function buildStubMcpServer(): McpServer {
  const server = new McpServer({ name: 'lib-stub', version: '0.0.0-test' });
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Echoes the given id back — test stub only.',
      inputSchema: { id: z.string() },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async (args: { id: string }) => ({
      content: [{ type: 'text' as const, text: args.id }],
    }),
  );
  return server;
}

/** Learn a free loopback port via a throwaway bind, released before the
 * real server (under test) binds it — the same accepted, documented
 * bind/release residual `libServerHost.ts` itself uses for its OWN,
 * zero-race internal path; here it is unavoidable because the test needs a
 * concrete port NUMBER to put in `expect` before `createLibServer` can wire
 * a request handler around it. */
function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      probe.close(() => {
        if (addr === null || typeof addr === 'string') {
          reject(new Error('getEphemeralPort: unexpected address shape'));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

interface TestServerHandle {
  readonly server: http.Server;
  readonly expect: TransportExpectation;
  readonly port: number;
}

const openServers: http.Server[] = [];

async function startTestServer(
  overrides: Partial<TransportExpectation> = {},
  buildMcpServer: () => McpServer = buildStubMcpServer,
  log?: (msg: string) => void,
): Promise<TestServerHandle> {
  const port = await getEphemeralPort();
  const expect: TransportExpectation = {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    path: '/mcp',
    token: TOKEN,
    maxBodyBytes: 4 * 1024 * 1024,
    ...overrides,
  };
  const server = createLibServer({ expect, buildMcpServer, log });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  openServers.push(server);
  return { server, expect, port };
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections?.();
        }),
    ),
  );
});

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function httpRequest(opts: {
  port: number;
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  chunks?: string[]; // when set, written as multiple writes with NO Content-Length (chunked)
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path ?? '/mcp',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.chunks !== undefined) {
      for (const c of opts.chunks) req.write(c);
      req.end();
    } else if (opts.body !== undefined) {
      req.end(opts.body);
    } else {
      req.end();
    }
  });
}

/** Raw-socket request for wire shapes a plain header object cannot express
 * (a genuine duplicate `Host` header — Node's client-side `headers` object
 * has exactly one slot per name). `Connection: close` is always sent so the
 * server closes the socket once it answers, making `'end'` a reliable
 * terminal signal even on the accept path. */
function rawSocketRequest(port: number, rawRequestHead: string, body = ''): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(rawRequestHead.replace(/\n/g, '\r\n') + body);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const splitAt = raw.indexOf('\r\n\r\n');
      const headerPart = splitAt === -1 ? raw : raw.slice(0, splitAt);
      const bodyPart = splitAt === -1 ? '' : raw.slice(splitAt + 4);
      const lines = headerPart.split('\r\n');
      const statusLine = lines[0] ?? '';
      const status = Number(statusLine.split(' ')[1]);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      resolve({ status, headers, body: bodyPart });
    });
  });
}

describe('createLibServer — (a) simulated Hermes preflight', () => {
  it('HEAD with a valid bearer gets a non-2xx 405, never a route/body leak', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'HEAD',
      headers: { Authorization: `Bearer ${exp.token}` },
    });
    expect(res.status).toBe(405);
    // The load-bearing property for Hermes's preflight is simply "non-2xx".
    expect(res.status >= 200 && res.status < 300).toBe(false);
    expect(res.headers.allow).toBe('POST');
  });

  it('GET with a valid bearer also gets 405 (mirrors the HEAD-then-GET retry)', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'GET',
      headers: { Authorization: `Bearer ${exp.token}` },
    });
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'method not allowed' });
    expect(res.headers['content-type']).toBe('application/json');
  });
});

describe('createLibServer — (b) real MCP initialize + tools/list + tools/call round trip', () => {
  it('completes a full round trip against the stub tool via the real SDK client', async () => {
    const { port, expect: exp } = await startTestServer();
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${exp.token}` } },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('echo');

    const result = await client.callTool({ name: 'echo', arguments: { id: 'round-trip-value' } });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe('round-trip-value');

    await transport.close();
  });
});

describe('createLibServer — (c) 401 without a bearer', () => {
  it('rejects a POST with no Authorization header', async () => {
    const { port } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });
});

describe('createLibServer — (d) 403 with forged Origin / forged Host', () => {
  it('rejects a valid-bearer POST carrying a forged Origin', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exp.token}`,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
  });

  it('rejects a valid-bearer POST carrying a forged Host', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exp.token}`,
        Host: 'evil.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
  });
});

describe('createLibServer — (e) streaming body-cap abort (authoritative, not the header pre-reject)', () => {
  it('aborts a CHUNKED body with NO Content-Length once the running total exceeds the cap', async () => {
    // maxBodyBytes is small on purpose so the test is fast; the request
    // below sends >cap bytes via multiple `req.write()` calls and never
    // sets Content-Length, so Node's client automatically frames it as
    // `Transfer-Encoding: chunked`. Because `declaredContentLength` is
    // therefore `undefined`, evaluateHeaders' rule 7 (the header pre-reject)
    // MUST have passed this request through — the only remaining source of
    // a 413 on the accept path is the streaming byte counter in server.ts,
    // which is exactly what this proves.
    const CAP = 64;
    const { port, expect: exp } = await startTestServer({ maxBodyBytes: CAP });
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exp.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      chunks: Array.from({ length: 10 }, () => 'x'.repeat(32)), // 320 bytes total, no Content-Length
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'payload too large' });
  });

  it('accepts a chunked body that stays within the cap (sanity — the counter is not overzealous)', async () => {
    const CAP = 4 * 1024 * 1024;
    const { port, expect: exp } = await startTestServer({ maxBodyBytes: CAP });
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exp.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      chunks: [payload],
    });
    expect(res.status).not.toBe(413);
  });
});

describe('createLibServer — (f) duplicate Host header', () => {
  it('rejects a request carrying two Host header lines, before the guard even runs', async () => {
    const { port, expect: exp } = await startTestServer();
    const head =
      `POST /mcp HTTP/1.1\n` +
      `Host: 127.0.0.1:${port}\n` +
      `Host: evil.example\n` +
      `Authorization: Bearer ${exp.token}\n` +
      `Content-Type: application/json\n` +
      `Content-Length: 2\n` +
      `Connection: close\n\n`;
    const res = await rawSocketRequest(port, head, '{}');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'bad request' });
  });
});

describe('createLibServer — (g) concurrent POSTs, no cross-request bleed', () => {
  it('resolves each concurrent tools/call with its OWN result, never another request’s', async () => {
    const { port, expect: exp } = await startTestServer();
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${exp.token}` } },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const ids = Array.from({ length: 8 }, (_, i) => `concurrent-${i}`);
    const results = await Promise.all(
      ids.map((id) => client.callTool({ name: 'echo', arguments: { id } })),
    );

    results.forEach((result, i) => {
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toBe(ids[i]);
    });

    await transport.close();
  });
});

describe('createLibServer — guard runs before body/SDK, and the token never logs', () => {
  it('answers 401 (not 413) for a bad-auth request whose body alone would exceed the cap — proving the guard runs first', async () => {
    const CAP = 16;
    const { port } = await startTestServer({ maxBodyBytes: CAP });
    const res = await httpRequest({
      port,
      method: 'POST',
      // No Authorization header at all — must fail on the header guard,
      // before a single body byte is read/counted.
      headers: { 'Content-Type': 'application/json' },
      chunks: ['x'.repeat(1000)], // far over CAP; must never be evaluated
    });
    expect(res.status).toBe(401);
  });

  it('never logs the token, in accept or reject paths, across a representative mix of requests', async () => {
    const logged: string[] = [];
    const { port, expect: exp } = await startTestServer({}, buildStubMcpServer, (msg) => logged.push(msg));

    await httpRequest({ port, method: 'GET', headers: { Authorization: `Bearer ${exp.token}` } }); // 405
    await httpRequest({ port, method: 'POST', headers: {} }); // 401
    await httpRequest({
      port,
      method: 'POST',
      headers: { Authorization: `Bearer ${exp.token}`, Origin: 'https://evil.example' },
    }); // 403
    await httpRequest({
      port,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exp.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{}',
    }); // accepted path — malformed JSON (empty object is valid JSON but invalid JSON-RPC; either way exercises the accept path)

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(exp.token);
    }
  });
});

describe('createLibServer — T1 carry-note #2: Origin extraction honesty (absent vs present-empty vs literal "null")', () => {
  it('absent Origin passes (undefined, as Hermes/httpx sends)', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exp.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    expect(res.status).not.toBe(403);
  });

  it('present-but-empty Origin is a STRING that fails the match (never coerced to undefined)', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: { Authorization: `Bearer ${exp.token}`, Origin: '', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
  });

  it('the literal string "null" Origin (opaque/sandboxed browser origin) is rejected', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: { Authorization: `Bearer ${exp.token}`, Origin: 'null', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('createLibServer — AU-21: a buildMcpServer() throw is caught, never an unhandled rejection', () => {
  it(
    'answers 500 within a tick and never fires process "unhandledRejection" (fails at HEAD: hangs — the constructor throw escapes the void-shaped caller uncaught)',
    async () => {
      const { port, expect: exp } = await startTestServer({}, () => {
        throw new Error('AU-21 RED: buildMcpServer boom');
      });

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const res = await httpRequest({
          port,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${exp.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: '{}',
        });
        expect(res.status).toBe(500);
        expect(JSON.parse(res.body)).toEqual({ error: 'internal error' });
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
      expect(unhandled).toEqual([]);
    },
    3000,
  );
});

describe('createLibServer — malformed JSON body on the accept path', () => {
  it('answers a JSON-RPC parse error instead of hanging or crashing', async () => {
    const { port, expect: exp } = await startTestServer();
    const res = await httpRequest({
      port,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exp.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.error.code).toBe(-32700);
  });
});
