import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectAllTsAndTsxSources, collectNonTestTsSources, scanLines, VSCODE_IMPORT_BAN } from '../purityScan';
import { AUTOCOMPLETE_API_KEY_SECRET } from '../../autocomplete/apiKey';
import {
  AGENT_BACKENDS,
  FIM_BACKENDS,
  getBackend,
  HERMES_PIN,
  NEXT_DEDICATED_MODEL,
  SYNTINAL_HF_OWNER,
  type BackendDescriptor,
  type InstallRecipe,
} from './registry';

/**
 * Task 3 (onboarding-backend-setup-architecture.md §4) — the backend
 * registry's acceptance locks (a)–(h). The registry is PURE DATA: these
 * tests are the only executable statement of its contract, so every fact
 * asserted here is grounded in a source the plan names:
 *
 *  - Hermes packaging facts (§2.1): pyproject `name="hermes-agent"`,
 *    `[acp]` extra REQUIRED, console scripts `hermes`/`hermes-acp`,
 *    `requires-python = ">=3.11,<3.14"`, `hermes-acp --check` printing
 *    `Hermes ACP check OK`.
 *  - FIM endpoint defaults: `src/autocomplete/config.ts` DEFAULT_ENDPOINTS
 *    (drift-locked BOTH ways below — registry vs. the five expected strings,
 *    AND config.ts source text vs. the same strings, so neither side can
 *    move without this file going red).
 *  - SecretStorage key: `src/autocomplete/apiKey.ts`
 *    AUTOCOMPLETE_API_KEY_SECRET (imported — that module is vscode-free).
 *  - `talaria.rag.embedModel` default: package.json contributes.configuration.
 */

const ALL_BACKENDS: readonly BackendDescriptor[] = [...AGENT_BACKENDS, ...FIM_BACKENDS];

function mustGet(id: string): BackendDescriptor {
  const d = getBackend(id);
  if (!d) throw new Error(`registry is missing backend '${id}'`);
  return d;
}

function pipxRecipe(d: BackendDescriptor): Extract<InstallRecipe, { kind: 'pipx' }> {
  const recipe = d.localInstall?.recipe;
  if (!recipe || recipe.kind !== 'pipx') {
    throw new Error(`'${d.id}' has no pipx recipe (got ${JSON.stringify(recipe?.kind)})`);
  }
  return recipe;
}

describe('registry: roster + pin', () => {
  it('AGENT_BACKENDS is exactly hermes, openclaw, talaria-ai (in card order)', () => {
    expect(AGENT_BACKENDS.map((d) => d.id)).toEqual(['hermes', 'openclaw', 'talaria-ai']);
    for (const d of AGENT_BACKENDS) expect(d.kind).toBe('agent');
  });

  it('FIM_BACKENDS is exactly ollama, llamacpp, vllm, codestral, openai-compat (in card order)', () => {
    expect(FIM_BACKENDS.map((d) => d.id)).toEqual([
      'ollama',
      'llamacpp',
      'vllm',
      'codestral',
      'openai-compat',
    ]);
    for (const d of FIM_BACKENDS) expect(d.kind).toBe('fim');
  });

  it('getBackend finds every roster id and returns undefined for unknown ids', () => {
    for (const d of ALL_BACKENDS) expect(getBackend(d.id)).toBe(d);
    expect(getBackend('no-such-backend')).toBeUndefined();
  });

  it('HERMES_PIN is the owner-decided D10 pin', () => {
    expect(HERMES_PIN).toBe('0.18.2');
  });
});

