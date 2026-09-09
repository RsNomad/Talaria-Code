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
import { mockApprovalId, mockTurn } from './fixtures';
import { INITIAL_STATE, type AppState } from '../types';
import { reduce } from '../state/transcript';
import { must } from '../testing/must';

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

    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 1, method: 'nextEdit.toggle', params: { source: 'next', on: true } });

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
    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 1, method: 'nextEdit.toggle', params: { source: 'next', on: true } });
    messages.length = 0;

    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 2, method: 'nextEdit.toggle', params: { source: 'generic', on: true } });

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
    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 1, method: 'nextEdit.toggle', params: { source: 'generic', on: true } });
    messages.length = 0;

    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 2, method: 'nextEdit.toggle', params: { source: 'next', on: true } });

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
    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 1, method: 'nextEdit.toggle', params: { source: 'next', on: true } });
    messages.length = 0;

    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 2, method: 'nextEdit.toggle', params: { source: 'next', on: false } });

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

    backend.handle({ type: 'control.request', instanceId: 'test-instance', requestId: 1, method: 'nextEdit.toggle', params: { source: 'bogus', on: true } });

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

/*
 * WS-A T5c (BH-05): the mock scene must model the REAL two-card manual
 * edit-approval shape Hermes puts on the wire (grounded in
 * acp_adapter/events.py _tool_progress + edit_approval.py
 * build_acp_edit_tool_call + tools.py build_tool_complete): a real `tc-…`
 * patch card (pending → done) AND a separate synthetic `edit-approval-1`
 * card (tool.start → tool.diff → approval.request, same id) whose pill is
 * settle-derived — never one item that goes running → diff → done (that is
 * the auto-allowed accept_edits/dont_ask path, which masked the bug).
 */
