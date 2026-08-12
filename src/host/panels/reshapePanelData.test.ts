import { describe, it, expect } from 'vitest';
import {
  reshapeToolsList,
  reshapeSkillsList,
  reshapeMcpServers,
  reshapeSessionsList,
  reshapeModelOptions,
  reshapeConfigShow,
} from './reshapePanelData';
import { must } from '../../testing/must';
import type {
  RawToolsListResult,
  RawSkillsManageListResult,
  RawConfigFullResult,
  RawSessionListResult,
  RawModelOptionsResult,
  RawConfigShowResult,
} from './reshapePanelData';

/**
 * Fixture-based unit tests for the Zone S reshaping seam. The reference panel
 * is Tools (`tools.list`) — per the tui_gateway wire contract:
 *
 *   `tools.list` -> `{"toolsets": [{"name","description","tool_count",
 *   "enabled","tools": [...resolved tool defs]}]}` (`tui_gateway/server.py:13439-13467`)
 *
 * The fixture below is shaped exactly like that raw contract; the expected
 * output is the panel's `ToolsData` (`ToolsPanel.tsx`'s prop type) — the
 * frozen `PanelDataMap['tools']` entry in `src/shared/protocol.ts`.
 */

const RAW_FIXTURE: RawToolsListResult = {
  toolsets: [
    {
      name: 'hermes-acp',
      description: 'Core Hermes tools',
      tool_count: 3,
      enabled: true,
      tools: [
        { name: 'read_file', description: 'Read a file from the workspace.' },
        { name: 'patch', description: 'Apply a unified diff to a file.', enabled: false },
        { name: 'todo', description: 'Maintain the plan / todo list.' },
      ],
    },
    {
      name: 'terminal',
      description: 'Shell execution',
      tool_count: 1,
      enabled: true,
      tools: [{ name: 'shell_exec', description: 'Run a shell command in a PTY.' }],
    },
    {
      name: 'github',
      description: 'GitHub MCP server',
      tool_count: 1,
      enabled: false,
      tools: [{ name: 'github:create_issue', description: 'Open a GitHub issue via MCP.' }],
    },
  ],
};

