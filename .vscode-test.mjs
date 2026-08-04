// .vscode-test.mjs — pinned version (a floating 'stable' can redden the gate
// on an unrelated VS Code release); NO workspaceFolder (no folder ⇒ no trust
// prompt AND the backend-agnostic LIB gate stays off: shouldActivateLib
// requires a workspace — src/host/trustGate.ts); user-data wiped by
// pretest:integration for profile determinism.
import { defineConfig } from '@vscode/test-cli';
export default defineConfig({
  files: 'out-inttest/**/*.test.js',
  version: '1.125.0',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'tdd', timeout: 240_000, color: true }, // > 90+30+15s internal waits
});
