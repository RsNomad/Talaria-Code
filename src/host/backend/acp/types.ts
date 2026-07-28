/**
 * Local, structural mirrors of the ACP wire shapes this backend consumes.
 *
 * These are deliberately NOT imported at runtime from the currently-installed
 * `@agentclientprotocol/sdk` package (0.17.1; audit C-1 replaced the prior,
 * now-uninstalled `@zed-industries/agent-client-protocol@0.4.5` — see the
 * `usage_update`/`session_info_update` union members below for that history).
 * Two reasons:
 *  1. Every pure mapping function under `acp/*` stays importable and unit
 *     testable without the SDK installed (spec: "keep the SDK/spawn behind a
 *     thin seam so the mappers are unit-testable").
 *  2. TypeScript structural typing means a real SDK value (e.g. the object
 *     handed to our `Client.sessionUpdate`) satisfies these types for free as
 *     long as the field names line up; every field name below is pinned
 *     against either the ACP TS SDK docs (Context7
 *     `/websites/zed-industries_github_io_agent-client-protocol`) or the real
 *     Hermes ACP adapter source (`acp_adapter/events.py`, `tools.py`,
 *     `permissions.py`, `edit_approval.py`, `server.py` — see each comment).
 *
 * "The field names line up" is no longer taken on faith for the two members
 * added by audit A-1 (`usage_update`, `session_info_update`): it is enforced
 * by `types.test-d.ts`, which type-only-imports the installed SDK's own
 * `UsageUpdate`/`SessionInfoUpdate` and pins each against its
 * `AcpSessionUpdate` member with `expectTypeOf`, running under vitest's
 * typecheck mode (`vitest.config.ts`'s `typecheck` block on the host
 * project) — these are COUNTED tests in the ordinary vitest pass total, not
 * a silent `tsc`-only check: deleting one moves the pinned gate numbers.
 * That file's own `import type` is erased at build time, so it does not
 * weaken reason 1 above — the mappers still need no SDK at runtime. Three
 * files need the SDK resolvable at typecheck time: acpClient.ts (runtime
 * import), acpWireNames.test.ts (runtime wire lock), and types.test-d.ts
 * (this file's type locks — see below); hiding the package produces TS2307
 * in exactly those three files. The rest of this file's members (everything
 * except those two) still rely on the manual citations described in point
 * 2, unchecked by any such lock.
 *
 * Wire convention confirmed throughout: camelCase JSON keys (`toolCallId`,
 * `sessionUpdate`, `rawInput`, ...) even though the Python-side Hermes
 * handlers use snake_case attribute names — the ACP Python SDK's pydantic
 * models alias snake_case -> camelCase on the wire (e.g. `mode_id` <-> `modeId`,
 * confirmed by `set_session_mode(self, mode_id, session_id)` in
 * `acp_adapter/server.py:2029`).
 */

/** ACP `ToolKind` (session/update `tool_call(_update)`.kind). Client docs: types/ToolKind. */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/** ACP `ToolCallStatus`. Defaults to `pending` when omitted (ACP docs). */
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A single ACP `ContentBlock` (session/update `content` field on chunks). */
export interface AcpContentBlock {
  type: string;
  /** Present when `type === 'text'`. */
  text?: string;
  [key: string]: unknown;
}

/** ACP `ToolCallContent` variant carrying a plain content block. */
export interface AcpToolTextContent {
  content: AcpContentBlock;
}

/**
 * ACP `ToolCallContent` diff variant (`acp.tool_diff_content` in
 * `acp_adapter/tools.py`/`edit_approval.py`). `oldText` is `null`/absent for a
 * brand-new file.
 */
export interface AcpDiffContent {
  type: 'diff';
  path: string;
  oldText?: string | null;
  newText: string;
}

/** ACP `ToolCallContent` terminal variant (not used by Hermes today — Hermes runs its own PTY). */
export interface AcpTerminalContent {
  type: 'terminal';
  terminalId: string;
}

export type AcpToolCallContent = AcpToolTextContent | AcpDiffContent | AcpTerminalContent;

/** ACP `ToolCallLocation` (`tools.py:extract_locations`). */
export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
}