describe('registry (a): hermes pipx recipe (§2.1 packaging facts)', () => {
  it('installs hermes-agent[acp]==HERMES_PIN via pipx — the [acp] extra is REQUIRED', () => {
    const recipe = pipxRecipe(mustGet('hermes'));
    expect(recipe.kind).toBe('pipx');
    expect(recipe.packageSpec).toBe(`hermes-agent[acp]==${HERMES_PIN}`);
    expect(recipe.pinnedVersion).toBe(HERMES_PIN);
  });

  it('post-install verification is `hermes-acp --check` expecting the §2.1 marker', () => {
    const recipe = pipxRecipe(mustGet('hermes'));
    expect(recipe.postCheck.app).toBe('hermes-acp');
    expect(recipe.postCheck.args).toEqual(['--check']);
    expect(recipe.postCheck.expectStdoutIncludes).toBe('Hermes ACP check OK');
  });

  it('python range mirrors pyproject requires-python ">=3.11,<3.14"', () => {
    const recipe = pipxRecipe(mustGet('hermes'));
    expect(recipe.pythonRange).toEqual({ minInclusive: '3.11', maxExclusive: '3.14' });
  });

  it('console scripts are the pyproject [project.scripts] names', () => {
    const recipe = pipxRecipe(mustGet('hermes'));
    expect(recipe.apps).toEqual({ main: 'hermes', acpCheck: 'hermes-acp' });
  });

  it('hermes is honestly labeled one-script and activates the acp backend', () => {
    const hermes = mustGet('hermes');
    expect(hermes.localInstall?.effort).toBe('one-script');
    expect(hermes.settingsToActivate).toEqual({ 'talaria.backend': 'acp' });
    expect(hermes.transport).toBe('stdio');
  });
});

describe('registry (b): status invariant', () => {
  it("every 'available' backend has remote or localInstall; every 'coming-soon' has neither", () => {
    expect(ALL_BACKENDS.length).toBeGreaterThan(0); // non-vacuous
    for (const d of ALL_BACKENDS) {
      if (d.status === 'available') {
        expect(
          d.remote !== undefined || d.localInstall !== undefined,
          `'${d.id}' is available but offers neither remote nor localInstall`,
        ).toBe(true);
      } else {
        expect(d.remote, `coming-soon '${d.id}' must not declare remote`).toBeUndefined();
        expect(d.localInstall, `coming-soon '${d.id}' must not declare localInstall`).toBeUndefined();
      }
    }
  });
});

/**
 * (c) — the five endpoint defaults, copied VERBATIM from
 * `src/autocomplete/config.ts` DEFAULT_ENDPOINTS. Drift-lock direction 1:
 * the registry must equal these strings. Drift-lock direction 2: config.ts
 * (module-private, deliberately not exported) must still CONTAIN each
 * `key: 'value'` pair — so editing either file without the other turns
 * this suite red.
 */
const EXPECTED_ENDPOINTS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8080',
  vllm: 'http://127.0.0.1:8000',
  codestral: 'https://codestral.mistral.ai',
  'openai-compat': 'http://127.0.0.1:8000',
};

const CONFIG_TS_PATH = join(__dirname, '..', '..', 'autocomplete', 'config.ts');

describe('registry (c): FIM endpoint defaults === config.ts DEFAULT_ENDPOINTS (drift-lock both ways)', () => {
  it('every FIM descriptor exposes remote with the verbatim default endpoint', () => {
    for (const d of FIM_BACKENDS) {
      const expected = EXPECTED_ENDPOINTS[d.id];
      expect(expected, `test table is missing FIM id '${d.id}'`).toBeDefined();
      expect(d.remote, `FIM '${d.id}' must offer a remote (connect) mode`).toBeDefined();
      expect(d.remote?.endpoint.defaultValue).toBe(expected);
      expect(d.remote?.endpoint.settingKey).toBe('talaria.autocomplete.endpoint');
    }
  });

  it('config.ts on disk still carries the same five pairs (reverse drift-lock)', () => {
    const source = readFileSync(CONFIG_TS_PATH, 'utf-8');
    expect(source).toContain("ollama: 'http://127.0.0.1:11434'");
    expect(source).toContain("llamacpp: 'http://127.0.0.1:8080'");
    expect(source).toContain("vllm: 'http://127.0.0.1:8000'");
    expect(source).toContain("codestral: 'https://codestral.mistral.ai'");
    expect(source).toContain("'openai-compat': 'http://127.0.0.1:8000'");
    // And no sixth entry the registry would silently miss: the FIM roster
    // here must cover every DEFAULT_ENDPOINTS key.
    expect(Object.keys(EXPECTED_ENDPOINTS).sort()).toEqual(FIM_BACKENDS.map((d) => d.id).sort());
  });
});