describe('reshapeToolsList', () => {
  it('maps each toolset to a flat ToolsetInfo row (tool_count -> toolCount)', () => {
    const result = reshapeToolsList(RAW_FIXTURE);
    expect(result.toolsets).toEqual([
      { name: 'hermes-acp', enabled: true, toolCount: 3 },
      { name: 'terminal', enabled: true, toolCount: 1 },
      { name: 'github', enabled: false, toolCount: 1 },
    ]);
  });

  it('flattens every toolset.tools entry into the top-level tools[] with a toolset tag', () => {
    const result = reshapeToolsList(RAW_FIXTURE);
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(['read_file', 'patch', 'todo', 'shell_exec', 'github:create_issue']);
    expect(result.tools.find((t) => t.name === 'read_file')?.toolset).toBe('hermes-acp');
    expect(result.tools.find((t) => t.name === 'shell_exec')?.toolset).toBe('terminal');
  });

  it('falls back a tool row missing `enabled` to its owning toolset.enabled', () => {
    const result = reshapeToolsList(RAW_FIXTURE);
    // `read_file`/`todo` don't set `enabled` on the raw tool row -> inherit
    // the toolset's `enabled: true`.
    expect(result.tools.find((t) => t.name === 'read_file')?.enabled).toBe(true);
    // `github:create_issue` inherits its toolset's `enabled: false`.
    expect(result.tools.find((t) => t.name === 'github:create_issue')?.enabled).toBe(false);
  });

  it('respects an explicit tool-level `enabled`, overriding the toolset default', () => {
    const result = reshapeToolsList(RAW_FIXTURE);
    // `patch` explicitly sets `enabled: false` even though its toolset is enabled.
    expect(result.tools.find((t) => t.name === 'patch')?.enabled).toBe(false);
  });

  it('classifies `source` as mcp for "<server>:<tool>" names (tools.configure convention), core otherwise', () => {
    const result = reshapeToolsList(RAW_FIXTURE);
    expect(result.tools.find((t) => t.name === 'github:create_issue')?.source).toBe('mcp');
    expect(result.tools.find((t) => t.name === 'read_file')?.source).toBe('core');
  });

  it('classifies `kind` by name heuristics (read/edit/execute/think/other)', () => {
    const result = reshapeToolsList(RAW_FIXTURE);
    expect(result.tools.find((t) => t.name === 'read_file')?.kind).toBe('read');
    expect(result.tools.find((t) => t.name === 'patch')?.kind).toBe('edit');
    expect(result.tools.find((t) => t.name === 'todo')?.kind).toBe('think');
    expect(result.tools.find((t) => t.name === 'shell_exec')?.kind).toBe('execute');
    // No pattern matches an MCP-qualified name -> 'other'.
    expect(result.tools.find((t) => t.name === 'github:create_issue')?.kind).toBe('other');
  });

  it('defaults a missing `description` to an empty string rather than throwing', () => {
    const raw: RawToolsListResult = {
      toolsets: [
        { name: 'x', tool_count: 1, enabled: true, tools: [{ name: 'mystery_tool' }] },
      ],
    };
    const result = reshapeToolsList(raw);
    expect(result.tools[0]).toMatchObject({ name: 'mystery_tool', description: '' });
  });

  it('tolerates a toolset with no `tools` array (empty toolset)', () => {
    const raw: RawToolsListResult = {
      toolsets: [{ name: 'empty-set', tool_count: 0, enabled: true, tools: [] }],
    };
    const result = reshapeToolsList(raw);
    expect(result.toolsets).toEqual([{ name: 'empty-set', enabled: true, toolCount: 0 }]);
    expect(result.tools).toEqual([]);
  });

  it('tolerates a missing `toolsets` array entirely (defensive raw-input handling)', () => {
    const result = reshapeToolsList({} as RawToolsListResult);
    expect(result).toEqual({ toolsets: [], tools: [] });
  });

  // corr-M1: the REAL `tools.list` wire shape carries a toolset's members as
  // `resolved_tools: string[]` (bare names), NOT `{name}` objects. Reading a
  // string as `t.name` was crashing the LIVE no-dashboard tools source
  // (`classifySource(undefined)` TypeError). These prove the string form works.
  it('accepts the real `resolved_tools: string[]` shape (bare tool names) without crashing', () => {
    const raw: RawToolsListResult = {
      toolsets: [
        { name: 'web', tool_count: 2, enabled: true, resolved_tools: ['web_search', 'github:create_issue'] },
      ],
    };
    const result = reshapeToolsList(raw);
    expect(result.toolsets).toEqual([{ name: 'web', enabled: true, toolCount: 2 }]);
    expect(result.tools).toEqual([
      // `web_search` matches the web/fetch name heuristic -> 'fetch'.
      { name: 'web_search', description: '', enabled: true, kind: 'fetch', toolset: 'web', source: 'core' },
      { name: 'github:create_issue', description: '', enabled: true, kind: 'other', toolset: 'web', source: 'mcp' },
    ]);
  });

  it('accepts a legacy `tools` array of bare NAME strings too (fallback path)', () => {
    const raw: RawToolsListResult = {
      toolsets: [{ name: 'core', tool_count: 1, enabled: false, tools: ['read_file'] }],
    };
    const result = reshapeToolsList(raw);
    // A string entry inherits its toolset's `enabled` (here false).
    expect(result.tools).toEqual([
      { name: 'read_file', description: '', enabled: false, kind: 'read', toolset: 'core', source: 'core' },
    ]);
  });
});

