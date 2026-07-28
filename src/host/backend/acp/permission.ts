import type { ApprovalOption, HostToWebviewMessage } from '../../../shared/protocol';
import type { PolicySignal } from '../policy/editPolicy';
import { extractDiffs, extractToolCallOutputText } from './contentBlocks';
import type { AcpPermissionOption, AcpRequestPermissionRequest, AcpRequestPermissionResponse } from './types';

/**
 * Hermes' `optionId` values are, by construction, already the exact strings
 * our protocol's {@link ApprovalOption.kind} union expects
 * (`acp_adapter/permissions.py:41-70`: `allow_once` / `allow_session` /
 * `allow_always` / `deny` / `deny_always`; `edit_approval.py:308-311` reuses
 * `allow_once` / `deny`). Prefer the `optionId` as the kind directly; only
 * fall back to translating ACP's generic `kind` enum
 * (`allow_once|allow_always|reject_once|reject_always`) for option ids this
 * build of Hermes hasn't defined (forward-compat / other ACP agents).
 */
const KNOWN_OPTION_KINDS: ReadonlySet<ApprovalOption['kind']> = new Set([
  'allow_once',
  'allow_session',
  'allow_always',
  'deny',
  'deny_always',
]);

export function mapApprovalOption(option: AcpPermissionOption): ApprovalOption {
  const kind = KNOWN_OPTION_KINDS.has(option.optionId as ApprovalOption['kind'])
    ? (option.optionId as ApprovalOption['kind'])
    : mapGenericPermissionKind(option.kind);
  return { id: option.optionId, label: option.name, kind };
}

function mapGenericPermissionKind(kind: AcpPermissionOption['kind']): ApprovalOption['kind'] {
  switch (kind) {
    case 'allow_once':
      return 'allow_once';
    case 'allow_always':
      return 'allow_always';
    case 'reject_always':
      return 'deny_always';
    case 'reject_once':
    default:
      return 'deny';
  }
}

/**
 * ACP command-approval defaults to a 60s auto-deny timeout
 * (`permissions.py:112,153`); edit-approval matches (`edit_approval.py`
 * default `timeout: float = 60.0`). Exported (T-A0 / M2-b): the harness does
 * NOT put this deadline on the wire, so `SessionController` mirrors this
 * SAME constant as the fallback for arming its own host-side expiry timer
 * (`mapped.approval.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS`) — one number,
 * not two independently-maintained copies.
 *
 * WCAG 2.2.1 (Timing Adjustable) (T-20 hygiene sweep): this timeout is
 * HARNESS-FIXED and security-essential — the fail-closed consent boundary
 * for a permission prompt (no response = deny), not a UI preference, so it
 * is deliberately not user-adjustable. It is surfaced to the user via the
 * webview's `ApprovalCard` static deadline line (see that component's own
 * WCAG 2.2.1 note). Full SC 2.2.1 conformance would require the harness
 * itself to expose an adjustable/extendable deadline over the wire; that is
 * an owner/harness item, documented not silently ignored.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

/** Narrow aliases so callers (AcpBackend) can read `.options`/`.hunks` without re-casting the broader union. */
export type ApprovalRequestMessage = Extract<HostToWebviewMessage, { type: 'approval.request' }>;
export type ToolDiffMessage = Extract<HostToWebviewMessage, { type: 'tool.diff' }>;

/**
 * W2-F1: the typed slice of `toolCall.rawInput` the client policy engine keys on
 * — `{tool, arguments}` for edits (`edit_approval.py:264-283`), `{command,
 * description}` for commands (`permissions.py:73-92`). Surfaced here because it
 * was previously DISCARDED (existing-map §3, gap 2).
 */
export interface PermissionRawInput {
  tool?: string;
  arguments?: Record<string, unknown>;
  command?: string;
  description?: string;
}

export interface MappedPermissionRequest {
  approval: ApprovalRequestMessage;
  diffs: ToolDiffMessage[];
  /** Pass-through of `req.toolCall.rawInput` (undefined when absent). */
  rawInput: PermissionRawInput | undefined;
}

/**
 * ACP `session/request_permission` -> `approval.request` (+ `tool.diff` for
 * every diff block the tool call carries, which covers Hermes' edit-approval
 * path — `edit_approval.py` attaches a single `tool_diff_content` to the
 * permission's `toolCall`).
 *
 * SECURITY (Bucket 1 F2): the `approval.kind`/`approval.title` built here are
 * PROVISIONAL — copied from the agent-supplied `toolCall` and therefore
 * untrusted. The emitting caller ({@link ../AcpBackend.handleRequestPermission})
 * MUST override them via {@link applyResolvedPresentation} with the effect the
 * policy layer actually resolved before showing the card to a human.
 */
