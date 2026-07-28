import { describe, it, expect } from 'vitest';
import { mapSessionUpdate, createReasoningState } from './sessionUpdate';
import type { AcpSessionUpdate } from './types';
import { must } from '../../../testing/must';

const TURN = 'turn-1';
const SESSION = 'sess-1';

describe('mapSessionUpdate — reasoning (derived start/end)', () => {
  it('opens a reasoning block on the first thought chunk and reuses it on subsequent chunks', () => {
    const state = createReasoningState();
    const first = mapSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
      TURN,
      SESSION,
      state,
    );
    expect(first).toEqual([
      { type: 'reasoning.start', turnId: TURN, sessionId: SESSION, blockId: 'think-turn-1-1' },
      { type: 'reasoning.delta', turnId: TURN, sessionId: SESSION, blockId: 'think-turn-1-1', text: 'thinking...' },
    ]);

    const second = mapSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' more' } },
      TURN,
      SESSION,
      state,
    );
    expect(second).toEqual([
      { type: 'reasoning.delta', turnId: TURN, sessionId: SESSION, blockId: 'think-turn-1-1', text: ' more' },
    ]);
  });

  it('closes reasoning on the first non-thought update and opens a NEW block if thinking resumes', () => {
    const state = createReasoningState();
    mapSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'a' } },
      TURN,
      SESSION,
      state,
    );

    const closed = mapSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
      TURN,
      SESSION,
      state,
    );
    expect(closed).toEqual([
      { type: 'reasoning.end', turnId: TURN, sessionId: SESSION, blockId: 'think-turn-1-1' },
      { type: 'message.delta', turnId: TURN, sessionId: SESSION, text: 'hello' },
    ]);
    expect(state.blockId).toBeUndefined();

    const reopened = mapSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'again' } },
      TURN,
      SESSION,
      state,
    );
    expect(reopened[0]).toEqual({ type: 'reasoning.start', turnId: TURN, sessionId: SESSION, blockId: 'think-turn-1-2' });
  });

  it('ignores empty-text thought chunks', () => {
    const state = createReasoningState();
    expect(
      mapSessionUpdate(
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } },
        TURN,
        SESSION,
        state,
      ),
    ).toEqual([]);
  });
});

describe('mapSessionUpdate — message chunks', () => {
  it('emits message.delta without opening/closing anything when no reasoning is open', () => {
    const state = createReasoningState();
    expect(
      mapSessionUpdate(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        TURN,
        SESSION,
        state,
      ),
    ).toEqual([{ type: 'message.delta', turnId: TURN, sessionId: SESSION, text: 'hi' }]);
  });
});

describe('mapSessionUpdate — tool_call / tool_call_update', () => {
  it('maps a fresh tool_call to tool.start with mapped kind/status and a rawInput preview', () => {
    const state = createReasoningState();
    const update: AcpSessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'terminal: npm test',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'npm test' },
    };
    expect(mapSessionUpdate(update, TURN, SESSION, state)).toEqual([
      {
        type: 'tool.start',
        turnId: TURN,
        sessionId: SESSION,
        toolId: 'tc-1',
        kind: 'execute',
        title: 'terminal: npm test',
        status: 'pending',
        rawInput: 'npm test',
      },
    ]);
  });

  it('emits a tool.diff alongside tool.start when the start content carries a diff (pre-approved edit)', () => {
    const state = createReasoningState();
    const update: AcpSessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'patch (replace): src/a.ts',
      kind: 'edit',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }],
    };
    const messages = mapSessionUpdate(update, TURN, SESSION, state);
    expect(messages).toHaveLength(2);
    expect(must(messages[0]).type).toBe('tool.start');
    expect(must(messages[1])).toMatchObject({ type: 'tool.diff', turnId: TURN, sessionId: SESSION, toolId: 'tc-2', path: 'src/a.ts' });
  });

  it('maps tool_call_update to tool.update with joined text output', () => {
    const state = createReasoningState();
    const update: AcpSessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ content: { type: 'text', text: 'PASS' } }],
    };
    expect(mapSessionUpdate(update, TURN, SESSION, state)).toEqual([
      { type: 'tool.update', turnId: TURN, sessionId: SESSION, toolId: 'tc-1', status: 'done', output: 'PASS' },
    ]);
  });

  it('closes an open reasoning block before a tool_call/tool_call_update', () => {
    const state = createReasoningState();
    mapSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'a' } },
      TURN,
      SESSION,
      state,
    );
    const messages = mapSessionUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read: a.ts', kind: 'read' },
      TURN,
      SESSION,
      state,
    );
    expect(messages[0]).toEqual({ type: 'reasoning.end', turnId: TURN, sessionId: SESSION, blockId: 'think-turn-1-1' });
  });
});