/**
 * `reshapeSkillsList` — raw `skills.manage {action:"list"}` -> `SkillsData`.
 *
 * GROUNDING (contracts-tui-gateway.md §2 only pins `{"skills": [...]}`, not
 * the inner element type — traced further into
 * `hermes-agent-2026.7.7.2/tui_gateway/server.py:13721-13724`, which calls
 * `hermes_cli.banner.get_available_skills()`. That function
 * (`hermes_cli/banner.py:93-110`) does NOT forward the richer
 * `{name,description,category}` dicts that `tools/skills_tool.py:_find_all_skills()`
 * produces — it regroups them into `Dict[category, List[name]]`, discarding
 * `description` entirely. So the real wire shape is
 * `{"skills": {"<category>": ["<name>", ...], ...}}` — a name-only, grouped
 * shape, NOT an array of skill objects. `get_available_skills()` also only
 * returns skills that (a) exist on disk and (b) are NOT in the user's
 * disabled-skill list — so every entry it returns is legitimately
 * `installed: true` / `enabled: true`; there is no raw field for
 * `description` or `source` at all (flagged in the zone report rather than
 * inventing one).
 */
const SKILLS_RAW_FIXTURE: RawSkillsManageListResult = {
  skills: {
    coding: ['python-debug', 'refactor-helper'],
    research: ['deep-research'],
  },
};

describe('reshapeSkillsList', () => {
  it('flattens the category->names grouping into SkillInfo rows tagged with their category', () => {
    const result = reshapeSkillsList(SKILLS_RAW_FIXTURE);
    expect(result.skills.map((s) => [s.name, s.category])).toEqual([
      ['python-debug', 'coding'],
      ['refactor-helper', 'coding'],
      ['deep-research', 'research'],
    ]);
  });

  it('derives `categories` as the distinct set of raw group keys, in encounter order', () => {
    const result = reshapeSkillsList(SKILLS_RAW_FIXTURE);
    expect(result.categories).toEqual(['coding', 'research']);
  });

  it('uses the skill name as `id` (the raw shape has no separate id field)', () => {
    const result = reshapeSkillsList(SKILLS_RAW_FIXTURE);
    expect(result.skills[0]).toMatchObject({ id: 'python-debug', name: 'python-debug' });
  });

  it('defaults `enabled` to true — get_available_skills() already filters to on-disk, non-disabled skills', () => {
    const result = reshapeSkillsList(SKILLS_RAW_FIXTURE);
    for (const skill of result.skills) {
      expect(skill.enabled).toBe(true);
    }
  });

  it('defaults `description` to empty string and OMITS provenance/usage — neither is present on the raw name-only entry (A4)', () => {
    const result = reshapeSkillsList(SKILLS_RAW_FIXTURE);
    for (const skill of result.skills) {
      expect(skill.description).toBe('');
      expect(skill.provenance).toBeUndefined();
      expect(skill.usage).toBeUndefined();
      // A4: `installed`/`source` were removed from SkillInfo entirely.
      expect('installed' in skill).toBe(false);
      expect('source' in skill).toBe(false);
    }
  });

  it('tolerates a missing `skills` key entirely (defensive raw-input handling)', () => {
    const result = reshapeSkillsList({} as RawSkillsManageListResult);
    expect(result).toEqual({ skills: [], categories: [] });
  });

  it('tolerates an empty category array', () => {
    const result = reshapeSkillsList({ skills: { empty: [] } });
    expect(result).toEqual({ skills: [], categories: ['empty'] });
  });

  it('accepts a richer per-entry object defensively (name/description/enabled), for forward-compat with a future banner.py shape', () => {
    const result = reshapeSkillsList({
      skills: {
        coding: [{ name: 'rich-skill', description: 'Has real metadata.', enabled: false }],
      },
    });
    expect(result.skills).toEqual([
      {
        id: 'rich-skill',
        name: 'rich-skill',
        category: 'coding',
        description: 'Has real metadata.',
        enabled: false,
      },
    ]);
  });
});