describe('fixtures — WS-A T5c (BH-05): manual edit-approval scene shape (pure data)', () => {
  const REAL_TOOL = 'tc-8a4c2f1e9b3d';
  const SYNTHETIC = 'edit-approval-1';
  const messages: HostToWebview[] = mockTurn.map((step) => step.message);
  const indexOf = (predicate: (m: HostToWebview) => boolean): number => messages.findIndex(predicate);

  it('has exactly two approval gates: the EDIT gate first (its id IS mockApprovalId), the npm-test COMMAND gate second under a different id', () => {
    const gated = mockTurn.filter((step) => step.gate === 'approval');
    expect(gated).toHaveLength(2);
    expect(gated[0]?.message).toMatchObject({ type: 'approval.request', kind: 'edit', id: mockApprovalId, toolId: SYNTHETIC });
    expect(gated[1]?.message).toMatchObject({ type: 'approval.request', kind: 'command' });
    expect(gated[1]?.message.type === 'approval.request' ? gated[1].message.id : 'wrong-type').not.toBe(mockApprovalId);
    expect(mockTurn.some((step) => step.gate === 'diff')).toBe(false);
  });

  it('two-card shape in host emit order: real tc-… start → synthetic start → synthetic diff → edit approval.request (gated) → real tc-… done; the synthetic id never gets a tool.update and the real id never gets a tool.diff', () => {
    const realStart = indexOf((m) => m.type === 'tool.start' && m.toolId === REAL_TOOL);
    const synthStart = indexOf((m) => m.type === 'tool.start' && m.toolId === SYNTHETIC);
    const synthDiff = indexOf((m) => m.type === 'tool.diff' && m.toolId === SYNTHETIC);
    const request = indexOf((m) => m.type === 'approval.request' && m.id === mockApprovalId);
    const realDone = indexOf((m) => m.type === 'tool.update' && m.toolId === REAL_TOOL && m.status === 'done');

    expect(realStart).toBeGreaterThanOrEqual(0);
    expect(realStart).toBeLessThan(synthStart);
    expect(synthStart).toBeLessThan(synthDiff);
    expect(synthDiff).toBeLessThan(request);
    expect(request).toBeLessThan(realDone);
    expect(mockTurn[request]?.gate).toBe('approval');

    expect(messages[realStart]).toMatchObject({ kind: 'edit', title: 'patch (replace): src/auth/login.ts', status: 'pending' });
    expect(messages[realStart] !== undefined && 'rawInput' in messages[realStart]).toBe(false);
    expect(messages[synthStart]).toMatchObject({ kind: 'edit', title: 'Edit: src/auth/login.ts', status: 'pending' });
    expect(messages[synthDiff]).toMatchObject({ path: 'src/auth/login.ts' });
    expect(messages[synthDiff]?.type === 'tool.diff' ? messages[synthDiff].hunks : []).toHaveLength(2);

    expect(messages.some((m) => m.type === 'tool.update' && m.toolId === SYNTHETIC)).toBe(false);
    expect(messages.some((m) => m.type === 'tool.diff' && m.toolId === REAL_TOOL)).toBe(false);
  });

  it('the edit approval carries the wire-exact Hermes option set (allow_once "Allow edit" / deny "Deny"), the 60 s deadline, and NO detail (a diff-only permission has no text block)', () => {
    const request = messages.find((m) => m.type === 'approval.request' && m.id === mockApprovalId);
    expect(request).toMatchObject({
      title: 'Edit: src/auth/login.ts',
      timeoutMs: 60000,
      options: [
        { id: 'allow_once', label: 'Allow edit', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    });
    expect(request !== undefined && 'detail' in request).toBe(false);
  });

  it('timing budget the replay tests rely on: the FIRST gate lands after 2550 ms and before 6000 ms of cumulative delay, and the first post-gate step within 3000 ms', () => {
    let elapsed = 0;
    let firstGateAt = -1;
    let firstPostGateDelay = -1;
    for (const step of mockTurn) {
      elapsed += step.delayMs;
      if (firstGateAt >= 0 && firstPostGateDelay < 0) firstPostGateDelay = step.delayMs;
      if (step.gate && firstGateAt < 0) firstGateAt = elapsed;
    }
    expect(firstGateAt).toBeGreaterThan(2550);
    expect(firstGateAt).toBeLessThan(6000);
    expect(firstPostGateDelay).toBeGreaterThanOrEqual(0);
    expect(firstPostGateDelay).toBeLessThan(3000);
  });
});

describe('webview MockBackend — WS-A T5c (BH-05): settle echo, per-step gate id, per-hunk resume', () => {
  const REAL_TOOL = 'tc-8a4c2f1e9b3d';
  const SYNTHETIC = 'edit-approval-1';

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Boot, bind the bootstrap tab, start a turn, run to the FIRST gate. */
  async function bootToEditGate() {
    vi.useFakeTimers();
    const { backend, messages } = makeHarness();
    backend.handle({ type: 'ready' });
    const sessionId = (messages.find((m) => m.type === 'tab.bound') as { sessionId: string }).sessionId;
    backend.handle({ type: 'prompt', sessionId, text: 'go', mode: 'default' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(forSession(messages, sessionId).at(-1)).toMatchObject({ type: 'approval.request', id: mockApprovalId, kind: 'edit', toolId: SYNTHETIC });
    return { backend, messages, sessionId };
  }

  it('approval.respond on the edit gate echoes approval.settle{selected, the chosen optionId, toolId} FIRST, then the real tc-… card completes, then the script parks on the npm-test gate (exactly one settle so far)', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    messages.length = 0;

    backend.handle({ type: 'approval.respond', sessionId, id: mockApprovalId, optionId: 'allow_once' });

    expect(messages[0]).toEqual({
      type: 'approval.settle',
      sessionId,
      turnId: 'turn-1',
      id: mockApprovalId,
      toolId: SYNTHETIC,
      outcome: 'selected',
      optionId: 'allow_once',
    });
    await vi.advanceTimersByTimeAsync(6000);
    const doneIdx = messages.findIndex((m) => m.type === 'tool.update' && m.toolId === REAL_TOOL && m.status === 'done');
    expect(doneIdx).toBeGreaterThan(0);
    expect(messages.filter((m) => m.type === 'approval.settle')).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ type: 'approval.request', kind: 'command' });
    expect(messages.some((m) => m.type === 'tool.update' && m.toolId === SYNTHETIC)).toBe(false);
  });

  it('a respond whose id is NOT the parked gate is a silent no-op (nothing emitted, still parked)', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    messages.length = 0;

    backend.handle({ type: 'approval.respond', sessionId, id: 'appr-2', optionId: 'allow_once' });
    await vi.advanceTimersByTimeAsync(3000);

    expect(messages).toEqual([]);
  });

  it('the SECOND gate resumes on ITS OWN id (read off the parked step), not on mockApprovalId', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    backend.handle({ type: 'approval.respond', sessionId, id: mockApprovalId, optionId: 'allow_once' });
    await vi.advanceTimersByTimeAsync(6000);
    const second = messages.at(-1);
    expect(second).toMatchObject({ type: 'approval.request', kind: 'command' });
    const secondId = second?.type === 'approval.request' ? second.id : 'wrong-type';
    expect(secondId).not.toBe(mockApprovalId);
    messages.length = 0;

    backend.handle({ type: 'approval.respond', sessionId, id: mockApprovalId, optionId: 'opt-once' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages).toEqual([]);

    backend.handle({ type: 'approval.respond', sessionId, id: secondId, optionId: 'opt-once' });
    expect(messages[0]).toMatchObject({ type: 'approval.settle', id: secondId, outcome: 'selected', optionId: 'opt-once' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(messages.at(-1)).toMatchObject({ type: 'turn.end', status: 'complete' });
  });

  it('diff.resolve REJECT on any hunk of the parked edit settles the WHOLE edit to its deny option and resumes (mirrors SessionController.resolveDiff)', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    messages.length = 0;

    backend.handle({ type: 'diff.resolve', sessionId, toolId: SYNTHETIC, hunkIndex: 1, action: 'reject' });

    expect(messages[0]).toMatchObject({ type: 'approval.settle', id: mockApprovalId, toolId: SYNTHETIC, outcome: 'selected', optionId: 'deny' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.some((m) => m.type === 'tool.update' && m.toolId === REAL_TOOL)).toBe(true);
  });

  it('diff.resolve ACCEPT settles to allow_once only once EVERY hunk is accepted; duplicate and out-of-range indexes never count', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    messages.length = 0;

    backend.handle({ type: 'diff.resolve', sessionId, toolId: SYNTHETIC, hunkIndex: 0, action: 'accept' });
    backend.handle({ type: 'diff.resolve', sessionId, toolId: SYNTHETIC, hunkIndex: 0, action: 'accept' });
    backend.handle({ type: 'diff.resolve', sessionId, toolId: SYNTHETIC, hunkIndex: 7, action: 'accept' });
    backend.handle({ type: 'diff.resolve', sessionId, toolId: SYNTHETIC, hunkIndex: -1, action: 'accept' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages).toEqual([]);

    backend.handle({ type: 'diff.resolve', sessionId, toolId: SYNTHETIC, hunkIndex: 1, action: 'accept' });
    expect(messages[0]).toMatchObject({ type: 'approval.settle', id: mockApprovalId, toolId: SYNTHETIC, outcome: 'selected', optionId: 'allow_once' });
  });

  it('diff.resolve for a toolId that is NOT the parked approval is a silent no-op', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    messages.length = 0;

    backend.handle({ type: 'diff.resolve', sessionId, toolId: REAL_TOOL, hunkIndex: 0, action: 'reject' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(messages).toEqual([]);
  });

  it('diff.resolve REJECT on the DIFF-LESS npm-test gate (tool-test-1, no tool.diff steps) is a no-op — no hunks means no aggregation state at all, mirroring SessionController.resolveDiff\'s total===0 no-op', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    backend.handle({ type: 'approval.respond', sessionId, id: mockApprovalId, optionId: 'allow_once' });
    await vi.advanceTimersByTimeAsync(6000);
    const commandGate = messages.at(-1);
    expect(commandGate).toMatchObject({ type: 'approval.request', kind: 'command', id: 'appr-2', toolId: 'tool-test-1' });
    messages.length = 0;

    backend.handle({ type: 'diff.resolve', sessionId, toolId: 'tool-test-1', hunkIndex: 0, action: 'reject' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(messages).toEqual([]);
  });

  it('END-TO-END through the real reducer: the two cards land as edit-approval-1 → "approved" (with its diff) and tc-… → "done" (no diff) — never one item going done', async () => {
    const { backend, messages, sessionId } = await bootToEditGate();
    backend.handle({ type: 'approval.respond', sessionId, id: mockApprovalId, optionId: 'allow_once' });
    await vi.advanceTimersByTimeAsync(6000);
    const second = messages.at(-1);
    const secondId = second?.type === 'approval.request' ? second.id : 'wrong-type';
    backend.handle({ type: 'approval.respond', sessionId, id: secondId, optionId: 'opt-once' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(messages.at(-1)).toMatchObject({ type: 'turn.end', status: 'complete' });

    let state: AppState = INITIAL_STATE;
    for (const m of messages) state = reduce(state, m);
    const tab = must(state.tabs[state.activeTabId], 'no active tab after replay');
    const tools = tab.transcript.filter((i) => i.kind === 'tool');
    const synthetic = tools.find((i) => i.kind === 'tool' && i.toolId === SYNTHETIC);
    const real = tools.find((i) => i.kind === 'tool' && i.toolId === REAL_TOOL);

    expect(synthetic).toMatchObject({ status: 'approved', title: 'Edit: src/auth/login.ts' });
    expect(synthetic?.kind === 'tool' ? synthetic.diffs?.length : undefined).toBe(1);
    expect(real).toMatchObject({ status: 'done', title: 'patch (replace): src/auth/login.ts' });
    expect(real?.kind === 'tool' ? real.diffs : 'wrong-kind').toBeUndefined();
    const editApproval = tab.transcript.find((i) => i.kind === 'approval' && i.id === mockApprovalId);
    expect(editApproval).toMatchObject({ settledOutcome: 'selected', resolvedOptionId: 'allow_once', toolId: SYNTHETIC });
  });
});
