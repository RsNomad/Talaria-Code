import { describe, it, expect } from 'vitest';
import type { PanelSourceContext } from './PanelSourceRegistry';
import type { AcpClientLike } from '../backend/acp/acpClient';
import {
  ToolsPanelSource,
  SkillsPanelSource,
  ModelsPanelSource,
  SettingsPanelSource,
  McpPanelSource,
  SessionsPanelSource,
} from './panelSources';

/**
 * L2-CA-02 (ADR-R2-05) regression lock. Before this fix, every panel source
 * cast its raw dispatch/ACP result straight into its reshaper (`raw as
 * RawXxx`), and the reshaper dereferenced a field on it unconditionally
 * (`raw.toolsets`, `raw.skills`, `row.models`, `raw.sessions`, …). A
 * malformed/degraded wire result (`null`, a bare string, an array, or
 * `undefined` in place of the expected object) made the reshaper throw
 * `TypeError: Cannot read properties of null (reading '<field>')`, which
 * rejected the WHOLE panel fetch (blank panel, no signal).
 *
 * This suite drives all 6 `unwrapRecord`-guarded ingress points with each
 * malformed shape and asserts the fail-safe behavior: the source resolves
 * the reshaper's EMPTY shape (never throws) and logs EXACTLY ONE line
 * naming the wire method that returned the bad result — so a degraded panel
 * renders empty instead of crashing silently.
 */

interface FakeLogger {
  lines: string[];
  append(line: string): void;
}

function makeLogger(): FakeLogger {
  const lines: string[] = [];
  return { lines, append: (line: string) => lines.push(line) };
}

/** Minimal `PanelSourceContext` — only the members these 6 sources' `fetch` paths touch. */
function makeCtx(
  dispatch: (method: string, params?: unknown) => Promise<unknown>,
  logger: FakeLogger,
  acpClient?: AcpClientLike,
): PanelSourceContext {
  return {
    dispatch,
    getAcpClient: () => acpClient,
    getCwd: () => undefined,
    getSessionCwd: () => undefined,
    getSessionSubagentsSnapshot: () => undefined,
    getRootTracker: () => undefined,
    getOneShotSessionIds: () => new Set<string>(),
    logger,
  };
}

/** The four malformed shapes the brief specifies: null / a bare string / an array / undefined. */
const MALFORMED = [null, 'nonsense', [], undefined] as const;

describe('L2-CA-02 fail-safe: panel sources coerce a non-object wire result to an empty reshape + one log line', () => {
  it.each(MALFORMED)('ToolsPanelSource.fetch tolerates %p from tools.list', async (bad) => {
    const logger = makeLogger();
    const source = new ToolsPanelSource(makeCtx(async () => bad, logger));

    const outcome = await source.fetch();

    expect(outcome).toEqual({ data: { toolsets: [], tools: [] } });
    expect(logger.lines).toEqual(['[panels] tools.list returned a non-object result — rendering empty']);
  });

  it.each(MALFORMED)('SkillsPanelSource.fetch tolerates %p from skills.manage', async (bad) => {
    const logger = makeLogger();
    const source = new SkillsPanelSource(makeCtx(async () => bad, logger));

    const outcome = await source.fetch();

    expect(outcome).toEqual({ data: { skills: [], categories: [] } });
    expect(logger.lines).toEqual(['[panels] skills.manage returned a non-object result — rendering empty']);
  });

  it.each(MALFORMED)('ModelsPanelSource.fetch tolerates %p from model.options', async (bad) => {
    const logger = makeLogger();
    const source = new ModelsPanelSource(makeCtx(async () => bad, logger));

    const outcome = await source.fetch();

    expect(outcome).toEqual({ data: { providers: [], currentModelId: '' } });
    expect(logger.lines).toEqual(['[panels] model.options returned a non-object result — rendering empty']);
  });

  it.each(MALFORMED)('SettingsPanelSource.fetch tolerates %p from config.show', async (bad) => {
    const logger = makeLogger();
    const source = new SettingsPanelSource(makeCtx(async () => bad, logger));

    const outcome = await source.fetch();

    expect(outcome).toEqual({ data: { sections: [] } });
    expect(logger.lines).toEqual(['[panels] config.show returned a non-object result — rendering empty']);
  });

  it.each(MALFORMED)(
    'McpPanelSource.fetch tolerates %p from the tools.list half while config.get stays well-formed (rawConfig path is NOT double-wrapped)',
    async (bad) => {
      const logger = makeLogger();
      const source = new McpPanelSource(
        makeCtx(async (method) => (method === 'config.get' ? { config: {} } : bad), logger),
      );

      const outcome = await source.fetch();

      expect(outcome).toEqual({ data: { servers: [] } });
      expect(logger.lines).toEqual(['[panels] tools.list returned a non-object result — rendering empty']);
    },
  );

  it.each(MALFORMED)('SessionsPanelSource.fetch tolerates %p from session/list', async (bad) => {
    const logger = makeLogger();
    const client = { listSessions: async () => bad } as unknown as AcpClientLike;
    const source = new SessionsPanelSource(
      makeCtx(
        async () => {
          throw new Error('SessionsPanelSource must use the ACP channel, not dispatch');
        },
        logger,
        client,
      ),
    );

    const outcome = await source.fetch();

    expect(outcome).toEqual({ data: { sessions: [] } });
    expect(logger.lines).toEqual(['[panels] session/list returned a non-object result — rendering empty']);
  });
});