/**
 * `reshapeMcpServers` — joins `config.get({key:"full"}).mcp_servers` (server
 * list + launch command, contracts-tui-gateway.md §3.1/§3.2) with
 * `tools.list`'s per-toolset `tool_count` (§2) into `McpData`. Per §3 GAPS #1,
 * there is NO single RPC for this; `reload.mcp` (the third source the wave
 * spec suggested joining) was traced into
 * `tui_gateway/server.py:11137-11223` and found to return only
 * `{"status": "confirm_required"|"reloaded", "message"?}` — no per-server
 * data at all — so it contributes nothing to this pure reshaper (it's wired
 * as the panel's explicit reload ACTION in `AcpBackend`, not as a data
 * source; see the zone report).
 *
 * Server->toolset name matching: `register_mcp_servers()` always registers
 * the canonical toolset as `mcp-<server_name>` (`tools/mcp_tool.py:4750`)
 * then an alias `<server_name> -> mcp-<server_name>` (`tools/mcp_tool.py:4840`);
 * `toolsets.get_all_toolsets()` prefers the alias as the display key unless it
 * collides with a static toolset name (`toolsets.py:814-836`). So a
 * `tools.list` toolset for an MCP server is normally keyed by the bare server
 * name, falling back to `mcp-<name>` on a collision — `reshapeMcpServers`
 * checks both.
 */
const MCP_CONFIG_FIXTURE: RawConfigFullResult = {
  mcp_servers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    remote_api: { url: 'https://my-mcp-server.example.com/mcp' },
    disabled_server: { command: 'npx', args: ['-y', 'something'], enabled: false },
  },
};

const MCP_TOOLS_FIXTURE: RawToolsListResult = {
  toolsets: [
    { name: 'hermes-acp', tool_count: 3, enabled: true, tools: [] },
    // bare-name alias display (the common case)
    { name: 'filesystem', tool_count: 4, enabled: true, tools: [] },
    // canonical `mcp-<name>` form (collision fallback case)
    { name: 'mcp-github', tool_count: 2, enabled: true, tools: [] },
    // `remote_api` and `disabled_server` intentionally have NO matching
    // toolset — never connected / explicitly disabled.
  ],
};

describe('reshapeMcpServers', () => {
  it('joins config mcp_servers with tools.list toolset tool_count, matched by bare server name', () => {
    const result = reshapeMcpServers(MCP_CONFIG_FIXTURE, MCP_TOOLS_FIXTURE);
    expect(result.servers.find((s) => s.id === 'filesystem')).toEqual({
      id: 'filesystem',
      name: 'filesystem',
      status: 'connected',
      command: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
      toolCount: 4,
    });
  });

  it('falls back to matching the `mcp-<name>` canonical toolset name on a collision', () => {
    const result = reshapeMcpServers(MCP_CONFIG_FIXTURE, MCP_TOOLS_FIXTURE);
    expect(result.servers.find((s) => s.id === 'github')).toEqual({
      id: 'github',
      name: 'github',
      status: 'connected',
      command: 'npx -y @modelcontextprotocol/server-github',
      toolCount: 2,
    });
  });

  it('marks a configured server with no matching toolset as disconnected, toolCount 0', () => {
    const result = reshapeMcpServers(MCP_CONFIG_FIXTURE, MCP_TOOLS_FIXTURE);
    expect(result.servers.find((s) => s.id === 'remote_api')).toEqual({
      id: 'remote_api',
      name: 'remote_api',
      status: 'disconnected',
      command: 'https://my-mcp-server.example.com/mcp',
      toolCount: 0,
    });
  });

  it('marks an explicitly `enabled: false` server as disconnected even if a stale matching toolset exists', () => {
    const toolsWithStaleEntry: RawToolsListResult = {
      toolsets: [...(MCP_TOOLS_FIXTURE.toolsets ?? []), { name: 'disabled_server', tool_count: 5, enabled: true, tools: [] }],
    };
    const result = reshapeMcpServers(MCP_CONFIG_FIXTURE, toolsWithStaleEntry);
    expect(result.servers.find((s) => s.id === 'disabled_server')).toEqual({
      id: 'disabled_server',
      name: 'disabled_server',
      status: 'disconnected',
      command: 'npx -y something',
      toolCount: 0,
    });
  });

  it('uses the raw `url` as `command` for a remote (HTTP/SSE) server', () => {
    const result = reshapeMcpServers(MCP_CONFIG_FIXTURE, MCP_TOOLS_FIXTURE);
    expect(result.servers.find((s) => s.id === 'remote_api')?.command).toBe(
      'https://my-mcp-server.example.com/mcp',
    );
  });

  it('tolerates a missing `mcp_servers` key (defensive raw-input handling)', () => {
    expect(reshapeMcpServers({}, MCP_TOOLS_FIXTURE)).toEqual({ servers: [] });
  });

  it('tolerates a missing `toolsets` array on the tools.list side (every server disconnected)', () => {
    const result = reshapeMcpServers(MCP_CONFIG_FIXTURE, {});
    expect(result.servers.every((s) => s.status === 'disconnected' && s.toolCount === 0)).toBe(true);
  });
});

