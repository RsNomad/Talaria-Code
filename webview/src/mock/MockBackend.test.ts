/*
 * W4-T3b (§7 B12): the standalone webview MockBackend two-tab interleave —
 * the only place W4's multi-tab UI is driveable pre-Fedora under the
 * build-blind rule. Exercises: `tab.open` minting a session PER TAB, the
 * P-1 bleed (two tabs' scripted turns never cross-wire), and independent
 * approval-gate parking per tab.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HostToWebview } from '../protocol';
import { BOOTSTRAP_TAB_ID } from '../protocol';
import { MockBackend } from './MockBackend';
import { mockApprovalId } from './fixtures';

function makeHarness() {
  const messages: HostToWebview[] = [];
  const backend = new MockBackend((msg) => messages.push(msg));
  return { backend, messages };
}

/** All messages of a given type that carry `sessionId === id`. */
function forSession(messages: HostToWebview[], sessionId: string): HostToWebview[] {
  return messages.filter((m) => 'sessionId' in m && (m as { sessionId?: string }).sessionId === sessionId);
}

describe('webview MockBackend — W4-T3b B12: tab.open mints a session per tab', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ready auto-binds the bootstrap tab (composer latch parity with the real backend)', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });

    const bound = messages.find((m) => m.type === 'tab.bound');
    expect(bound).toMatchObject({ type: 'tab.bound', tabId: BOOTSTRAP_TAB_ID });
    expect((bound as { sessionId: string }).sessionId).toBeTruthy();
    expect((bound as { rootId: string }).rootId).toBeTruthy();
  });

  it('tab.open mints a DISTINCT mock-session-N for the new tab, bound to its own tabId', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    const bootstrapBound = messages.find((m) => m.type === 'tab.bound') as { sessionId: string };

    backend.handle({ type: 'tab.open', tabId: 'tab-2' });

    const bounds = messages.filter((m) => m.type === 'tab.bound');
    expect(bounds).toHaveLength(2);
    const tab2Bound = bounds[1] as { tabId: string; sessionId: string; rootId: string };
    expect(tab2Bound.tabId).toBe('tab-2');
    expect(tab2Bound.sessionId).not.toBe(bootstrapBound.sessionId);
    expect(tab2Bound.rootId).toBe(tab2Bound.sessionId);
  });
});

describe('webview MockBackend — W4-T3b B12: two-tab interleave never cross-wires (the P-1 bleed exercise)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function bindTwoTabs(backend: MockBackend, messages: HostToWebview[]) {
    backend.handle({ type: 'ready' });
    const bootstrapId = (messages.find((m) => m.type === 'tab.bound') as { sessionId: string }).sessionId;
    backend.handle({ type: 'tab.open', tabId: 'tab-2' });
    const tab2Id = (messages.filter((m) => m.type === 'tab.bound')[1] as { sessionId: string }).sessionId;
    return { bootstrapId, tab2Id };
  }

  it('interleaved prompts from two tabs each stream ONLY under their own sessionId', async () => {
    vi.useFakeTimers();
    const { backend, messages } = makeHarness();
    const { bootstrapId, tab2Id } = bindTwoTabs(backend, messages);

    backend.handle({ type: 'prompt', sessionId: bootstrapId, text: 'first tab turn', mode: 'default' });
    await vi.advanceTimersByTimeAsync(50);
    backend.handle({ type: 'prompt', sessionId: tab2Id, text: 'second tab turn', mode: 'default' });

    // Run both scripts up to (not into) the first approval gate.
    await vi.advanceTimersByTimeAsync(2500);

    const bootstrapMsgs = forSession(messages, bootstrapId);
    const tab2Msgs = forSession(messages, tab2Id);
    expect(bootstrapMsgs.length).toBeGreaterThan(0);
    expect(tab2Msgs.length).toBeGreaterThan(0);

    // P-1: every message carries EXACTLY one of the two session ids — no
    // message ever lands under the wrong tab's session.
    for (const m of messages) {
      if (!('sessionId' in m)) continue;
      expect([bootstrapId, tab2Id]).toContain((m as { sessionId: string }).sessionId);
    }
    // A representative streamed field (message.delta text) proves it's not
    // just the routing key that's right — content genuinely interleaves.
    expect(bootstrapMsgs.some((m) => m.type === 'turn.start')).toBe(true);
    expect(tab2Msgs.some((m) => m.type === 'turn.start')).toBe(true);
  });

  it('an approval.respond for tab A does not resume tab B (independent parking)', async () => {
    vi.useFakeTimers();
    const { backend, messages } = makeHarness();
    const { bootstrapId, tab2Id } = bindTwoTabs(backend, messages);

    backend.handle({ type: 'prompt', sessionId: bootstrapId, text: 'a', mode: 'default' });
    backend.handle({ type: 'prompt', sessionId: tab2Id, text: 'b', mode: 'default' });

    // Run past both scripts' gate (approval.request), well before the end.
    await vi.advanceTimersByTimeAsync(6000);

    const bootstrapApproval = forSession(messages, bootstrapId).find((m) => m.type === 'approval.request');
    const tab2Approval = forSession(messages, tab2Id).find((m) => m.type === 'approval.request');
    expect(bootstrapApproval).toBeDefined();
    expect(tab2Approval).toBeDefined();

    messages.length = 0;
    // Resolve ONLY tab-2's approval.
    backend.handle({ type: 'approval.respond', sessionId: tab2Id, id: mockApprovalId, optionId: 'opt-once' });
    await vi.advanceTimersByTimeAsync(3000);

    // tab-2 resumed (streamed more messages); the bootstrap tab, still
    // parked on its OWN gate, streamed nothing further.
    expect(forSession(messages, tab2Id).length).toBeGreaterThan(0);
    expect(forSession(messages, bootstrapId).length).toBe(0);
  });

  it('cancel for one tab ends only that tab\'s turn', async () => {
    vi.useFakeTimers();
    const { backend, messages } = makeHarness();
    const { bootstrapId, tab2Id } = bindTwoTabs(backend, messages);

    backend.handle({ type: 'prompt', sessionId: bootstrapId, text: 'a', mode: 'default' });
    backend.handle({ type: 'prompt', sessionId: tab2Id, text: 'b', mode: 'default' });
    await vi.advanceTimersByTimeAsync(200);

    messages.length = 0;
    backend.handle({ type: 'cancel', sessionId: tab2Id });

    const cancelled = messages.filter((m) => m.type === 'turn.end');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ sessionId: tab2Id, status: 'cancelled' });
  });
});

