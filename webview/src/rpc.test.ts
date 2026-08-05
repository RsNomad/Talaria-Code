/*
 * Red-first tests for the id-correlated request/response client (Part A2).
 *
 * The webview issues control invocations that need a return value (panel
 * fetches, checkpoint.restore) over the SAME host<->webview message bridge as
 * the existing fire-and-forget `control.invoke` + `panel.data` push. This is a
 * minimal in-house echo-id RPC (the shape TypeFox `vscode-messenger`'s
 * `RequestType<P,R>` / `sendRequest`+`onRequest` implement internally), so it
 * carries zero new dependency.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RpcClient } from './rpc';
import { must } from './testing/must';
import type { HostToWebview, WebviewToHost } from './protocol';

type ControlRequest = Extract<WebviewToHost, { type: 'control.request' }>;

function response(requestId: number, result: unknown): HostToWebview {
  return { type: 'control.response', requestId, ok: true, result };
}
function errorResponse(requestId: number, message: string): HostToWebview {
  return { type: 'control.response', requestId, ok: false, error: { message } };
}

describe('RpcClient — id-correlated request/response (Part A2)', () => {
  it('resolves the pending promise with the result of the matching-id response', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    const pending = rpc.request('tools.list', { panel: 'tools' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'control.request', method: 'tools.list', params: { panel: 'tools' } });
    const { requestId } = must(sent[0]);

    rpc.handleResponse(response(requestId, { ok: 'data' }));
    await expect(pending).resolves.toEqual({ ok: 'data' });
  });

  it('assigns a distinct, monotonically increasing id to each request', () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    rpc.request('tools.list');
    rpc.request('skills.manage');

    expect(must(sent[0]).requestId).not.toBe(must(sent[1]).requestId);
    expect(must(sent[1]).requestId).toBeGreaterThan(must(sent[0]).requestId);
  });

  it('correlates by id even when responses arrive out of order', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    const first = rpc.request('tools.list');
    const second = rpc.request('model.options');

    // Answer the SECOND request first.
    rpc.handleResponse(response(must(sent[1]).requestId, 'second-result'));
    rpc.handleResponse(response(must(sent[0]).requestId, 'first-result'));

    await expect(first).resolves.toBe('first-result');
    await expect(second).resolves.toBe('second-result');
  });

  it('rejects the pending promise when the response carries ok:false (RPC error)', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    const pending = rpc.request('reload.mcp');
    rpc.handleResponse(errorResponse(must(sent[0]).requestId, 'gateway not connected'));

    await expect(pending).rejects.toThrow(/gateway not connected/);
  });

  it('rejects with a timeout when no response arrives within timeoutMs', async () => {
    let fireTimeout: (() => void) | undefined;
    const rpc = new RpcClient(() => {}, {
      timeoutMs: 100,
      setTimeout: (fn) => {
        fireTimeout = fn;
        return 1;
      },
      clearTimeout: () => {
        fireTimeout = undefined;
      },
    });

    const pending = rpc.request('config.show');
    expect(fireTimeout).toBeDefined();
    fireTimeout?.();

    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it('clears the timeout when the response arrives in time (no late rejection)', async () => {
    let cleared = false;
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req), {
      timeoutMs: 100,
      setTimeout: () => 1,
      clearTimeout: () => {
        cleared = true;
      },
    });

    const pending = rpc.request('tools.list');
    rpc.handleResponse(response(must(sent[0]).requestId, 'ok'));
    await expect(pending).resolves.toBe('ok');
    expect(cleared).toBe(true);
  });

  it('ignores a response whose id has no pending request (stale/duplicate) without throwing', () => {
    const rpc = new RpcClient(() => {});
    // consumed:true means "this was a control.response for me to route", even
    // when there's nothing left to resolve — it must not leak to app listeners.
    expect(rpc.handleResponse(response(999, 'nobody-waiting'))).toBe(true);
  });

  it('returns false for non-control.response messages (leaves them for app listeners)', () => {
    const rpc = new RpcClient(() => {});
    expect(rpc.handleResponse({ type: 'clear', sessionId: 'sess-1' })).toBe(false);
    expect(rpc.handleResponse({ type: 'panel.data', panel: 'tools', data: { toolsets: [], tools: [] } })).toBe(false);
  });

  it('rejectAll settles every in-flight request (view teardown safety net)', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));
    const a = rpc.request('tools.list');
    const b = rpc.request('skills.manage');

    rpc.rejectAll('view disposed');

    await expect(a).rejects.toThrow(/view disposed/);
    await expect(b).rejects.toThrow(/view disposed/);
  });

  it('rejectByTag (W4-T3b §2e Deliverable 5): rejects only the requests tagged with the closed tab, leaving another tab\'s in-flight request settled normally', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    const tabAFetch = rpc.request('panel.data', { panel: 'subagents' }, 'tab-a');
    const tabBFetch = rpc.request('panel.data', { panel: 'subagents' }, 'tab-b');

    rpc.rejectByTag('tab-a', 'Tab was closed.');

    await expect(tabAFetch).rejects.toThrow(/Tab was closed/);
    // tab-b's request is UNTOUCHED — still pending, resolves normally.
    rpc.handleResponse(response(must(sent[1]).requestId, { delegations: [] }));
    await expect(tabBFetch).resolves.toEqual({ delegations: [] });
  });

  it('rejectByTag leaves untagged (connection-global) requests pending', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    const untagged = rpc.request('tools.list'); // no tag — e.g. a global panel fetch

    rpc.rejectByTag('tab-a', 'Tab was closed.');

    rpc.handleResponse(response(must(sent[0]).requestId, { toolsets: [], tools: [] }));
    await expect(untagged).resolves.toEqual({ toolsets: [], tools: [] });
  });

  it('F-1 (final-4way-fixes.md) regression: an untagged config.set survives the ISSUING tab closing mid-flight — the exact "panel lies about persisted config" bug App.tsx\'s setConfig must never reintroduce', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    // Settings is connection-global (owns no tab) — App.tsx's setConfig must
    // issue this WITHOUT a tag, exactly like this call.
    const configSet = rpc.request('config.set', { key: 'theme', value: 'dark' });

    // The tab the user happened to be looking at Settings from closes while
    // the write is still in flight.
    rpc.rejectByTag('tab-a', 'Tab was closed.');

    // The host still confirms the persisted write — SettingsPanel must see
    // that resolution, not a spurious rejection/rollback.
    rpc.handleResponse(response(must(sent[0]).requestId, { ok: true }));
    await expect(configSet).resolves.toEqual({ ok: true });
  });
});

describe('RpcClient — W5.1 Task 13 (R5): nextEdit.toggle correlation', () => {
  it('F-1 discipline: an UNTAGGED nextEdit.toggle survives an unrelated tab closing mid-flight — the toggles are connection-global extension state, owned by no tab', () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    // App.tsx's `setNextEditToggle` must issue this WITHOUT a tag, exactly
    // like this call. Tagging it would make an unrelated tab close reject a
    // legitimate in-flight toggle, and the row would snap back + show a
    // refusal for a toggle the Guard actually ratified (the F-1 bug shape).
    const toggle = rpc.request('nextEdit.toggle', { source: 'next', on: true });

    rpc.rejectByTag('tab-a', 'Tab was closed.');

    rpc.handleResponse(response(must(sent[0]).requestId, { next: true, generic: false }));
    return expect(toggle).resolves.toEqual({ next: true, generic: false });
  });

  it('a host REFUSAL rejects the exact pending toggle with the Guard message verbatim (this is what drives rollbackField)', async () => {
    const sent: ControlRequest[] = [];
    const rpc = new RpcClient((req) => sent.push(req));

    const toggle = rpc.request('nextEdit.toggle', { source: 'generic', on: true });
    rpc.handleResponse(
      errorResponse(must(sent[0]).requestId, 'Next Edit: turn off NEXT first — the two sources are mutually exclusive.'),
    );

    await expect(toggle).rejects.toThrow(
      'Next Edit: turn off NEXT first — the two sources are mutually exclusive.',
    );
  });
});

/*
 * The two locks above exercise `RpcClient`, which is method-agnostic — they
 * pin the CORRELATION contract but cannot see whether App.tsx actually issues
 * the toggle untagged. This source lock closes that gap: it reads the real
 * call site. F-1 was exactly a third argument nobody could see from a unit
 * test of this class.
 */
