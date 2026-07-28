import { describe, it, expect } from 'vitest';
import { ReplayTranslator } from './replayTranslator';
import type { AcpSessionUpdate } from './types';

const user = (text: string): AcpSessionUpdate => ({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text },
});
const agent = (text: string): AcpSessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
});
const tool: AcpSessionUpdate = {
  sessionUpdate: 'tool_call',
  toolCallId: 'tc-1',
  title: 'read: a.ts',
  kind: 'read',
  status: 'pending',
};

function make(): { rt: ReplayTranslator; ids: string[] } {
  const ids = ['turn-1'];
  let n = 1;
  const rt = new ReplayTranslator('sess-1', 'turn-1', () => {
    n += 1;
    const id = `turn-${n}`;
    ids.push(id);
    return id;
  });
  return { rt, ids };
}

describe('ReplayTranslator — R-C2: session/load replay rendering', () => {
  it('renders a leading user_message_chunk as a user item in the FIRST turn (no empty bracket)', () => {
    const { rt } = make();
    expect(rt.apply(user('fix the bug'))).toEqual([
      { type: 'user', turnId: 'turn-1', sessionId: 'sess-1', text: 'fix the bug', mode: 'default' },
    ]);
    expect(rt.currentTurnId).toBe('turn-1');
  });

  it('a user chunk AFTER agent content closes the turn and opens the next: finish + turn.end + turn.start + user', () => {
    const { rt } = make();
    rt.apply(user('fix the bug'));
    rt.apply(agent('Done.'));

    const boundary = rt.apply(user('now add tests'));

    expect(boundary).toEqual([
      { type: 'message.end', turnId: 'turn-1', sessionId: 'sess-1', text: 'Done.' },
      { type: 'turn.end', turnId: 'turn-1', sessionId: 'sess-1', status: 'complete' },
      { type: 'turn.start', turnId: 'turn-2', sessionId: 'sess-1' },
      { type: 'user', turnId: 'turn-2', sessionId: 'sess-1', text: 'now add tests', mode: 'default' },
    ]);
    expect(rt.currentTurnId).toBe('turn-2');
  });

  it('non-user updates delegate to the inner TurnTranslator with the CURRENT turn id', () => {
    const { rt } = make();
    rt.apply(user('q1'));
    rt.apply(agent('a1'));
    rt.apply(user('q2'));
    const msgs = rt.apply(agent('a2'));
    expect(msgs).toEqual([{ type: 'message.delta', turnId: 'turn-2', sessionId: 'sess-1', text: 'a2' }]);
  });

  it('consecutive user chunks stack in ONE turn (queued-prompt history, server.py:1383)', () => {
    const { rt } = make();
    rt.apply(user('q1'));
    const second = rt.apply(user('q2'));
    expect(second).toEqual([{ type: 'user', turnId: 'turn-1', sessionId: 'sess-1', text: 'q2', mode: 'default' }]);
  });

  it('tool activity counts as agent content for the boundary rule', () => {
    const { rt } = make();
    rt.apply(user('q1'));
    rt.apply(tool);
    const boundary = rt.apply(user('q2'));
    expect(boundary.map((m) => m.type)).toEqual(['turn.end', 'turn.start', 'user']);
  });

  it('bookkeeping updates emit nothing and do NOT trip the boundary', () => {
    const { rt } = make();
    rt.apply(user('q1'));
    // Real usage_update shape (audit A-1, types.ts) — `used`/`size` are
    // required `number` fields on the wire; a bare `{ sessionUpdate:
    // 'usage_update' }` no longer satisfies `AcpSessionUpdate` and would
    // only compile behind an `as` cast that hides the fixture being
    // incomplete (task-6-review.md M-7).
    const usageUpdate: AcpSessionUpdate = { sessionUpdate: 'usage_update', used: 10, size: 100 };
    expect(rt.apply(usageUpdate)).toEqual([]);
    const second = rt.apply(user('q2'));
    expect(second.map((m) => m.type)).toEqual(['user']); // same turn — no bracket
  });

  it('empty-text user chunks are ignored; finish() returns only the inner tail', () => {
    const { rt } = make();
    expect(rt.apply(user(''))).toEqual([]);
    rt.apply(agent('tail text'));
    expect(rt.finish()).toEqual([{ type: 'message.end', turnId: 'turn-1', sessionId: 'sess-1', text: 'tail text' }]);
  });
});
