/*
 * WS-F1 F1-4 (recommended): direct tests for the two RPC-wrapper helpers
 * split into their own module (`requireShape` itself stays non-exported —
 * used only inside these two, per the brief's grounding that App.tsx never
 * called it directly).
 *
 * Same window-stub + dynamic-import idiom as `globalActions.test.ts`/
 * `bridge.test.ts`: `rpcShaped.ts` imports the real `bridge` singleton,
 * whose constructor touches `window` (absent in this repo's `webview-pure`
 * node vitest project) — stub the one surface it touches, then dynamically
 * import AFTER the stub is in place (a static top-level import would be
 * hoisted ahead of the stub).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as RpcShaped from './rpcShaped';
import type { bridge as BridgeSingleton } from './bridge';

let rpcShaped: typeof RpcShaped;
let bridge: typeof BridgeSingleton;

beforeAll(async () => {
  vi.stubGlobal('window', {
    addEventListener: () => {
      /* no-op — nothing here ever needs to fire a message/pagehide event */
    },
  });
  rpcShaped = await import('./rpcShaped');
  ({ bridge } = await import('./bridge'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const isString = (x: unknown): x is string => typeof x === 'string';

describe('rpcShaped.ts — requestShaped / requestShapedOptional (WS-F1 F1-4)', () => {
  it('requestShaped rejects with a method-named error when the result fails the guard', async () => {
    const spy = vi.spyOn(bridge, 'request').mockResolvedValue({ nope: true });
    await expect(rpcShaped.requestShaped('mcp.test', {}, isString)).rejects.toThrow(
      'mcp.test returned an unrecognized result shape',
    );
    spy.mockRestore();
  });

  it('requestShapedOptional passes a bare undefined result straight through, unshaped', async () => {
    const spy = vi.spyOn(bridge, 'request').mockResolvedValue(undefined);
    await expect(rpcShaped.requestShapedOptional('checkpoint.restore', {}, isString)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('forwards the tag argument verbatim to bridge.request', async () => {
    const spy = vi.spyOn(bridge, 'request').mockResolvedValue('ok');
    await rpcShaped.requestShaped('mcp.test', { name: 'x' }, isString, 'tab-1');
    expect(spy).toHaveBeenCalledWith('mcp.test', { name: 'x' }, 'tab-1');
    spy.mockRestore();
  });
});
