import { describe, it, expect, vi } from 'vitest';
import { MockBackend } from './MockBackend';
import type { ContextRef, HostToWebviewMessage } from '../../shared/protocol';

/**
 * `vscode` isn't resolvable outside the extension host; `MockBackend` only
 * needs `vscode.EventEmitter` at construction time. Same minimal shim as
 * `AcpBackend.test.ts`.
 */
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    };
    fire(data: T): void {
      for (const listener of [...this.listeners]) listener(data);
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  return { EventEmitter };
});

const SOME_MENTIONS: ContextRef[] = [
  { id: 'm1', kind: 'file', path: 'src/auth/login.ts' },
  { id: 'm2', kind: 'selection' },
];

/** Play a MockBackend turn, collecting emitted messages up to (but not into) the first gate. */
async function playAndCollect(mentions?: ContextRef[]): Promise<HostToWebviewMessage[]> {
  const backend = new MockBackend();
  const messages: HostToWebviewMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  backend.start();
  backend.sendPrompt('mock-session-1', 'Refactor login()', 'default', undefined, mentions);
  // Well short of the scenario's first `gate: 'approval'` step, but far
  // enough to cover turn.start/user/reasoning/tool.start/tool.update/
  // message.delta — a representative multi-message sample.
  await vi.advanceTimersByTimeAsync(2500);
  backend.dispose();
  return messages;
}

describe('MockBackend — W2 S0: sendPrompt optional `mentions` param', () => {
  it('is a no-op: passing `mentions` emits the identical message sequence as omitting it', async () => {
    vi.useFakeTimers();
    try {
      const withoutMentions = await playAndCollect(undefined);
      const withMentions = await playAndCollect(SOME_MENTIONS);

      expect(withoutMentions.length).toBeGreaterThan(0);
      expect(withMentions).toEqual(withoutMentions);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw when called with a `mentions` array', () => {
    const backend = new MockBackend();
    backend.start();
    expect(() => backend.sendPrompt('mock-session-1', 'hello', 'default', undefined, SOME_MENTIONS)).not.toThrow();
    backend.dispose();
  });
});
