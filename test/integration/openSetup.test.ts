import * as assert from 'assert';
import * as vscode from 'vscode';

/** Structural mirror of src/host/testApi.ts (inttest tsconfig stays out of src/). */
type PanelFetchCause = 'activate' | 'hydrate' | 'user';
interface TalariaTestApi {
  whenWebviewReady(timeoutMs?: number): Promise<void>;
  panelFetchCount(panel: string, cause?: PanelFetchCause): number;
  waitForPanelFetch(panel: string, opts?: { minCount?: number; cause?: PanelFetchCause; timeoutMs?: number }): Promise<{ ok: boolean; hasData: boolean }>;
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
});
