/*
 * UI-I1 layer 2: `ErrorBoundary` is a React class component — the render/
 * fallback wiring is build-blind (no jsdom/RTL in THIS file's project,
 * `webview-pure`, `environment: 'node'`; see `state/panels.ts`'s "this
 * repo's webview test convention is no-jsdom" for that project — `webview-
 * dom` exists for other components, see `vitest.config.ts`/ADR-015, but this
 * file stays on the lighter node project since nothing here needs a real
 * DOM). `getDerivedStateFromError` is a plain static method, though — no DOM
 * needed to call it directly — so its normalization (a thrown value can be
 * ANY JS value, not just an `Error`, since `throw` accepts anything; the
 * boundary must produce a stable, always-truthy `state.error` regardless)
 * is genuinely unit-tested here.
 *
 * F11: the Reload button's handler (`private readonly reload`) is likewise
 * exercised directly (no render/click) — an instance's own arrow-bound class
 * field, invoked the same "seam" way `TalariaViewProvider.test.ts`'s `seam()`
 * cast reaches private host methods. `../bridge` is mocked because its real
 * module-level singleton touches `window` at import time (`bridge.test.ts`'s
 * documented reason), which this `node`-environment project does not have —
 * mocking it also makes `bridge.post` itself the assertable seam the F11
 * spec calls for ("assert via the mocked host-post seam").
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../bridge', () => ({ bridge: { post: vi.fn() } }));

import { ErrorBoundary } from './ErrorBoundary';
import { bridge } from '../bridge';

describe('ErrorBoundary.getDerivedStateFromError (UI-I1 layer 2)', () => {
  it('passes a thrown Error straight through as state.error', () => {
    const err = new Error('boom');
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
  });

  it('normalizes a thrown non-Error value (string) into a real Error, never undefined', () => {
    const state = ErrorBoundary.getDerivedStateFromError('plain string throw');
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error?.message).toBe('plain string throw');
  });

  it('normalizes a thrown null/undefined into a real Error (JS allows throwing anything)', () => {
    expect(ErrorBoundary.getDerivedStateFromError(null).error).toBeInstanceOf(Error);
    expect(ErrorBoundary.getDerivedStateFromError(undefined).error).toBeInstanceOf(Error);
  });
});

/** Reach the private arrow-bound `reload` class field without rendering. */
function seamReload(instance: ErrorBoundary): () => void {
  return (instance as unknown as { reload: () => void }).reload;
}

describe('ErrorBoundary Reload button (F11: host-driven recovery)', () => {
  it('posts a webviewToHost {type:"reload"} message through the bridge instead of calling window.location.reload', () => {
    const instance = new ErrorBoundary({ children: null, region: 'test' });

    expect(() => seamReload(instance)()).not.toThrow();

    expect(bridge.post).toHaveBeenCalledWith({ type: 'reload' });
    expect(bridge.post).toHaveBeenCalledTimes(1);
  });
});
