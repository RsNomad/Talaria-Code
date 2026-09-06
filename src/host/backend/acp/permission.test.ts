import { describe, it, expect } from 'vitest';
import {
  mapApprovalOption,
  mapPermissionRequest,
  buildSelectedOutcome,
  buildCancelledOutcome,
  buildMinimalAskApproval,
  applyResolvedPresentation,
  buildPermissionToolStart,
} from './permission';
import type { ApprovalRequestMessage } from './permission';
import type { AcpRequestPermissionRequest, AcpToolCallFields } from './types';
import { buildEditSignalFromResolved } from './policySignal';

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

// ADR-R2-02 (BH-05 fix, [SEC]): the synthetic `tool.start` keyed to the
// edit-approval id must present OUR resolved `approval.kind`/`approval.title`
// (already re-labeled by applyResolvedPresentation) — never the agent-authored
// `toolCall.title`/`toolCall.kind` — so the DiffCard the human sees is titled
// with the verified effect, not attacker-crafted copy.
describe('buildPermissionToolStart', () => {
  const resolvedEditApproval: ApprovalRequestMessage = {
    type: 'approval.request',
    turnId: 'turn-1',
    sessionId: 'sess-1',
    id: 'appr-1',
    kind: 'edit',
    title: 'Edit: src/a.ts, src/b.ts',
    options: [],
    timeoutMs: 60000,
  };

  it('reads title/kind from approval (resolved), never from toolCall (misleading agent copy)', () => {
    const toolCall: AcpToolCallFields = {
      toolCallId: 'edit-approval-1',
      title: 'Delete everything',
      kind: 'read',
    };
    const result = buildPermissionToolStart(toolCall, resolvedEditApproval);
    expect(result.title).toBe('Edit: src/a.ts, src/b.ts');
    expect(result.kind).toBe('edit');
  });

  it('reads the routing id from toolCall.toolCallId', () => {
    const toolCall: AcpToolCallFields = { toolCallId: 'edit-approval-1' };
    const result = buildPermissionToolStart(toolCall, resolvedEditApproval);
    expect(result.toolId).toBe('edit-approval-1');
  });

  it('maps approval.kind: command -> execute, edit -> edit', () => {
    const toolCall: AcpToolCallFields = { toolCallId: 't-1' };
    const commandApproval: ApprovalRequestMessage = {
      ...resolvedEditApproval,
      kind: 'command',
      title: 'Run: npm test',
    };
    expect(buildPermissionToolStart(toolCall, commandApproval).kind).toBe('execute');
    expect(buildPermissionToolStart(toolCall, resolvedEditApproval).kind).toBe('edit');
  });

  it('carries turnId/sessionId from approval and sets status pending', () => {
    const toolCall: AcpToolCallFields = { toolCallId: 't-1' };
    const approval: ApprovalRequestMessage = { ...resolvedEditApproval, turnId: 'turn-9', sessionId: 'sess-9' };
    const result = buildPermissionToolStart(toolCall, approval);
    expect(result.turnId).toBe('turn-9');
    expect(result.sessionId).toBe('sess-9');
    expect(result.status).toBe('pending');
  });

  it('produces exactly the expected ToolStartMessage shape, with rawInput absent', () => {
    const toolCall: AcpToolCallFields = { toolCallId: 'edit-approval-1', title: 'irrelevant', kind: 'read' };
    const result = buildPermissionToolStart(toolCall, resolvedEditApproval);
    expect(result).toEqual({
      type: 'tool.start',
      turnId: 'turn-1',
      sessionId: 'sess-1',
      toolId: 'edit-approval-1',
      kind: 'edit',
      title: 'Edit: src/a.ts, src/b.ts',
      status: 'pending',
    });
    expect('rawInput' in result).toBe(false);
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

// R2 WS-A T5a (BH-05 regression anchor): feed the LITERAL Hermes
// `edit_approval.py:264-283` request_permission payload shape through the
// full host mapping chain (parse -> resolve -> synthetic tool.start) and
// assert the card the human sees carries OUR resolved title end to end,
// never the agent-authored `toolCall.title`. This is the [SEC] anti-spoof
// proof for ADR-R2-02 / BH-05 and a Minor deferred from T3.
describe('BH-05 contract: Hermes edit_approval request_permission → resolved client output', () => {
  // `tool_call_id = f"edit-approval-{next(_PERMISSION_REQUEST_IDS)}"` and
  // `title = f"Approve edit: {proposal.path}"` (edit_approval.py:264-283) —
  // the literal agent-authored id/title this fix must never let through.
  const req: AcpRequestPermissionRequest = {
    sessionId: 'sess-1',
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ],
    toolCall: {
      toolCallId: 'edit-approval-1',
      title: 'Approve edit: src/auth/login.ts',
      kind: 'edit',
      content: [{ type: 'diff', path: 'src/auth/login.ts', oldText: 'a', newText: 'b' }],
      rawInput: { tool: 'write_file', arguments: { path: 'src/auth/login.ts' } },
    },
  };

  it('parse stage (mapPermissionRequest): routing id/kind/diffs are correct, but the title is STILL the agent\'s (resolution is a separate step)', () => {
    const mapped = mapPermissionRequest(req, 'turn-1', 'appr-1');

    expect(mapped.approval.id).toBe('appr-1');
    expect(mapped.approval.toolId).toBe('edit-approval-1');
    expect(mapped.approval.kind).toBe('edit');

    expect(mapped.diffs.length).toBeGreaterThanOrEqual(1);
    for (const diff of mapped.diffs) {
      expect(diff.toolId).toBe('edit-approval-1');
    }
    const totalHunks = mapped.diffs.reduce((sum, diff) => sum + diff.hunks.length, 0);
    expect(totalHunks).toBeGreaterThanOrEqual(1);

    // Documents the [SEC] boundary: at THIS stage the title is still
    // unvetted agent copy — `applyResolvedPresentation` is what re-labels it.
    expect(mapped.approval.title).toBe('Approve edit: src/auth/login.ts');
  });

  it('resolve stage (applyResolvedPresentation): the card title becomes OUR canonical resolved path, never the agent\'s "Approve edit: …" — the anti-spoof assertion', () => {
    const mapped = mapPermissionRequest(req, 'turn-1', 'appr-1');
    const editSignal = buildEditSignalFromResolved(
      [{ canonicalPath: '/workspace/src/auth/login.ts', relPath: 'src/auth/login.ts', insideWorkspace: true }],
      true,
    );

    const resolved = applyResolvedPresentation(mapped.approval, editSignal);

    expect(resolved.title).toBe('Edit: src/auth/login.ts');
    expect(resolved.title).not.toBe(req.toolCall.title);
    expect(resolved.kind).toBe('edit');
  });

  it('synthetic tool.start (buildPermissionToolStart): the card the human sees carries the RESOLVED title/kind, never the agent\'s title — the whole chain never lets "Approve edit: …" reach the card', () => {
    const mapped = mapPermissionRequest(req, 'turn-1', 'appr-1');
    const editSignal = buildEditSignalFromResolved(
      [{ canonicalPath: '/workspace/src/auth/login.ts', relPath: 'src/auth/login.ts', insideWorkspace: true }],
      true,
    );
    const resolved = applyResolvedPresentation(mapped.approval, editSignal);

    const start = buildPermissionToolStart(req.toolCall, resolved);

    expect(start.toolId).toBe('edit-approval-1');
    expect(start.kind).toBe('edit');
    expect(start.status).toBe('pending');
    expect(start.title).toBe(resolved.title);
    expect(start.title).toBe('Edit: src/auth/login.ts');
    expect(start.title).not.toBe(req.toolCall.title);
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