describe('webview MockBackend — W3-T6 (CF-11/D2): tab.newSession rebinds ONLY the named tab', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function bindTwoTabs(backend: MockBackend, messages: HostToWebview[]) {
    backend.handle({ type: 'ready' });
    const bootstrapId = (messages.find((m) => m.type === 'tab.bound') as { sessionId: string }).sessionId;
    backend.handle({ type: 'tab.open', tabId: 'tab-2' });
    const tab2Id = (messages.filter((m) => m.type === 'tab.bound')[1] as { sessionId: string }).sessionId;
    return { bootstrapId, tab2Id };
  }

  it('clears the OLD session and binds a FRESH one to the SAME tab', () => {
    const { backend, messages } = makeHarness();
    const { bootstrapId } = bindTwoTabs(backend, messages);

    backend.handle({ type: 'tab.newSession', tabId: BOOTSTRAP_TAB_ID, sessionId: bootstrapId });

    // MIN-B/IMP-2 (3-lens review): tabId-scoped `tab.clear`, not the old
    // sessionId-keyed `clear` — parity with the real backend + host mock.
    const clearIdx = messages.findIndex((m) => m.type === 'tab.clear' && (m as { tabId?: string }).tabId === BOOTSTRAP_TAB_ID);
    const bounds = messages.filter((m) => m.type === 'tab.bound') as Array<{ tabId: string; sessionId: string }>;
    const freshBound = bounds.find((b) => b.tabId === BOOTSTRAP_TAB_ID && b.sessionId !== bootstrapId);
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(freshBound).toBeDefined();
  });

  it('a sibling tab\'s player is untouched — its in-flight turn keeps streaming after the rebind', async () => {
    vi.useFakeTimers();
    const { backend, messages } = makeHarness();
    const { bootstrapId, tab2Id } = bindTwoTabs(backend, messages);

    backend.handle({ type: 'prompt', sessionId: tab2Id, text: 'tab-2 still running', mode: 'default' });
    await vi.advanceTimersByTimeAsync(50);

    messages.length = 0;
    backend.handle({ type: 'tab.newSession', tabId: BOOTSTRAP_TAB_ID, sessionId: bootstrapId });

    // Nothing about the rebind ever names tab-2's session.
    expect(forSession(messages, tab2Id)).toEqual([]);

    // tab-2's own script is still genuinely running — it keeps streaming.
    messages.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(forSession(messages, tab2Id).length).toBeGreaterThan(0);
  });
});

