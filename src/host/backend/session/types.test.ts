import { describe, it, expect } from 'vitest';
import { RootCoordinator } from '../../checkpoints/RootCoordinator';
import type { AcpClientLike, AcpLoadSessionResult } from '../acp/acpClient';
import type { SessionHostPort } from './types';

/**
 * W6-FE Part 3 (3-way ARCH I-3b) — proves `SessionHostPort.emit` really is
 * constrained to `SessionScoped<HostToWebviewMessage>` at compile time (not
 * merely documented as a convention): a genuinely UNSCOPED message
 * (`system.error`, no `sessionId`) is REJECTED by `emit`, while the
 * connection-global escape hatch (`emitSystemError`) exists precisely
 * because `emit` can no longer carry it.
 */

class FakeAcpClient implements AcpClientLike {
  async connect(): Promise<void> {}
  async initialize(): Promise<void> {}
  async newSession(): Promise<{ sessionId: string; currentModeId: string }> {
    return { sessionId: 'unused', currentModeId: 'default' };
  }
  async prompt(): Promise<{ stopReason: string }> {
    return { stopReason: 'end_turn' };
  }
  async cancel(): Promise<void> {}
  async setSessionMode(): Promise<void> {}
  async setSessionModel(): Promise<void> {}
  async listSessions(): Promise<{ sessions: never[] }> {
    return { sessions: [] };
  }
  async loadSession(): Promise<AcpLoadSessionResult> {
    return { found: true, currentModeId: 'default' };
  }
  onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  dispose(): void {}
}

describe('SessionHostPort.emit — constrained to SessionScoped<HostToWebviewMessage> (compile-time proof)', () => {
  it('rejects a deliberately-unscoped `system.error` at `port.emit` — the SAME check `check-types` runs on every real call site', () => {
    const client = new FakeAcpClient();
    const port: SessionHostPort = {
      getClient: () => client,
      emit: () => undefined,
      emitSystemError: () => undefined,
      root: new RootCoordinator('/ws', undefined),
      workspaceRoots: () => [],
      refreshCheckpointsPanel: () => undefined,
      resolveMentions: async () => [],
    };

    // `system.error` carries NO `sessionId` (it is connection-global by
    // design — a banner across every tab). Before Part 3, `emit` accepted
    // any `HostToWebviewMessage` and this compiled clean; a controller
    // could emit an unscoped message straight into the shared connection
    // emitter. Now it is a compile error — this is the failure mode Part 3
    // closes, demonstrated once here (not a real production call site).
    // Verified non-vacuous: deleting this directive makes `check-types`
    // fail with TS2322 "'system.error' is not assignable to ... 'clear' |
    // 'turn.start' | ... " (the SessionScopedMessage discriminant list).
    // @ts-expect-error — argument not assignable to SessionScopedMessage (no `sessionId`).
    port.emit({ type: 'system.error', message: 'unscoped — must not compile' });

    // The sanctioned escape hatch for exactly this case: no sessionId
    // parameter to spuriously stamp, so nothing to get wrong.
    port.emitSystemError('this compiles — the dedicated connection-global path');

    // A genuinely session-scoped message compiles fine through `emit`.
    port.emit({ type: 'clear', sessionId: 'session-a' });

    expect(port).toBeDefined();
  });
});
