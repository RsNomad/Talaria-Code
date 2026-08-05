import * as assert from 'assert';
import * as vscode from 'vscode';

/** Structural mirror of src/host/testApi.ts (inttest tsconfig stays out of src/). */
type PanelFetchCause = 'activate' | 'hydrate' | 'user';
interface TalariaTestApi {
  whenWebviewReady(timeoutMs?: number): Promise<void>;
  panelFetchCount(panel: string, cause?: PanelFetchCause): number;
  waitForPanelFetch(panel: string, opts?: { minCount?: number; cause?: PanelFetchCause; timeoutMs?: number }): Promise<{ ok: boolean; hasData: boolean }>;
  /** T16 (§5.5, S-F15): live `SetupController.status()` snapshot, untyped —
   *  never `.handle()`, never logged/asserted wholesale (userinfo-bearing
   *  endpoint URLs may be present). */
  getSetupData(): Promise<unknown>;
}

/** Narrow local shape for the ONE field group T16 asserts on — deliberately
 *  not the full `SetupData` (S-F15: never widen what this test touches). */
interface SetupDataOsSlice {
  os?: { family?: string; manager?: string };
}

suite('Talaria Code — activation + open-Setup smoke (beta.3 regression guard)', () => {
  test('activates; talaria.openSetup lands the webview on Setup (cold AND live paths)', async () => {
    const ext = vscode.extensions.getExtension('syntinal.talaria-code');
    assert.ok(ext, 'extension syntinal.talaria-code not found in the test host');
    const api = (await ext.activate()) as TalariaTestApi | undefined;
    assert.ok(api, 'activate() returned no TalariaTestApi — extensionMode was not Test?');

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('talaria.openSetup'), 'talaria.openSetup not registered');

    // COLD path: a trigger='hydrate' setup fetch can ONLY come from the
    // initialPanel-latch boot (first-run auto-open or our command — same code
    // path; cause-attribution makes profile freshness irrelevant).
    await vscode.commands.executeCommand('talaria.openSetup');
    await api.whenWebviewReady(90_000);
    const cold = await api.waitForPanelFetch('setup', { cause: 'hydrate', minCount: 1, timeoutMs: 30_000 });
    assert.ok(cold.ok && cold.hasData, `cold path: ok=${cold.ok} hasData=${cold.hasData} — Setup did not boot with a real SetupData snapshot`);

    // LIVE path: a trigger='activate' fetch can ONLY come from the webview
    // processing a live panel.activate. Count sampled per-cause ⇒ no
    // confusion with any in-flight cold fetch.
    const n = api.panelFetchCount('setup', 'activate');
    await vscode.commands.executeCommand('talaria.openSetup');
    const live = await api.waitForPanelFetch('setup', { cause: 'activate', minCount: n + 1, timeoutMs: 15_000 });
    assert.ok(live.ok && live.hasData, `live path: ok=${live.ok} hasData=${live.hasData} — live webview did not process panel.activate`);
  });

  // Task T16 (§7/§5.5): build-blind proof that the OS-detection engine
  // resolves LIVE through the real extension (real fs binding), not just
  // unit fixtures. Reuses the extension activated by the test above — VS
  // Code only runs activate() once, and the export is history-buffered, so
  // whenWebviewReady() resolves immediately here.
  test('getSetupData() resolves the live OS engine (T16 — CI: debian/apt-get on ubuntu-latest)', async () => {
    const ext = vscode.extensions.getExtension('syntinal.talaria-code');
    assert.ok(ext, 'extension syntinal.talaria-code not found in the test host');
    const api = (await ext.activate()) as TalariaTestApi | undefined;
    assert.ok(api, 'activate() returned no TalariaTestApi — extensionMode was not Test?');

    await api.whenWebviewReady(90_000);

    // S-F15: never log or assert the whole snapshot (it can carry
    // user-typed endpoint URLs with embedded userinfo) — extract ONLY the
    // two os fields this test needs.
    const data = (await api.getSetupData()) as SetupDataOsSlice;
    const family = data.os?.family;
    const manager = data.os?.manager;

    if (process.platform === 'linux') {
      // CI = ubuntu-latest -> /etc/os-release ID=ubuntu resolves through
      // osDetect's family map to 'debian' / 'apt-get'. NO bootstrap-command
      // assertion here: the pipx-missing card (and its composed bootstrap
      // command) is a state this smoke never drives the extension into, so
      // it is unreachable on CI (C-15) — os.family/os.manager are the whole
      // claim.
      assert.strictEqual(family, 'debian', `expected os.family "debian" on linux CI, got "${String(family)}"`);
      assert.strictEqual(manager, 'apt-get', `expected os.manager "apt-get" on linux CI, got "${String(manager)}"`);
    } else if (process.platform === 'win32') {
      // setupHost.vscode.ts's readOsRelease seam short-circuits to `{}` on
      // win32 (the dev-gate host) — the controller degrades to 'unknown'.
      assert.strictEqual(family, 'unknown', `expected os.family "unknown" on win32, got "${String(family)}"`);
    }
  });
});