/** ACP `PlanEntry` (`acp_adapter/events.py:_build_plan_update_from_todo_result`). */
export interface AcpPlanEntry {
  content: string;
  priority?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * One entry of an ACP `available_commands_update` (the agent-control slash
 * command catalog — W2 F-S, `docs/research/wave-2/00-architecture-and-paths.md`
 * §2e). The exact Hermes payload shape is UNPINNED until verified live
 * (Fedora probe P3), so every field below is read DEFENSIVELY by whichever
 * mapper parses this (T1) — an entry failing a shape guard is dropped rather
 * than throwing.
 */
export interface AcpAvailableCommand {
  name: string;
  description: string;
  input?: { hint?: string } | null;
}

/** Shared fields of `tool_call` / `tool_call_update`. */
export interface AcpToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolStatus | null;
  content?: AcpToolCallContent[] | null;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: Record<string, unknown> | null;
  /**
   * Audit A-2. Widened from `Record<string, unknown> | null` to `unknown`:
   * the SDK types this as `unknown` (`zToolCall`/`zToolCallUpdate`,
   * `dist/schema/zod.gen.js:1688` and `:1707`, both `z.unknown().optional()`)
   * because it can legitimately be any JSON value, not just an object — e.g.
   * a plain string result from an unpolished tool. Nothing in this codebase
   * READS `rawOutput` at runtime today: `grep -rn rawOutput src/
   * webview/ docs/` (the full glob, not just non-test files under this
   * directory — test files also mention the field, in assertions, not
   * reads) finds only this declaration, a comment in `acpClient.ts`, and
   * test-fixture assignments, so nothing downstream depended on the old
   * narrowing.
   */
  rawOutput?: unknown;
}

/**
 * The `update` payload of an ACP `session/update` notification
 * (`SessionNotification.update` per the TS SDK docs). `title` is required on
 * `tool_call` (a fresh call) and optional on `tool_call_update` (an upsert).
 */
