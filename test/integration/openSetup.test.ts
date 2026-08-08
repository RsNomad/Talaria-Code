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

/**
 * T15 (beta.6): narrow local shapes for the wire-shape slices this task
 * asserts on — S-F15 discipline (same as {@link SetupDataOsSlice}): extract
 * ONLY the fields under test, never widen towards the full `SetupData`
 * (which can carry user-typed endpoint URLs with embedded userinfo).
 */
interface SetupDataCatalogSlice {
  catalog?: { models?: { role: string; defaultForRole?: boolean }[] };
}
interface SetupDataLlamacppRuntimeSlice {
  llamacppRuntime?: { binary?: string };
}
interface SetupDataAgentLocalModelSlice {
  agentLocalModel?: { endpointDefaults?: { ollama?: string; llamacpp?: string; vllm?: string } };
}
interface SetupDataRagSlice {
  rag?: { endpointDefaults?: { ollama?: string; llamacpp?: string; 'openai-compat'?: string } };
}
type SetupDataT15Slice = SetupDataCatalogSlice &
  SetupDataLlamacppRuntimeSlice &
  SetupDataAgentLocalModelSlice &
  SetupDataRagSlice;

/** `SetupData.llamacppRuntime.binary`'s enum — mirrors `src/shared/protocol.ts`
 *  (do not hardcode a guessed set independent of the wire type). */
const LLAMACPP_BINARY_STATES = ['checking', 'found', 'missing', 'unknown'] as const;

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

  // Task T15 (beta.6): build-blind proof that the beta.6 wire shape — the
  // verified model catalog, the llama.cpp runtime memo, and the host-owned
  // endpoint defaults — reaches the panel through the REAL
  // `SetupController.status()`, not just unit fixtures. These fields are
  // platform-INDEPENDENT (static catalog + host-owned constants), so unlike
  // the OS-detection test above they are NOT OS-gated — they must hold on
  // both win32 (this box) and linux (CI, ubuntu-latest).
  test('getSetupData() exposes the beta.6 wire shape — catalog, defaultForRole, llamacpp/rag/agent endpoint defaults (T15)', async () => {
    const ext = vscode.extensions.getExtension('syntinal.talaria-code');
    assert.ok(ext, 'extension syntinal.talaria-code not found in the test host');
    const api = (await ext.activate()) as TalariaTestApi | undefined;
    assert.ok(api, 'activate() returned no TalariaTestApi — extensionMode was not Test?');

    await api.whenWebviewReady(90_000);

    // S-F15: extract ONLY the four field groups this test asserts on — never
    // the whole snapshot (it can carry user-typed endpoint URLs).
    const data = (await api.getSetupData()) as SetupDataT15Slice;

    // 1. Catalog reaches the wire as `catalog.models`, all 13 rows.
    const models = data.catalog?.models;
    assert.ok(Array.isArray(models), 'expected catalog.models to be an array');
    assert.strictEqual(models.length, 13, `expected 13 catalog rows on the wire, got ${models.length}`);

    // 2. llamacppRuntime.binary is one of its allowed enum values.
    const binary = data.llamacppRuntime?.binary;
    assert.ok(
      binary !== undefined && (LLAMACPP_BINARY_STATES as readonly string[]).includes(binary),
      `expected llamacppRuntime.binary to be one of ${LLAMACPP_BINARY_STATES.join('/')}, got "${String(binary)}"`,
    );

    // 3. agentLocalModel.endpointDefaults (CC-6) is always populated.
    const agentDefaults = data.agentLocalModel?.endpointDefaults;
    assert.ok(agentDefaults !== undefined, 'expected agentLocalModel.endpointDefaults to be present');
    for (const key of ['ollama', 'llamacpp', 'vllm'] as const) {
      const value = agentDefaults[key];
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `expected agentLocalModel.endpointDefaults.${key} to be a non-empty string, got ${JSON.stringify(value)}`,
      );
    }

    // 4. rag.endpointDefaults (panel-fix PT2) mirrors the agent defaults'
    // CC-6 pattern exactly — host-owned, never webview-fabricated.
    const ragDefaults = data.rag?.endpointDefaults;
    assert.ok(ragDefaults !== undefined, 'expected rag.endpointDefaults to be present');
    assert.strictEqual(ragDefaults.ollama, 'http://127.0.0.1:11434', 'rag.endpointDefaults.ollama mismatch');
    assert.strictEqual(ragDefaults.llamacpp, 'http://127.0.0.1:8081', 'rag.endpointDefaults.llamacpp mismatch');
    assert.strictEqual(
      ragDefaults['openai-compat'],
      'http://127.0.0.1:8000',
      "rag.endpointDefaults['openai-compat'] mismatch",
    );

    // 5. Exactly one `defaultForRole` row per role (4 roles, 4 defaults,
    // derived from the wire — not a hardcoded role list).
    const defaultsByRole = new Map<string, number>();
    const rolesSeen = new Set<string>();
    for (const model of models) {
      rolesSeen.add(model.role);
      if (model.defaultForRole === true) {
        defaultsByRole.set(model.role, (defaultsByRole.get(model.role) ?? 0) + 1);
      }
    }
    assert.strictEqual(rolesSeen.size, 4, `expected 4 distinct catalog roles on the wire, got ${rolesSeen.size}`);
    for (const role of rolesSeen) {
      assert.strictEqual(
        defaultsByRole.get(role),
        1,
        `expected exactly one defaultForRole===true row for role "${role}", got ${defaultsByRole.get(role) ?? 0}`,
      );
    }
  });
});