describe('registry (d): codestral auth', () => {
  it('requires an API key stored under the existing SecretStorage key', () => {
    const codestral = mustGet('codestral');
    expect(codestral.remote?.auth).toEqual({
      kind: 'apiKey',
      required: true,
      secretKey: 'talaria.autocomplete.apiKey',
    });
    // Drift-lock against the real constant in src/autocomplete/apiKey.ts.
    expect(codestral.remote?.auth).toMatchObject({ secretKey: AUTOCOMPLETE_API_KEY_SECRET });
  });

  it('codestral is remote-only with no unauthenticated probe (§2.5)', () => {
    const codestral = mustGet('codestral');
    expect(codestral.localInstall).toBeUndefined();
    expect(codestral.remote?.probe).toEqual({ kind: 'none' });
  });
});

describe('registry (e): nextEditTransport mapping (§2.3 NEXT row)', () => {
  it("ollama → 'ollama'", () => {
    expect(mustGet('ollama').nextEditTransport).toBe('ollama');
  });

  it("vllm / llamacpp / openai-compat → 'openai-compat'", () => {
    expect(mustGet('vllm').nextEditTransport).toBe('openai-compat');
    expect(mustGet('llamacpp').nextEditTransport).toBe('openai-compat');
    expect(mustGet('openai-compat').nextEditTransport).toBe('openai-compat');
  });

  it('codestral and every agent backend are absent from NEXT setup', () => {
    expect(mustGet('codestral').nextEditTransport).toBeUndefined();
    for (const d of AGENT_BACKENDS) {
      expect(d.nextEditTransport, `agent '${d.id}' must not offer a NEXT transport`).toBeUndefined();
    }
  });
});

describe('registry (f): ollama model provisioning', () => {
  it('maps fim → talaria.autocomplete.model and embedding → talaria.rag.embedModel', () => {
    const models = mustGet('ollama').localInstall?.models;
    expect(models?.pull).toBe('ollama-api');
    expect(models?.defaults).toEqual([
      { role: 'fim', model: 'qwen2.5-coder:1.5b-base', settingKey: 'talaria.autocomplete.model' },
      { role: 'embedding', model: 'qwen3-embedding:0.6b', settingKey: 'talaria.rag.embedModel' },
    ]);
  });

  it('the fim default model still matches config.ts DEFAULT_MODEL (reverse drift-lock)', () => {
    const source = readFileSync(CONFIG_TS_PATH, 'utf-8');
    expect(source).toContain("const DEFAULT_MODEL = 'qwen2.5-coder:1.5b-base'");
  });

  it('the embedding default still matches package.json talaria.rag.embedModel (reverse drift-lock)', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
    ) as {
      contributes?: { configuration?: Array<{ properties?: Record<string, { default?: unknown }> }> };
    };
    const sections = pkg.contributes?.configuration ?? [];
    const embed = sections
      .map((s) => s.properties?.['talaria.rag.embedModel'])
      .find((p) => p !== undefined);
    expect(embed, 'package.json no longer declares talaria.rag.embedModel').toBeDefined();
    expect(embed?.default).toBe('qwen3-embedding:0.6b');
  });
});

describe('registry (g): coming-soon stubs', () => {
  it("getBackend('openclaw') is a coming-soon stub", () => {
    expect(mustGet('openclaw').status).toBe('coming-soon');
  });

  it("getBackend('talaria-ai') is a coming-soon stub", () => {
    expect(mustGet('talaria-ai').status).toBe('coming-soon');
  });

  it('every FIM entry activates talaria.autocomplete.backend = <id>; stubs activate nothing', () => {
    for (const d of FIM_BACKENDS) {
      expect(d.settingsToActivate).toEqual({ 'talaria.autocomplete.backend': d.id });
    }
    expect(mustGet('openclaw').settingsToActivate).toEqual({});
    expect(mustGet('talaria-ai').settingsToActivate).toEqual({});
  });
});