describe('webview MockBackend — W4-T3b B12: per-session policy.setPreset does not cross-wire', () => {
  it('echoes policy.state under the SAME sessionId it was set on', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    const bootstrapId = (messages.find((m) => m.type === 'tab.bound') as { sessionId: string }).sessionId;
    backend.handle({ type: 'tab.open', tabId: 'tab-2' });
    const tab2Id = (messages.filter((m) => m.type === 'tab.bound')[1] as { sessionId: string }).sessionId;

    messages.length = 0;
    backend.handle({ type: 'policy.setPreset', sessionId: tab2Id, preset: 'strict' });

    expect(messages).toEqual([{ type: 'policy.state', sessionId: tab2Id, preset: 'strict' }]);
    void bootstrapId;
  });
});

describe('webview MockBackend — ARCH-1 (final review, UI I-1) / T2: setModel echoes an authoritative model.state', () => {
  it('echoes model.state under the SAME sessionId + modelId it was set with (closes the P7-N6 "push that never came" gap)', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    const bootstrapId = (messages.find((m) => m.type === 'tab.bound') as { sessionId: string }).sessionId;

    messages.length = 0;
    backend.handle({ type: 'setModel', sessionId: bootstrapId, modelId: 'qwen2.5-coder:7b-base' });

    // RED today: setModel falls into the `default` case (a documented
    // "acknowledged optimistically; nothing to echo" no-op) — the mock
    // never confirms, so ModelsPanel's header/highlight (which reads
    // `resolveEffectiveModelId`) is left permanently stale relative to the
    // chip's optimistic write.
    expect(messages).toEqual([{ type: 'model.state', sessionId: bootstrapId, modelId: 'qwen2.5-coder:7b-base' }]);
  });

  it('echoes model.state under the SAME sessionId on a second tab (no cross-wire)', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    backend.handle({ type: 'tab.open', tabId: 'tab-2' });
    const tab2Id = (messages.filter((m) => m.type === 'tab.bound')[1] as { sessionId: string }).sessionId;

    messages.length = 0;
    backend.handle({ type: 'setModel', sessionId: tab2Id, modelId: 'B' });

    expect(messages).toEqual([{ type: 'model.state', sessionId: tab2Id, modelId: 'B' }]);
  });
});

/*
 * W3-T8 (closes L1 m8): the scripted turn's `user` step carries CANNED text
 * (`mockTurn`'s baked-in "Refactor the login() function..." string). When a
 * real person types their own prompt into the F5 mock demo and sends it, the
 * replayed transcript must echo what THEY typed, not the canned scenario
 * text — otherwise the demo looks disconnected from the user's own input.
 * Everything else in the scenario (assistant steps, tools, timing, the
 * frozen `mockTurn` data itself) stays exactly as scripted; only the `user`
 * step's `text` is restamped at replay time, the same way `sessionId`
 * already is.
 */
describe('webview MockBackend — W3-T8: replays the ACTUALLY TYPED prompt (closes L1 m8)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restamps the scripted user step's text with the incoming prompt text, not the canned scenario text", async () => {
    vi.useFakeTimers();
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    const bootstrapId = (messages.find((m) => m.type === 'tab.bound') as { sessionId: string }).sessionId;

    backend.handle({ type: 'prompt', sessionId: bootstrapId, text: 'HELLO FROM THE USER', mode: 'default' });
    await vi.advanceTimersByTimeAsync(50);

    const userStep = messages.find((m) => m.type === 'user') as { text: string } | undefined;
    expect(userStep).toBeDefined();
    expect(userStep?.text).toBe('HELLO FROM THE USER');
  });

  it('restamps independently per session — a second tab\'s own typed prompt never leaks into the first', async () => {
    vi.useFakeTimers();
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    const bootstrapId = (messages.find((m) => m.type === 'tab.bound') as { sessionId: string }).sessionId;
    backend.handle({ type: 'tab.open', tabId: 'tab-2' });
    const tab2Id = (messages.filter((m) => m.type === 'tab.bound')[1] as { sessionId: string }).sessionId;

    backend.handle({ type: 'prompt', sessionId: bootstrapId, text: 'first tab prompt', mode: 'default' });
    backend.handle({ type: 'prompt', sessionId: tab2Id, text: 'second tab prompt', mode: 'default' });
    await vi.advanceTimersByTimeAsync(50);

    const bootstrapUser = messages.find(
      (m) => m.type === 'user' && (m as { sessionId?: string }).sessionId === bootstrapId,
    ) as { text: string } | undefined;
    const tab2User = messages.find(
      (m) => m.type === 'user' && (m as { sessionId?: string }).sessionId === tab2Id,
    ) as { text: string } | undefined;
    expect(bootstrapUser?.text).toBe('first tab prompt');
    expect(tab2User?.text).toBe('second tab prompt');
  });
});