export type AcpSessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | ({ sessionUpdate: 'tool_call'; title: string } & AcpToolCallFields)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallFields)
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AcpAvailableCommand[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  // Audit A-1 / fabrication G-7. These two were typed as open records
  // (`{ [key: string]: unknown }`) and `sessionUpdate.ts` documented them as
  // "received and ignored — bookkeeping only". Under
  // `@zed-industries/agent-client-protocol@0.4.5` (Task 5's predecessor
  // package; no longer installed, so this is a historical citation, not
  // re-checkable from this checkout) a prior audit's executed zod probe
  // found neither variant was ever accepted onto the wire at all — the
  // types described a notification that did not exist, so "received and
  // ignored" was false in both halves: nothing was ever received.
  //
  // Under `@agentclientprotocol/sdk@0.17.1` both are real, accepted union
  // members (verified directly against the installed package):
  // `zSessionInfoUpdate` (defined `dist/schema/zod.gen.js:1133`, referenced
  // as the `zSessionInfoUpdate.and(...)` arm of the `zSessionUpdate` union)
  // and `zUsageUpdate` (defined `:1905`, referenced as the
  // `zUsageUpdate.and(...)` arm of the same union) — named by schema
  // constant rather than pinned to the union-arm line number, which sits one
  // line below each `.and(...)` call and drifts easily. The 0.17.1 union
  // also gained a third new member this task does NOT type,
  // `config_option_update` (`zConfigOptionUpdate`, `:943`): the Hermes ACP
  // adapter never sends it (zero matches for `config_option_update` in the
  // Hermes source tree), so there is no wire to build for.
  //
  // Stability, checked per member rather than assumed: of the three union
  // members named above, `zUsageUpdate` alone carries `**UNSTABLE** …
  // @experimental` in its JSDoc ("not part of the spec yet, and may be
  // removed or changed at any point"). `zSessionInfoUpdate` and
  // `zConfigOptionUpdate` carry no such marking. `zCost` (`zod.gen.js:153`,
  // the schema behind the `cost` field inside the `usage_update` member
  // below) carries the identical `**UNSTABLE** … @experimental` marking —
  // it is exactly as fragile as its `zUsageUpdate` parent, not a
  // separately-stable field. So the `usage_update` shape below, `cost`
  // included, may change under us on an SDK bump in a way the other member
  // will not — worth knowing before anything is built on it. It is typed
  // here anyway because an accurate
  // experimental shape beats the open record it replaces, but the pin
  // belongs in whatever task first consumes it.
  | {
      sessionUpdate: 'usage_update';
      /** Tokens currently in context. */
      used: number;
      /** Total context window size in tokens. */
      size: number;
      /** Cumulative session cost, when the agent reports one. */
      cost?: { amount: number; currency: string } | null;
      /**
       * ACP extensibility bag (`zUsageUpdate`, `zod.gen.js:1906`;
       * `UsageUpdate._meta`, `types.gen.d.ts:3656`). Hermes does not populate
       * this on `usage_update` today (`_build_usage_update`,
       * `acp_adapter/server.py`, constructs `UsageUpdate` with no
       * `field_meta`), but the SDK declares the field on this member and
       * `session_info_update` below proves the same bag carries real data
       * elsewhere, so it is modelled here too rather than left unreachable.
       */
      _meta?: Record<string, unknown> | null;
    }
  | {
      sessionUpdate: 'session_info_update';
      /** Human-readable session title; `null` clears it. */
      title?: string | null;
      /** ISO 8601 timestamp of last activity; `null` clears it. */
      updatedAt?: string | null;
      /**
       * ACP extensibility bag (`zSessionInfoUpdate`, `zod.gen.js:1134`;
       * `SessionInfoUpdate._meta`, `types.gen.d.ts:2888`). Hermes populates
       * this as `_meta.hermes.sessionProvenance` — previous/current internal
       * Hermes session id and lineage root across a compression-driven
       * session rotation (`acp_adapter/server.py:_send_session_info_update`,
       * `field_meta=meta`; `acp_adapter/provenance.py`). Tracked open item R9
       * (`docs/reviews/l2-hermes-contract-map.md`) needs exactly this field;
       * it was unreachable under the old open-record placeholder's implicit
       * shape and is now typed so a future consumer does not have to
       * reverse-engineer it from the wire.
       */
      _meta?: Record<string, unknown> | null;
    };

/** ACP `PermissionOption` (client docs interfaces/PermissionOption). */
export interface AcpPermissionOption {
  optionId: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  name: string;
}

/** ACP `RequestPermissionRequest` (client docs interfaces/RequestPermissionRequest). */
export interface AcpRequestPermissionRequest {
  sessionId: string;
  options: AcpPermissionOption[];
  toolCall: AcpToolCallFields & { title?: string | null };
}

/** ACP `RequestPermissionResponse` outcome (client docs interfaces/RequestPermissionResponse). */
export type AcpRequestPermissionResponse =
  | { outcome: { outcome: 'cancelled' } }
  | { outcome: { outcome: 'selected'; optionId: string } };

/** ACP `PromptResponse.stopReason` (client docs interfaces/PromptResponse). */
export type AcpStopReason = 'cancelled' | 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal';

/**
 * ACP `Usage` as sent by Hermes' Python SDK (`acp_adapter/server.py:1667`:
 * `Usage(input_tokens=..., output_tokens=..., total_tokens=..., thought_tokens=...,
 * cached_read_tokens=...)`), aliased to camelCase on the wire. NOTE: the
 * published TS `PromptResponse` interface (Context7) does not list a `usage`
 * field at all — this is a version-skew risk between the pinned Python SDK
 * (`agent-client-protocol==0.9.0`) and whatever TS SDK version gets installed.
 * Read defensively (see `usage.ts`).
 */
export interface AcpUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/**
 * ACP `EmbeddedResourceResource` (client docs `types/EmbeddedResourceResource`,
 * confirmed via `@zed-industries/agent-client-protocol`'s schema types before
 * Audit C-1 (`src/host/backend/acp/acpClient.ts`) replaced that package with
 * `@agentclientprotocol/sdk`; it is no longer installed, so this is a
 * historical citation, not one re-checkable from this checkout): a
 * discriminated union on which field is present — `text` XOR `blob`, never
 * both optional-and-absent — following the MCP embedded-resource convention
 * this block is built on.
 */
export type AcpEmbeddedResourceResource =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

/** A single ACP content block to send outbound in a `session/prompt` request. */
export type AcpOutboundContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string | null }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      mimeType?: string | null;
      description?: string | null;
    }
  | {
      type: 'resource';
      resource: AcpEmbeddedResourceResource;
    };
