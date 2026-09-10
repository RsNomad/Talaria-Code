import { describe, it, expect, vi } from 'vitest';

/**
 * R4-ARCH-01 — this file mocks NOTHING. There is deliberately no
 * `vi.mock('vscode', …)` here: `sessionScopeActions.ts` reaches the
 * `talaria.customModes` settings read through the injected
 * `SessionScopePort.readCustomModes` (the R3-ARCH-02 `NextEditConfigReader`
 * precedent) instead of value-importing `../customModes.vscode`, so nothing
 * on this file's import graph resolves the `vscode` package. Vitest has no
 * `vscode` alias (`vitest.config.ts`), so a transitive edge back to it would
 * fail THIS file at import time — the mock's absence IS the headless proof
 * (mutation mB1 in the R4 plan re-adds the value import and watches this
 * file fail to load).
 *
 * Scope: the DOMAIN in isolation — id resolution through the port seam, the
 * snapshot handed to THAT controller only, the emitted `mode.state`, and the
 * config-change fan-out (warn once, refresh the catalog, never re-snapshot).
 * The snapshot builder's own content is pinned by `customModes.test.ts`; the
 * vscode-mocked end-to-end wire through `AcpBackend.setCustomMode` stays in
 * `AcpBackend.test.ts` ("SF-2 (T4b): router").
 */
import { SessionScopeActions, type SessionScopePort } from './sessionScopeActions';
import { SessionRegistry } from '../session/SessionRegistry';
import type { SessionHostPort } from '../session/types';
import { RootCoordinator } from '../../checkpoints/RootCoordinator';
import type { CustomModeConfig, HostToWebview } from '../../../shared/protocol';

const SELF_PROTECTION_DENY = ['.vscode/settings.json', '*.code-workspace'];

/** Minimal headless `SessionHostPort` — the `SessionRegistry.routing.test.ts` shape, no client needed here. */
function makeSessionHostPort(): SessionHostPort {
  return {
    getClient: () => undefined,
    emit: () => {},
    emitSystemError: () => {},
    root: new RootCoordinator('/ws', () => undefined),
    workspaceRoots: () => [],
    refreshCheckpointsPanel: () => {},
    resolveMentions: async () => [],
  };
}

function makeScope(initialConfigs: CustomModeConfig[]): {
  actions: SessionScopeActions;
  sessions: SessionRegistry;
  emitted: HostToWebview[];
  warnings: string[];
  holder: { configs: CustomModeConfig[]; reads: number };
} {
  const sessions = new SessionRegistry();
  const emitted: HostToWebview[] = [];
  const warnings: string[] = [];
  const holder = { configs: initialConfigs, reads: 0 };
  const port: SessionScopePort = {
    sessions,
    emit: (msg) => {
      emitted.push(msg);
    },
    getActiveSessionId: () => undefined,
    showWarningMessage: (message) => {
      warnings.push(message);
    },
    isPendingClose: () => false,
    loadSessionIntoTab: async () => undefined,
    readCustomModes: () => {
      holder.reads += 1;
      return holder.configs;
    },
  };
  return { actions: new SessionScopeActions(port), sessions, emitted, warnings, holder };
}

const DOCS_ONLY: CustomModeConfig = { id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] };
const OTHER: CustomModeConfig = { id: 'other', name: 'Other' };

describe('R4-ARCH-01: SessionScopeActions is headless — loaded with NO vscode mock', () => {
  it('the module loads and constructs without any vscode stub (structural headless proof — see the header)', () => {
    const { actions } = makeScope([]);
    expect(actions).toBeInstanceOf(SessionScopeActions);
  });
});

