import { describe, it, expect, vi } from 'vitest';
import { SetupController, type SetupHost, type SetupControllerDeps } from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend, NEXT_DEDICATED_MODEL } from './registry';
import type { LfsOidVerdict, HfGgufSpec } from './hfDigest';
import type { PipxLocateResult } from './pipxLocator';
import type { OllamaStatus } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';
import { homedir } from 'node:os';

/**
 * T7 (beta.6 §2.5/§7): `setup.provisionModel` against POISONED + PINNED
 * catalog fixtures — the "unreachable-but-tested" half of the refusal-order
 * table. The real `MODEL_CATALOG` ships no row that can reach these branches
 * (charset/allowlist/prefix violations are drift-locked out at T1; the one
 * pinned row ships `sha256: ''`), so this file — and ONLY this file — mocks
 * the catalog module with fixture rows. `assertCatalogSource`,
 * `TRUSTED_HF_PUBLISHERS`, and everything else stay the REAL exports.
 */

const TEST_PIN = vi.hoisted(() => 'e'.repeat(64));

vi.mock('./modelCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./modelCatalog')>();
  const SWEEP_GGUF = {
    hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
    file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    approxBytes: 4_680_000_000,
  };
  const base = {
    role: 'agent' as const,
    license: 'Apache-2.0',
    vramLine: 'fixture',
  };
  const MODEL_CATALOG: (typeof actual)['MODEL_CATALOG'] = [
    {
      ...base,
      id: 'sweep-next',
      role: 'next',
      displayName: 'Sweep Next-Edit v2 (7B)',
      publisher: 'SyntinalCo',
      ollama: {
        tier: 'hf-ingest',
        gguf: SWEEP_GGUF,
        createdName: 'sweep-next-edit-v2-7b:q4_k_m',
        verify: { mode: 'pinned', sha256: TEST_PIN },
      },
      llamacpp: { gguf: SWEEP_GGUF, verify: { mode: 'pinned', sha256: TEST_PIN } },
    },
    {
      ...base,
      id: 'live-ok',
      displayName: 'Live Row',
      publisher: 'Qwen',
      ollama: {
        tier: 'hf-ingest',
        gguf: { hfRepo: 'Qwen/live-repo', file: 'live.gguf', quant: 'Q4_K_M', approxBytes: 4_680_000_000 },
        createdName: 'live:1',
        verify: { mode: 'live-oid' },
      },
      llamacpp: {
        gguf: { hfRepo: 'Qwen/live-repo', file: 'live.gguf', quant: 'Q4_K_M', approxBytes: 4_680_000_000 },
        verify: { mode: 'live-oid' },
      },
    },
    {
      ...base,
      id: 'bad-charset',
      displayName: 'Poisoned Charset',
      publisher: 'mistralai',
      ollama: {
        tier: 'hf-ingest',
        gguf: { hfRepo: 'mistralai/../evil-org', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        createdName: 'x:1',
        verify: { mode: 'live-oid' },
      },
      llamacpp: {
        gguf: { hfRepo: 'mistralai/../evil-org', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        verify: { mode: 'live-oid' },
      },
    },
    {
      ...base,
      id: 'bad-publisher',
      displayName: 'Unlisted Publisher',
      publisher: 'evil-org',
      ollama: {
        tier: 'hf-ingest',
        gguf: { hfRepo: 'evil-org/repo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        createdName: 'x:1',
        verify: { mode: 'live-oid' },
      },
      llamacpp: {
        gguf: { hfRepo: 'evil-org/repo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        verify: { mode: 'live-oid' },
      },
    },
    {
      ...base,
      id: 'bad-prefix',
      displayName: 'Owner Mismatch',
      publisher: 'Qwen',
      ollama: {
        tier: 'hf-ingest',
        gguf: { hfRepo: 'ggml-org/foo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        createdName: 'x:1',
        verify: { mode: 'live-oid' },
      },
      llamacpp: {
        gguf: { hfRepo: 'ggml-org/foo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        verify: { mode: 'live-oid' },
      },
    },
    {
      ...base,
      id: 'bad-created',
      displayName: 'Poisoned CreatedName',
      publisher: 'Qwen',
      ollama: {
        tier: 'hf-ingest',
        gguf: { hfRepo: 'Qwen/foo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        createdName: 'evil/name:tag',
        verify: { mode: 'live-oid' },
      },
    },
    {
      ...base,
      id: 'bad-mode',
      displayName: 'Future Verify Mode',
      publisher: 'Qwen',
      ollama: {
        tier: 'hf-ingest',
        gguf: { hfRepo: 'Qwen/foo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        createdName: 'x:1',
        verify: { mode: 'sha3-someday' } as never,
      },
      llamacpp: {
        gguf: { hfRepo: 'Qwen/foo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        verify: { mode: 'sha3-someday' } as never,
      },
    },
    {
      ...base,
      id: 'pinned-foreign',
      displayName: 'Pinned Non-Registry Artifact',
      publisher: 'SyntinalCo',
      ollama: {
        tier: 'hf-ingest',
        gguf: { hfRepo: 'SyntinalCo/other-repo', file: 'other.gguf', quant: 'Q4', approxBytes: 1 },
        createdName: 'other:1',
        verify: { mode: 'pinned', sha256: TEST_PIN },
      },
      llamacpp: {
        gguf: { hfRepo: 'SyntinalCo/other-repo', file: 'other.gguf', quant: 'Q4', approxBytes: 1 },
        verify: { mode: 'pinned', sha256: TEST_PIN },
      },
    },
    {
      ...base,
      id: 'no-ollama',
      displayName: 'Llamacpp Only',
      publisher: 'Qwen',
      llamacpp: {
        gguf: { hfRepo: 'Qwen/foo', file: 'x.gguf', quant: 'Q4', approxBytes: 1 },
        verify: { mode: 'live-oid' },
      },
    },
    {
      ...base,
      id: 'no-llamacpp',
      displayName: 'Ollama Only',
      publisher: 'Qwen',
      ollama: { tier: 'library', tag: 'x:1', approxBytes: 1 },
    },
    {
      ...base,
      id: 'dash-tag',
      displayName: 'Option-Shaped Tag',
      publisher: 'Qwen',
      ollama: { tier: 'library', tag: '-inject:latest', approxBytes: 1 },
    },
  ];
  return { ...actual, MODEL_CATALOG };
});

// --- §6 copy, verbatim -------------------------------------------------------

const INTEGRITY_REFUSAL = 'integrity check failed — refusing to download';
const REMOTE_ENDPOINT_REFUSAL =
  'Verified downloads only run against a local Ollama (loopback). For a remote server, download and verify the model on that machine — see the guided instructions.';
const LLAMACPP_HONEST_ABSENCE =
  'No build of this model from a verified publisher exists for llama.cpp — use it via Ollama instead.';
const OLLAMA_HONEST_ABSENCE =
  'No build of this model from a verified publisher exists for Ollama — use it via llama.cpp instead.';
const UNKNOWN_VERIFY_REFUSAL = 'unknown verify mode — refusing to download';

// The pinned provision modals: beta.5 strong-claim wording + the endpoint/dest
// clause (§6 "Provision modal — pinned"); DISTINCT from live-oid (A-2).
const PINNED_OLLAMA_MODAL =
  "Download 'Sweep Next-Edit v2 (7B)' (~4.7 GB) and install it into your local Ollama? " +
  "Source: huggingface.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF — Syntinal's build converted from Sweep's official release. " +
  "Talaria verifies the file's checksum against its pinned value after downloading, " +
  'and Ollama verifies it again during install at http://127.0.0.1:11434.';

const PINNED_LLAMACPP_MODAL =
  "Download 'Sweep Next-Edit v2 (7B)' (Q4_K_M, ~4.7 GB) from huggingface.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF? " +
  'Publisher: Syntinal (us) — Our own publishing account; artifacts additionally self-pinned by code-committed SHA-256. ' +
  "Talaria verifies the file's checksum against its pinned value after downloading, " +
  'then places it in ~/.local/share/talaria/models/SyntinalCo/sweep-next-edit-v2-7B-GGUF/sweep-next-edit-v2-7B-Q4_K_M.gguf.';

const LIVE_OID_OLLAMA_MODAL =
  "Download 'Live Row' (Q4_K_M, ~4.7 GB) from huggingface.co/Qwen/live-repo? " +
  'Publisher: Qwen (Alibaba) — Alibaba’s verified Hugging Face organization — the models’ own publisher. ' +
  "Talaria verifies the file's checksum against the publisher's manifest after downloading, " +
  'and Ollama verifies it again during install at http://127.0.0.1:11434.';

const LIVE_OID_LLAMACPP_MODAL =
  "Download 'Live Row' (Q4_K_M, ~4.7 GB) from huggingface.co/Qwen/live-repo? " +
  'Publisher: Qwen (Alibaba) — Alibaba’s verified Hugging Face organization — the models’ own publisher. ' +
  "Talaria verifies the file's checksum against the publisher's manifest after downloading, " +
  'then places it in ~/.local/share/talaria/models/Qwen/live-repo/live.gguf.';

const GOOD_OID = 'a'.repeat(64);

// --- fakes (the provisionModel harness, shared-calls spy order) --------------

class FakeHost implements SetupHost {
  calls: string[];
  modalResponses: boolean[] = [];
  modalGate?: Promise<void>;
  settings = new Map<string, unknown>();
  globalStateStore = new Map<string, unknown>();
  trusted = true;

  constructor(sharedCalls: string[]) {
    this.calls = sharedCalls;
  }

  async showModal(message: string, _confirmLabel: string): Promise<boolean> {
    this.calls.push(`showModal:${message}`);
    if (this.modalGate) await this.modalGate;
    return this.modalResponses.length > 0 ? (this.modalResponses.shift() as boolean) : true;
  }
  async showPasswordInput(): Promise<string | undefined> {
    return undefined;
  }
  createTerminal(): void {}
  runInTerminal(): void {}
  getSetting<T>(key: string): T | undefined {
    return this.settings.get(key) as T | undefined;
  }
  async updateSettingGlobal(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }
  secrets = {
    store: async (): Promise<void> => {},
    has: async (): Promise<boolean> => false,
    delete: async (): Promise<void> => {},
  };
  globalState = {
    get: <T,>(key: string): T | undefined => this.globalStateStore.get(key) as T | undefined,
    update: async (key: string, v: unknown): Promise<void> => {
      this.globalStateStore.set(key, v);
    },
  };
  isTrusted(): boolean {
    return this.trusted;
  }
  offerReload(): void {}
  reload(): void {}
}

function makeFixtureController(
  behaviors: { verify?: { ok: true } | { ok: false; reason: string } | 'reject' } = {},
): {
  host: FakeHost;
  controller: SetupController;
  calls: string[];
  verifyArgs: HfGgufSpec[];
  ingestArgs: Array<{ spec: unknown; endpoint: string }>;
  storeArgs: Array<{ spec: unknown; destDir: string; destFile: string }>;
} {
  const calls: string[] = [];
  const host = new FakeHost(calls);
  const verifyArgs: HfGgufSpec[] = [];
  const ingestArgs: Array<{ spec: unknown; endpoint: string }> = [];
  const storeArgs: Array<{ spec: unknown; destDir: string; destFile: string }> = [];
  const deps: SetupControllerDeps = {
    locatePipx: async (): Promise<PipxLocateResult> => ({ ok: false, reason: 'pipx-missing', detail: 'unused' }),
    readOsRelease: async () => ({}),
    installHermes: async () => {
      throw new Error('not used here');
    },
    probeOllama: async (): Promise<OllamaStatus> => ({ running: false, detail: 'not running' }),
    pullModel: async (): Promise<void> => {
      calls.push('pullModel');
    },
    probeRemote: async (): Promise<ProbeOutcome> => ({ ok: true, detail: 'ok' }),
    registry: { AGENT_BACKENDS, FIM_BACKENDS, getBackend },
    getNextEditSource: () => 'off',
    getAdvertisedAuthMethods: () => undefined,
    verifyHfDigest: async (gguf) => {
      calls.push('verifyHfDigest');
      verifyArgs.push(gguf);
      if (behaviors.verify === 'reject') throw new Error('verify seam rejected');
      return behaviors.verify ?? { ok: true };
    },
    ingestGguf: async (spec, endpoint): Promise<void> => {
      calls.push('ingestGguf');
      ingestArgs.push({ spec, endpoint });
    },
    resolveLfsOid: async (): Promise<LfsOidVerdict> => {
      calls.push('resolveLfsOid');
      return { ok: true, oid: GOOD_OID };
    },
    locateLlamaServer: () => new Promise<never>(() => {}),
    scanStorePresence: async () => new Map<string, boolean>(),
    storeDest: () => ({ ok: false, reason: 'not used here' }),
    checkedStoreDest: async (hfRepo: string, file: string) => {
      calls.push('checkedStoreDest');
      const destDir = `${homedir()}/.local/share/talaria/models/${hfRepo}`;
      return { ok: true as const, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    downloadGgufToStore: async (spec, destDir, destFile): Promise<void> => {
      calls.push('downloadGgufToStore');
      storeArgs.push({ spec, destDir, destFile });
    },
  };
  const controller = new SetupController(host, deps);
  return { host, controller, calls, verifyArgs, ingestArgs, storeArgs };
}

// --- step 2: SC-1 refusals fire BEFORE any fetch (assert-before-resolve) -----

describe('T7 step 2 (poisoned fixtures): source refusals fire BEFORE any fetch/modal/latch work', () => {
  for (const backend of ['ollama', 'llamacpp'] as const) {
    it(`charset violation ('mistralai/../evil-org') × ${backend} → refuse; resolveLfsOid/verify NEVER called`, async () => {
      const { controller, calls } = makeFixtureController();
      const result = await controller.handle('setup.provisionModel', { modelId: 'bad-charset', backend });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('hfRepo');
      expect(calls).toEqual([]);
    });

    it(`publisher outside TRUSTED_HF_PUBLISHERS × ${backend} → refuse before any fetch`, async () => {
      const { controller, calls } = makeFixtureController();
      const result = await controller.handle('setup.provisionModel', { modelId: 'bad-publisher', backend });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('allowlist');
      expect(calls).toEqual([]);
    });

    it(`hfRepo owner ≠ row publisher × ${backend} → prefix re-assert refuses before any fetch`, async () => {
      const { controller, calls } = makeFixtureController();
      const result = await controller.handle('setup.provisionModel', { modelId: 'bad-prefix', backend });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('publisher');
      expect(calls).toEqual([]);
    });
  }

  it('a createdName with a "/" (poisoned tag) → refuse before any fetch', async () => {
    const { controller, calls } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'bad-created', backend: 'ollama' });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

// --- exhaustive VerifySpec: default-REFUSE -----------------------------------

describe('T7: unknown VerifySpec mode is refused, never a permissive fall-through (SC-A-9)', () => {
  for (const backend of ['ollama', 'llamacpp'] as const) {
    it(`verify.mode 'sha3-someday' × ${backend} → refusal; no fetch, no modal, no engine`, async () => {
      const { controller, calls } = makeFixtureController();
      const result = await controller.handle('setup.provisionModel', { modelId: 'bad-mode', backend });
      expect(result).toEqual({ ok: false, reason: UNKNOWN_VERIFY_REFUSAL });
      expect(calls).toEqual([]);
    });
  }
});

// --- honest absence (fixture-only rows) --------------------------------------

describe('T7 steps 4a/5a: honest-absence refusals (no shipping row reaches these)', () => {
  it('backend=ollama with no ollama cell → honest absence refusal', async () => {
    const { controller, calls } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'no-ollama', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: OLLAMA_HONEST_ABSENCE });
    expect(calls).toEqual([]);
  });

  it('backend=llamacpp with no llamacpp cell → the §6 unavailableReason copy', async () => {
    const { controller, calls } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'no-llamacpp', backend: 'llamacpp' });
    expect(result).toEqual({ ok: false, reason: LLAMACPP_HONEST_ABSENCE });
    expect(calls).toEqual([]);
  });
});

// --- the T1-M1 dash guard through the catalog tier ---------------------------

describe('T7: runLibraryPull rejects an option-shaped catalog tag', () => {
  it("tag '-inject:latest' passes charset but is refused before deps.pullModel", async () => {
    const { controller, calls } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'dash-tag', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: "model tag must not begin with '-'" });
    expect(calls).not.toContain('pullModel');
  });
});

// --- step 4c pinned (published pin): the NEXT re-route -----------------------

describe('T7 step 4c (pinned fixture pin published): sweep-next via ollama — the NEXT re-route', () => {
  it('non-loopback endpoint → remote refusal BEFORE verifyHfDigest/modal/ingest', async () => {
    const { controller, calls } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'sweep-next',
      backend: 'ollama',
      endpoint: 'http://192.168.1.5:11434',
    });
    expect(result).toEqual({ ok: false, reason: REMOTE_ENDPOINT_REFUSAL });
    expect(calls).toEqual([]);
  });

  it('verifyHfDigest failure → integrity refusal BEFORE the modal', async () => {
    const { controller, calls } = makeFixtureController({ verify: { ok: false, reason: 'set mismatch' } });
    const result = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL });
    expect(calls).toEqual(['verifyHfDigest']);
  });

  it('a REJECTING verify seam is the same refusal, never a crash', async () => {
    const { controller, calls } = makeFixtureController({ verify: 'reject' });
    const result = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL });
    expect(calls).toEqual(['verifyHfDigest']);
  });

  it('happy path: EXACT beta.5 engine order (verify → pinned modal → ingest), keyed pull:sweep-next', async () => {
    const { controller, calls, verifyArgs, ingestArgs } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['verifyHfDigest', `showModal:${PINNED_OLLAMA_MODAL}`, 'ingestGguf']);
    // SC-5: the pre-flight runs the FULL exact-file-set check — the registry's
    // own allowedRepoFiles, drift-locked equal to the catalog artifact.
    expect(verifyArgs).toEqual([
      {
        hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
        file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
        sha256: TEST_PIN,
        allowedRepoFiles: NEXT_DEDICATED_MODEL.gguf.allowedRepoFiles,
      },
    ]);
    expect(ingestArgs).toEqual([
      {
        spec: {
          gguf: {
            hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
            file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
            quant: 'Q4_K_M',
            sha256: TEST_PIN,
            approxBytes: 4_680_000_000,
            allowedRepoFiles: NEXT_DEDICATED_MODEL.gguf.allowedRepoFiles,
          },
          ollamaCreatedName: 'sweep-next-edit-v2-7b:q4_k_m',
        },
        endpoint: 'http://127.0.0.1:11434',
      },
    ]);
  });

  it('the re-route is latched pull:sweep-next — a second call while the modal is open is refused', async () => {
    const { host, controller } = makeFixtureController();
    let release: () => void = () => {};
    host.modalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    await vi.waitFor(() => {
      expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(true);
    });
    const second = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    expect(second).toEqual({ ok: false, reason: 'pull already running' });
    release();
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('a pinned row whose artifact is NOT the registry pin is refused (fail-closed guard)', async () => {
    const { controller, calls } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'pinned-foreign', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL });
    expect(calls).toEqual([]); // refused before ANY verify/fetch — the exact-set spec cannot be assembled
  });
});

