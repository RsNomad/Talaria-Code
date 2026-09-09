import { bridge } from './bridge';
import { requestShaped } from './rpcShaped';
import { unwrapSetupResult } from './state/panels';
import {
  isHubInstallResult,
  isHubPreview,
  isHubScan,
  isMcpAddResult,
  isMcpCatalogData,
  isMcpCatalogInstallResult,
  isMcpTestResult,
} from './shapeGuards';
import type {
  ControlMethod,
  HubInstallResult,
  HubPreview,
  HubScan,
  McpAddParams,
  McpAddResult,
  McpCatalogData,
  McpCatalogInstallParams,
  McpCatalogInstallResult,
  McpTestResult,
  NextEditToggleSource,
  SetupMethod,
  SkillCreateParams,
} from './protocol';

/*
 * WS-F1 F1-4 (FI-04 god-component close): the 18 App.tsx handlers that
 * closed over NOTHING component-scoped — moved here verbatim (bodies + their
 * existing doc comments, unchanged wire method/params/tag), grouped by
 * domain in their original App() declaration order.
 *
 * Connection-global (`PANEL_SCOPE === 'global'`) correlated actions.
 * Invariant F-1: every request here is UNTAGGED. Enforced BY SCOPE — this
 * module imports no React, takes no `TabState`, has no `tab` identifier; a
 * `tab.tabId` tag cannot be written here without changing the module's
 * signature.
 */

// CF-13/D1: the Models panel's "Add key" affordance — posts ONLY the
// provider slug. The host prompts for the key directly (masked) and
// dispatches `model.save_key`; the key never enters the webview.
export const onAddProviderKey = (slug: string) => bridge.post({ type: 'model.addKey', slug });

// Correlated toggle (W1.5): the Skills/Tools switches persist through the
// dashboard REST channel and need the resolved/rejected result so the panel
// can do optimistic write-through with rollback-on-error. Returns the
// promise. F-1 (final-4way-fixes.md): Tools/Skills toggles are connection-
// global (`tools`/`skills` own no single tab, per the panel-scope
// taxonomy) — UNTAGGED, so closing an unrelated tab can never reject this
// in-flight write and trigger a false optimistic-rollback.
export const toggle = (method: ControlMethod, params: Record<string, unknown>) =>
  bridge.request(method, params);

// A#5: MCP "Reload servers" over the CORRELATED path so the gateway's result
// (`{status, message?}`) — or a failure — becomes visible in the panel,
// instead of the old fire-and-forget that dropped both. The host still
// re-fetches + re-pushes the server list when the reload actually
// confirmed. F-1: `mcp` is connection-global (owns no tab) — UNTAGGED.
export const reloadMcp = () => bridge.request('reload.mcp', { confirm: true });

// Task A7 (§4.9): the MCP admin RPCs `McpPanel`'s row actions + Add-server
// form drive. All correlated (`bridge.request`), same F-1 posture as
// `reloadMcp`/`toggle` above — `mcp` is connection-global, so these are
// UNTAGGED. `addMcpServer`/`testMcpServer`/`authMcpServer` now GUARD the
// resolved value onto its known shape via `requireShape` (WS-BG), the same
// `restoreCheckpoint`/`redoCheckpoint` idiom above (`bridge.request` itself
// only promises `unknown` — the host's real return shape is the wire
// contract).
export const addMcpServer = (params: McpAddParams): Promise<McpAddResult> =>
  requestShaped('mcp.add', params, isMcpAddResult);
export const testMcpServer = (name: string): Promise<McpTestResult> =>
  requestShaped('mcp.test', { name }, isMcpTestResult);
export const removeMcpServer = (name: string) => bridge.request('mcp.remove', { name });
export const setMcpServerEnabled = (name: string, enabled: boolean) =>
  bridge.request('mcp.setEnabled', { name, enabled });
// Task A8 (§4.8): drives the panel's per-row `Login` button.
export const authMcpServer = (name: string): Promise<McpTestResult> =>
  requestShaped('mcp.auth', { name }, isMcpTestResult);
// Task A8 (§4.7): the Catalog disclosure's fetch (read-only, not trust-
// gated — fired at most once per panel mount, on first expand) and its
// `Install` action. Same untagged/guarded posture as the other MCP admin
// RPCs above — `mcp` is connection-global.
export const mcpCatalog = (): Promise<McpCatalogData> => requestShaped('mcp.catalog', {}, isMcpCatalogData);
export const mcpCatalogInstall = (p: McpCatalogInstallParams): Promise<McpCatalogInstallResult> => {
  // `bridge.request` wants `Record<string, unknown>`; unlike `McpAddParams`
  // (a `type` alias, structurally weak against an index signature),
  // `McpCatalogInstallParams` is an `interface` — TS never infers an
  // implicit index signature for those, so the params are rebuilt as a
  // fresh object literal here (the same posture `restoreCheckpoint` above
  // uses for its own `Record<string, unknown>` params).
  // Rev-1 B4 (CF-13 parity): no `env` field at all — the webview never
  // collects a credential value; the host prompts for each of the entry's
  // `required_env` vars itself, masked, after the consent modal.
  const wireParams: Record<string, unknown> = { name: p.name };
  return requestShaped('mcp.catalogInstall', wireParams, isMcpCatalogInstallResult);
};

