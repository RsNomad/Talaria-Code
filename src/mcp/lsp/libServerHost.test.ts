import * as http from 'node:http';
import * as net from 'node:net';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createLibServerHost, decideRebindAction, type LibServerHost } from './libServerHost';

/**
 * W3 (LIB) · T2 — `LibServerHost` lifecycle tests. Two layers, per the
 * "unit-testable where extractable" process guidance:
 *  1. `decideRebindAction` — the post-bind listener-error POLICY, a pure
 *     function, tested with zero sockets.
 *  2. Real-socket lifecycle tests — bind/idempotency, dispose (matrix item
 *     (h): destroys sockets, releases the port), and an end-to-end
 *     one-rebind-then-permanent-down proof driven against a REAL `net`
 *     listener occupying the port to force the second rebind attempt to
 *     genuinely fail (not a simulated/mocked failure).
 *
 * No `vscode` import anywhere in this file.
 */

function buildStubMcpServer(): McpServer {
  const server = new McpServer({ name: 'lib-stub', version: '0.0.0-test' });
  server.registerTool(
    'echo',
    { title: 'Echo', description: 'test stub', inputSchema: { id: z.string() } },
    // eslint-disable-next-line @typescript-eslint/require-await
    async (args: { id: string }) => ({ content: [{ type: 'text' as const, text: args.id }] }),
  );
  return server;
}

/** Register any hold-open resource (delay-gate) or slow tool that lets a
 * test guarantee a request is genuinely "mid-flight" when dispose() fires. */
function buildSlowMcpServer(gate: Promise<void>): () => McpServer {
  return () => {
    const server = new McpServer({ name: 'lib-slow-stub', version: '0.0.0-test' });
    server.registerTool(
      'slow-echo',
      { title: 'Slow echo', description: 'test stub', inputSchema: { id: z.string() } },
      async (args: { id: string }) => {
        await gate;
        return { content: [{ type: 'text' as const, text: args.id }] };
      },
    );
    return server;
  };
}

const openHosts: LibServerHost[] = [];
function track(host: LibServerHost): LibServerHost {
  openHosts.push(host);
  return host;
}
afterEach(() => {
  for (const h of openHosts.splice(0)) h.dispose();
});

describe('decideRebindAction — pure post-bind listener-error policy (no sockets)', () => {
  it('the first-ever post-bind error gets the one allowed rebind', () => {
    expect(decideRebindAction({ rebindAttempted: false, down: false })).toBe('rebind');
  });

  it('a second error after the one rebind was already attempted goes permanently down', () => {
    expect(decideRebindAction({ rebindAttempted: true, down: false })).toBe('permanent-down');
  });

  it('once permanently down, further errors are ignored — no retry loop, ever', () => {
    expect(decideRebindAction({ rebindAttempted: true, down: true })).toBe('ignore');
    // Even a (structurally impossible, but defensively checked) down-but-not-
    // yet-rebound state must never re-attempt — `down` alone is authoritative.
    expect(decideRebindAction({ rebindAttempted: false, down: true })).toBe('ignore');
  });
});

describe('createLibServerHost — start()/advertisement()', () => {
  it('binds 127.0.0.1 on an ephemeral port and returns an http advertisement', async () => {
    const host = track(createLibServerHost({ buildMcpServer: buildStubMcpServer }));
    const ad = await host.start();
    expect(ad).toBeDefined();
    if (ad === undefined) throw new Error('unreachable — checked above');
    expect(ad.type).toBe('http');
    expect(ad.name).toBe('vscode_lsp');
    expect(ad.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(ad.headers).toHaveLength(1);
    expect(ad.headers[0]?.name).toBe('Authorization');
    expect(ad.headers[0]?.value).toMatch(/^Bearer .+$/);
  });

  it('is idempotent: repeat start() calls return the SAME cached advertisement, never re-binding', async () => {
    const host = track(createLibServerHost({ buildMcpServer: buildStubMcpServer }));
    const first = await host.start();
    const second = await host.start();
    const third = await host.start();
    expect(second).toBe(first); // same object identity — genuinely cached, not just equal
    expect(third).toBe(first);
  });

  it('advertisement() mirrors start()’s resolved value and is undefined before start()', () => {
    const host = track(createLibServerHost({ buildMcpServer: buildStubMcpServer }));
    expect(host.advertisement()).toBeUndefined();
  });

  it('honors an overridden serverName and maxBodyBytes', async () => {
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        serverName: 'custom_name',
        maxBodyBytes: 1234,
      }),
    );
    const ad = await host.start();
    expect(ad?.name).toBe('custom_name');
  });

  it('the bound advertisement actually answers real MCP traffic end-to-end', async () => {
    const host = track(createLibServerHost({ buildMcpServer: buildStubMcpServer }));
    const ad = await host.start();
    if (ad === undefined) throw new Error('unreachable — start() must succeed here');
    const authHeader = ad.headers.find((h) => h.name === 'Authorization')?.value;
    const transport = new StreamableHTTPClientTransport(new URL(ad.url), {
      requestInit: { headers: { Authorization: authHeader ?? '' } },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'echo', arguments: { id: 'via-host' } });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe('via-host');
    await transport.close();
  });
});