/**
 * `reshapeSessionsList` — raw ACP `session/list` -> `SessionsData` (Zone
 * HIST, `SessionsPanel.tsx`). UNLIKE every other reshaper above, this raw
 * shape comes from the ACP channel (`AcpClient.listSessions`), not a
 * tui_gateway RPC — grounded in `acp_adapter/server.py:1249-1292`'s
 * `list_sessions`/`SessionInfo`/`ListSessionsResponse`.
 *
 * Field-casing tolerance: the wire casing IS camelCase — settled during Task
 * 5's review from the Python `agent-client-protocol==0.9.0` SDK Hermes pins
 * (`acp/schema.py`'s `Field(alias=...)` declarations plus, decisively,
 * `acp/connection.py`'s `_run_request` dumping results with `by_alias=True`);
 * see `AcpListSessionsRawResult`'s doc in `acp/acpClient.ts` for the full
 * reasoning. This comment previously said the casing "could not be confirmed"
 * and that `session/list` routes through the SDK's `extMethod` escape hatch —
 * both were true of SDK 0.4.5 and neither survived Audit C-1's migration to
 * `@agentclientprotocol/sdk@0.17.1`, where `listSessions` is a real typed
 * method. The snake_case fixtures below are kept deliberately: the
 * both-casings tolerance in `reshapeSessionsList` is belt-and-braces on a wire
 * boundary and stays even though the casing is now known, so it must stay
 * covered — the fixtures are no longer hedging against an open question.
 */
const SESSIONS_RAW_FIXTURE: RawSessionListResult = {
  sessions: [
    {
      session_id: 'sess-1',
      cwd: '/workspace/project-a',
      title: 'Fix the flaky test',
      updated_at: '2026-07-10T12:00:00Z',
    },
    {
      session_id: 'sess-2',
      cwd: '/workspace/project-a',
      title: null,
      updated_at: null,
    },
  ],
  next_cursor: 'sess-2',
};

