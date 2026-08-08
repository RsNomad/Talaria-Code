import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Onboarding/backend-setup Task 1 (architecture §5.3/§5.4/§2.8): the
 * extension's `contributes.configuration` is an ARRAY of five titled
 * categories — the Settings editor renders them as a table-of-contents
 * submenu under the extension. This file is the LOCK on that reorg:
 *
 *  (a) exactly five categories, fixed titles, ascending `order` 1–5;
 *  (b) the UNION of all category `properties` equals the pre-reorg 31-key
 *      list (hardcoded below — the "no key lost, none renamed" guarantee
 *      for beta users' settings.json) PLUS exactly one new key,
 *      `talaria.nextEdit.source`;
 *  (c) the machine-scope set is asserted VERBATIM — the §5.3 security lock:
 *      every key that repoints an executable or steers a spawn/egress
 *      destination stays `scope: "machine"` (a workspace cannot override
 *      it), and no key silently joins or leaves that set;
 *  (d) the new `talaria.nextEdit.source` enum (D7: structural mutual
 *      exclusion for the NEXT source — off/dedicated/generic);
 *  (e) `talaria.nextEdit.source` is trust-restricted
 *      (`capabilities.untrustedWorkspaces.restrictedConfigurations`);
 *  (f) no category title equals the extension `displayName` — §2.8's
 *      default-category trap: a category titled like the displayName is
 *      rendered directly under the main heading with its `order` IGNORED,
 *      silently breaking the five-section layout.
 *
 * Reads the real manifest fresh (never restates it), same discipline as
 * `activationEvents.test.ts`.
 */

const REPO_ROOT = join(__dirname, '..', '..');

interface ConfigProperty {
  readonly type?: string | string[];
  readonly enum?: readonly string[];
  readonly default?: unknown;
  readonly scope?: string;
  readonly order?: number;
  readonly description?: string;
  readonly markdownDescription?: string;
}

interface ConfigCategory {
  readonly title?: string;
  readonly order?: number;
  readonly properties?: Record<string, ConfigProperty>;
}

interface Manifest {
  readonly displayName?: string;
  readonly contributes?: { readonly configuration?: unknown };
  readonly capabilities?: {
    readonly untrustedWorkspaces?: { readonly restrictedConfigurations?: readonly string[] };
  };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Manifest;
}

/** Asserts the array shape (the reorg itself) and returns the categories. */
function categories(manifest: Manifest): ConfigCategory[] {
  const configuration = manifest.contributes?.configuration;
  expect(
    Array.isArray(configuration),
    'contributes.configuration must be an ARRAY of titled categories (§5.4) — found a non-array',
  ).toBe(true);
  return configuration as ConfigCategory[];
}

function unionOfProperties(cats: ConfigCategory[]): Record<string, ConfigProperty> {
  const union: Record<string, ConfigProperty> = {};
  for (const cat of cats) {
    for (const [key, def] of Object.entries(cat.properties ?? {})) {
      union[key] = def;
    }
  }
  return union;
}

/** §5.4 — the five categories, their order, and every property with its order. */
const EXPECTED_SECTIONS: ReadonlyArray<{
  title: string;
  order: number;
  properties: Record<string, number>;
}> = [
  {
    title: 'Backend & Agent',
    order: 1,
    properties: {
      'talaria.backend': 1,
      'talaria.hermesPath': 2,
      'talaria.pythonPath': 3,
      'talaria.cwd': 4,
      'talaria.agent.localModel.modelId': 5,
      'talaria.agent.localModel.backend': 6,
      'talaria.agent.localModel.endpoint': 7,
    },
  },
  {
    title: 'Autocomplete (FIM)',
    order: 2,
    properties: {
      'talaria.autocomplete.enabled': 1,
      'talaria.autocomplete.backend': 2,
      'talaria.autocomplete.endpoint': 3,
      'talaria.autocomplete.model': 4,
      'talaria.autocomplete.apiKey': 5,
      'talaria.autocomplete.debounceMs': 6,
      'talaria.autocomplete.maxPromptTokens': 7,
      'talaria.autocomplete.temperature': 8,
      'talaria.autocomplete.crossFile.enabled': 9,
      'talaria.autocomplete.crossFile.prefixInjection': 10,
      'talaria.autocomplete.crossFile.prefixInjectionRemote': 11,
      'talaria.autocomplete.crossFile.warmUp': 12,
    },
  },
  {
    title: 'Next Edit',
    order: 3,
    properties: {
      'talaria.nextEdit.source': 1,
      'talaria.nextEdit.backend': 2,
      'talaria.nextEdit.endpoint': 3,
      'talaria.nextEdit.model': 4,
      'talaria.nextEdit.dedicatedBackendId': 5,
    },
  },
  {
    title: 'RAG (Codebase Index)',
    order: 4,
    properties: {
      'talaria.rag.enabled': 1,
      'talaria.rag.embedEndpoint': 2,
      'talaria.rag.embedModel': 3,
      'talaria.rag.dims': 4,
      'talaria.rag.maxChunkTokens': 5,
      'talaria.rag.indexDir': 6,
      'talaria.rag.debounceMs': 7,
      'talaria.rag.excludeGlobs': 8,
      'talaria.rag.embedBackend': 9,
    },
  },
  {
    title: 'Advanced',
    order: 5,
    properties: {
      'talaria.dashboardPort': 1,
      'talaria.dashboardAdopt': 2,
      'talaria.lib.enabled': 3,
      'talaria.customModes': 4,
    },
  },
];

/**
 * The COMPLETE pre-reorg key list (31 keys), hardcoded on purpose: beta
 * users' settings.json must keep working, so no key may be lost or renamed
 * by the reorg. A future rename fails HERE, loudly.
 */
const PRE_REORG_KEYS: readonly string[] = [
  'talaria.hermesPath',
  'talaria.pythonPath',
  'talaria.cwd',
  'talaria.backend',
  'talaria.dashboardPort',
  'talaria.dashboardAdopt',
  'talaria.autocomplete.enabled',
  'talaria.autocomplete.backend',
  'talaria.autocomplete.endpoint',
  'talaria.autocomplete.model',
  'talaria.autocomplete.debounceMs',
  'talaria.autocomplete.maxPromptTokens',
  'talaria.autocomplete.temperature',
  'talaria.autocomplete.apiKey',
  'talaria.autocomplete.crossFile.enabled',
  'talaria.autocomplete.crossFile.prefixInjection',
  'talaria.autocomplete.crossFile.prefixInjectionRemote',
  'talaria.autocomplete.crossFile.warmUp',
  'talaria.rag.enabled',
  'talaria.rag.embedEndpoint',
  'talaria.rag.embedModel',
  'talaria.rag.dims',
  'talaria.rag.maxChunkTokens',
  'talaria.rag.indexDir',
  'talaria.rag.debounceMs',
  'talaria.rag.excludeGlobs',
  'talaria.lib.enabled',
  'talaria.customModes',
  'talaria.nextEdit.backend',
  'talaria.nextEdit.endpoint',
  'talaria.nextEdit.model',
];

const NEW_KEY = 'talaria.nextEdit.source';

/**
 * beta.6 T8 (§1.3/§2.5): the 5 additive keys — 3 for the "Configure Local
 * Agent Model" block's saved selection, 2 restoration-only hints
 * (`nextEdit.dedicatedBackendId` / `rag.embedBackend`). Same "no key lost,
 * none renamed" guarantee as {@link PRE_REORG_KEYS} — this list only ever
 * grows via a reviewed addition, never a rename.
 */
const BETA6_T8_NEW_KEYS: readonly string[] = [
  'talaria.agent.localModel.modelId',
  'talaria.agent.localModel.backend',
  'talaria.agent.localModel.endpoint',
  'talaria.nextEdit.dedicatedBackendId',
  'talaria.rag.embedBackend',
];

/**
 * §5.3 security lock, VERBATIM. Every key that repoints an executable
 * (`hermesPath`, `pythonPath`, `cwd`, `backend`), steers a spawn
 * (`dashboardPort`, `dashboardAdopt`, `lib.enabled`) or an egress
 * destination / model integrity (`autocomplete.*`, `nextEdit.*`, `rag.*`
 * entries below) MUST stay `scope: "machine"` so a checked-in
 * `.vscode/settings.json` can never override it. `talaria.nextEdit.source`
 * joins the set (it steers whether — and via generic, where — editor
 * context is sent). beta.6 T8: the 3 `talaria.agent.localModel.*` keys join
 * for the SAME egress/model-integrity rationale as their `autocomplete.*`/
 * `nextEdit.*` siblings; `nextEdit.dedicatedBackendId` and `rag.embedBackend`
 * join by symmetry with every OTHER key in their own category (every
 * existing `nextEdit.*`/security-relevant `rag.*` key is already
 * machine-scoped — these restoration hints are no exception).
 */
const MACHINE_SCOPED_KEYS: readonly string[] = [
  'talaria.backend',
  'talaria.hermesPath',
  'talaria.pythonPath',
  'talaria.cwd',
  'talaria.dashboardPort',
  'talaria.dashboardAdopt',
  'talaria.autocomplete.backend',
  'talaria.autocomplete.endpoint',
  'talaria.autocomplete.model',
  'talaria.autocomplete.apiKey',
  'talaria.autocomplete.crossFile.prefixInjectionRemote',
  'talaria.nextEdit.source',
  'talaria.nextEdit.backend',
  'talaria.nextEdit.endpoint',
  'talaria.nextEdit.model',
  'talaria.rag.embedEndpoint',
  'talaria.rag.embedModel',
  'talaria.rag.indexDir',
  'talaria.lib.enabled',
  'talaria.agent.localModel.modelId',
  'talaria.agent.localModel.backend',
  'talaria.agent.localModel.endpoint',
  'talaria.nextEdit.dedicatedBackendId',
  'talaria.rag.embedBackend',
];

describe('contributes.configuration — five titled sections (§5.4)', () => {
  it('(a) is an array of exactly 5 categories with the fixed titles, ascending order 1–5', () => {
    const cats = categories(readManifest());
    expect(cats).toHaveLength(5);
    expect(cats.map((c) => c.title)).toEqual([
      'Backend & Agent',
      'Autocomplete (FIM)',
      'Next Edit',
      'RAG (Codebase Index)',
      'Advanced',
    ]);
    expect(cats.map((c) => c.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('(f) no category title equals the extension displayName (§2.8 default-category trap: its order would be IGNORED)', () => {
    const manifest = readManifest();
    const displayName = manifest.displayName;
    // Reach guard: if displayName ever vanished, every comparison below
    // would pass vacuously against `undefined`.
    expect(displayName, 'package.json displayName must exist for this lock to bite').toBeTruthy();
    for (const cat of categories(manifest)) {
      expect(
        cat.title,
        `category "${String(cat.title)}" must not be titled like the extension displayName — ` +
          'VS Code would hoist it as the "default category" and ignore its order',
      ).not.toBe(displayName);
    }
  });

  it('(b) the union of all category properties = the 31 pre-reorg keys + talaria.nextEdit.source + the 5 beta.6 T8 keys (no key lost, none renamed, none duplicated)', () => {
    const cats = categories(readManifest());
    const perSectionCounts = cats.map((c) => Object.keys(c.properties ?? {}).length);
    const union = unionOfProperties(cats);

    // No key may appear in two sections (a duplicate would be silently
    // last-wins-merged by the union helper — and by VS Code itself).
    const totalDeclared = perSectionCounts.reduce((a, b) => a + b, 0);
    expect(Object.keys(union), 'a key is declared in more than one category').toHaveLength(
      totalDeclared,
    );

    expect(Object.keys(union).sort()).toEqual([...PRE_REORG_KEYS, NEW_KEY, ...BETA6_T8_NEW_KEYS].sort());
  });

  it('(b′) each section contains exactly its §5.4 properties, each with its §5.4 order', () => {
    const cats = categories(readManifest());
    for (const [i, expected] of EXPECTED_SECTIONS.entries()) {
      const cat = cats[i];
      expect(cat, `section ${expected.title} missing`).toBeDefined();
      const actualOrders = Object.fromEntries(
        Object.entries(cat?.properties ?? {}).map(([key, def]) => [key, def.order]),
      );
      expect(actualOrders, `section "${expected.title}" property set / order mismatch`).toEqual(
        expected.properties,
      );
    }
  });

  it('(c) SECURITY LOCK — the machine-scope set matches §5.3 verbatim; customModes is resource; everything else is default/window scope', () => {
    const union = unionOfProperties(categories(readManifest()));

    const machine = Object.keys(union)
      .filter((key) => union[key]?.scope === 'machine')
      .sort();
    expect(
      machine,
      'the machine-scope set changed — every exec-path/spawn/egress/model-integrity key must stay machine-scoped, and no key may join or leave silently',
    ).toEqual([...MACHINE_SCOPED_KEYS].sort());

    const resource = Object.keys(union).filter((key) => union[key]?.scope === 'resource');
    expect(resource, 'only customModes is resource-scoped (workspace-level by design)').toEqual([
      'talaria.customModes',
    ]);

    for (const [key, def] of Object.entries(union)) {
      if (def.scope !== 'machine' && def.scope !== 'resource') {
        expect(
          def.scope,
          `${key}: unexpected scope "${String(def.scope)}" — cosmetic tunables stay on the default (window) scope`,
        ).toBeUndefined();
      }
    }
  });

  it('(d) talaria.nextEdit.source: enum off/dedicated/generic, default off, machine scope, described (D7)', () => {
    const union = unionOfProperties(categories(readManifest()));
    const source = union[NEW_KEY];
    expect(source, `${NEW_KEY} must be contributed`).toBeDefined();
    expect(source?.type).toBe('string');
    expect(source?.enum).toEqual(['off', 'dedicated', 'generic']);
    expect(source?.default).toBe('off');
    expect(source?.scope).toBe('machine');
    // House style: the description must explain Generic-vs-Dedicated and
    // state the machine-scope security rationale.
    const description = source?.markdownDescription ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description).toMatch(/[Gg]eneric/);
    expect(description).toMatch(/[Dd]edicated/);
    expect(description).toMatch(/[Mm]achine-scoped/);
    expect(description).toMatch(/security/);
  });

  it('(e) talaria.nextEdit.source is trust-restricted (untrustedWorkspaces.restrictedConfigurations)', () => {
    const manifest = readManifest();
    const restricted = manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
    expect(
      restricted,
      'reach: an empty restrictedConfigurations list would rubber-stamp this assertion',
    ).toContain('talaria.nextEdit.endpoint');
    expect(restricted).toContain(NEW_KEY);
  });
});
