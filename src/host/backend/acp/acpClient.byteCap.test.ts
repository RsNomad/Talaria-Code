import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * CA-01 (WS-AC) at the SEAM: the REAL `AcpClient` over a fake child (same
 * harness as `acpClient.wire.test.ts`). An oversized single line on stdout
 * must (a) SIGTERM the child, (b) — once the child exits — settle in-flight
 * requests through the EXISTING terminate() choke and fan onExit (the
 * supervisor's respawn signal). A large-but-under-cap frame must still parse
 * (no false trip).
 */
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { AcpClient, type AcpClientCallbacks } from './acpClient';

const NOOP_CALLBACKS: AcpClientCallbacks = {
  onSessionUpdate: () => {},
  onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  onReadTextFile: async () => '',
};

const PINNED_CAPS = {
  loadSession: true,
  promptCapabilities: { image: true },
  sessionCapabilities: { fork: {}, list: {}, resume: {} },
};

function makeFakeChild(): { child: ChildProcess; stdout: PassThrough; kill: ReturnType<typeof vi.fn> } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const fake = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill, killed: false, exitCode: null });
  return { child: fake as unknown as ChildProcess, stdout, kill };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function connectInitialized(): Promise<{
  client: AcpClient;
  child: ChildProcess;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}> {
  const { child, stdout, kill } = makeFakeChild();
  vi.mocked(spawn).mockReturnValue(child);
  const client = new AcpClient({ spawn: { command: 'hermes', args: ['acp'] }, cwd: '/w', callbacks: NOOP_CALLBACKS });
  await client.connect();
  const init = client.initialize();
  await flush();
  stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: PINNED_CAPS, authMethods: [] } })}\n`,
  );
  await init;
  return { client, child, stdout, kill };
}

describe('AcpClient — CA-01 byte cap on the ACP stdout line', () => {
  it('an oversized unterminated line SIGTERMs the child; the natural exit settles in-flight requests + onExit', async () => {
    const { client, child, stdout, kill } = await connectInitialized();
    const exits: Array<number | null> = [];
    client.onExit((code) => exits.push(code));

    const pending = client.listSessions(); // in flight — stdout never answers id 1

    const chunk = Buffer.alloc(1024 * 1024, 0x78); // 1 MiB, no newline
    for (let i = 0; i < 5; i++) stdout.write(chunk); // 5 MiB single line
    await flush();

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 143); // the kill's natural exit — drives the EXISTING crash path
    await expect(pending).rejects.toThrow(/terminated/i);
    expect(exits).toEqual([143]);
  });

  it('a large-but-under-cap response frame still parses — no false trip', async () => {
    const { client, stdout, kill } = await connectInitialized();
    const big = 'y'.repeat(1024 * 1024); // 1 MiB payload in a terminated frame
    const listing = client.listSessions();
    await flush();
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessions: [{ sessionId: big }] } })}\n`);
    const result = (await listing) as { sessions: Array<{ sessionId: string }> };
    expect(result.sessions[0]?.sessionId).toBe(big);
    expect(kill).not.toHaveBeenCalled();
  });
});