describe('mapSessionUpdate — plan', () => {
  it('maps a plan update', () => {
    const state = createReasoningState();
    const update: AcpSessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read file', status: 'completed' },
        { content: 'Run tests', status: 'in_progress' },
      ],
    };
    expect(mapSessionUpdate(update, TURN, SESSION, state)).toEqual([
      {
        type: 'plan.update',
        turnId: TURN,
        sessionId: SESSION,
        items: [
          { text: 'Read file', status: 'done' },
          { text: 'Run tests', status: 'active' },
        ],
      },
    ]);
  });
});

describe('mapSessionUpdate — ignored variants', () => {
  // V-18 (Tier-2 remediation architecture §2, declared test overturn): this
  // describe used to also assert `user_message_chunk` maps to `[]` — that
  // pinned the drain-echo defect (a queued prompt drained mid-turn streamed
  // with NO user bubble at all). The other three legs below are UNCHANGED —
  // they still have no row in the wave-1 mapping table and must stay pinned.
  it('ignores available_commands_update / current_mode_update / usage_update', () => {
    const state = createReasoningState();
    expect(
      mapSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }, TURN, SESSION, state),
    ).toEqual([]);
    expect(mapSessionUpdate({ sessionUpdate: 'usage_update', size: 100, used: 10 }, TURN, SESSION, state)).toEqual(
      [],
    );
    expect(
      mapSessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] }, TURN, SESSION, state),
    ).toEqual([]);
  });

  // V-18 declared overturn (see the architecture doc §2.2 "Drain rendering"):
  // a live `user_message_chunk` is Hermes' queued-prompt DRAIN echo (the
  // ONLY live emitter of this variant left once `/steer`/`/queue` are
  // admitted mid-turn) — it must now render as a `user` transcript item, not
  // be silently dropped.
  it('V-18: maps a user_message_chunk to a user item (drain echo — the ONLY live emitter of this variant)', () => {
    const state = createReasoningState();
    expect(
      mapSessionUpdate(
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'now add tests' } },
        TURN,
        SESSION,
        state,
      ),
    ).toEqual([{ type: 'user', turnId: TURN, sessionId: SESSION, text: 'now add tests', mode: 'default' }]);
  });

  it('V-18: an empty-text user_message_chunk maps to no message (mirrors agent_message_chunk\'s own empty-text guard)', () => {
    const state = createReasoningState();
    expect(
      mapSessionUpdate(
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '' } },
        TURN,
        SESSION,
        state,
      ),
    ).toEqual([]);
  });

  it('V-18: a user_message_chunk closes an open reasoning block first, same as any other non-thought update', () => {
    const state = createReasoningState();
    mapSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      TURN,
      SESSION,
      state,
    );
    const messages = mapSessionUpdate(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'drained prompt' } },
      TURN,
      SESSION,
      state,
    );
    expect(messages).toEqual([
      { type: 'reasoning.end', turnId: TURN, sessionId: SESSION, blockId: 'think-turn-1-1' },
      { type: 'user', turnId: TURN, sessionId: SESSION, text: 'drained prompt', mode: 'default' },
    ]);
  });
});

