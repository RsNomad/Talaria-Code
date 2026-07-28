import type { SubagentNode, SubagentsData, SubagentStatus } from '../../shared/protocol';
import { extractToolCallOutputText } from '../backend/acp/contentBlocks';
import { mapToolStatus } from '../backend/acp/toolKind';
import type { AcpSessionUpdate, AcpToolCallFields } from '../backend/acp/types';

/**
 * The Subagents / delegation panel is sourced from a STATEFUL FOLD over the
 * LIVE ACP `session/update` stream's `delegate_task` `tool_call`/
 * `tool_call_update` events — NOT `tui_gateway`'s `delegation.status`/
 * `spawn_tree.list`/`subagent.*` (those reflect the tui_gateway control-plane
 * child process, a DIFFERENT process from the actual chat agent — wave-1
 * architecture decision, `docs/specs/wave-1-golive.md` Zone SUB / "Contract
 * note"). Unlike every entry in `reshapePanelData.ts`, there is no single
 * "get me the tree" RPC to reshape — this module IS the accumulator that
 * `reshapePanelData.ts`'s `// Zone SUB` comment points at.
 *
 * ## How `delegate_task` surfaces on the wire (grounded in
 * `Main Agent(harness)/hermes-agent-2026.7.7.2/acp_adapter/`)
 *
 * Live tool-call events reach the ACP stream via `events.py`'s callback
 * factories, NOT `server.py` directly (that file's only `build_tool_start`/
 * `build_tool_complete` call sites are the `session/load` HISTORY REPLAY
 * path, `server.py:1085,1100`):
 *  - `make_tool_progress_cb`'s `_tool_progress` (`events.py:134-182`) fires on
 *    Hermes' internal `"tool.started"` event and calls
 *    `build_tool_start(tc_id, name, args, edit_diff=...)` (`:179`) → emitted
 *    as ACP `tool_call`.
 *  - `make_step_cb`'s `_step` (`events.py:223-259`) fires once a tool
 *    finishes and calls `build_tool_complete(tc_id, tool_name, result=...,
 *    function_args=...)` (`:244`) → emitted as ACP `tool_call_update`.
 *
 * For `tool_name == "delegate_task"` specifically (`tools.py`):
 *  - `TOOL_KIND_MAP["delegate_task"] = "execute"` (`:50`) — same `kind` as
 *    `terminal`/`process`/`execute_code`, so `kind` alone can't identify a
 *    delegation.
 *  - `delegate_task` is in `_POLISHED_TOOLS` (`:61`), and its dedicated
 *    `build_tool_start` branch (`:1180-1197`) never passes `raw_input=` to
 *    `acp.start_tool_call(...)` — so **`rawInput` is always absent/`None` on
 *    the wire for this tool**, unlike what a naive reading of the wave-1 spec
 *    ("rawInput `{tasks|goal}`") would suggest. The only structured signal
 *    left is `title`, built by `build_tool_title` (`:119-126`):
 *    `"delegate: <goal, truncated to 60 chars>"` for a single task,
 *    `"delegate batch (N tasks)"` for a batch, or the literal `"delegate
 *    task"` when the goal is empty. No other Hermes tool's title (scanning
 *    every branch of `build_tool_title`, `:91-180`) starts with the word
 *    "delegate" — so a `title.startsWith('delegate')` check is a safe,
 *    unique identifying signal, and the only one available.
 *  - The `content` block on the START event carries a human-readable preview
 *    (`:1183-1194`: the per-task/batch listing or the single goal, truncated)
 *    — a bonus (not required for identification), surfaced here as `detail`.
 *  - On completion, `build_tool_complete` (`:1249-1274`) sets
 *    `status: "failed"` iff `_tool_result_failed(result, "delegate_task")`
 *    (`:205-240`) else `"completed"`, and its `content` is
 *    `_format_delegate_result(result)` (`:563-606`) — a formatted prose
 *    summary of every task in the (possibly batched) delegation, including
 *    per-task status/model/duration/summary/error. This is the ONLY place a
 *    model name ever appears for a delegation, and it's free text inside one
 *    combined string, not a structured per-task field — see the "what we did
 *    NOT model" note on `SubagentNode` (`src/shared/protocol.ts`) for why
 *    this repo does not attempt to parse it into a tree.
 *
 * ## Granularity: one node per `delegate_task` tool call
 * A batch `delegate_task` call (multiple tasks in one invocation) is still
 * exactly one `toolCallId`, hence one `tool_call`/`tool_call_update` pair,
 * hence one `SubagentNode` here — Hermes gives the batch's per-task
 * breakdown only as prose inside `_format_delegate_result`'s output, never as
 * separate ACP tool-call events. Regex-scraping that prose into synthetic
 * per-task nodes would be exactly the kind of fabrication the wave-1 honesty
 * constraint rules out, so this accumulator deliberately does not do it.
 */

/**
 * Identify a `tool_call`/`tool_call_update`'s `title` as a `delegate_task`
 * call. See the module doc above for why this prefix check is the only
 * available (and a safe, unique) signal.
 */
function isDelegateTaskTitle(title: string): boolean {
  return title.startsWith('delegate');
}