/*
 * V-19 sibling finding (Tier-2 T-12, webview RPC deadline): the connection
 * default `DEFAULT_TIMEOUT_MS` (30s) is shorter than the host's real
 * checkpoint-restore time (the host side runs up to ~120s) — a slow-but-
 * successful restore used to time out HERE first, reading as a false
 * "failed" and re-arming the destructive "Restore anyway" confirmation.
 * `checkpoint.restore`/`checkpoint.redo` get a per-method 150_000ms
 * override; audit-3 Code M-2 added `checkpoint.redoAll` to the same
 * override BY SYMMETRY with `checkpoint.redo` — a redo-all is the same
 * long-running checkpoint op the other two already cover, and the earlier
 * exclusion was an oversight, not a deliberate scoping decision. Every
 * OTHER method keeps the connection default.
 */
describe('RpcClient — per-method timeout override (T-12 RPC deadline)', () => {
  function captureTimeoutMs(rpcOpts: { timeoutMs?: number } = {}): { rpc: RpcClient; capturedMs: () => number | undefined } {
    let capturedMs: number | undefined;
    const rpc = new RpcClient(() => {}, {
      ...rpcOpts,
      setTimeout: (_fn, ms) => {
        capturedMs = ms;
        return 1;
      },
      clearTimeout: () => {},
    });
    return { rpc, capturedMs: () => capturedMs };
  }

  it('RED: checkpoint.restore arms a 150000ms timer, not the 30000ms connection default', () => {
    const { rpc, capturedMs } = captureTimeoutMs();
    rpc.request('checkpoint.restore');
    expect(capturedMs()).toBe(150_000);
  });

  it('RED: checkpoint.redo arms a 150000ms timer, not the 30000ms connection default', () => {
    const { rpc, capturedMs } = captureTimeoutMs();
    rpc.request('checkpoint.redo');
    expect(capturedMs()).toBe(150_000);
  });

  it('checkpoint.redoAll arms a 150000ms timer, not the 30000ms connection default (Code M-2: symmetry with checkpoint.redo)', () => {
    const { rpc, capturedMs } = captureTimeoutMs();
    rpc.request('checkpoint.redoAll');
    expect(capturedMs()).toBe(150_000);
  });

  it('a method with no override (e.g. config.show) still arms the ordinary 30000ms default', () => {
    const { rpc, capturedMs } = captureTimeoutMs();
    rpc.request('config.show');
    expect(capturedMs()).toBe(30_000);
  });

  it('the per-method override is independent of an injected custom default — checkpoint.restore stays at 150000ms even when the connection default is tuned down for a test', () => {
    const { rpc, capturedMs } = captureTimeoutMs({ timeoutMs: 100 });
    rpc.request('checkpoint.restore');
    expect(capturedMs()).toBe(150_000);
  });

  it('an overridden-default method (config.show) DOES respect an injected custom default', () => {
    const { rpc, capturedMs } = captureTimeoutMs({ timeoutMs: 100 });
    rpc.request('config.show');
    expect(capturedMs()).toBe(100);
  });

  /*
   * T2 (beta.5, §0.1 ⑦ / §2.1): `setup.install`/`setup.pullModel` are the two
   * long-running Setup mutations that used to hit the 30s connection default
   * mid-flight (`control.request 'setup.install' timed out after 30000ms`)
   * even though the host was still legitimately working (pipx/hermes install,
   * model pull). `rpc.ts:97`'s `??` lets an override of `0` win over the
   * default, and `rpc.ts:103`'s `if (effectiveTimeoutMs > 0)` means `0` skips
   * arming a timer AT ALL — not "a very long timer". `setTimeout` is
   * therefore never called for these two methods; `capturedMs()` stays
   * `undefined`. `setup.testRemote` is a bounded network probe, not a
   * long-running install/pull, and stays on the ordinary 30000ms default.
   */
  it('RED: setup.install arms NO timer at all (long-running op exempted from the 30s default)', () => {
    const { rpc, capturedMs } = captureTimeoutMs();
    rpc.request('setup.install');
    expect(capturedMs()).toBeUndefined();
  });

  it('RED: setup.pullModel arms NO timer at all (long-running op exempted from the 30s default)', () => {
    const { rpc, capturedMs } = captureTimeoutMs();
    rpc.request('setup.pullModel');
    expect(capturedMs()).toBeUndefined();
  });

  it('setup.testRemote is NOT exempted — it still arms the ordinary 30000ms connection default', () => {
    const { rpc, capturedMs } = captureTimeoutMs();
    rpc.request('setup.testRemote');
    expect(capturedMs()).toBe(30_000);
  });
});

describe('App.tsx issues nextEdit.toggle connection-GLOBAL (F-1 source lock, Task 13)', () => {
  const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf-8');

  it('calls bridge.request for nextEdit.toggle with NO tag argument', () => {
    // `bridge.request(method, params)` — a third argument is a tab tag, which
    // would let an unrelated tab close reject a legitimate in-flight toggle.
    const call = /bridge\s*\.?\s*request\(\s*'nextEdit\.toggle'\s*,\s*\{[^}]*\}\s*(,)?\s*\)/.exec(appSource);
    expect(call, 'App.tsx must issue a bridge.request(\'nextEdit.toggle\', { … }) call').not.toBeNull();
    expect(call?.[1], 'nextEdit.toggle must be UNTAGGED (connection-global) — no third argument').toBeUndefined();
  });

  it('never tags the toggle with tab.tabId (the exact F-1 regression shape)', () => {
    expect(appSource).not.toMatch(/'nextEdit\.toggle'[^;]*tab\.tabId/);
  });
});
