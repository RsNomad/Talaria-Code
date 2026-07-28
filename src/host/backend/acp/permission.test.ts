import { describe, it, expect } from 'vitest';
import {
  mapApprovalOption,
  mapPermissionRequest,
  buildSelectedOutcome,
  buildCancelledOutcome,
  buildMinimalAskApproval,
  applyResolvedPresentation,
} from './permission';
import type { ApprovalRequestMessage } from './permission';
import type { AcpRequestPermissionRequest } from './types';

describe('mapApprovalOption', () => {
  it('uses the Hermes optionId directly as the protocol kind when known', () => {
    expect(mapApprovalOption({ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' })).toEqual({
      id: 'allow_once',
      label: 'Allow once',
      kind: 'allow_once',
    });
    expect(mapApprovalOption({ optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' })).toEqual(
      { id: 'allow_session', label: 'Allow for session', kind: 'allow_session' },
    );
    expect(mapApprovalOption({ optionId: 'deny', kind: 'reject_once', name: 'Deny' })).toEqual({
      id: 'deny',
      label: 'Deny',
      kind: 'deny',
    });
  });

  it('falls back to translating the generic ACP kind for unknown option ids', () => {
    expect(mapApprovalOption({ optionId: 'custom-opt', kind: 'reject_always', name: 'Nope' })).toEqual({
      id: 'custom-opt',
      label: 'Nope',
      kind: 'deny_always',
    });
  });
});

describe('mapPermissionRequest', () => {
  it('maps a command approval (terminal_tool) to kind=command with a detail line', () => {
    const req: AcpRequestPermissionRequest = {
      sessionId: 'sess-1',
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
      toolCall: {
        toolCallId: 'perm-check-1',
        title: 'Run command: npm test',
        kind: 'execute',
        content: [{ content: { type: 'text', text: 'Run tests\n$ npm test' } }],
      },
    };
    const { approval, diffs } = mapPermissionRequest(req, 'turn-1', 'appr-1');
    expect(approval).toEqual({
      type: 'approval.request',
      turnId: 'turn-1',
      sessionId: 'sess-1',
      id: 'appr-1',
      kind: 'command',
      title: 'Run command: npm test',
      detail: 'Run tests\n$ npm test',
      toolId: 'perm-check-1',
      options: [
        { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
      timeoutMs: 60000,
    });
    expect(diffs).toEqual([]);
  });

  it('maps an edit approval to kind=edit and attaches a tool.diff', () => {
    const req: AcpRequestPermissionRequest = {
      sessionId: 'sess-1',
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
      toolCall: {
        toolCallId: 'edit-approval-1',
        title: 'Approve edit: src/a.ts',
        kind: 'edit',
        content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }],
      },
    };
    const { approval, diffs } = mapPermissionRequest(req, 'turn-1', 'appr-2');
    expect(approval).toMatchObject({ type: 'approval.request', kind: 'edit', toolId: 'edit-approval-1' });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ type: 'tool.diff', toolId: 'edit-approval-1', path: 'src/a.ts' });
  });

  // W2-F1 (C3, existing-map §3 gap 2): rawInput was DISCARDED; surface it so the
  // client policy engine can key on tool/arguments/command.
  it('surfaces the edit rawInput ({tool, arguments}) verbatim', () => {
    const req: AcpRequestPermissionRequest = {
      sessionId: 'sess-1',
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' }],
      toolCall: {
        toolCallId: 'edit-approval-1',
        title: 'Approve edit: src/a.ts',
        kind: 'edit',
        content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }],
        rawInput: { tool: 'write_file', arguments: { path: 'src/a.ts', content: 'b' } },
      },
    };
    const { rawInput } = mapPermissionRequest(req, 'turn-1', 'appr-2');
    expect(rawInput).toEqual({ tool: 'write_file', arguments: { path: 'src/a.ts', content: 'b' } });
  });

  it('surfaces the command rawInput ({command, description}) verbatim', () => {
    const req: AcpRequestPermissionRequest = {
      sessionId: 'sess-1',
      options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
      toolCall: {
        toolCallId: 'perm-check-1',
        title: 'Run command: npm test',
        kind: 'execute',
        content: [{ content: { type: 'text', text: '$ npm test' } }],
        rawInput: { command: 'npm test', description: 'Run tests' },
      },
    };
    const { rawInput } = mapPermissionRequest(req, 'turn-1', 'appr-1');
    expect(rawInput).toEqual({ command: 'npm test', description: 'Run tests' });
  });

  it('returns rawInput undefined when the request carries none', () => {
    const req: AcpRequestPermissionRequest = {
      sessionId: 'sess-1',
      options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
      toolCall: { toolCallId: 't', title: 'x', kind: 'execute', content: [] },
    };
    const { rawInput } = mapPermissionRequest(req, 'turn-1', 'appr-1');
    expect(rawInput).toBeUndefined();
  });
});