export function mapPermissionRequest(
  req: AcpRequestPermissionRequest,
  turnId: string,
  approvalId: string,
): MappedPermissionRequest {
  const toolCall = req.toolCall;
  const kind: 'command' | 'edit' = toolCall.kind === 'edit' ? 'edit' : 'command';
  const detail = extractToolCallOutputText(toolCall.content) || undefined;
  // W4 §2d: the request already names its own ACP session — that IS the
  // routing key to stamp, no separate parameter needed (and it's the exact
  // value `AcpBackend.handleRequestPermission` already validated against
  // `this.sessionId` before calling in).
  const sessionId = req.sessionId;

  const approval: ApprovalRequestMessage = {
    type: 'approval.request',
    turnId,
    sessionId,
    id: approvalId,
    kind,
    title: toolCall.title ?? 'Approval required',
    detail,
    toolId: toolCall.toolCallId,
    options: req.options.map(mapApprovalOption),
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
  };

  const diffs: ToolDiffMessage[] = extractDiffs(toolCall.content).map((diff) => ({
    type: 'tool.diff',
    turnId,
    sessionId,
    toolId: toolCall.toolCallId,
    path: diff.path,
    hunks: diff.hunks,
  }));

  return { approval, diffs, rawInput: toPermissionRawInput(toolCall.rawInput) };
}

/**
 * Surface `toolCall.rawInput` (a broad `Record<string, unknown>` on the wire) as
 * the typed {@link PermissionRawInput} slice — value-preserving (verbatim), only
 * the documented fields, `undefined` when absent/non-object (fail-safe).
 */
function toPermissionRawInput(raw: Record<string, unknown> | null | undefined): PermissionRawInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result: PermissionRawInput = {};
  const { tool, arguments: args, command, description } = raw;
  if (typeof tool === 'string') result.tool = tool;
  if (args !== null && typeof args === 'object') result.arguments = args as Record<string, unknown>;
  if (typeof command === 'string') result.command = command;
  if (typeof description === 'string') result.description = description;
  return result;
}

/**
 * Bucket 1 F2 (CWE-807 / LLM06 complete mediation): re-label an approval card
 * from OUR resolved effect state. The `kind` comes from the effect the policy
 * layer actually evaluated (never the agent's `toolCall.kind`) and the `title`
 * from our canonical resolved paths / the raw command text (never the agent's
 * `toolCall.title`) — so the human approves the VERIFIED effect, not
 * attacker-authored copy. The agent-supplied `detail`/diff content is kept as
 * clearly-agent-supplied preview only.
 */
export function applyResolvedPresentation(
  approval: ApprovalRequestMessage,
  effect: PolicySignal,
): ApprovalRequestMessage {
  const title =
    effect.kind === 'edit'
      ? `Edit: ${effect.paths.join(', ') || '(unresolved path)'}`
      : `Run: ${effect.command || '(unresolved command)'}`;
  return { ...approval, kind: effect.kind, title };
}

/**
 * Bucket 1 F5 (C7, CWE-636): the fail-closed fallback card for a request whose
 * PARSE threw (`mapPermissionRequest` chews hostile agent diff content via
 * `extractDiffs`). Built from `req` fields only — a fixed title, the options
 * passed through, no diff parsing — so it cannot itself throw on the input
 * that just failed. If even the options are unmappable they are dropped: an
 * option-less card cannot be answered, and Hermes's 60 s auto-deny (gate G5)
 * closes it out.
 */
export function buildMinimalAskApproval(
  req: AcpRequestPermissionRequest,
  turnId: string,
  approvalId: string,
): ApprovalRequestMessage {
  let options: ApprovalOption[] = [];
  try {
    options = req.options.map(mapApprovalOption);
  } catch {
    options = [];
  }
  return {
    type: 'approval.request',
    turnId,
    sessionId: req.sessionId,
    id: approvalId,
    // Conservative labeling: the effect could NOT be verified, so never present
    // it as a benign "edit" and never echo agent-authored text in the title.
    kind: 'command',
    title: 'Approval required (request could not be parsed)',
    toolId: req.toolCall?.toolCallId,
    options,
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
  };
}

/** Build the ACP `RequestPermissionResponse` for a user-selected option id. */
export function buildSelectedOutcome(optionId: string): AcpRequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}

/** Build the ACP `RequestPermissionResponse` for a cancelled/abandoned prompt (spec: "must respond with Cancelled if the client cancels via session/cancel"). */
export function buildCancelledOutcome(): AcpRequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}