// --- step 5 pinned (published pin): llamacpp — SC-5 pre-flight ---------------

describe('T7 step 5b (pinned fixture pin published): sweep-next via llamacpp', () => {
  it('pinned llamacpp calls verifyHfDigest (SC-5) → dest → pinned modal → downloadGgufToStore', async () => {
    const { controller, calls, verifyArgs, storeArgs } = makeFixtureController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'llamacpp' });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      'verifyHfDigest',
      'checkedStoreDest',
      `showModal:${PINNED_LLAMACPP_MODAL}`,
      'downloadGgufToStore',
    ]);
    expect(verifyArgs).toEqual([
      {
        hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
        file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
        sha256: TEST_PIN,
        allowedRepoFiles: NEXT_DEDICATED_MODEL.gguf.allowedRepoFiles,
      },
    ]);
    expect(storeArgs).toEqual([
      {
        spec: {
          catalogId: 'sweep-next',
          gguf: {
            hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
            file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
            quant: 'Q4_K_M',
            sha256: TEST_PIN,
            approxBytes: 4_680_000_000,
          },
        },
        destDir: `${homedir()}/.local/share/talaria/models/SyntinalCo/sweep-next-edit-v2-7B-GGUF`,
        destFile: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
      },
    ]);
  });

  it('verify failure → integrity refusal BEFORE dest/modal/download', async () => {
    const { controller, calls } = makeFixtureController({ verify: { ok: false, reason: 'unexpected file' } });
    const result = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'llamacpp' });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL });
    expect(calls).toEqual(['verifyHfDigest']);
  });
});

