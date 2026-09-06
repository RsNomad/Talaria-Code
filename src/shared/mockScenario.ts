/**
 * Talaria Code — canned mock data replayed by the MockBackend.
 *
 * `mockTurn` is an ordered, delay-timed script of {@link HostToWebview} messages
 * modelling ONE realistic coding turn: the user asks to refactor `login()`, the
 * agent reasons, reads the file, proposes a 2-hunk patch and — under the default
 * `manual` preset — asks permission to APPLY it (the BH-05 two-card shape: the
 * real `tc-…` patch card plus the synthetic `edit-approval-1` diff card, gate #1),
 * asks permission to run `npm test` (gate #2), updates a plan, and summarizes.
 * The MockBackend echoes `approval.settle` for each gate itself, as the real
 * host does. `panelData` gives realistic snapshots for all 8 control panels.
 *
 * Everything here uses Hermes-accurate names: models `claude-sonnet-5` /
 * provider `anthropic`; tools `read_file` / `patch` / `terminal` / `web_search`;
 * MCP servers `github` / `postgres`. No `gpt-4o`.
 *
 * Nothing in this module spawns a process — it is pure data. The MockBackend
 * walks `mockTurn`, waiting `delayMs` before emitting each `msg`, and answers
 * panel switches from `panelData`.
 */

import type {
  HostToWebview,
  PanelDataMap,
  ThemeInfo,
} from './protocol';

/**
 * One replay step: wait `delayMs`, then emit `message`. If `gate` is set the
 * player PARKS after emitting until the matching user response arrives
 * (`respondApproval` for `'approval'`, `resolveDiff` for `'diff'`).
 */
export interface MockStep {
  delayMs: number;
  message: HostToWebview;
  gate?: 'approval' | 'diff';
}

/** The full canned scenario the MockBackend replays. */
export interface MockScenario {
  timeline: MockStep[];
  panels: PanelDataMap;
}

/** Stable ids reused across the scripted turn. */
const TURN_ID = 'turn-1';
const SESSION_ID = 'sess-8a4c';
const REASON_BLOCK = 'think-1';
const TOOL_READ = 'tool-read-1';
/** The REAL `patch` tool call — Hermes mints `tc-<12 hex>` ids (acp_adapter/tools.py make_tool_call_id). */
const TOOL_PATCH = 'tc-8a4c2f1e9b3d';
/** The edit permission's OWN ToolCallUpdate id (acp_adapter/edit_approval.py build_acp_edit_tool_call) — the BH-05 synthetic diff card is keyed to it. */
const EDIT_APPROVAL_TOOL = 'edit-approval-1';
/** Approval id of the edit gate — the FIRST gate the MockBackend parks on. Host-minted in production, opaque. */
const EDIT_APPROVAL_ID = 'appr-1';
const TOOL_TEST = 'tool-test-1';
/** Approval id of the `npm test` command gate — the SECOND gate. */
const CMD_APPROVAL_ID = 'appr-2';

/** Default theme the MockBackend seeds hydrate with. */
export const mockTheme: ThemeInfo = {
  kind: 'dark',
  accent: '#14b8a6',
};

/**
 * The scripted coding turn. Delays are cumulative-per-step (the MockBackend
 * sleeps `delayMs` before each emit), tuned to feel like real streaming.
 */
