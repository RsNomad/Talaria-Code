import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * B-4 (SEC-6): `onStdout` accumulates chunks into `stdoutBuffer` until a
 * `\n` completes a frame. If the child streams a huge run of bytes with NO
 * newline, that buffer grows unbounded -> extension-host OOM (the child is
 * the semi-trusted/prompt-injectable component). Mirrors the discipline
 * `autocomplete/backends/http.ts`'s `MAX_STREAM_BYTES` already applies to
 * the FIM stream.
 *
 * TEST-SEAM: same harness as `acpClient.test.ts`/`acpClient.wire.test.ts` —
 * mock `node:child_process`, drive the REAL production `JsonRpcStdio` over a
 * fake `ChildProcess` wired to genuine `PassThrough` streams. This proves
 * what a real oversized stdout chunk does to the real class, not what our
 * code does to a stub we built ourselves.
 */
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { JsonRpcStdio } from './JsonRpcStdio';

/** Same minimal fake `ChildProcess` shape as `acpClient.test.ts`. */
function makeFakeChild(): {
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const fake = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill,
    killed: false,
    exitCode: null as number | null,
  });
  return { child: fake as unknown as ChildProcess, stdin, stdout, kill };
}

function makeTransport(): {
  transport: JsonRpcStdio;
  stdout: PassThrough;
  fakeChild: ChildProcess & { kill: ReturnType<typeof vi.fn>; exitCode: number | null };
} {
  const { child, stdout } = makeFakeChild();
  vi.mocked(spawn).mockReturnValue(child);
  const transport = new JsonRpcStdio({ command: 'python', args: ['-m', 'tui_gateway.entry'] });
  return {
    transport,
    stdout,
    fakeChild: child as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn>; exitCode: number | null },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;

describe('JsonRpcStdio.onStdout — B-4 (SEC-6): cap the residual (post-drain) stdout line buffer', () => {
  it('tears down the transport when a single unterminated stdout chunk exceeds MAX_LINE_BYTES', async () => {
    const { transport, stdout, fakeChild } = makeTransport();

    const onExitSpy = vi.fn();
    transport.onExit(onExitSpy);

    const pending = transport.request('some.method', {});
    // Swallow the eventual rejection assertion below (avoids an
    // unhandled-rejection warning if the assert runs after settle).
    pending.catch(() => {});

    // One stdout 'data' chunk, NO newline, one byte over the cap.
    stdout.emit('data', 'x'.repeat(MAX_LINE_BYTES + 1));
    await flush();

    await expect(pending).rejects.toThrow(/exceeded/i);

    // The oversized buffer must not be retained: since the transport tears
    // itself down (disposed), a fresh request after teardown must reject
    // immediately rather than hang forever with the corrupted buffer.
    await expect(transport.request('another.method')).rejects.toThrow();

    // The teardown/respawn path fired: the child was killed (the crash-like
    // signal an upstream supervisor's `onExit` subscription reacts to).
    expect(fakeChild.kill).toHaveBeenCalled();

    // And once the OS actually reaps the process, the pre-existing
    // 'exit' -> exitHandlers chain still runs (dispose() never removes
    // that listener) — proving the SAME path `ControlChannel`'s
    // `transport.onExit(...)` respawn subscription depends on is reached.
    fakeChild.emit('exit', null);
    expect(onExitSpy).toHaveBeenCalledWith(null);
  });

  it('does NOT false-trip on a legit burst of many complete frames (residual check only, not transient)', async () => {
    const { transport, stdout, fakeChild } = makeTransport();

    // Two 1 MiB COMPLETE (\n-terminated) frames back-to-back in one chunk.
    // Neither is a real JSON-RPC response frame (they're bare padding), so
    // `handleFrame` will log-and-drop them as non-JSON — that's fine, the
    // only thing under test is that draining a large transient burst never
    // trips the residual cap.
    const oneMib = 1024 * 1024;
    const frame = 'x'.repeat(oneMib) + '\n';
    stdout.emit('data', frame + frame);
    await flush();

    expect(fakeChild.kill).not.toHaveBeenCalled();

    // The transport must still be alive/usable afterward.
    const pending = transport.request('ping');
    await flush();
    stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'pong' })}\n`);
    await expect(pending).resolves.toBe('pong');
  });
});

/**
 * CF-16 / L6 I-6: `42`, `null`, `"str"`, `true` are all VALID JSON, so
 * `JSON.parse` happily returns them — but they are not objects, and the
 * response-frame check does `'id' in frame`. The `in` operator throws a
 * `TypeError` on a non-object right-hand side (`'id' in 42`), so a
 * primitive frame from the child crashed `onStdout` instead of being
 * dropped like any other malformed line. The fix extends the existing
 * parse-failure guard to also catch `typeof frame !== 'object' ||
 * frame === null`, warn-dropping down the SAME path — never reaching the
 * `in` check.
 */
describe("JsonRpcStdio.handleFrame — I-6: primitive JSON frames are warn-dropped, not thrown", () => {
  it('does not throw on a bare-number frame, and still processes a valid frame in the same chunk', async () => {
    const logged: string[] = [];
    const { child, stdout } = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const transport = new JsonRpcStdio({
      command: 'python',
      args: ['-m', 'tui_gateway.entry'],
      logger: { append: (line) => logged.push(line) },
    });

    const pending = transport.request('ping');
    await flush();

    // A primitive JSON frame (`42`) immediately followed by a genuine
    // response frame for the pending request, in ONE stdout chunk — the
    // primitive must not stop the valid frame after it from processing.
    expect(() => {
      stdout.emit(
        'data',
        `42\n${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'pong' })}\n`,
      );
    }).not.toThrow();

    await expect(pending).resolves.toBe('pong');
    expect(logged.some((l) => /warn/i.test(l) && /dropped/i.test(l))).toBe(true);
  });

  it.each([
    ['null', 'null'],
    ['a bare string', '"str"'],
    ['a bare boolean', 'true'],
  ])('does not throw on %s frame', async (_label, primitiveJson) => {
    const { child, stdout } = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    new JsonRpcStdio({ command: 'python', args: ['-m', 'tui_gateway.entry'] });

    expect(() => stdout.emit('data', `${primitiveJson}\n`)).not.toThrow();
    await flush();
  });
});

/**
 * CF-16 / L6 I-7: a write against a dead child's stdin surfaces as an
 * async `'error'` event (e.g. EPIPE) on the `Writable` stream. Node's
 * `EventEmitter` throws an unhandled `'error'` event SYNCHRONOUSLY from
 * `.emit()` when no listener is registered — an uncaught exception that
 * crashes the whole extension host process. `gitProcess.ts` guards this
 * exact case (`child.stdin.on('error', () => undefined)`); `JsonRpcStdio`
 * had no such listener on `child.stdin`. The fix attaches one in the
 * constructor that logs status/message only (never body/secret), mirroring
 * `gitProcess.ts`.
 */
describe('JsonRpcStdio — I-7: child.stdin has an error listener (write-after-death)', () => {
  it('does not throw when stdin emits an error, and logs it', () => {
    const logged: string[] = [];
    const { child, stdin } = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    new JsonRpcStdio({
      command: 'python',
      args: ['-m', 'tui_gateway.entry'],
      logger: { append: (line) => logged.push(line) },
    });

    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    // With no 'error' listener on stdin, EventEmitter#emit('error', ...)
    // throws synchronously, right here — that IS the crash this guards.
    expect(() => stdin.emit('error', epipe)).not.toThrow();

    expect(logged.some((l) => /EPIPE/i.test(l))).toBe(true);
  });
});

/**
 * CF-13 security review of `b800b79`: CONFIRMED Critical — the traffic tap
 * (`send()`'s `→` log and `handleFrame()`'s `←` log) wrote the FULL framed
 * JSON verbatim to the logger, which for `model.save_key({slug, api_key})`
 * means the raw provider API key landed in cleartext in the always-on
 * "Talaria Code" output channel. `TalariaViewProvider.test.ts`'s and
 * `AcpBackend.test.ts`'s existing "never logged" tests use a mock backend /
 * fake control boundary and never reach THIS tap — so they never proved the
 * property their names claimed. These are the GENUINE transport-level
 * tests: a real `JsonRpcStdio` over a fake child, asserting (a) the logger
 * never sees the raw secret and DOES see the redaction marker, while (b)
 * the bytes actually written to `child.stdin` carry the REAL key
 * unchanged — redaction is LOG-ONLY, the harness needs the real value on
 * the wire.
 */
describe('JsonRpcStdio traffic tap — SECRET DISCIPLINE: redact secret-shaped fields in the log, never the wire (CF-13 C-1/C-2)', () => {
  it('send(): a secret-shaped param (api_key) is redacted in the → log line but the REAL key still hits stdin', async () => {
    const logged: string[] = [];
    const { child, stdin } = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const writeSpy = vi.spyOn(stdin, 'write');
    const transport = new JsonRpcStdio({
      command: 'python',
      args: ['-m', 'tui_gateway.entry'],
      logger: { append: (line) => logged.push(line) },
    });

    const pending = transport.request('model.save_key', {
      slug: 'deepseek',
      api_key: 'sk-PLANTED-SECRET-VALUE',
    });
    pending.catch(() => {});
    await flush();

    // LOG: the raw key must never appear anywhere in the traffic tap, and
    // the redaction marker must be present in its place.
    const logText = logged.join('\n');
    expect(logText).not.toContain('sk-PLANTED-SECRET-VALUE');
    expect(logText).toContain('[redacted]');

    // WIRE: the bytes actually written to the child's stdin carry the REAL,
    // unredacted key — the harness needs it to authenticate the provider.
    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('sk-PLANTED-SECRET-VALUE');

    transport.dispose();
  });

  it('handleFrame(): a secret-shaped field in a RECV response result (e.g. config.show env) is redacted before the ← log line', async () => {
    const logged: string[] = [];
    const { child, stdout } = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const transport = new JsonRpcStdio({
      command: 'python',
      args: ['-m', 'tui_gateway.entry'],
      logger: { append: (line) => logged.push(line) },
    });

    const pending = transport.request('config.show');
    pending.catch(() => {});
    await flush();

    const responseFrame = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        mcp_servers: [{ name: 'x', env: { API_KEY: 'sk-PLANTED-RECV-SECRET' } }],
      },
    };
    stdout.emit('data', `${JSON.stringify(responseFrame)}\n`);
    await flush();

    const logText = logged.join('\n');
    expect(logText).not.toContain('sk-PLANTED-RECV-SECRET');
    expect(logText).toContain('[redacted]');

    // The RESOLVED value (what the caller actually gets) is unaffected —
    // redaction is a LOG-ONLY concern, never a wire/data concern.
    await expect(pending).resolves.toEqual(responseFrame.result);

    transport.dispose();
  });
});

/**
 * TE-1 (AU-12): `'error'` never fanned to `onExit` subscribers — only
 * `rejectAll`'d pending requests. Node's own docs warn `'error'` may fire
 * WITHOUT a following `'exit'` at all (e.g. a post-ready transport failure),
 * which previously left every `onExit` subscriber (`ControlChannel`'s
 * `transportExitSub` -> `handleCrash`, its respawn trigger) silently
 * unnotified: no respawn, `ControlChannel` wedged in `'ready'` state on a
 * dead transport forever. The SAME class was already fixed at the
 * `AcpClient` seam (T-B1, `acpClient.ts`'s `terminate()`); this mirrors that
 * shape: a private `terminated` guard makes `'error'` and `'exit'` both fan
 * out through the SAME idempotent `terminate()` choke, exactly once,
 * regardless of which fires first or if both fire.
 *
 * RED (pre-fix): the first case's `onExitSpy` is never called (`'error'`
 * only calls `rejectAll`) — fails at HEAD.
 */
describe("JsonRpcStdio — AU-12/TE-1: child 'error' fans to onExit (mirrors AcpClient's T-B1 terminate)", () => {
  it("a bare child 'error' event (no following 'exit') still notifies onExit subscribers exactly once, with a null code", () => {
    const { transport, fakeChild } = makeTransport();
    const onExitSpy = vi.fn();
    transport.onExit(onExitSpy);

    fakeChild.emit('error', new Error('spawn ENOENT'));

    expect(onExitSpy).toHaveBeenCalledTimes(1);
    expect(onExitSpy).toHaveBeenCalledWith(null);
  });

  it("'error' then 'exit' fires onExit exactly ONCE (idempotent terminate, error wins the race)", () => {
    const { transport, fakeChild } = makeTransport();
    const onExitSpy = vi.fn();
    transport.onExit(onExitSpy);

    fakeChild.emit('error', new Error('spawn ENOENT'));
    fakeChild.emit('exit', 1);

    expect(onExitSpy).toHaveBeenCalledTimes(1);
    expect(onExitSpy).toHaveBeenCalledWith(null);
  });

  it("'exit' then a late 'error' fires onExit exactly ONCE (idempotent terminate, exit wins the race)", () => {
    const { transport, fakeChild } = makeTransport();
    const onExitSpy = vi.fn();
    transport.onExit(onExitSpy);

    fakeChild.emit('exit', 0);
    fakeChild.emit('error', new Error('EPIPE after exit'));

    expect(onExitSpy).toHaveBeenCalledTimes(1);
    expect(onExitSpy).toHaveBeenCalledWith(0);
  });

  it('a pending request still rejects when the child errors (rejectAll unaffected by the onExit fix)', async () => {
    const { transport, fakeChild } = makeTransport();
    const pending = transport.request('some.method', {});
    pending.catch(() => {});

    fakeChild.emit('error', new Error('spawn ENOENT'));

    await expect(pending).rejects.toThrow(/error/i);
  });

  /**
   * Review follow-up on TE-1 (AU-12): `terminate()`'s `exitHandlers` fan-out
   * (`for (const h of this.exitHandlers) h(code);`) has no try/catch, unlike
   * this SAME class's `eventHandlers` fan-out (`handleFrame`, guarded) and
   * the T-B1 mirror this fix was modeled on (`acpClient.ts`'s `terminate`,
   * also guarded). A throwing `onExit` subscriber propagates synchronously
   * out of a `child.on('error'|'exit', ...)` listener — an uncaught
   * exception that can crash the extension host. Also proves the OTHER
   * (non-throwing) subscribers still run.
   */
  it("a throwing onExit subscriber does not propagate out of terminate(), and other subscribers still fire", () => {
    const { transport, fakeChild } = makeTransport();
    const throwing = vi.fn(() => {
      throw new Error('boom from onExit subscriber');
    });
    const other = vi.fn();
    transport.onExit(throwing);
    transport.onExit(other);

    expect(() => fakeChild.emit('error', new Error('spawn ENOENT'))).not.toThrow();

    expect(throwing).toHaveBeenCalledWith(null);
    expect(other).toHaveBeenCalledWith(null);
  });
});