// Audit A-1/A-2. Runtime documentation only: `mapSessionUpdate` maps
// usage_update / session_info_update to no UI message, and a string
// rawOutput flows through without throwing. No test in this file is
// DESIGNATED a type-level guard; the designated locks (SDK assignability,
// key-completeness, exact field pins, the rawOutput `unknown` pin) live in
// `types.test-d.ts`, where they are COUNTED tests under the host project's
// typecheck mode — deleting one moves the gate's pass count. The
// `AcpSessionUpdate` annotations on the fixtures below (including the
// `rawOutput: 'plain text...'` one in the A-2 test) DO still fail
// compilation if the shapes they exercise change — that is INCIDENTAL to
// what this file is testing (runtime mapper behavior), not the control
// (task 6.2 review, I-3: the previous wording here, "Nothing in THIS file
// is a type-level guard," was false — falsifiable in one mutation — and
// contradicted this same describe's own A-2 comment three tests below,
// which claimed the opposite).
describe('audit A-1/A-2: usage_update / session_info_update get real types; rawOutput survives a string', () => {
  it('a usage_update carries real numbers through the mapper without throwing', () => {
    const update: AcpSessionUpdate = { sessionUpdate: 'usage_update', used: 1234, size: 128000 };
    const messages = mapSessionUpdate(update, TURN, SESSION, createReasoningState());

    // Documentation only (the TYPE lock for this shape lives in
    // types.test-d.ts): no UI surface consumes usage_update yet.
    expect(messages).toEqual([]);
  });

  it('a session_info_update with a null title is accepted', () => {
    const update: AcpSessionUpdate = {
      sessionUpdate: 'session_info_update',
      title: null,
      updatedAt: '2026-07-22T00:00:00Z',
    };
    const messages = mapSessionUpdate(update, TURN, SESSION, createReasoningState());

    // Documentation only (the TYPE lock for this shape lives in
    // types.test-d.ts): no UI surface consumes session_info_update yet.
    expect(messages).toEqual([]);
  });

  it('I-1: usage_update and session_info_update both carry _meta (Hermes provenance rides here)', () => {
    // Hermes populates `_meta.hermes.sessionProvenance` on session_info_update
    // (acp_adapter/server.py `_send_session_info_update`, `field_meta=meta`);
    // usage_update never sets field_meta today but the SDK declares `_meta` on
    // both (`zod.gen.js:1906`, `:1134`), so both members must model it.
    // Documentation only (the TYPE lock for `_meta` on both members lives in
    // types.test-d.ts): no UI surface consumes either field yet.
    const usage: AcpSessionUpdate = { sessionUpdate: 'usage_update', used: 10, size: 100 };
    const info: AcpSessionUpdate = { sessionUpdate: 'session_info_update', title: 'my session' };
    expect(mapSessionUpdate(usage, TURN, SESSION, createReasoningState())).toEqual([]);
    expect(mapSessionUpdate(info, TURN, SESSION, createReasoningState())).toEqual([]);
  });

  it('a tool_call_update whose rawOutput is a plain string flows through the mapper without throwing', () => {
    // `rawOutput` is never read by `mapSessionUpdate` (verified: only
    // `content` and `rawInput` feed tool.update/tool.start), so no runtime
    // assertion here can prove the A-2 fix — the real defect was upstream,
    // in SDK 0.4.5's zod schema rejecting a string `rawOutput` and dropping
    // the WHOLE notification before it ever reached this mapper. That is not
    // reproducible from this file. What IS ours to fix is that
    // `AcpToolCallFields.rawOutput` accepts a bare string — the `const
    // update: AcpSessionUpdate = {...}` assignment below incidentally
    // re-checks that at compile time too (see the describe-level comment
    // above: incidental, not the control), but it is NOT the designated pin.
    //
    // Designated type pin for rawOutput: types.test-d.ts ("rawOutput is exactly unknown").
    const update: AcpSessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: 'plain text result, not an object',
    };
    const messages = mapSessionUpdate(update, TURN, SESSION, createReasoningState());
    expect(messages.length).toBeGreaterThan(0);
  });
});