// Bucket 1 F2 (CWE-807 / LLM06 complete mediation): the emitted card's `kind`
// and `title` come from OUR resolved effect state, never from the agent's
// `toolCall.kind`/`toolCall.title` — the human must approve the verified
// effect, not attacker-authored text.
describe('applyResolvedPresentation (F2 card-from-our-resolved-state)', () => {
  const agentLabeled: ApprovalRequestMessage = {
    type: 'approval.request',
    turnId: 'turn-1',
    sessionId: 'sess-1',
    id: 'appr-3',
    kind: 'edit', // agent-supplied label (untrusted)
    title: 'Update README', // agent-supplied text (untrusted)
    detail: 'agent detail (kept as clearly-agent-supplied preview)',
    toolId: 'tc-1',
    options: [{ id: 'deny', label: 'Deny', kind: 'deny' }],
    timeoutMs: 60000,
  };

  it('labels a command effect as kind=command with the title derived from the command — the agent title is dropped', () => {
    const result = applyResolvedPresentation(agentLabeled, { kind: 'command', command: 'rm -rf /' });
    expect(result.kind).toBe('command');
    expect(result.title).toBe('Run: rm -rf /');
    // Everything else (options, detail preview, ids) is preserved.
    expect(result.options).toEqual(agentLabeled.options);
    expect(result.detail).toBe(agentLabeled.detail);
    expect(result.id).toBe('appr-3');
  });

  it('labels an edit effect with OUR canonical resolved paths, not the raw agent path', () => {
    const result = applyResolvedPresentation(agentLabeled, {
      kind: 'edit',
      paths: ['/home/user/.bashrc'],
      insideWorkspace: false,
      turnProtected: true,
    });
    expect(result.kind).toBe('edit');
    expect(result.title).toBe('Edit: /home/user/.bashrc');
  });

  it('never renders an empty title when the effect could not be parsed', () => {
    const edit = applyResolvedPresentation(agentLabeled, {
      kind: 'edit',
      paths: [],
      insideWorkspace: false,
      turnProtected: true,
    });
    expect(edit.title).toBe('Edit: (unresolved path)');
    const cmd = applyResolvedPresentation(agentLabeled, { kind: 'command', command: '' });
    expect(cmd.title).toBe('Run: (unresolved command)');
  });
});

// Bucket 1 F5 (C7, CWE-636): when parsing the (hostile, agent-supplied) request
// throws, the fail-closed fallback still surfaces a HUMAN ask card — built from
// `req` fields only, never from the parse that just failed.
describe('buildMinimalAskApproval (F5 fail-closed fallback card)', () => {
  it('builds an ask card from raw req fields only: fixed title, passed-through options, no diff parsing', () => {
    const req: AcpRequestPermissionRequest = {
      sessionId: 'sess-1',
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
      toolCall: {
        toolCallId: 'evil-1',
        title: 'Innocent-looking agent title',
        kind: 'edit',
        // Malformed diff content — the reason we are on the fallback path.
        content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 42 as unknown as string }],
      },
    };

    const approval = buildMinimalAskApproval(req, 'turn-1', 'appr-9');

    expect(approval).toEqual({
      type: 'approval.request',
      turnId: 'turn-1',
      sessionId: 'sess-1',
      id: 'appr-9',
      // Conservative label: we could NOT verify the effect, so never present it
      // as a cozy "edit"; the fixed title never echoes agent-authored text.
      kind: 'command',
      title: 'Approval required (request could not be parsed)',
      toolId: 'evil-1',
      options: [
        { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
      timeoutMs: 60000,
    });
  });

  it('tolerates a hostile/unmappable options shape (empty options; Hermes 60s auto-deny is the backstop)', () => {
    const req = {
      sessionId: 'sess-1',
      options: null,
      toolCall: { toolCallId: 't-1', title: 'x', kind: 'edit' },
    } as unknown as AcpRequestPermissionRequest;

    const approval = buildMinimalAskApproval(req, 'turn-1', 'appr-9');

    expect(approval.options).toEqual([]);
    expect(approval.kind).toBe('command');
  });
});

describe('outcome builders', () => {
  it('builds a selected outcome', () => {
    expect(buildSelectedOutcome('allow_once')).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  });

  it('builds a cancelled outcome', () => {
    expect(buildCancelledOutcome()).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
