import { describe, it, expect } from 'vitest';
import { SubagentAccumulator } from './subagentAccumulator';
import type { AcpSessionUpdate } from '../backend/acp/types';
import { must } from '../../testing/must';

/**
 * Fixtures shaped exactly like the real `delegate_task` `tool_call`/
 * `tool_call_update` events (grounded in `acp_adapter/tools.py`):
 *  - start: `title` is always one of the literal prefixes
 *    `build_tool_title` produces for `tool_name == "delegate_task"`
 *    (`:119-126`) — `"delegate: <goal>"` / `"delegate batch (N tasks)"` /
 *    `"delegate task"`. `rawInput` is never populated for this tool (it's in
 *    `_POLISHED_TOOLS`, so `build_tool_start`'s delegate_task branch never
 *    passes `raw_input=` — `tools.py:1180-1197`), so the accumulator must not
 *    depend on it.
 *  - completion: `content` carries `_format_delegate_result`'s formatted
 *    prose summary (`tools.py:563-606`), `status` is `"completed"`/`"failed"`
 *    (`build_tool_complete`, `tools.py:1268-1274`).
 */
function delegateStart(toolCallId: string, title: string, contentText?: string): AcpSessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind: 'execute',
    status: 'pending',
    content: contentText ? [{ content: { type: 'text', text: contentText } }] : null,
  };
}

function delegateUpdate(
  toolCallId: string,
  status: 'completed' | 'failed' | undefined,
  contentText?: string,
): AcpSessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    content: contentText ? [{ content: { type: 'text', text: contentText } }] : null,
  };
}

function otherToolStart(toolCallId: string, title: string): AcpSessionUpdate {
  return { sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'pending', content: null };
}

describe('SubagentAccumulator', () => {
  it('folds a delegate_task start -> completion into one running -> complete node', () => {
    const acc = new SubagentAccumulator();

    const changed1 = acc.apply(
      delegateStart('tc-1', 'delegate: refactor the parser', 'Delegating task:\nrefactor the parser'),
    );
    expect(changed1).toBe(true);
    expect(acc.snapshot()).toEqual({
      delegations: [
        expect.objectContaining({
          id: 'tc-1',
          goal: 'delegate: refactor the parser',
          status: 'running',
          detail: 'Delegating task:\nrefactor the parser',
        }),
      ],
    });

    const changed2 = acc.apply(
      delegateUpdate('tc-1', 'completed', 'Delegation results: 1 task in 12.3s\n\n✅ Task 1: completed'),
    );
    expect(changed2).toBe(true);

    const node = must(acc.snapshot().delegations[0]);
    expect(node.status).toBe('complete');
    expect(node.detail).toContain('Delegation results: 1 task');
    expect(node.id).toBe('tc-1');
  });

  it('tracks two concurrent delegations independently, preserving start order', () => {
    const acc = new SubagentAccumulator();
    acc.apply(delegateStart('tc-1', 'delegate: task A'));
    acc.apply(delegateStart('tc-2', 'delegate: task B'));

    acc.apply(delegateUpdate('tc-1', 'completed'));

    const snapshot = acc.snapshot();
    expect(snapshot.delegations.map((d) => d.id)).toEqual(['tc-1', 'tc-2']);
    expect(must(snapshot.delegations[0]).status).toBe('complete');
    expect(must(snapshot.delegations[1]).status).toBe('running');
  });

  it('maps a failed completion to status "failed" and captures the failure detail', () => {
    const acc = new SubagentAccumulator();
    acc.apply(delegateStart('tc-1', 'delegate: task A'));

    const changed = acc.apply(delegateUpdate('tc-1', 'failed', 'Delegation failed: timeout'));

    expect(changed).toBe(true);
    expect(acc.snapshot().delegations[0]).toMatchObject({
      status: 'failed',
      detail: 'Delegation failed: timeout',
    });
  });

  it('reset() clears every tracked delegation', () => {
    const acc = new SubagentAccumulator();
    acc.apply(delegateStart('tc-1', 'delegate: task A'));
    expect(acc.snapshot().delegations).toHaveLength(1);

    acc.reset();

    expect(acc.snapshot()).toEqual({ delegations: [] });
  });

  it('ignores tool_call events for non-delegate tools (title does not start with "delegate")', () => {
    const acc = new SubagentAccumulator();
    const changed = acc.apply(otherToolStart('tc-1', 'terminal: ls -la'));

    expect(changed).toBe(false);
    expect(acc.snapshot().delegations).toEqual([]);
  });

  it('ignores tool_call_update events for an untracked toolCallId (no prior delegate tool_call observed)', () => {
    const acc = new SubagentAccumulator();
    const changed = acc.apply(delegateUpdate('tc-unknown', 'completed'));

    expect(changed).toBe(false);
    expect(acc.snapshot().delegations).toEqual([]);
  });

  it('ignores unrelated session/update variants (e.g. agent_message_chunk)', () => {
    const acc = new SubagentAccumulator();
    const changed = acc.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });

    expect(changed).toBe(false);
    expect(acc.snapshot().delegations).toEqual([]);
  });

  it('a duplicate/no-op tool_call_update (same terminal status, no new content) reports no change', () => {
    const acc = new SubagentAccumulator();
    acc.apply(delegateStart('tc-1', 'delegate: task A'));
    acc.apply(delegateUpdate('tc-1', 'completed', 'done.'));

    const changed = acc.apply(delegateUpdate('tc-1', 'completed', 'done.'));

    expect(changed).toBe(false);
  });

  it('markRunningInterrupted flips only the RUNNING delegations to interrupted (X4)', () => {
    const acc = new SubagentAccumulator();
    acc.apply(delegateStart('tc-1', 'delegate: still running'));
    acc.apply(delegateStart('tc-2', 'delegate: finished'));
    acc.apply(delegateUpdate('tc-2', 'completed'));

    const changed = acc.markRunningInterrupted();

    expect(changed).toBe(true);
    const [a, b] = acc.snapshot().delegations;
    expect(a).toMatchObject({ id: 'tc-1', status: 'interrupted' }); // was running -> interrupted
    expect(b).toMatchObject({ id: 'tc-2', status: 'complete' }); // already terminal -> untouched
  });

  it('markRunningInterrupted is a no-op (returns false) when nothing is running', () => {
    const acc = new SubagentAccumulator();
    acc.apply(delegateStart('tc-1', 'delegate: task A'));
    acc.apply(delegateUpdate('tc-1', 'completed'));

    expect(acc.markRunningInterrupted()).toBe(false);
  });

  it('omits startedAt for a delegation observed during a session/load replay (no fabricated now())', () => {
    const acc = new SubagentAccumulator();

    acc.setReplaying(true);
    acc.apply(delegateStart('tc-1', 'delegate: historical'));
    expect(must(acc.snapshot().delegations[0]).startedAt).toBeUndefined();

    // Back to live: startedAt is observed again.
    acc.setReplaying(false);
    acc.apply(delegateStart('tc-2', 'delegate: live'));
    expect(typeof must(acc.snapshot().delegations[1]).startedAt).toBe('string');
  });
});