describe('registry (h): purity — zero vscode imports (purityScan discipline)', () => {
  it('no non-test module under src/host/setup/ imports vscode', () => {
    const files = collectNonTestTsSources(__dirname);
    // Non-vacuous: the scan must actually see registry.ts.
    expect(files.map((f) => f.file)).toContain('registry.ts');
    expect(scanLines(files, VSCODE_IMPORT_BAN)).toEqual([]);
  });
});

/**
 * (i) — T6 (beta5-setup-hardening-architecture.md §1.2 A3): llama.cpp's
 * guided-terminal recipe gains `packageKey: 'llamacpp'` so
 * `SetupController.handleOpenInstallTerminal` can override its `command`
 * with the OS engine's (`packageTable.ts`) per-family verified line —
 * fail-open closed (S-F9), never falling back to this static Fedora-shaped
 * `command` on an unmatched family. Ollama's vendor-script recipe carries no
 * `packageKey` and stays untouched by that override, on every family.
 */
describe('registry (i): llamacpp guided-terminal recipe carries packageKey for OS-engine routing (T6/S-F9)', () => {
  it("llamacpp's recipe carries packageKey: 'llamacpp'", () => {
    const recipe = mustGet('llamacpp').localInstall?.recipe;
    expect(recipe?.kind).toBe('guided-terminal');
    if (recipe?.kind === 'guided-terminal') {
      expect(recipe.packageKey).toBe('llamacpp');
    }
  });

  it('ollama carries no packageKey — its recipe is never engine-overridden (byte-identical regression lock)', () => {
    const recipe = mustGet('ollama').localInstall?.recipe;
    expect(recipe?.kind).toBe('guided-terminal');
    if (recipe?.kind === 'guided-terminal') {
      expect(recipe.packageKey).toBeUndefined();
      expect(recipe.command).toBe('curl -fsSL https://ollama.com/install.sh | sh');
      expect(recipe.docsUrl).toBe('https://ollama.com/download/linux');
    }
  });
});

/**
 * (j) — T6 §5.2 rev 3 (⑪): vLLM's local install has no verified source to
 * compose a command from (the beta.3 pip-based recipe was unpinned,
 * PEP-668-hostile, and hardware-specific) — the recipe becomes docs-only.
 * R-1a: `SetupController.projectBackend` projects only DESCRIPTOR-level
 * `docsUrl` onto the wire (not the recipe's own), so the descriptor must
 * carry its own copy too, or the docs-only tab would render linkless.
 */
describe('registry (j): vLLM local install is docs-only — docsUrl on BOTH the recipe and the descriptor (R-1a)', () => {
  it("vllm's recipe is exactly {kind:'docs-only', docsUrl:'https://docs.vllm.ai/'}", () => {
    const vllm = mustGet('vllm');
    expect(vllm.localInstall?.recipe).toEqual({ kind: 'docs-only', docsUrl: 'https://docs.vllm.ai/' });
  });

  it('the vllm DESCRIPTOR also carries docsUrl (R-1a)', () => {
    expect(mustGet('vllm').docsUrl).toBe('https://docs.vllm.ai/');
  });

  it('vllm is still status:available (docs-only + Test-only is a legitimate offering, not absence)', () => {
    expect(mustGet('vllm').status).toBe('available');
    expect(mustGet('vllm').remote).toBeDefined();
  });
});

/**
 * (k) — T6 §5.2 rev 3: the deleted vLLM install line (a `pip` invocation
 * naming the `vllm` package, unpinned) must never reappear anywhere under
 * `src/`. Deliberately phrased without ever spelling out the banned two-word
 * literal in this file's own prose/comments — this scan collects TEST files
 * too (unlike (h)'s production-only purity scan), so this file is itself
 * subject to the ban it asserts and must not trip its own lock.
 */
