/**
 * §7 — reload-vs-live classification for every `talaria.rag.*` setting.
 *
 * All 8 `talaria.rag.*` settings are read exactly ONCE, at activation
 * (`extension.ts:606-688`'s `activateCodebaseRag`), and captured into the
 * `createIndexer`/`buildRagMcpServer` opts objects — including `debounceMs`,
 * which `indexer.ts:517` reads as `opts.debounceMs ?? 500` (the captured
 * opts value, never a live re-read of the setting). Flipping any of them
 * today is therefore a silently-broken setting: nothing reacts until the
 * user manually reloads the window, and nothing tells them that.
 *
 * This map is the single source of truth `extension.ts`'s
 * `onDidChangeConfiguration` reload-prompt listener walks — it must never
 * hardcode a key list of its own. Key = the property suffix after
 * `'talaria.rag.'` (e.g. `'enabled'`, `'embedEndpoint'`); value =
 * `'reload'` (requires a manual window reload to take effect) or `'live'`
 * (re-read on every use). `ragReloadSettings.test.ts` pins this object's key
 * set against `package.json`'s own `contributes.configuration.properties`,
 * so adding a new `talaria.rag.*` setting without classifying it here fails
 * that test.
 *
 * beta.6 T8: `embedBackend` is `'live'` — UNLIKE the 8 keys above, it is
 * never captured into `activateCodebaseRag`'s indexer/MCP-server opts at
 * all (it is restoration-only metadata for the Setup panel's RAG block,
 * consumed solely by `SetupController.status()`, which re-reads it fresh
 * on every call — there is no captured/stale-opts value for it to go stale
 * against, so no reload is ever needed for a change to "take effect").
 */
export const RAG_SETTING_RELOAD: Record<string, 'reload' | 'live'> = {
  enabled: 'reload',
  embedEndpoint: 'reload',
  embedModel: 'reload',
  dims: 'reload',
  maxChunkTokens: 'reload',
  indexDir: 'reload',
  debounceMs: 'reload',
  excludeGlobs: 'reload',
  embedBackend: 'live',
};
