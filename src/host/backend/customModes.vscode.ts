import * as vscode from 'vscode';
import type { CustomModeConfig } from '../../shared/protocol';
import { parseCustomModes } from './customModes';

/**
 * W4-T4b / R4-ARCH-01 — the vscode ADAPTER for SF-2 custom modes: the ONLY
 * module that reads `talaria.customModes`, and the only place a rule-ingest
 * warning becomes a toast. Everything else (validation, the warnings' text,
 * the `ModeFloor` snapshot, the wire catalog) is the vscode-free core in
 * `customModes.ts`. Mirrors `src/autocomplete/config.ts`'s read pattern and
 * this repo's `<name>.vscode.ts` adapter naming (`purityScan.ts`'s tiering).
 *
 * `control/` must NEVER value-import this module — it reaches the read
 * through the injected `SessionScopePort.readCustomModes` port instead;
 * `control/controlHeadless.lock.test.ts` proves the tier stays headless.
 */

const CUSTOM_MODES_SECTION = 'talaria.customModes';

/**
 * B10 / §4.1: read the WORKSPACE value SPECIFICALLY via `inspect()`, never
 * the merged `.get()`. VS Code's configuration override chain is
 * `default -> global -> workspace -> workspaceFolder` and `.get()` returns
 * the EFFECTIVE (already-overridden) value — so a FOLDER-level value would
 * silently take precedence over the workspace-level one `.get()` returns.
 * `.inspect().workspaceValue` is the security-relevant choice: a per-folder
 * override in a multi-root workspace must not be able to silently WIDEN a
 * workspace-level mode's floor, so folder overrides are IGNORED entirely.
 * Validation and the malformed-rule warnings are `parseCustomModes`'s
 * (core); this adapter only supplies the raw value and the toast sink.
 */
export function readCustomModes(): CustomModeConfig[] {
  const inspected = vscode.workspace.getConfiguration().inspect<unknown>(CUSTOM_MODES_SECTION);
  return parseCustomModes(inspected?.workspaceValue, (message) => {
    void vscode.window.showWarningMessage(message);
  });
}