describe('reshapeSessionsList', () => {
  it('renames session_id->id, cwd, title, updated_at->updatedAt for each session', () => {
    const result = reshapeSessionsList(SESSIONS_RAW_FIXTURE);
    expect(result.sessions[0]).toEqual({
      id: 'sess-1',
      cwd: '/workspace/project-a',
      title: 'Fix the flaky test',
      updatedAt: '2026-07-10T12:00:00Z',
    });
  });

  it('renames next_cursor->nextCursor', () => {
    const result = reshapeSessionsList(SESSIONS_RAW_FIXTURE);
    expect(result.nextCursor).toBe('sess-2');
  });

  it('collapses a null title/updated_at to undefined (not null) — matches the optional (not nullable) SessionSummary fields', () => {
    const result = reshapeSessionsList(SESSIONS_RAW_FIXTURE);
    expect(result.sessions[1]).toEqual({
      id: 'sess-2',
      cwd: '/workspace/project-a',
      title: undefined,
      updatedAt: undefined,
    });
  });

  it('tolerates a missing `sessions` array (defensive raw-input handling)', () => {
    expect(reshapeSessionsList({})).toEqual({ sessions: [], nextCursor: undefined });
  });

  it('tolerates a missing `next_cursor` (last page — no more results)', () => {
    const result = reshapeSessionsList({
      sessions: [{ session_id: 's1', cwd: '/ws', title: 'x', updated_at: 't' }],
    });
    expect(result.nextCursor).toBeUndefined();
  });

  it('also accepts the camelCase spelling (sessionId/updatedAt/nextCursor) — wire casing for this unstable ext method is unconfirmed', () => {
    const result = reshapeSessionsList({
      sessions: [{ sessionId: 'sess-3', cwd: '/ws/b', title: 'Camel case', updatedAt: '2026-07-11T00:00:00Z' }],
      nextCursor: 'sess-3',
    });
    expect(result).toEqual({
      sessions: [{ id: 'sess-3', cwd: '/ws/b', title: 'Camel case', updatedAt: '2026-07-11T00:00:00Z' }],
      nextCursor: 'sess-3',
    });
  });

  it('prefers the snake_case field when BOTH casings are somehow present on the same entry', () => {
    const result = reshapeSessionsList({
      sessions: [{ session_id: 'snake-wins', sessionId: 'camel-loses', cwd: '/ws' }],
    });
    expect(must(result.sessions[0]).id).toBe('snake-wins');
  });

  it('defaults a missing cwd to an empty string rather than throwing', () => {
    const result = reshapeSessionsList({ sessions: [{ session_id: 's1' }] });
    expect(result.sessions[0]).toEqual({ id: 's1', cwd: '', title: undefined, updatedAt: undefined });
  });

  /**
   * CA-17 (audit-3): `session/list`'s `updated_at` can arrive as a
   * STRINGIFIED epoch float (e.g. Python `str(time.time())` — seconds, with
   * a fractional part) rather than an ISO-8601 string. Before this fix, the
   * reshape did a bare `String(updatedAtRaw)` passthrough, so an epoch-float
   * string came out unchanged — `SessionsPanel.tsx`'s `relativeAge` then
   * calls `Date.parse` on it, which does NOT recognize a bare numeric
   * string, so it falls back to displaying the raw float string instead of
   * an age (wrong/no date — cosmetic but user-visible). The fix normalizes
   * an epoch-numeric string (seconds OR milliseconds, auto-detected by
   * magnitude) into the same ISO-8601 shape the existing (already-working)
   * ISO-string path produces, so `Date.parse` downstream succeeds either way.
   */
  describe('CA-17: epoch-float-string updatedAt parsing', () => {
    it('parses a stringified epoch-SECONDS float into the same ISO shape an ISO string already produces', () => {
      const result = reshapeSessionsList({
        sessions: [{ session_id: 's1', cwd: '/ws', updated_at: '1690633200.5' }],
      });
      expect(result.sessions[0]?.updatedAt).toBe(new Date(1690633200.5 * 1000).toISOString());
    });

    it('parses a stringified epoch-MILLISECONDS integer into the same ISO shape an ISO string already produces', () => {
      const result = reshapeSessionsList({
        sessions: [{ session_id: 's1', cwd: '/ws', updated_at: '1690633200000' }],
      });
      expect(result.sessions[0]?.updatedAt).toBe(new Date(1690633200000).toISOString());
    });

    it('still passes an ISO-8601 updated_at through unchanged (existing behavior, not a regression)', () => {
      const result = reshapeSessionsList({
        sessions: [{ session_id: 's1', cwd: '/ws', updated_at: '2026-07-10T12:00:00Z' }],
      });
      expect(result.sessions[0]?.updatedAt).toBe('2026-07-10T12:00:00Z');
    });

    it('degrades an out-of-range/overflow epoch (nanosecond-shaped) to the raw string instead of throwing (B-6 review)', () => {
      // A NANOSECOND epoch string (Python `str(time.time_ns())`, 19 digits)
      // matches EPOCH_NUMERIC_PATTERN; parseFloat -> 1.7e18, treated as ms ->
      // Invalid Date. `new Date(...).toISOString()` would throw RangeError,
      // which has NO catch up to invokeControl and would fail the WHOLE
      // sessions-list fetch. The reshape must degrade the one bad entry and
      // keep the fetch (and the good sibling row) alive.
      const nanoEpoch = '1700000000000000000';
      expect(() =>
        reshapeSessionsList({
          sessions: [
            { session_id: 's1', cwd: '/ws', updated_at: nanoEpoch },
            { session_id: 's2', cwd: '/ws', updated_at: '2026-07-10T12:00:00Z' },
          ],
        }),
      ).not.toThrow();
      const result = reshapeSessionsList({
        sessions: [
          { session_id: 's1', cwd: '/ws', updated_at: nanoEpoch },
          { session_id: 's2', cwd: '/ws', updated_at: '2026-07-10T12:00:00Z' },
        ],
      });
      // Bad entry degrades to the raw string; the good sibling still renders.
      expect(result.sessions[0]?.updatedAt).toBe(nanoEpoch);
      expect(result.sessions[1]?.updatedAt).toBe('2026-07-10T12:00:00Z');
    });
  });
});

