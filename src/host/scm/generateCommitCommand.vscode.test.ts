/**
 * SCM-2 (§12.1 T-11, tier2-remediation-architecture.md): `presentResult`
 * (the `scm/title` command's `GenerateResult` → notification mapping) must
 * stop echoing `result.message` verbatim for a `model-error` — that message
 * can carry a raw provider/model error body (`modelResult.error` from
 * `AcpBackend.oneShot`, or SCM-1's caught-exception `.message`) — Invariant
 * #3 (see `HermesDashboardClient.ts`'s identical posture) forbids surfacing
 * that to the user. The user-facing toast gets one fixed, generic copy; the
 * raw detail goes ONLY to the injected `Logger` (structurally the "Hermes"
 * `vscode.OutputChannel`, same `Logger` shape `JsonRpcStdio.ts` already
 * defines and `HermesDashboardManager`/`Client` already reuse).
 *
 * Only `vscode.window.showWarningMessage`/`showInformationMessage` are
 * exercised here — narrow `vi.mock('vscode', ...)`, same discipline as
 * `gitPort.test.ts`'s minimal mock, not the full fake-host apparatus
 * `shell.vscode.test.ts` needs for a whole activation surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import { presentResult } from './generateCommitCommand.vscode';
import type { GenerateResult } from './generateCommitCommand';

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

interface FakeLogger {
  lines: string[];
  append(line: string): void;
}

function makeLogger(): FakeLogger {
  const lines: string[] = [];
  return {
    lines,
    append(line: string) {
      lines.push(line);
    },
  };
}

describe('presentResult — SCM-2: a model-error result never echoes the raw message to the user', () => {
  it('shows a fixed generic warning (no raw detail) and routes the raw detail to the Logger only', () => {
    const RAW_MARKER = 'RAW_PROVIDER_DETAIL_MARKER_xyz789';
    const result: GenerateResult = {
      ok: false,
      kind: 'permanent',
      reason: 'model-error',
      message: `connection reset by peer: ${RAW_MARKER}`,
    };
    const logger = makeLogger();

    presentResult(result, logger);

    const warnMock = vi.mocked(vscode.window.showWarningMessage);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(expect.not.stringContaining(RAW_MARKER));

    expect(logger.lines.join('\n')).toContain(RAW_MARKER);
  });

  it('a non-model-error permanent failure (nothing-to-commit) is unaffected — its message is already user-safe', () => {
    const result: GenerateResult = {
      ok: false,
      kind: 'permanent',
      reason: 'nothing-to-commit',
      message: 'Nothing to commit — stage or make some changes first.',
    };
    const logger = makeLogger();

    presentResult(result, logger);

    const warnMock = vi.mocked(vscode.window.showWarningMessage);
    expect(warnMock).toHaveBeenCalledWith('Hermes: Nothing to commit — stage or make some changes first.');
    expect(logger.lines).toHaveLength(0); // non-model-error path never touches the logger
  });

  it('a cancelled result stays silent — no warning, no log line', () => {
    const result: GenerateResult = { ok: false, kind: 'permanent', reason: 'cancelled', message: 'Cancelled.' };
    const logger = makeLogger();

    presentResult(result, logger);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(logger.lines).toHaveLength(0);
  });
});
