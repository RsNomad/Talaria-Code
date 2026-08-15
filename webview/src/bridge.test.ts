/*
 * P7-N2 regression: `Bridge.post` (and its siblings) are ordinary prototype
 * methods that read `this.vscode`/`this.mockHandler` — passing one as a bare
 * method reference (`onLoad={bridge.post}`, the exact shape `App.tsx:552`
 * had) detaches it from its instance, so the FIRST property read inside the
 * method throws with `this === undefined` (strict-mode ES modules never
 * default `this` to the global object). This exercises the REAL `bridge`
 * singleton (not a reproduction) to prove that shape throws, and that the
 * standard fix — wrapping in an arrow function, exactly what
 * `useHostActions` does for every host-post it exposes — makes the same
 * call safe.
 *
 * This repo's vitest has no jsdom/RTL environment (see `useFileSearch.ts`'s
 * doc) — `bridge.ts`'s module-level singleton construction touches the
 * `window` global (`addEventListener('message'/'pagehide', ...)`), which
 * plain Node lacks. Rather than add jsdom (a new dependency, out of scope),
 * this stubs the one global surface the constructor actually touches via
 * vitest's own `vi.stubGlobal` (already a project dependency), then
 * dynamically imports the module AFTER the stub is in place — a static
 * top-level `import` would be hoisted and run before the stub exists.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { bridge as BridgeSingleton } from './bridge';
import type { WebviewToHost } from './protocol';

let bridge: typeof BridgeSingleton;

beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener: () => {} });
  ({ bridge } = await import('./bridge'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('bridge.post — must never be passed as an unbound method reference (P7-N2)', () => {
  it('throws when detached from its instance and invoked bare (documents the exact N2 crash shape)', () => {
    const unbound = bridge.post;
    expect(() => unbound({ type: 'ready' })).toThrow(TypeError);
  });

  it('an arrow wrapper does NOT throw once detached — the fix shape every useHostActions export uses', () => {
    const wrapped = (msg: Parameters<typeof bridge.post>[0]) => bridge.post(msg);
    expect(() => wrapped({ type: 'ready' })).not.toThrow();
  });

  it('bridge.post.bind(bridge) is an equally valid fix shape (same underlying cause)', () => {
    const bound = bridge.post.bind(bridge);
    expect(() => bound({ type: 'ready' })).not.toThrow();
  });
});

/*
 * AU-9/INV-13 (TE-2): the bridge's per-page `instanceId` (minted once, where
 * this singleton is built) must ride on every `control.request` the RPC
 * client sends, so a late `control.response` from a PRIOR page instance
 * (webview reload/re-create) can be told apart from this one — see
 * `rpc.test.ts` for the correlation-drop mechanism this wiring feeds.
 */
describe('bridge.request — AU-9/INV-13: stamps every outgoing control.request with a per-page instanceId', () => {
  it('RED: the posted control.request carries a non-empty instanceId string', async () => {
    const outbound: WebviewToHost[] = [];
    bridge.attachMock((msg) => outbound.push(msg));

    void bridge.request('tools.list');
    // `Bridge.post` defers mock delivery via `queueMicrotask` — flush it.
    await Promise.resolve();
    await Promise.resolve();

    const req = outbound.find((m) => m.type === 'control.request');
    expect(req, 'bridge.request must post a control.request message').toBeDefined();
    const instanceId = (req as { instanceId?: unknown } | undefined)?.instanceId;
    expect(typeof instanceId).toBe('string');
    expect((instanceId as string).length).toBeGreaterThan(0);
  });
});
