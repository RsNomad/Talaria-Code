import { describe, it, expect } from 'vitest';
import { wireBackendFailureNudge, type BackendFailureNudgeHost, type BackendFailureNudgeSource } from './backendFailureNudge';
import type { HostToWebviewMessage } from '../shared/protocol';

/**
 * Task 11 (A): the "existing backend-failure surface" the plan §6 entry
 * point 2 asks for is `ConnectionSupervisor.startInternal`'s own
 * `system.error` emission on `resolveHermes` throw / spawn fail / initialize
 * fail (`src/host/backend/connection/ConnectionSupervisor.ts:387-390`) — the
 * ONLY host-emitted backend-failure signal that exists today. This module
 * subscribes to that signal (via the backend's own `onMessage`, exactly the
 * same event `TalariaViewProvider` already relays to the webview) and adds a
 * native "Open Backend Setup" action that deep-links into the setup panel
 * via the `talaria.openSetup` command path — never calling anything panel
 * -specific directly, per the brief ("reuse the talaria.openSetup command
 * path").
 *
 * PURE, structurally-typed seams (no `vscode`/`AgentBackend` import) so this
 * is unit-testable without mocking `vscode` at all — `extension.ts` wires
 * the real `backend.onMessage` + `vscode.window.showErrorMessage` +
 * `vscode.commands.executeCommand('talaria.openSetup')` in one small
 * closure (see that file's own "backend-failure nudge" comment).
 */

class FakeSource implements BackendFailureNudgeSource {
  private listeners = new Set<(message: HostToWebviewMessage) => void>();

  fire(message: HostToWebviewMessage): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  onMessage(listener: (message: HostToWebviewMessage) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

function makeHost(choice: string | undefined): {
  host: BackendFailureNudgeHost;
  showErrorCalls: [string, string][];
  openSetupCalls: { count: number };
} {
  const showErrorCalls: [string, string][] = [];
  const openSetupCalls = { count: 0 };
  const host: BackendFailureNudgeHost = {
    showErrorMessage: (message, action) => {
      showErrorCalls.push([message, action]);
      return Promise.resolve(choice);
    },
    openSetup: () => {
      openSetupCalls.count++;
    },
  };
  return { host, showErrorCalls, openSetupCalls };
}

describe('wireBackendFailureNudge', () => {
  it('a system.error message shows a native error with an "Open Backend Setup" action', () => {
    const source = new FakeSource();
    const { host, showErrorCalls } = makeHost(undefined);
    wireBackendFailureNudge(source, host);

    source.fire({ type: 'system.error', message: 'Hermes failed to start: spawn ENOENT' });

    expect(showErrorCalls).toEqual([['Hermes failed to start: spawn ENOENT', 'Open Backend Setup']]);
  });

  it('clicking the action executes the talaria.openSetup command path (host.openSetup)', async () => {
    const source = new FakeSource();
    const { host } = makeHost('Open Backend Setup');
    let openSetupCalls = 0;
    const trackedHost: BackendFailureNudgeHost = {
      showErrorMessage: host.showErrorMessage,
      openSetup: () => {
        openSetupCalls++;
      },
    };
    wireBackendFailureNudge(source, trackedHost);

    source.fire({ type: 'system.error', message: 'Hermes failed to start: spawn ENOENT' });
    await flushMicrotasks();

    expect(openSetupCalls).toBe(1);
  });

  it('dismissing the notification (no choice) never opens setup', async () => {
    const source = new FakeSource();
    let openSetupCalls = 0;
    const host: BackendFailureNudgeHost = {
      showErrorMessage: () => Promise.resolve(undefined),
      openSetup: () => {
        openSetupCalls++;
      },
    };
    wireBackendFailureNudge(source, host);

    source.fire({ type: 'system.error', message: 'boom' });
    await flushMicrotasks();

    expect(openSetupCalls).toBe(0);
  });

  it('ignores every other message type — no notification, no dispatch', () => {
    const source = new FakeSource();
    const { host, showErrorCalls } = makeHost(undefined);
    wireBackendFailureNudge(source, host);

    source.fire({ type: 'system.recovered' });
    source.fire({ type: 'tab.error', tabId: 't1', message: 'x', kind: 'open-failed' });

    expect(showErrorCalls).toEqual([]);
  });

  it('returns a disposable that detaches from the source', () => {
    const source = new FakeSource();
    const { host, showErrorCalls } = makeHost(undefined);
    const sub = wireBackendFailureNudge(source, host);
    expect(source.listenerCount).toBe(1);

    sub.dispose();
    expect(source.listenerCount).toBe(0);

    source.fire({ type: 'system.error', message: 'after dispose' });
    expect(showErrorCalls).toEqual([]);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
