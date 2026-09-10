import { describe, it, expect } from 'vitest';
import { collectNonTestTsSources } from '../../purityScan';

/**
 * R4-ARCH-01 — the TRANSITIVE headless-importability lock for `control/`.
 * `policyAcpPurity.test.ts` bans a DIRECT `from 'vscode'` under `control/`
 * by text scan; it cannot see a value-import of a neighbour that itself
 * imports `vscode` (the exact false-green R4-ARCH-01 named:
 * `sessionScopeActions.ts` → `customModes.ts` → `vscode`). This file closes
 * that gap the only way a text scan cannot be fooled: it VALUE-IMPORTS every
 * non-test module under `control/` with NO `vi.mock('vscode')` anywhere on
 * its graph. Vitest has no `vscode` alias, so ANY transitive edge to it —
 * direct or through any neighbour at any depth — fails this file at load
 * time (the R3 T6 / `nextEditRoute.test.ts` idiom, widened to the tier).
 *
 * Named-list idiom (`reuseLocks.test.ts`): the static import list below is
 * checked against the REAL directory walk, so a new `control/*.ts` that is
 * not listed here fails the completeness test with the missing name — it
 * cannot be silently unlocked. Keep the two lists in lockstep.
 */
import './adminOpRunner';
import './checkpointActions';
import './configWriteTail';
import './ControlDispatcher';
import './ControlDispatcher.golden.harness';
import './dashboardToggles';
import './mcpAdminHandler';
import './mcpEntryValidation';
import './panelDataCoordinator';
import './sessionScopeActions';
import './skillsAdminHandler';
import './skillSourceGate';

const HEADLESS_IMPORTED: readonly string[] = [
  'adminOpRunner.ts',
  'checkpointActions.ts',
  'configWriteTail.ts',
  'ControlDispatcher.ts',
  'ControlDispatcher.golden.harness.ts',
  'dashboardToggles.ts',
  'mcpAdminHandler.ts',
  'mcpEntryValidation.ts',
  'panelDataCoordinator.ts',
  'sessionScopeActions.ts',
  'skillsAdminHandler.ts',
  'skillSourceGate.ts',
];

describe('R4-ARCH-01: control/ is headless-importable (every module value-imported above with NO vscode mock)', () => {
  it('non-vacuous: the walk finds the two modules the finding named', () => {
    const walked = collectNonTestTsSources(__dirname).map((f) => f.file);
    expect(walked).toContain('sessionScopeActions.ts');
    expect(walked).toContain('ControlDispatcher.ts');
  });

  it('completeness: the static import list equals the REAL non-test control/ file set — a new file must be imported here too', () => {
    const walked = collectNonTestTsSources(__dirname)
      .map((f) => f.file)
      .sort();
    expect(walked).toEqual([...HEADLESS_IMPORTED].sort());
  });
});
