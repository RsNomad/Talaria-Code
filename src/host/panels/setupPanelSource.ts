import type { SetupData } from '../../shared/protocol';
import type { PanelFetchOutcome, PanelSource } from './PanelSourceRegistry';

/**
 * The narrow shape {@link SetupPanelSource} needs from `SetupController`
 * (Task 9) — declared locally so this module never imports `SetupController`
 * itself (which would pull the whole Task 3-7 engine surface into every
 * caller of this tiny file for no reason; structural typing makes the real
 * controller satisfy this interface for free).
 */
export interface SetupStatusSource {
  status(): Promise<SetupData>;
}

/**
 * `'setup'` panel source (Task 9, plan §6/§8) — the standard `PanelSource
 * <'setup'>` wrapper around `SetupController.status()`, following the exact
 * pattern every other panel source in this directory uses
 * (`ToolsPanelSource`, `SettingsPanelSource`, ... in `panelSources.ts`).
 *
 * NOT registered onto `PanelSourceRegistry` the way those are: that registry
 * is constructed fresh PER `AcpBackend` INSTANCE (`AcpBackend.panelSources`)
 * and has no equivalent under `MockBackend` — but Setup must render and
 * accept `setup.*` requests under EITHER backend (the mock default is
 * exactly when first-run auto-open fires, §6 entry point 1). So this source
 * is instead constructed once in `TalariaViewProvider` (alongside the
 * `SetupController` itself) and consulted directly from
 * `handleControlRequest`'s `nextEdit.toggle`-style special-case — the same
 * "host-internal, works with no agent" posture `nextEdit.toggle` already
 * has (F-7 lesson: control must work with no agent). It still satisfies the
 * REAL `PanelSource<'setup'>` interface (pure, injectable, independently
 * testable) rather than being an ad-hoc inline closure.
 */
export class SetupPanelSource implements PanelSource<'setup'> {
  constructor(private readonly controller: SetupStatusSource) {}

  async fetch(): Promise<PanelFetchOutcome<'setup'>> {
    return { data: await this.controller.status() };
  }
}
