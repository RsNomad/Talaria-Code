import type { HostToWebviewMessage } from '../shared/protocol';

/**
 * Task 11 (A) — the entry-points slice: "existing backend-failure surface
 * gains one 'Open Backend Setup' action" (plan §6 entry point 2).
 *
 * The ONLY host-emitted backend-failure signal that exists today is
 * `system.error` — fired by `ConnectionSupervisor.startInternal`'s catch
 * block on a `resolveHermes` throw, a spawn failure, or an `initialize()`
 * failure (`src/host/backend/connection/ConnectionSupervisor.ts:387-390`,
 * "Hermes failed to start: …"), and relayed to the webview by
 * `TalariaViewProvider`'s `backend.onMessage` subscription as a
 * connection-wide banner. This module taps the SAME event (structurally —
 * anything shaped like `{onMessage(listener)}`, so `extension.ts` can pass
 * the real `AgentBackend` without this file importing it or `vscode`) and
 * ALSO shows a native `showErrorMessage` with an "Open Backend Setup"
 * action, so a failure that happens before the user ever opens the panel
 * still has a path INTO it.
 *
 * "backend unconfigured" (the brief's 4th failure case) does not fire
 * `system.error` — it is the pre-existing first-run auto-open (§6 entry
 * point 1, wired in Task 9), not a failure notification, so it is out of
 * scope here by design (see task-11-report.md).
 *
 * PURE / structurally-typed — no `vscode` import, no `AgentBackend` import
 * — so this is unit-testable with plain fakes (`backendFailureNudge.test
 * .ts`) instead of a `vscode` mock. `extension.ts` supplies the real
 * `vscode.window.showErrorMessage` + `vscode.commands.executeCommand(
 * 'talaria.openSetup')` (the brief's "reuse the talaria.openSetup command
 * path" — never a direct `provider.openSetupPanel()` call from here).
 */

export interface BackendFailureNudgeSource {
  onMessage(listener: (message: HostToWebviewMessage) => void): { dispose(): void };
}

export interface BackendFailureNudgeHost {
  /** `vscode.window.showErrorMessage(message, action)` — resolves the
   *  clicked action's label, or `undefined` on dismiss. */
  showErrorMessage(message: string, action: string): Promise<string | undefined> | Thenable<string | undefined>;
  /** `vscode.commands.executeCommand('talaria.openSetup')` — the command
   *  path, never a direct panel-reveal call (keeps this module decoupled
   *  from `TalariaViewProvider`). */
  openSetup(): void;
}

const ACTION_LABEL = 'Open Backend Setup';

export function wireBackendFailureNudge(
  source: BackendFailureNudgeSource,
  host: BackendFailureNudgeHost,
): { dispose(): void } {
  return source.onMessage((message) => {
    if (message.type !== 'system.error') return;
    void Promise.resolve(host.showErrorMessage(message.message, ACTION_LABEL)).then((choice) => {
      if (choice === ACTION_LABEL) host.openSetup();
    });
  });
}