/*
 * W5.1 R5 (Task 13), RE-BASED by Task 12 (§5.5/D7): the standalone scaffold
 * must model the Guard's ONE invariant, not just ack the request. Blindly
 * acking `nextEdit.toggle` (the catch-all branch) let the dev app turn BOTH
 * sources on at once — exactly the both-on state `08` §8 says is
 * unrepresentable in the UI by construction. It is the only place this UX is
 * driveable pre-Fedora, so an unfaithful mock here is a scaffold that teaches
 * the wrong thing.
 *
 * Task 2 re-based the real Guard onto the `talaria.nextEdit.source` enum
 * setting, making mutual exclusion STRUCTURAL: turning the second source on
 * REPLACES the first instead of being refused. Task 12 re-bases this mock the
 * same way — the REFUSAL tests this describe block used to carry (`ok:false`
 * plus the Guard's refusal copy) tested a code path production has not run
 * since Task 2; they are replaced below with the structural-replace
 * equivalents.
 */
describe('webview MockBackend — R5 nextEdit.toggle (Task 13, structural-replace since Task 12)', () => {
  it('accepts a toggle-on from off and answers with the new state PLUS a nextEdit.state push', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    messages.length = 0;

    backend.handle({ type: 'control.request', requestId: 1, method: 'nextEdit.toggle', params: { source: 'next', on: true } });

    expect(messages).toContainEqual({ type: 'nextEdit.state', state: { next: true, generic: false } });
    expect(messages).toContainEqual({
      type: 'control.response',
      requestId: 1,
      ok: true,
      result: { next: true, generic: false },
    });
  });

  it('turning the second source ON while the first is on REPLACES it — no refusal, ok:true with the new state', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    backend.handle({ type: 'control.request', requestId: 1, method: 'nextEdit.toggle', params: { source: 'next', on: true } });
    messages.length = 0;

    backend.handle({ type: 'control.request', requestId: 2, method: 'nextEdit.toggle', params: { source: 'generic', on: true } });

    expect(messages).toContainEqual({ type: 'nextEdit.state', state: { next: false, generic: true } });
    expect(messages).toContainEqual({
      type: 'control.response',
      requestId: 2,
      ok: true,
      result: { next: false, generic: true },
    });
  });

  it('turning the NEXT source ON while Generic is on REPLACES it too — the mirror direction', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    backend.handle({ type: 'control.request', requestId: 1, method: 'nextEdit.toggle', params: { source: 'generic', on: true } });
    messages.length = 0;

    backend.handle({ type: 'control.request', requestId: 2, method: 'nextEdit.toggle', params: { source: 'next', on: true } });

    expect(messages).toContainEqual({ type: 'nextEdit.state', state: { next: true, generic: false } });
    expect(messages).toContainEqual({
      type: 'control.response',
      requestId: 2,
      ok: true,
      result: { next: true, generic: false },
    });
  });

  it('turning the active source OFF returns to fully-off', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    backend.handle({ type: 'control.request', requestId: 1, method: 'nextEdit.toggle', params: { source: 'next', on: true } });
    messages.length = 0;

    backend.handle({ type: 'control.request', requestId: 2, method: 'nextEdit.toggle', params: { source: 'next', on: false } });

    expect(messages).toContainEqual({ type: 'nextEdit.state', state: { next: false, generic: false } });
    expect(messages).toContainEqual({
      type: 'control.response',
      requestId: 2,
      ok: true,
      result: { next: false, generic: false },
    });
  });

  it('a malformed source is rejected ok:false — the one refusal-shaped path left is validation, not conflict', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    messages.length = 0;

    backend.handle({ type: 'control.request', requestId: 1, method: 'nextEdit.toggle', params: { source: 'bogus', on: true } });

    expect(messages).toEqual([
      {
        type: 'control.response',
        requestId: 1,
        ok: false,
        error: { message: 'Next Edit: malformed toggle request.' },
      },
    ]);
  });

  it('pushes the current toggles on ready, so a mounted scaffold panel is never guessing', () => {
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });

    expect(messages).toContainEqual({ type: 'nextEdit.state', state: { next: false, generic: false } });
  });
});
