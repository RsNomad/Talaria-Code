/**
 * src/host/testApi.test.ts (Task 5, onboarding-entrypoint-fix-architecture.md
 * §4.2/§4.3): pure unit coverage of `createTestApi` — the event source is
 * INJECTED (a hand-rolled synchronous pub/sub below), never the real
 * `vscode.EventEmitter`/`TalariaViewProvider`, so this file never imports
 * `vscode` and needs no `vi.mock('vscode', ...)`.
 */
import { describe, it, expect } from 'vitest';
import type { WebviewSignal } from './TalariaViewProvider';
import { createTestApi } from './testApi';

/**
 * A minimal, synchronous pub/sub mirroring the shape `onWebviewSignal`
 * (`vscode.Event<WebviewSignal>`) presents to `createTestApi`: a function
 * that takes a listener and returns a `{ dispose(): void }`. Exposes a
 * `disposeCallCount` so the "dispose unsubscribes" test can spy on the
 * subscription's own `dispose()` without reaching into `createTestApi`'s
 * internals.
 */
function makeEmitter(): {
  fire: (signal: WebviewSignal) => void;
  on: (listener: (signal: WebviewSignal) => void) => { dispose(): void };
  readonly disposeCallCount: number;
} {
  const listeners = new Set<(signal: WebviewSignal) => void>();
  let disposeCallCount = 0;
  return {
    fire: (signal) => {
      for (const listener of [...listeners]) listener(signal);
    },
    on: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          disposeCallCount++;
          listeners.delete(listener);
        },
      };
    },
    get disposeCallCount() {
      return disposeCallCount;
    },
  };
}

describe('createTestApi', () => {
  it('resolves waiters that subscribe AFTER the signal fired (history buffer)', async () => {
    const { fire, on } = makeEmitter();
    const { api } = createTestApi(on);

    fire({ kind: 'ready' });
    fire({ kind: 'panelFetch', panel: 'setup', cause: 'hydrate', ok: true, hasData: true });

    await api.whenWebviewReady(100);
    expect(api.panelFetchCount('setup')).toBe(1);
    expect(api.panelFetchCount('setup', 'activate')).toBe(0);
    await expect(api.waitForPanelFetch('setup', { cause: 'hydrate', timeoutMs: 100 })).resolves.toEqual({
      ok: true,
      hasData: true,
    });
  });

  it('waits for the Nth fetch OF THAT CAUSE and reports its ok/hasData', async () => {
    const { fire, on } = makeEmitter();
    const { api } = createTestApi(on);

    const p = api.waitForPanelFetch('setup', { cause: 'activate', minCount: 2, timeoutMs: 500 });
    fire({ kind: 'panelFetch', panel: 'setup', cause: 'activate', ok: true, hasData: true });
    fire({ kind: 'panelFetch', panel: 'setup', cause: 'hydrate', ok: true, hasData: true }); // ignored
    fire({ kind: 'panelFetch', panel: 'setup', cause: 'activate', ok: true, hasData: false });

    await expect(p).resolves.toEqual({ ok: true, hasData: false });
  });

  it('rejects on timeout with a diagnosable message', async () => {
    const { api } = createTestApi(() => ({ dispose() {} }));
    await expect(api.waitForPanelFetch('setup', { timeoutMs: 20 })).rejects.toThrow(/setup.*20ms/);
  });

  it('dispose unsubscribes from the signal source', () => {
    const emitter = makeEmitter();
    const { dispose } = createTestApi(emitter.on);

    expect(emitter.disposeCallCount).toBe(0);
    dispose();
    expect(emitter.disposeCallCount).toBe(1);
  });
});