describe('SessionScopeActions.setCustomMode — reads through the injected port, snapshots onto THAT controller only', () => {
  it('resolves the id via readCustomModes, hands the self-protected snapshot to the target controller, emits the authoritative mode.state', () => {
    const { actions, sessions, emitted, holder } = makeScope([DOCS_ONLY, OTHER]);
    const target = sessions.open('session-1', '/ws', makeSessionHostPort());
    const bystander = sessions.open('session-2', '/ws', makeSessionHostPort());
    const targetSpy = vi.spyOn(target, 'setCustomMode');
    const bystanderSpy = vi.spyOn(bystander, 'setCustomMode');

    actions.setCustomMode('session-1', 'docs-only');

    expect(holder.reads).toBe(1);
    expect(targetSpy).toHaveBeenCalledTimes(1);
    expect(targetSpy).toHaveBeenCalledWith({ deny: SELF_PROTECTION_DENY, allowOnly: ['docs/'] }, 'docs-only');
    expect(bystanderSpy).not.toHaveBeenCalled();
    expect(target.activeCustomModeId).toBe('docs-only');
    expect(bystander.activeCustomModeId).toBeNull();
    expect(emitted).toEqual([
      {
        type: 'mode.state',
        sessionId: 'session-1',
        modeId: 'docs-only',
        available: [
          { id: 'docs-only', name: 'Docs only' },
          { id: 'other', name: 'Other' },
        ],
      },
    ]);
  });

  it('an unknown modeId resolves to null (snapshot undefined) while the catalog still ships — fail-safe, never a partial floor', () => {
    const { actions, sessions, emitted } = makeScope([DOCS_ONLY]);
    const target = sessions.open('session-1', '/ws', makeSessionHostPort());
    const targetSpy = vi.spyOn(target, 'setCustomMode');

    actions.setCustomMode('session-1', 'ghost-mode');

    expect(targetSpy).toHaveBeenCalledWith(undefined, null);
    expect(target.activeCustomModeId).toBeNull();
    expect(emitted).toEqual([
      { type: 'mode.state', sessionId: 'session-1', modeId: null, available: [{ id: 'docs-only', name: 'Docs only' }] },
    ]);
  });

  it('modeId=null clears the active mode', () => {
    const { actions, sessions, emitted } = makeScope([DOCS_ONLY]);
    const target = sessions.open('session-1', '/ws', makeSessionHostPort());
    actions.setCustomMode('session-1', 'docs-only');
    emitted.length = 0;

    actions.setCustomMode('session-1', null);

    expect(target.activeCustomModeId).toBeNull();
    expect(emitted).toEqual([
      { type: 'mode.state', sessionId: 'session-1', modeId: null, available: [{ id: 'docs-only', name: 'Docs only' }] },
    ]);
  });

  it('an unknown sessionId is a no-op — no settings read, no emit', () => {
    const { actions, emitted, holder } = makeScope([DOCS_ONLY]);

    expect(() => actions.setCustomMode('ghost-session', 'docs-only')).not.toThrow();

    expect(holder.reads).toBe(0);
    expect(emitted).toEqual([]);
  });
});

describe('SessionScopeActions.handleCustomModesConfigChanged — the self-widening close, at the domain level', () => {
  it('no session with an active mode → nothing to protect: no warning, no read, no emit', () => {
    const { actions, sessions, emitted, warnings, holder } = makeScope([DOCS_ONLY]);
    sessions.open('session-1', '/ws', makeSessionHostPort());

    actions.handleCustomModesConfigChanged();

    expect(warnings).toEqual([]);
    expect(holder.reads).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('an active mode → ONE warning, ONE re-read, a mode.state per AFFECTED session with the UNCHANGED modeId and the REFRESHED catalog — and no re-snapshot', () => {
    const { actions, sessions, emitted, warnings, holder } = makeScope([DOCS_ONLY]);
    const affected = sessions.open('session-1', '/ws', makeSessionHostPort());
    sessions.open('session-2', '/ws', makeSessionHostPort()); // no active mode — must NOT get a mode.state
    actions.setCustomMode('session-1', 'docs-only');
    const affectedSpy = vi.spyOn(affected, 'setCustomMode');
    emitted.length = 0;
    holder.reads = 0;

    // The on-disk definition widens (no allowOnly) and a new mode appears.
    holder.configs = [{ id: 'docs-only', name: 'Docs only' }, { id: 'new', name: 'New' }];
    actions.handleCustomModesConfigChanged();

    expect(warnings).toEqual([
      "A custom mode's definition changed on disk. The active session keeps enforcing the previously-selected definition — re-select the mode to apply changes.",
    ]);
    expect(holder.reads).toBe(1);
    expect(affectedSpy).not.toHaveBeenCalled(); // enforcement did not move — snapshot-on-activate only
    expect(affected.activeCustomModeId).toBe('docs-only');
    expect(emitted).toEqual([
      {
        type: 'mode.state',
        sessionId: 'session-1',
        modeId: 'docs-only',
        available: [
          { id: 'docs-only', name: 'Docs only' },
          { id: 'new', name: 'New' },
        ],
      },
    ]);
  });
});
