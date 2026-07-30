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