/**
 * ACP `ToolCallStatus` (routed through the same {@link mapToolStatus} used
 * for ordinary tool cards) -> {@link SubagentStatus}. `pending`/`running`
 * intentionally map to `undefined` (no transition) here — a tracked
 * delegation is already `'running'` from its start event, so only a terminal
 * `done`/`failed` is a meaningful state change on an UPDATE.
 */
function toTerminalSubagentStatus(status: AcpToolCallFields['status']): SubagentStatus | undefined {
  const mapped = mapToolStatus(status);
  if (mapped === 'done') return 'complete';
  if (mapped === 'failed') return 'failed';
  return undefined;
}

/**
 * Stateful fold over the ACP `session/update` stream, building the current
 * `SubagentsData` snapshot for the panel. One instance lives on `AcpBackend`
 * for the life of the extension host; `reset()` is called on session
 * teardown/`session/load` (see `AcpBackend.teardownSession`/`loadSession`).
 * Framework-free (no `vscode`) so it is directly unit-testable.
 */
export class SubagentAccumulator {
  private readonly nodes = new Map<string, SubagentNode>();
  /** Insertion order of `toolCallId`s, so the snapshot lists delegations in the order they started. */
  private readonly order: string[] = [];

  /**
   * `true` while `AcpBackend.loadSession` is replaying a historical transcript
   * (see {@link setReplaying}). A `delegate_task` START observed during replay
   * is historical, and the ACP wire carries no original timestamp, so its
   * {@link SubagentNode.startedAt} is OMITTED rather than fabricated as `now()`
   * (which would falsely read as "started just now" for an old delegation).
   */
  private replaying = false;

  /**
   * Enter/leave replay mode. `AcpBackend` sets this `true` immediately before
   * awaiting `client.loadSession(...)` (Hermes streams the whole transcript
   * back as ordinary `session/update` notifications before that resolves) and
   * `false` once the load settles — so only replayed START events skip
   * `startedAt`; live ones keep it.
   */
  setReplaying(replaying: boolean): void {
    this.replaying = replaying;
  }

  /**
   * Flip every still-`running` delegation to `interrupted`, returning `true`
   * iff at least one node changed (so `AcpBackend` knows whether to push a
   * fresh `panel.data`). Called when a turn ends CANCELLED/errored (X4): Hermes
   * emits no `tool_call_update` completion for an in-flight `delegate_task`
   * when its turn is cancelled, so without this the delegation would remain
   * `running` forever — the spinner persisting across every later turn. Also
   * called at the end of a `session/load` replay to settle a historical
   * delegation whose completion was never recorded.
   */
  markRunningInterrupted(): boolean {
    let changed = false;
    for (const node of this.nodes.values()) {
      if (node.status === 'running') {
        node.status = 'interrupted';
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Fold one ACP `session/update` payload. Returns `true` iff it changed the
   * snapshot — `AcpBackend` uses this to decide whether to emit a fresh
   * `panel.data` push. Every non-`delegate_task` `tool_call`/
   * `tool_call_update`, and every other `session/update` variant, is a no-op.
   */
  apply(update: AcpSessionUpdate): boolean {
    if (update.sessionUpdate === 'tool_call') return this.applyStart(update);
    if (update.sessionUpdate === 'tool_call_update') return this.applyUpdate(update);
    return false;
  }

  private applyStart(update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>): boolean {
    if (!isDelegateTaskTitle(update.title)) return false;

    const node: SubagentNode = {
      id: update.toolCallId,
      goal: update.title,
      status: 'running',
      detail: extractToolCallOutputText(update.content) || undefined,
    };
    // startedAt is a host-observed LIVE timestamp — meaningless (and misleading
    // as `now()`) for a historical delegation replayed by `session/load`.
    if (!this.replaying) node.startedAt = new Date().toISOString();
    if (!this.nodes.has(update.toolCallId)) this.order.push(update.toolCallId);
    this.nodes.set(update.toolCallId, node);
    return true;
  }

  private applyUpdate(update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>): boolean {
    // An update for a toolCallId we never saw a delegate_task START for is
    // either a different tool's update or a delegation we couldn't identify
    // (title is optional/absent on tool_call_update) — nothing to fold it
    // into, so it's ignored rather than guessed at.
    const existing = this.nodes.get(update.toolCallId);
    if (!existing) return false;

    let changed = false;

    const nextStatus = toTerminalSubagentStatus(update.status);
    if (nextStatus && nextStatus !== existing.status) {
      existing.status = nextStatus;
      changed = true;
    }

    const detail = extractToolCallOutputText(update.content) || undefined;
    if (detail && detail !== existing.detail) {
      existing.detail = detail;
      changed = true;
    }

    return changed;
  }

  /** Drop every tracked delegation (new session / `session/load` / explicit reset). */
  reset(): void {
    this.nodes.clear();
    this.order.length = 0;
  }

  /** The current `SubagentsData` snapshot, in delegation start order. */
  snapshot(): SubagentsData {
    const delegations = this.order
      .map((id) => this.nodes.get(id))
      .filter((node): node is SubagentNode => node !== undefined);
    return { delegations };
  }
}
