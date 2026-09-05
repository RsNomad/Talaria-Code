import { describe, it, expect, vi } from 'vitest';

/** `ControlDispatcher.ts` pulls in `./customModes.ts`, which imports `vscode` at module scope — same `vi.mock` as `ControlDispatcher.golden.admin.test.ts`. */
vi.mock('vscode', () => ({}));

import { ControlDispatcher } from './ControlDispatcher';
import { makePort, makeFakeAdminClient, makeFakeDashboard } from './ControlDispatcher.golden.harness';

/**
 * AU-59 Task 3 interim pin — REPLACED by Task 5's orchestration suite. Until
 * the env-store methods and the config-first sequence exist, a crafted
 * `mcp.add` carrying secret names must fail CLOSED: validated, then refused
 * BEFORE any modal or network call — never "validated, shown in the modal,
 * then silently added without the secrets".
 */
describe('mcp.add secretEnvNames — T3 interim fail-closed guard', () => {
  it('a non-empty secretEnvNames is refused AFTER validation and BEFORE any modal/network call', async () => {
    const client = makeFakeAdminClient();
    let confirmCalls = 0;
    const { port } = makePort({
      getDashboard: () => makeFakeDashboard(client),
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
    });
    const dispatcher = new ControlDispatcher(port);

    await expect(
      dispatcher.invokeControl('mcp.add', {
        name: 'gh',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        secretEnvNames: ['GITHUB_TOKEN'],
      }),
    ).rejects.toThrow(/not yet stored by this build/);
    expect(confirmCalls).toBe(0);
    expect(client.calls.addMcpServer).toEqual([]);
  });
});