// --- A-2: the two verify-mode modal strings are DISTINCT ---------------------

describe('T7 A-2: pinned vs live-oid modal copy is DISTINCT (a modal claim never exceeds the engine)', () => {
  it('ollama pair: observed pinned modal ≠ observed live-oid modal; each names its own verification basis', async () => {
    const pinned = makeFixtureController();
    await pinned.controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    const pinnedModal = pinned.calls.find((c) => c.startsWith('showModal:'));

    const live = makeFixtureController();
    await live.controller.handle('setup.provisionModel', { modelId: 'live-ok', backend: 'ollama' });
    const liveModal = live.calls.find((c) => c.startsWith('showModal:'));

    expect(pinnedModal).toBe(`showModal:${PINNED_OLLAMA_MODAL}`);
    expect(liveModal).toBe(`showModal:${LIVE_OID_OLLAMA_MODAL}`);
    expect(pinnedModal).not.toBe(liveModal);
    expect(pinnedModal).toContain('against its pinned value');
    expect(liveModal).toContain("against the publisher's manifest");
    expect(liveModal).not.toContain('against its pinned value');
  });

  it('llamacpp pair: observed pinned modal ≠ observed live-oid modal', async () => {
    const pinned = makeFixtureController();
    await pinned.controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'llamacpp' });
    const pinnedModal = pinned.calls.find((c) => c.startsWith('showModal:'));

    const live = makeFixtureController();
    await live.controller.handle('setup.provisionModel', { modelId: 'live-ok', backend: 'llamacpp' });
    const liveModal = live.calls.find((c) => c.startsWith('showModal:'));

    expect(pinnedModal).toBe(`showModal:${PINNED_LLAMACPP_MODAL}`);
    expect(liveModal).toBe(`showModal:${LIVE_OID_LLAMACPP_MODAL}`);
    expect(pinnedModal).not.toBe(liveModal);
  });
});