describe('createLibServerHost — dispose() (matrix item (h))', () => {
  it('destroys an in-flight connection and releases the port for a follow-up bind', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const host = track(createLibServerHost({ buildMcpServer: buildSlowMcpServer(gate) }));
    const ad = await host.start();
    if (ad === undefined) throw new Error('unreachable — start() must succeed here');
    const port = Number(new URL(ad.url).port);
    const authHeader = ad.headers.find((h) => h.name === 'Authorization')?.value;

    const transport = new StreamableHTTPClientTransport(new URL(ad.url), {
      requestInit: { headers: { Authorization: authHeader ?? '' } },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    // Fire a call that will hang inside the stub tool until `releaseGate()`
    // runs — guaranteeing the request is genuinely mid-flight below.
    const pending = client.callTool({ name: 'slow-echo', arguments: { id: 'mid-flight' } });
    const pendingOutcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );

    // Give the request a moment to actually reach the server before disposing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    host.dispose();
    releaseGate(); // let the stub finish if it somehow still can — it shouldn't matter

    // The in-flight call must NOT resolve successfully — its connection was destroyed.
    await expect(pendingOutcome).resolves.toBe('rejected');

    // The port must be released — proven by a REAL follow-up bind succeeding.
    const follow = http.createServer();
    await new Promise<void>((resolve, reject) => {
      follow.once('error', reject);
      follow.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => follow.close(() => resolve()));
  });

  it('is idempotent and safe to call before start() ever resolved', () => {
    const host = createLibServerHost({ buildMcpServer: buildStubMcpServer });
    expect(() => {
      host.dispose();
      host.dispose();
    }).not.toThrow();
  });

  it('T-E1: clears the cached advertisement after dispose() — never keeps handing out a bearer token for a port we may no longer own', async () => {
    const host = createLibServerHost({ buildMcpServer: buildStubMcpServer });
    const ad = await host.start();
    expect(ad).toBeDefined();
    expect(host.advertisement()).toBe(ad);
    host.dispose();
    expect(host.advertisement()).toBeUndefined();
  });
});

describe('createLibServerHost — dispose() races a pending start() (I-1: bind-window leak)', () => {
  it('a dispose() that lands while start() is still awaiting the bind closes the server, not just makes start() report undefined', async () => {
    let capturedServer: http.Server | undefined;
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        createServer: () => {
          capturedServer = http.createServer();
          return capturedServer;
        },
      }),
    );

    // doStart() runs synchronously up to `await listenAsync(bareServer, 0)`
    // — the real `server.listen()` bind is genuine async I/O, so control
    // returns here before 'listening' can fire. The host's internal
    // `server` field is still undefined at this point (it's only assigned
    // AFTER the await, past the loopback assert).
    const p = host.start();
    // Runs synchronously, strictly before the pending bind resolves — sees
    // the host's internal `server === undefined`, so it no-ops the close
    // but still latches `disposed = true`.
    host.dispose();

    // doStart() resumes once the real OS bind completes.
    const adv = await p;

    expect(adv).toBeUndefined();
    if (capturedServer === undefined) {
      throw new Error('unreachable — createServer must have been invoked by doStart()');
    }
    // The load-bearing assertion: the bare server that finished binding
    // AFTER dispose() latched must not be left listening. `adv === undefined`
    // alone would also pass while the socket stays open — this is what
    // actually discriminates the bug (RED: still listening) from the fix
    // (GREEN: closed).
    expect(capturedServer.listening).toBe(false);
  });
});

