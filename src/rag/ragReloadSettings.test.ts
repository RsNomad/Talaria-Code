import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAG_SETTING_RELOAD } from './ragReloadSettings';

/**
 * §7 — every `talaria.rag.*` setting is read exactly once, at activation
 * (`extension.ts`'s `activateCodebaseRag`), and captured into the
 * indexer/MCP-server opts. Flipping any of them today is a silently-broken
 * setting: nothing reacts until a manual window reload, and the user is
 * never told. The fix mirrors the existing `talaria.backend` reload-prompt
 * listener (`extension.ts:213-224`): a SECOND `onDidChangeConfiguration`
 * listener that walks `RAG_SETTING_RELOAD` and prompts "reload to apply"
 * for any `'reload'`-classified key that changed.
 *
 * `RAG_SETTING_RELOAD` is the single source of truth the listener is
 * REQUIRED to iterate (never a hardcoded key list in the handler itself —
 * see `extension.ts`'s new listener). This file is the FORCING test: it
 * pins that classification's key set against `package.json`'s own
 * `contributes.configuration.properties`, so a future `talaria.rag.*`
 * addition to `package.json` that isn't ALSO added here fails this test —
 * the author is forced to classify it 'reload' | 'live' before shipping.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const RAG_PREFIX = 'talaria.rag.';

interface ConfigCategory {
  properties?: Record<string, unknown>;
}

interface PackageManifest {
  contributes: {
    configuration: ConfigCategory | ConfigCategory[];
  };
}

/** Reads `package.json` fresh (never cached) and returns the `talaria.rag.*`
 * property keys with the `talaria.rag.` prefix stripped — e.g. `'enabled'`,
 * `'embedEndpoint'`. `contributes.configuration` is an array of titled
 * categories (configurationSections.test.ts locks the shape), so the keys
 * are gathered across ALL categories. */
function ragSettingKeysFromPackageJson(): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageManifest;
  const sections = Array.isArray(manifest.contributes.configuration)
    ? manifest.contributes.configuration
    : [manifest.contributes.configuration];
  return sections
    .flatMap((section) => Object.keys(section.properties ?? {}))
    .filter((key) => key.startsWith(RAG_PREFIX))
    .map((key) => key.slice(RAG_PREFIX.length));
}

describe('RAG_SETTING_RELOAD is exhaustive over package.json talaria.rag.* properties', () => {
  it('classifies EXACTLY the talaria.rag.* keys declared in package.json -- no more, no less', () => {
    const packageKeys = ragSettingKeysFromPackageJson().sort();
    const classifiedKeys = Object.keys(RAG_SETTING_RELOAD).sort();

    expect(
      classifiedKeys,
      `RAG_SETTING_RELOAD's keys must equal package.json's talaria.rag.* property suffixes.\n` +
        `package.json has: ${JSON.stringify(packageKeys)}\n` +
        `RAG_SETTING_RELOAD has: ${JSON.stringify(classifiedKeys)}`,
    ).toEqual(packageKeys);
  });

  it('every classification value is either "reload" or "live" (no typos/other strings)', () => {
    for (const [key, value] of Object.entries(RAG_SETTING_RELOAD)) {
      expect(['reload', 'live'], `key '${key}' has invalid classification '${String(value)}'`).toContain(value);
    }
  });

  it('all 8 pre-existing rag settings are classified "reload" -- none of them is re-read live (extension.ts:606-688 reads each exactly once at activation, captured into createIndexer/buildRagMcpServer opts; indexer.ts:517 confirms debounceMs is `opts.debounceMs ?? 500`, not a live re-read)', () => {
    const expectedReloadKeys = [
      'enabled',
      'embedEndpoint',
      'embedModel',
      'dims',
      'maxChunkTokens',
      'indexDir',
      'debounceMs',
      'excludeGlobs',
    ].sort();
    const reloadKeys = Object.entries(RAG_SETTING_RELOAD)
      .filter(([, v]) => v === 'reload')
      .map(([k]) => k)
      .sort();

    expect(reloadKeys).toEqual(expectedReloadKeys);
    for (const key of expectedReloadKeys) {
      expect(RAG_SETTING_RELOAD[key], `key '${key}' expected 'reload'`).toBe('reload');
    }
  });

  it('embedBackend (beta.6 T8, restoration-only — never captured into indexer/MCP opts) is classified "live"', () => {
    expect(RAG_SETTING_RELOAD['embedBackend']).toBe('live');
  });
});