// Task B6 (§5.6): the T2 skills admin RPCs `SkillsPanel`'s Create/Install-
// from-hub disclosures and hub-row Remove button drive. Same untagged/guarded
// posture as the MCP admin RPCs above — `skills` is connection-global
// (`skills.toggle` above already is untagged), so these are UNTAGGED too.
// `createSkill` rebuilds `params` as a fresh `Record<string, unknown>`
// object literal (the same `mcpCatalogInstall` posture immediately above)
// — `SkillCreateParams` is an `interface`, so TS never infers an implicit
// index signature for it the way it does for `McpAddParams`'s `type` alias.
export const createSkill = (params: SkillCreateParams) => {
  const wireParams: Record<string, unknown> = { name: params.name, content: params.content };
  if (params.category !== undefined) wireParams.category = params.category;
  return bridge.request('skills.create', wireParams);
};
export const previewHubSkill = (identifier: string): Promise<HubPreview> =>
  requestShaped('skills.hubPreview', { identifier }, isHubPreview);
export const scanHubSkill = (identifier: string): Promise<HubScan> =>
  requestShaped('skills.hubScan', { identifier }, isHubScan);
export const installHubSkill = (identifier: string): Promise<HubInstallResult> =>
  requestShaped('skills.hubInstall', { identifier }, isHubInstallResult);
export const uninstallHubSkill = (name: string) => bridge.request('skills.hubUninstall', { name });

// D3/N13: SettingsPanel's `config.set` over the CORRELATED path (the same
// `toggle` pattern above) so a rejected/failed write resolves/rejects and
// the row can roll back instead of lying — replaces the old fire-and-
// forget `invoke('config.set', …)`, whose effect was only ever observable
// through a server-initiated `panel.data` push that doesn't exist today.
// F-1 (the Important finding this fix brief exists for): `settings` is
// connection-global — this MUST be UNTAGGED. Tagging it with `tab.tabId`
// (the pre-fix bug) meant closing tab A while a `config.set` issued from
// tab A was still in flight rejected the promise via `rejectByTag`, even
// though the host went on to persist the write — SettingsPanel then ran
// its rollback and showed "Not saved" for a value that WAS saved.
export const setConfig = (key: string, value: string | number | boolean) =>
  bridge.request('config.set', { key, value });

// R5 (Task 13): the «Next Edit Suggestions» toggles, over the HOST-INTERNAL
// correlated `nextEdit.toggle` request — special-cased in the host router
// before backend dispatch, so this never reaches Hermes (the toggles are
// extension state, not agent config). Resolves with the newly ratified
// state; REJECTS with the Guard's refusal message, which is what makes the
// row's `rollbackField` snap the switch back and show the reason.
//
// F-1: the toggle store is CONNECTION-GLOBAL (one per extension, owned by
// no chat tab) — this MUST be UNTAGGED, exactly like `setConfig` above. A
// `tab.tabId` tag here would let an unrelated tab close reject a legitimate
// in-flight toggle via `rejectByTag`, and the row would then show a refusal
// for a toggle the Guard actually ratified. Locked in `rpc.test.ts`.
export const setNextEditToggle = (source: NextEditToggleSource, on: boolean) =>
  bridge.request('nextEdit.toggle', { source, on });

// Task 10: the Setup / Talaria Config panel's single mutating-action
// dispatcher — every `SetupMethod` (install/apply/setApiKey/testRemote/
// pullModel/cancel/openProviderWizard/openInstallTerminal/recheck/
// setNextEdit/setRag/setTunable) rides this ONE correlated request, mirroring
// `setConfig`/`toggle` above. F-1: CONNECTION-GLOBAL (installing a backend
// or pulling a model belongs to no one chat tab) — UNTAGGED, so closing an
// unrelated tab can never reject an in-flight Setup mutation. The host
// re-pushes a fresh `panel.data{panel:'setup'}` on every accepted mutation
// (mirrors `reload.mcp`/`model.save_key`'s "dispatch -> refetch -> push"
// precedent — see `SetupController.handle`'s own doc), so this panel needs
// no manual re-fetch after a successful call.
//
// T2 (§0.1 ②, §2.2.4 — corrects the previous docstring here, which was
// silent on refusals): a controller REFUSAL is `ok:true` at the RPC
// TRANSPORT layer (the request itself succeeded) carrying `result:
// {ok:false, reason}` — so the raw `bridge.request(...)` promise used to
// RESOLVE on a refusal, and `ActionButton`'s error state never fired.
// Routed through `unwrapSetupResult` so this dispatcher has the SAME
// resolve/reject contract as `setConfig`/`setNextEditToggle` above: an
// accepted mutation resolves with its result, a refusal REJECTS with
// `reason` (or a default message) — except `reason: 'declined'` (the user
// dismissed a native confirmation modal), which resolves to the `DECLINED`
// sentinel instead of either (not an error, not a success to label).
export const dispatchSetup = (method: SetupMethod, params?: Record<string, unknown>) =>
  bridge.request(method, params).then(unwrapSetupResult);