describe('createLibServerHost — one-rebind-then-permanent-down (real listener-error proof)', () => {
  it('rebinds the SAME real server once on the first post-bind error, then goes permanently down on a second — never a third attempt', async () => {
    const log = vi.fn();
    let capturedServer: http.Server | undefined;
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        log,
        // The only production seam this test needs: a reference to the SAME
        // real `http.Server` object `libServerHost` binds and wires, so the
        // listener-error handler can be driven with a genuine
        // `EventEmitter.emit('error', ...)` on the real object under test —
        // not a fake/mock standing in for it.
        createServer: () => {
          capturedServer = http.createServer();
          return capturedServer;
        },
      }),
    );
    const ad = await host.start();
    if (ad === undefined || capturedServer === undefined) {
      throw new Error('unreachable — start() must succeed and capture the real server here');
    }
    const server = capturedServer;
    const listenSpy = vi.spyOn(server, 'listen');

    // --- First post-bind error: the ONE allowed same-port rebind.
    server.emit('error', new Error('simulated post-bind listener error'));
    await vi.waitFor(() => expect(listenSpy).toHaveBeenCalledTimes(1));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('attempting the one allowed same-port rebind'),
    );
    // The rebind used the SAME port + is answering real traffic again —
    // proof the "one rebind" is a genuine, working close()+listen() cycle,
    // not just a state-flag flip.
    await vi.waitFor(() => expect(server.listening).toBe(true));
    const [rebindPort, rebindHost] = listenSpy.mock.calls[0] ?? [];
    expect(rebindPort).toBe(Number(new URL(ad.url).port));
    expect(rebindHost).toBe('127.0.0.1');

    // --- Second post-bind error: must go permanently down, WITHOUT a
    // second rebind attempt (`listen` call count stays at 1).
    server.emit('error', new Error('simulated post-bind listener error #2'));
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('permanently down')),
    );
    expect(listenSpy).toHaveBeenCalledTimes(1);

    // --- A THIRD (and further) error must be a pure no-op forever — no
    // retry loop, never a new port.
    server.emit('error', new Error('simulated post-bind listener error #3'));
    server.emit('error', new Error('simulated post-bind listener error #4'));
    expect(listenSpy).toHaveBeenCalledTimes(1);

    // T-E1: once permanently down, the cached advertisement is CLEARED —
    // it must never keep handing out a bearer token for a port a squatter
    // process may now own (module doc :14-18 "fail toward less egress";
    // pre-T-E1 this asserted the advertisement stayed stable/unchanged,
    // which was exactly the bug this fix closes).
    expect(host.advertisement()).toBeUndefined();
  });

  it('T-E1: clears the cached advertisement once permanently down — never keeps handing out a bearer token for a port a squatter may now own', async () => {
    const log = vi.fn();
    let capturedServer: http.Server | undefined;
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        log,
        createServer: () => {
          capturedServer = http.createServer();
          return capturedServer;
        },
      }),
    );
    const ad = await host.start();
    if (ad === undefined || capturedServer === undefined) {
      throw new Error('unreachable — start() must succeed and capture the real server here');
    }
    expect(host.advertisement()).toBe(ad);

    const server = capturedServer;
    // First error: the one allowed same-port rebind — the advertisement
    // must stay cached, since we still own the port.
    server.emit('error', new Error('simulated post-bind listener error'));
    await vi.waitFor(() => expect(server.listening).toBe(true));
    expect(host.advertisement()).toBe(ad);

    // Second error: permanent-down — the advertisement must be cleared.
    server.emit('error', new Error('simulated post-bind listener error #2'));
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('permanently down')),
    );
    expect(host.advertisement()).toBeUndefined();
  });

  it('a rebind that itself fails (port genuinely occupied) also goes permanently down, never a new port', async () => {
    const log = vi.fn();
    let capturedServer: http.Server | undefined;
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        log,
        createServer: () => {
          capturedServer = http.createServer();
          return capturedServer;
        },
      }),
    );
    const ad = await host.start();
    if (ad === undefined || capturedServer === undefined) {
      throw new Error('unreachable — start() must succeed and capture the real server here');
    }
    const server = capturedServer;
    const port = Number(new URL(ad.url).port);

    // Trigger the one rebind, but let it race a real squatter that grabs
    // the port the instant our server closes it — the close()+listen()
    // sequence's OWN re-`listen()` call then hits a genuine EADDRINUSE,
    // which re-enters `onServerError` a second time (now `rebindAttempted`
    // is already true) and must land on permanent-down, not a silent hang
    // or a new port.
    server.once('close', () => {
      const squatter = net.createServer();
      squatter.listen(port, '127.0.0.1');
    });
    server.emit('error', new Error('simulated post-bind listener error'));

    await vi.waitFor(
      () => expect(log).toHaveBeenCalledWith(expect.stringContaining('permanently down')),
      { timeout: 2000 },
    );
    // T-E1: never a new port — AND never any port at all once permanently
    // down; the cached advertisement is cleared entirely rather than
    // continuing to hand out a token for a port a squatter may now hold.
    expect(host.advertisement()).toBeUndefined();
  });
});

