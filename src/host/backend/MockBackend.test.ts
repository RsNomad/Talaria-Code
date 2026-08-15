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

describe('MockBackend — W3-T6 (CF-11/D2): newSessionInTab (per-tab "New Session" mock)', () => {
  it('mints a fresh mock-tab-session-N bound to the SAME tab, and clears the tab (tab.clear, tabId-scoped) first', async () => {
    const backend = new MockBackend();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    backend.start(); // MOCK_SESSION_ID @ MOCK_TAB_ID (mock-session-1 / mock-tab-1)

    await backend.newSessionInTab('mock-tab-1', 'mock-session-1');

    // MIN-B (3-lens review): the host mock now emits the SAME tabId-scoped
    // `tab.clear` the real backend + webview mock use — not a
    // sessionId-keyed `clear` trusting the wire hint.
    const clearIdx = messages.findIndex(
      (m) => m.type === 'tab.clear' && (m as { tabId?: string }).tabId === 'mock-tab-1',
    );
    const boundIdx = messages.findIndex(
      (m) => m.type === 'tab.bound' && (m as { tabId?: string }).tabId === 'mock-tab-1' && (m as { sessionId?: string }).sessionId !== 'mock-session-1',
    );
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(boundIdx).toBeGreaterThan(clearIdx);
    backend.dispose();
  });

  it('MIN-B: stops the mid-stream scripted player on rebind — a step scheduled before the rebind never fires afterward', async () => {
    vi.useFakeTimers();
    try {
      const backend = new MockBackend();
      const messages: HostToWebviewMessage[] = [];
      backend.onMessage((m) => messages.push(m));
      backend.start();
      backend.sendPrompt('mock-session-1', 'work', 'default'); // scripted player now running
      await vi.advanceTimersByTimeAsync(50); // some steps have already fired

      messages.length = 0;
      await backend.newSessionInTab('mock-tab-1', 'mock-session-1');
      messages.length = 0;
      // If the OLD player were still scheduled, advancing time would still
      // emit its remaining scripted steps (stamped with the OLD session's
      // messages) after the rebind — proving it was genuinely stopped, not
      // merely superseded on the next sendPrompt.
      await vi.advanceTimersByTimeAsync(5000);
      expect(messages).toEqual([]);
      backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still emits tab.clear even when no sessionId is given (IMP-2 parity: unconditional, tabId-scoped) — still mints + binds fresh', async () => {
    const backend = new MockBackend();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.newSessionInTab('tab-2');

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'tab.clear', tabId: 'tab-2' }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'tab.bound', tabId: 'tab-2' }),
    );
    backend.dispose();
  });

  it('two calls for DIFFERENT tabs mint DISTINCT sessionIds', async () => {
    const backend = new MockBackend();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.newSessionInTab('tab-a');
    await backend.newSessionInTab('tab-b');

    const bounds = messages.filter((m) => m.type === 'tab.bound') as Array<{ tabId: string; sessionId: string }>;
    expect(bounds).toHaveLength(2);
    expect(bounds[0]?.sessionId).not.toBe(bounds[1]?.sessionId);
    backend.dispose();
  });
});

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

describe('MockBackend.invokeControl — TE-4 (AU-11 / INV-15): unknown method is refused, not courtesy-acked', () => {
  it('a method outside CONTROL_METHODS resolves {ok:false} — no more courtesy ok:true ack', async () => {
    const backend = new MockBackend();
    const result = await backend.invokeControl('totally.unknown.method');
    expect(result).toEqual({ ok: false, error: 'unknown method' });
  });

  it('a real CONTROL_METHODS entry the mock has no scripted behavior for still gets the courtesy ok:true ack (no regression)', async () => {
    const backend = new MockBackend();
    const result = await backend.invokeControl('tools.list');
    expect(result).toEqual({ ok: true, mock: true, method: 'tools.list' });
  });
});