export const mockTurn: MockStep[] = [
  // --- user kicks off the turn ---
  {
    delayMs: 0,
    message: { type: 'turn.start', turnId: TURN_ID, sessionId: SESSION_ID },
  },
  {
    delayMs: 0,
    message: {
      type: 'user',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      text: 'Refactor the login() function in src/auth/login.ts to use async/await and surface a typed error instead of returning null.',
      mode: 'default',
    },
  },

  // --- reasoning block streams in ---
  {
    delayMs: 400,
    message: { type: 'reasoning.start', turnId: TURN_ID, sessionId: SESSION_ID, blockId: REASON_BLOCK },
  },
  {
    delayMs: 250,
    message: {
      type: 'reasoning.delta',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      blockId: REASON_BLOCK,
      text: 'Let me read the current login() to see the callback shape and where null is returned. ',
    },
  },
  {
    delayMs: 300,
    message: {
      type: 'reasoning.delta',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      blockId: REASON_BLOCK,
      text: "I'll convert the promise chain to async/await and introduce a LoginError type, then run the test suite to confirm nothing regressed.",
    },
  },
  {
    delayMs: 200,
    message: { type: 'reasoning.end', turnId: TURN_ID, sessionId: SESSION_ID, blockId: REASON_BLOCK },
  },

  // --- read_file tool ---
  {
    delayMs: 300,
    message: {
      type: 'tool.start',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: TOOL_READ,
      kind: 'read',
      title: 'Read src/auth/login.ts',
      status: 'running',
      rawInput: 'src/auth/login.ts',
    },
  },
  {
    delayMs: 500,
    message: {
      type: 'tool.update',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: TOOL_READ,
      status: 'done',
      output: '42 lines read (login.ts)',
    },
  },

  // --- assistant explains the plan in prose ---
  {
    delayMs: 350,
    message: {
      type: 'message.delta',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      text: "Found it. `login()` chains `.then()` and returns `null` on failure. ",
    },
  },
  {
    delayMs: 300,
    message: {
      type: 'message.delta',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      text: "I'll rewrite it with async/await and a `LoginError`. Here's the patch:",
    },
  },

  // --- patch tool under the MANUAL preset (BH-05): the REAL tool card starts first ---
  // Hermes announces the real `patch` ToolCallStart (id tc-…, kind edit,
  // title `patch (replace): <path>`, no diff — its text block literally says
  // "Approval prompt shows the diff") BEFORE it asks for permission:
  // agent/tool_executor.py fires tool.started for every call before any
  // executes; acp_adapter/events.py _tool_progress sends the start; then
  // model_tools.py maybe_require_edit_approval blocks on the client.
  {
    delayMs: 300,
    message: {
      type: 'tool.start',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: TOOL_PATCH,
      kind: 'edit',
      title: 'patch (replace): src/auth/login.ts',
      status: 'pending',
    },
  },

  // --- the edit permission rides a SEPARATE ToolCallUpdate: edit-approval-1 ---
  // Our host turns session/request_permission into tool.start → tool.diff →
  // approval.request, all keyed to the permission's own toolCallId
  // (SessionController.emitApprovalCard). Under the manual preset the diff
  // exists ONLY here — never on the tc-… card. Title/kind come from the
  // host's RESOLVED presentation ("Edit: <path>"), not Hermes' own title.
  {
    delayMs: 250,
    message: {
      type: 'tool.start',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: EDIT_APPROVAL_TOOL,
      kind: 'edit',
      title: 'Edit: src/auth/login.ts',
      status: 'pending',
    },
  },
  {
    delayMs: 150,
    message: {
      type: 'tool.diff',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: EDIT_APPROVAL_TOOL,
      path: 'src/auth/login.ts',
      hunks: [
        {
          header: '@@ -1,6 +1,10 @@',
          lines: [
            { sign: ' ', text: "import { api } from '../client';" },
            { sign: '+', text: '' },
            { sign: '+', text: 'export class LoginError extends Error {' },
            { sign: '+', text: '  constructor(public readonly code: string) {' },
            { sign: '+', text: '    super(`login failed: ${code}`);' },
            { sign: '+', text: '  }' },
            { sign: '+', text: '}' },
            { sign: ' ', text: '' },
            { sign: '-', text: 'export function login(user, pass) {' },
            { sign: '+', text: 'export async function login(user: string, pass: string): Promise<Session> {' },
          ],
        },
        {
          header: '@@ -8,10 +12,9 @@',
          lines: [
            { sign: '-', text: '  return api.post("/login", { user, pass })' },
            { sign: '-', text: '    .then((r) => r.session)' },
            { sign: '-', text: '    .catch(() => null);' },
            { sign: '+', text: '  const r = await api.post("/login", { user, pass });' },
            { sign: '+', text: '  if (!r.ok) {' },
            { sign: '+', text: '    throw new LoginError(r.errorCode ?? "unknown");' },
            { sign: '+', text: '  }' },
            { sign: '+', text: '  return r.session;' },
            { sign: ' ', text: '}' },
          ],
        },
      ],
    },
  },
  {
    delayMs: 150,
    message: {
      type: 'approval.request',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      id: EDIT_APPROVAL_ID,
      kind: 'edit',
      title: 'Edit: src/auth/login.ts',
      toolId: EDIT_APPROVAL_TOOL,
      timeoutMs: 60000,
      // Hermes' own option set for an edit (edit_approval.py): allow_once /
      // deny — the host keeps the option ids verbatim as the kinds.
      options: [
        { id: 'allow_once', label: 'Allow edit', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    },
    // Park here until the user answers (approval.respond, or per-hunk
    // diff.resolve). The MockBackend echoes approval.settle itself — in
    // production the HOST emits it from respondApproval, Hermes never does.
    gate: 'approval',
  },

  // --- (resumes after the edit is allowed) the REAL tool completes ---
  // Hermes' step callback sends ToolCallUpdate{completed} for the tc-… id
  // with the _format_edit_result text (files_modified are absolute paths).
  // The edit-approval-1 card never receives a tool.update — its pill is the
  // settle-derived Approved/Denied (ADR-R2-15).
  {
    delayMs: 500,
    message: {
      type: 'tool.update',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: TOOL_PATCH,
      status: 'done',
      output: '✅ patch completed for `src/auth/login.ts`\nFiles: `/home/dev/talaria-code/src/auth/login.ts`',
    },
  },

  // --- plan appears ---
  {
    delayMs: 300,
    message: {
      type: 'plan.update',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      items: [
        { text: 'Read current login() implementation', status: 'done' },
        { text: 'Rewrite with async/await + LoginError', status: 'done' },
        { text: 'Run the test suite (npm test)', status: 'active' },
        { text: 'Report results', status: 'pending' },
      ],
    },
  },

  // --- approval to run npm test ---
  {
    delayMs: 300,
    message: {
      type: 'tool.start',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: TOOL_TEST,
      kind: 'execute',
      title: 'Run npm test',
      status: 'pending',
      rawInput: 'npm test',
    },
  },
  {
    delayMs: 200,
    message: {
      type: 'approval.request',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      id: CMD_APPROVAL_ID,
      kind: 'command',
      title: 'Run `npm test`?',
      detail: 'Talaria wants to execute the terminal command `npm test` in the workspace root.',
      toolId: TOOL_TEST,
      timeoutMs: 60000,
      options: [
        { id: 'opt-once', label: 'Allow once', kind: 'allow_once' },
        { id: 'opt-session', label: 'Allow for session', kind: 'allow_session' },
        { id: 'opt-always', label: 'Always allow', kind: 'allow_always' },
        { id: 'opt-deny', label: 'Deny', kind: 'deny' },
      ],
    },
    // Park here until the user answers the approval (respondApproval advances).
    gate: 'approval',
  },

  // --- (MockBackend resumes here after the user approves) test runs ---
  {
    delayMs: 600,
    message: {
      type: 'tool.update',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: TOOL_TEST,
      status: 'running',
      output: '> jest\n',
    },
  },
  {
    delayMs: 900,
    message: {
      type: 'tool.update',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      toolId: TOOL_TEST,
      status: 'done',
      output: 'PASS  src/auth/login.test.ts\nTests: 12 passed, 12 total',
    },
  },
  {
    delayMs: 250,
    message: {
      type: 'plan.update',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      items: [
        { text: 'Read current login() implementation', status: 'done' },
        { text: 'Rewrite with async/await + LoginError', status: 'done' },
        { text: 'Run the test suite (npm test)', status: 'done' },
        { text: 'Report results', status: 'active' },
      ],
    },
  },

  // --- final answer + summary ---
  {
    delayMs: 300,
    message: {
      type: 'message.delta',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      text: '\n\nDone. `login()` is now async and throws a typed `LoginError` instead of returning null. All 12 tests pass.',
    },
  },
  {
    delayMs: 200,
    message: {
      type: 'message.end',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      text: "Refactored `login()` to async/await with a typed `LoginError`, and ran the suite — 12/12 tests pass.\n\nDone. `login()` is now async and throws a typed `LoginError` instead of returning null. All 12 tests pass.",
    },
  },
  {
    delayMs: 150,
    message: {
      type: 'result.summary',
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      status: 'complete',
      text: 'Refactored login() to async/await with typed LoginError. 1 file changed, 12/12 tests passing.',
      usage: {
        inputTokens: 4820,
        outputTokens: 512,
        totalTokens: 5332,
        costUsd: 0.032,
        durationMs: 7300,
      },
    },
  },
  {
    delayMs: 100,
    message: { type: 'turn.end', turnId: TURN_ID, sessionId: SESSION_ID, status: 'complete' },
  },
];

/**
 * The approval id of the FIRST gate the MockBackend parks on (the BH-05 edit
 * approval). The player reads each gate's id off the parked step itself, so
 * the second gate — `CMD_APPROVAL_ID`, the `npm test` command approval —
 * resumes on its own id.
 */
export const mockApprovalId = EDIT_APPROVAL_ID;

/**
 * Realistic snapshots for every control panel, keyed by panel. The MockBackend
 * replies to a `switchPanel` (or `control.invoke`) by emitting the matching
 * `panel.data` message built from this map.
 */
export const panelData: PanelDataMap = {
  tools: {
    toolsets: [
      { name: 'hermes-acp', enabled: true, toolCount: 6 },
      { name: 'terminal', enabled: true, toolCount: 2 },
      { name: 'web', enabled: true, toolCount: 2 },
      { name: 'vision', enabled: false, toolCount: 2 },
      { name: 'github', enabled: true, toolCount: 1 },
    ],
    tools: [
      { name: 'read_file', description: 'Read a file from the workspace.', enabled: true, kind: 'read', toolset: 'hermes-acp', source: 'core' },
      { name: 'write_file', description: 'Create or overwrite a file.', enabled: true, kind: 'edit', toolset: 'hermes-acp', source: 'core' },
      { name: 'patch', description: 'Apply a unified diff to a file.', enabled: true, kind: 'edit', toolset: 'hermes-acp', source: 'core' },
      { name: 'terminal', description: 'Run a shell command in a PTY.', enabled: true, kind: 'execute', toolset: 'terminal', source: 'core' },
      { name: 'web_search', description: 'Search the web for a query.', enabled: true, kind: 'search', toolset: 'web', source: 'core' },
      { name: 'browser_open', description: 'Open a URL in a headless browser.', enabled: true, kind: 'fetch', toolset: 'web', source: 'core' },
      { name: 'todo', description: 'Maintain the plan / todo list.', enabled: true, kind: 'think', toolset: 'hermes-acp', source: 'core' },
      { name: 'delegate_task', description: 'Spawn a subagent for a subtask.', enabled: true, kind: 'other', toolset: 'hermes-acp', source: 'core' },
      { name: 'vision_analyze', description: 'Describe or OCR an image.', enabled: false, kind: 'other', toolset: 'vision', source: 'core' },
      { name: 'github.create_issue', description: 'Open a GitHub issue via MCP.', enabled: true, kind: 'other', toolset: 'github', source: 'mcp' },
    ],
  },

  mcp: {
    servers: [
      {
        id: 'mcp-github',
        name: 'github',
        status: 'connected',
        command: 'npx -y @modelcontextprotocol/server-github',
        toolCount: 14,
        enabled: true,
        transport: 'stdio',
      },
      {
        id: 'mcp-postgres',
        name: 'postgres',
        status: 'connected',
        command: 'npx -y @modelcontextprotocol/server-postgres postgres://localhost/app',
        toolCount: 6,
        enabled: true,
        transport: 'stdio',
      },
      {
        id: 'mcp-filesystem',
        name: 'filesystem',
        status: 'disconnected',
        command: 'npx -y @modelcontextprotocol/server-filesystem /srv/data',
        toolCount: 0,
        enabled: true,
        transport: 'stdio',
      },
    ],
  },

  skills: {
    categories: ['coding', 'research', 'official/web', 'writing'],
    skills: [
      { id: 'systematic-debugging', name: 'systematic-debugging', category: 'coding', description: 'Structured root-cause debugging workflow.', enabled: true, provenance: 'bundled', usage: 12 },
      { id: 'test-driven-development', name: 'test-driven-development', category: 'coding', description: 'Write a failing test before the implementation.', enabled: true, provenance: 'bundled', usage: 34 },
      { id: 'code-review', name: 'code-review', category: 'coding', description: 'Review a diff for bugs and cleanups.', enabled: true, provenance: 'hub', usage: 8 },
      { id: 'deep-research', name: 'deep-research', category: 'research', description: 'Fan-out web research with adversarial verification.', enabled: false, provenance: 'hub', usage: 3 },
      { id: 'web-fetch', name: 'web-fetch', category: 'official/web', description: 'Fetch and clean a web page to markdown.', enabled: true, provenance: 'bundled', usage: 0 },
      { id: 'changelog-writer', name: 'changelog-writer', category: 'writing', description: 'Draft release notes from a git range.', enabled: false, provenance: 'agent', usage: 1 },
    ],
  },

  checkpoints: {
    checkpoints: [
      { id: 'ckpt-3', label: 'Before patch to login.ts', age: 'just now', timestamp: '2026-07-11T14:32:10Z', filesChanged: 1, turnOrdinal: 1 },
      { id: 'ckpt-2', label: 'After scaffolding auth module', age: '18m ago', timestamp: '2026-07-11T14:14:02Z', filesChanged: 5, turnOrdinal: 0 },
      { id: 'ckpt-1', label: 'Session start (clean tree)', age: '42m ago', timestamp: '2026-07-11T13:50:44Z', filesChanged: 0 },
    ],
  },

  subagents: {
    delegations: [
      {
        id: 'tc-delegate-1',
        goal: 'delegate: apply the async/await patch to login.ts',
        status: 'complete',
        startedAt: '2026-07-11T14:20:00Z',
        detail: 'Delegation results: 1 task in 8.4s\n\n✅ Task 1: completed (claude-sonnet-5, 8.4s)\nPatched login.ts to use async/await.',
      },
      {
        id: 'tc-delegate-2',
        goal: 'delegate: review the patch and test output for regressions',
        status: 'running',
        startedAt: '2026-07-11T14:20:12Z',
        detail: 'Delegating task:\nreview the patch and test output for regressions',
      },
    ],
  },

  sessions: {
    sessions: [
      { id: 'sess-hist-3', cwd: '/home/dev/talaria-code', title: 'Refactor login() to async/await', updatedAt: '2026-07-11T14:32:10Z' },
      { id: 'sess-hist-2', cwd: '/home/dev/talaria-code', title: 'Wire up the RAG search MCP server', updatedAt: '2026-07-10T09:12:00Z' },
      // Mirrors webview/src/mock/fixtures.ts (T-19 drift lock, task-18
      // exactOptional prep): `SessionSummary.title` is `?: string` — this
      // fixture deliberately exercises the no-title fallback, so the key is
      // simply absent rather than present-with-`undefined`.
      { id: 'sess-hist-1', cwd: '/home/dev/other-repo', updatedAt: '2026-07-09T22:05:44Z' },
    ],
  },

  models: {
    currentModelId: 'claude-sonnet-5',
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        connected: true,
        models: [
          { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 200000 },
          { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 200000 },
          { id: 'claude-haiku-5', label: 'Claude Haiku 5', contextWindow: 200000 },
        ],
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        connected: true,
        models: [
          { id: 'deepseek-v3', label: 'DeepSeek V3', contextWindow: 128000 },
          { id: 'qwen3-coder', label: 'Qwen3 Coder', contextWindow: 256000 },
        ],
      },
      {
        id: 'ollama',
        name: 'Ollama (local)',
        connected: false,
        models: [
          { id: 'llama3.3', label: 'Llama 3.3 70B', contextWindow: 131072 },
        ],
      },
    ],
  },

  settings: {
    sections: [
      {
        name: 'model',
        fields: [
          { key: 'model.default', value: 'claude-sonnet-5', type: 'string', description: 'Default model for new sessions.' },
          { key: 'model.temperature', value: 0.2, type: 'number', description: 'Sampling temperature.' },
        ],
      },
      {
        name: 'agent',
        fields: [
          { key: 'agent.approval_policy', value: 'default', type: 'enum', options: ['default', 'accept_edits', 'dont_ask'], description: 'When to ask before edits / commands.' },
          { key: 'agent.max_turns', value: 50, type: 'number', description: 'Max iterations per turn.' },
        ],
      },
      {
        name: 'delegation',
        fields: [
          { key: 'delegation.max_concurrent_children', value: 3, type: 'number', description: 'Parallel subagents allowed.' },
          { key: 'delegation.max_spawn_depth', value: 4, type: 'number', description: 'Deepest subagent nesting.' },
          { key: 'delegation.subagent_auto_approve', value: true, type: 'boolean', description: 'Auto-approve subagent tool calls.' },
        ],
      },
      {
        name: 'checkpoints',
        fields: [
          { key: 'checkpoints.enabled', value: true, type: 'boolean', description: 'Snapshot the working tree each turn.' },
          { key: 'checkpoints.max_kept', value: 20, type: 'number', description: 'Checkpoints retained per session.' },
        ],
      },
      {
        name: 'security',
        fields: [
          { key: 'security.confirm_sensitive_paths', value: true, type: 'boolean', description: 'Always re-ask for .env / .git / .ssh edits.' },
          { key: 'security.allow_sudo', value: false, type: 'boolean', description: 'Permit sudo-elevated commands.' },
        ],
      },
    ],
  },

  // Task 8 (protocol v2, §6): a "you're ready" snapshot — agent ready,
  // provider configured, FIM configured and probed OK — so the mock (used
  // in dev/tests) reflects a plausible steady state rather than a blank one.
  setup: {
    trusted: true,
    agent: {
      options: [
        {
          id: 'hermes',
          kind: 'agent',
          status: 'available',
          displayName: 'Hermes',
          description: 'The default ACP agent backend.',
          localInstall: { flavor: 'pipx', effort: 'one-script' },
          docsUrl: 'https://github.com/hermes-agent/hermes',
        },
        { id: 'openclaw', kind: 'agent', status: 'coming-soon', displayName: 'OpenClaw', description: 'Coming soon.' },
        { id: 'talaria-ai', kind: 'agent', status: 'coming-soon', displayName: 'Talaria AI', description: 'Coming soon.' },
      ],
      selectedId: 'hermes',
      phase: 'ready',
      version: 'hermes-acp 1.4.0',
    },
    provider: { phase: 'configured', providerId: 'anthropic' },
    fim: {
      options: [
        {
          id: 'ollama',
          kind: 'fim',
          status: 'available',
          displayName: 'Ollama',
          description: 'Local FIM via Ollama.',
          remote: {
            endpointDefault: 'http://127.0.0.1:11434',
            endpointValue: 'http://127.0.0.1:11434',
            endpointPlaceholder: 'http://host:port',
            auth: 'none',
            apiKeySet: false,
            probe: 'ollama-tags',
          },
          localInstall: {
            flavor: 'guided-terminal',
            effort: 'one-script',
            models: [{ role: 'fim', model: 'qwen2.5-coder:1.5b-base', present: true }],
          },
          nextEditTransport: 'ollama',
        },
      ],
      selectedId: 'ollama',
      enabled: true,
      model: 'qwen2.5-coder:1.5b-base',
      endpointValue: 'http://127.0.0.1:11434',
      tuning: {
        debounceMs: 250,
        maxPromptTokens: 2048,
        temperature: 0.2,
        crossFileEnabled: true,
        prefixInjection: true,
        prefixInjectionRemote: false,
        warmUp: true,
      },
    },
    nextEdit: {
      source: 'generic',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:1.5b-base',
      dedicatedConfigured: false,
      genericSupported: true,
    },
    rag: {
      enabled: false,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'nomic-embed-text',
      embedModelPresent: false,
      tuning: { dims: 768, maxChunkTokens: 512, debounceMs: 500, excludeGlobs: ['node_modules/**', '.git/**'] },
      indexDir: '.talaria/index',
    },
    ollama: {
      running: true,
      models: [{ name: 'qwen2.5-coder:1.5b-base', sizeBytes: 986_000_000 }],
    },
    ready: true,
  },
};

/**
 * The full scenario the MockBackend consumes: the scripted `timeline` (with the
 * approval step gated) plus `panels` snapshots for every control panel.
 * Declared last so `panelData` is initialized before it is referenced.
 */
export const mockScenario: MockScenario = {
  timeline: mockTurn,
  panels: panelData,
};