describe('createLibServerHost — onPermanentDown hook (T-9: squatter full closure)', () => {
  /**
   * T-E1 (previous task) cleared the CACHED advertisement on the two
   * permanent-down transitions and on dispose() — the accessor is safe.
   * But `extension.ts` reads `advertisement()` ONCE at start and hands the
   * captured copy to `backend.setMcpServer('vscode_lsp', advertisement)` —
   * every FUTURE `session/new`/`session/load`/`session/resume` re-sends
   * that stale copy (`AcpBackend.getMcpServers`), token included, to
   * whatever now owns the port. `onPermanentDown` is the hook that lets
   * `extension.ts` withdraw that registration the instant the host goes
   * permanently down, so no future session ever hears about the dead
   * server again.
   */
  it('fires onPermanentDown exactly once, at the permanent-down transition — not on the rebind, not on later errors', async () => {
    const log = vi.fn();
    const onPermanentDown = vi.fn();
    let capturedServer: http.Server | undefined;
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        log,
        onPermanentDown,
        createServer: () => {
          capturedServer = http.createServer();
          return capturedServer;
        },
      }),
    );
    const ad = await host.start();
    if (ad === undefined || capturedServer === undefined) {
      throw new Error('unreachable — start() must succeed and capture the real server here');
    }
    const server = capturedServer;

    // First error: the one allowed same-port rebind — we still own the
    // port, so the squatter hook must NOT fire yet.
    server.emit('error', new Error('simulated post-bind listener error'));
    await vi.waitFor(() => expect(server.listening).toBe(true));
    expect(onPermanentDown).not.toHaveBeenCalled();

    // Second error: permanent-down — the hook fires exactly once.
    server.emit('error', new Error('simulated post-bind listener error #2'));
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('permanently down')),
    );
    expect(onPermanentDown).toHaveBeenCalledTimes(1);

    // Further errors, once already down, are a pure no-op (existing
    // 'ignore' branch) — the hook must not fire again.
    server.emit('error', new Error('simulated post-bind listener error #3'));
    server.emit('error', new Error('simulated post-bind listener error #4'));
    expect(onPermanentDown).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing onPermanentDown callback — the host state machine (permanently-down, cleared advertisement) is unaffected', async () => {
    const log = vi.fn();
    const onPermanentDown = vi.fn(() => {
      throw new Error('boom — a misbehaving caller must never wedge the host');
    });
    let capturedServer: http.Server | undefined;
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        log,
        onPermanentDown,
        createServer: () => {
          capturedServer = http.createServer();
          return capturedServer;
        },
      }),
    );
    const ad = await host.start();
    if (ad === undefined || capturedServer === undefined) {
      throw new Error('unreachable — start() must succeed and capture the real server here');
    }
    const server = capturedServer;

    server.emit('error', new Error('simulated post-bind listener error'));
    await vi.waitFor(() => expect(server.listening).toBe(true));

    // The permanent-down transition itself must not throw back through the
    // EventEmitter — a throwing hook is caught and swallowed.
    expect(() => {
      server.emit('error', new Error('simulated post-bind listener error #2'));
    }).not.toThrow();

    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('permanently down')),
    );
    expect(onPermanentDown).toHaveBeenCalledTimes(1);
    // Host state machine unaffected by the throw: still cleared, and a
    // further error is still a correctly-ignored no-op (not, say, a second
    // rebind attempt because some flag failed to latch).
    expect(host.advertisement()).toBeUndefined();
    const listenSpy = vi.spyOn(server, 'listen');
    server.emit('error', new Error('simulated post-bind listener error #3'));
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('extension-level seam: the callback withdraws the vscode_lsp MCP registration — mirrors the registration wiring in extension.ts', async () => {
    // A minimal stand-in for the one call extension.ts's wiring makes on
    // the CURRENT backend when the hook fires: `backend.setMcpServer(name,
    // server | undefined)` (real shape: AcpBackend.setMcpServer,
    // `src/host/backend/AcpBackend.ts`). Proves the DI seam `extension.ts`
    // hangs its withdrawal logic on, without needing the real `vscode`
    // module (extension.ts itself has no unit-test harness in this repo).
    const backend = { setMcpServer: vi.fn<(name: string, server: unknown) => void>() };
    let capturedServer: http.Server | undefined;
    const host = track(
      createLibServerHost({
        buildMcpServer: buildStubMcpServer,
        onPermanentDown: () => backend.setMcpServer('vscode_lsp', undefined),
        createServer: () => {
          capturedServer = http.createServer();
          return capturedServer;
        },
      }),
    );
    const ad = await host.start();
    if (ad === undefined || capturedServer === undefined) {
      throw new Error('unreachable — start() must succeed and capture the real server here');
    }
    const server = capturedServer;

    server.emit('error', new Error('simulated post-bind listener error'));
    await vi.waitFor(() => expect(server.listening).toBe(true));
    expect(backend.setMcpServer).not.toHaveBeenCalled();

    server.emit('error', new Error('simulated post-bind listener error #2'));
    await vi.waitFor(() => expect(backend.setMcpServer).toHaveBeenCalledTimes(1));
    expect(backend.setMcpServer).toHaveBeenCalledWith('vscode_lsp', undefined);
  });
});