describe('registry (k): the deleted vLLM pip-install recipe string is gone from the codebase', () => {
  it('no .ts/.tsx file under src/ contains the deleted install line', () => {
    const root = join(__dirname, '..', '..'); // src/host/setup -> src/host -> src
    const files = collectAllTsAndTsxSources(root);
    expect(files.length).toBeGreaterThan(0); // non-vacuous
    const bannedWords = ['pip', 'install', 'vllm'];
    const banned = new RegExp(bannedWords.join(' '));
    expect(scanLines(files, banned)).toEqual([]);
  });
});

/**
 * (l) — T12 (beta5-setup-hardening-architecture.md §4.1): the Dedicated NEXT
 * (Sweep) model registry data. Fail-closed by design: `gguf.sha256` is the
 * EMPTY-STRING placeholder until the out-of-band GGUF publication lands —
 * that is intentional, not a defect, and this suite must never demand a
 * non-empty value. These are drift-locks, not behavior tests: the registry
 * stays pure data (zero imports — see (h) above, which already scans this
 * file's directory and would catch a stray import here too).
 */
describe('registry (l): NEXT_DEDICATED_MODEL — Dedicated NEXT registry data (T12, §4.1)', () => {
  it('SYNTINAL_HF_OWNER is the owner-confirmed namespace', () => {
    expect(SYNTINAL_HF_OWNER).toBe('SyntinalCo');
  });

  it('matches the §4.1 object exactly (whole-shape drift-lock)', () => {
    expect(NEXT_DEDICATED_MODEL).toEqual({
      displayName: 'Sweep Next-Edit v2 (7B)',
      upstream: {
        hfRepo: 'sweepai/sweep-next-edit-v2-7B',
        format: 'safetensors',
        license: 'Apache-2.0',
        contextLength: 32768,
      },
      gguf: {
        hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
        file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        sha256: '',
        approxBytes: 4_680_000_000,
        allowedRepoFiles: ['sweep-next-edit-v2-7B-Q4_K_M.gguf', 'README.md', '.gitattributes'],
      },
      ollamaCreatedName: 'sweep-next-edit-v2-7b:q4_k_m',
      ollamaPullAlias: 'hf.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M',
      vram: { fullGiB: 15, q4GiB: 5 },
    });
  });

  it('every derived id starts with the owner constant (critic S-F2)', () => {
    expect(NEXT_DEDICATED_MODEL.gguf.hfRepo.startsWith(`${SYNTINAL_HF_OWNER}/`)).toBe(true);
  });

  it('ollamaPullAlias is computed-equal to hf.co/{gguf.hfRepo}:{gguf.quant}', () => {
    expect(NEXT_DEDICATED_MODEL.ollamaPullAlias).toBe(
      `hf.co/${NEXT_DEDICATED_MODEL.gguf.hfRepo}:${NEXT_DEDICATED_MODEL.gguf.quant}`,
    );
  });

  it('ollamaCreatedName is host-free because it contains NO "/" at all (rev 6 §4.4 predicate)', () => {
    expect(NEXT_DEDICATED_MODEL.ollamaCreatedName.includes('/')).toBe(false);
  });

  it('allowedRepoFiles contains exactly the gguf file + README.md + .gitattributes', () => {
    expect(NEXT_DEDICATED_MODEL.gguf.allowedRepoFiles).toEqual([
      NEXT_DEDICATED_MODEL.gguf.file,
      'README.md',
      '.gitattributes',
    ]);
  });

  it('sha256 is the empty-string fail-closed placeholder OR a 64-hex digest (publication-compatible)', () => {
    expect(NEXT_DEDICATED_MODEL.gguf.sha256).toMatch(/^$|^[0-9a-f]{64}$/i);
  });

  it('sha256 is currently EMPTY — the intentional fail-closed placeholder (NOT a defect; do not fill it here)', () => {
    expect(NEXT_DEDICATED_MODEL.gguf.sha256).toBe('');
  });
});