/**
 * `reshapeModelOptions` — raw `model.options` -> `ModelsData` (Zone Z3 "Minors"
 * fix; `ModelsPanel.tsx`). GROUNDED in `tui_gateway/server.py:12383-12421` (the
 * handler calls `build_models_payload(..., picker_hints=True)`) and
 * `hermes_cli/inventory.py:111-251`: providers is a list of rows with `slug` /
 * `name` / `authenticated` / a BARE `models` string list (NOT objects — see
 * `_apply_pricing:443`/`_moa_provider_row:509`), plus top-level `model`
 * (current model id) and `provider`.
 */
const MODELS_RAW_FIXTURE: RawModelOptionsResult = {
  providers: [
    {
      slug: 'anthropic',
      name: 'Anthropic',
      authenticated: true,
      is_current: true,
      models: ['claude-opus-4-8', 'claude-sonnet-4-6'],
      total_models: 2,
    },
    {
      slug: 'openai',
      name: 'OpenAI',
      authenticated: false,
      models: [],
      total_models: 0,
      source: 'canonical',
    },
  ],
  model: 'claude-opus-4-8',
  provider: 'anthropic',
};

describe('reshapeModelOptions', () => {
  it('maps each provider row to id(slug)/name/connected(authenticated), models as {id,label} with label==id', () => {
    const result = reshapeModelOptions(MODELS_RAW_FIXTURE);
    expect(result.providers[0]).toEqual({
      id: 'anthropic',
      name: 'Anthropic',
      connected: true,
      models: [
        { id: 'claude-opus-4-8', label: 'claude-opus-4-8' },
        { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
      ],
    });
  });

  it('maps the payload top-level `model` to currentModelId', () => {
    const result = reshapeModelOptions(MODELS_RAW_FIXTURE);
    expect(result.currentModelId).toBe('claude-opus-4-8');
  });

  it('treats a row with authenticated:false as not connected (the "not connected" picker hint)', () => {
    const result = reshapeModelOptions(MODELS_RAW_FIXTURE);
    expect(result.providers.find((p) => p.id === 'openai')).toEqual({
      id: 'openai',
      name: 'OpenAI',
      connected: false,
      models: [],
    });
  });

  it('never sets contextWindow (model.options carries no per-model context window)', () => {
    const result = reshapeModelOptions(MODELS_RAW_FIXTURE);
    for (const provider of result.providers) {
      for (const model of provider.models) {
        expect(model.contextWindow).toBeUndefined();
      }
    }
  });

  it('defaults name to slug when name is absent, and tolerates a missing models array', () => {
    const result = reshapeModelOptions({ providers: [{ slug: 'xai' }], model: '' });
    expect(result.providers[0]).toEqual({ id: 'xai', name: 'xai', connected: false, models: [] });
  });

  it('tolerates a missing providers array / missing model (defensive raw-input handling)', () => {
    expect(reshapeModelOptions({})).toEqual({ providers: [], currentModelId: '' });
  });

  it('beta.7 B4: a source:"virtual" row (MoA, inventory.py _moa_provider_row) maps to virtual:true; real rows carry NO virtual key', () => {
    const data = reshapeModelOptions({
      providers: [
        { slug: 'moa', name: 'Mixture of Agents', authenticated: true, source: 'virtual', models: ['balanced'] },
        { slug: 'deepseek', name: 'DeepSeek', authenticated: false, models: ['deepseek-chat'] },
      ],
      model: 'balanced',
    });
    expect(must(data.providers[0]).virtual).toBe(true);
    expect('virtual' in must(data.providers[1])).toBe(false);
  });
});

/**
 * `reshapeConfigShow` — raw `config.show` -> `SettingsData` (Zone Z3 "Minors"
 * fix; `SettingsPanel.tsx`). GROUNDED in `tui_gateway/server.py:13400-13434`:
 * a READ-ONLY display dump `{sections:[{title, rows:[[label, value]]}]}` with
 * every value already stringified server-side — so every field is honestly
 * `type:'string'` (no per-field type/enum metadata exists to fabricate a toggle
 * from). This is distinct from the editable `config.get`/`config.set` surface.
 */
const SETTINGS_RAW_FIXTURE: RawConfigShowResult = {
  sections: [
    {
      title: 'Model',
      rows: [
        ['Model', 'claude-opus-4-8'],
        ['Base URL', '(default)'],
        ['API Key', '****abcd'],
      ],
    },
    {
      title: 'Agent',
      rows: [
        ['Max Turns', '90'],
        ['Verbose', 'False'],
      ],
    },
  ],
};

describe('reshapeConfigShow', () => {
  it('maps each section title->name and each [label,value] row to a string SettingField keyed by label', () => {
    const result = reshapeConfigShow(SETTINGS_RAW_FIXTURE);
    expect(result.sections[0]).toEqual({
      name: 'Model',
      fields: [
        { key: 'Model', value: 'claude-opus-4-8', type: 'string' },
        { key: 'Base URL', value: '(default)', type: 'string' },
        { key: 'API Key', value: '****abcd', type: 'string' },
      ],
    });
  });

  it("types every field as 'string' — config.show carries no per-field type/enum metadata", () => {
    const result = reshapeConfigShow(SETTINGS_RAW_FIXTURE);
    for (const section of result.sections) {
      for (const field of section.fields) {
        expect(field.type).toBe('string');
      }
    }
  });

  it('tolerates a missing sections array (defensive raw-input handling)', () => {
    expect(reshapeConfigShow({})).toEqual({ sections: [] });
  });

  it('tolerates a section with no rows / a malformed row', () => {
    const result = reshapeConfigShow({ sections: [{ title: 'Empty' }, { title: 'Odd', rows: [['soloKey']] }] });
    expect(result.sections[0]).toEqual({ name: 'Empty', fields: [] });
    expect(must(must(result.sections[1]).fields[0])).toEqual({ key: 'soloKey', value: '', type: 'string' });
  });
});
