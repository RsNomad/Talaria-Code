import { describe, it, expect, vi } from 'vitest';
import { SetupController, assertProvisionSources, type SetupHost, type SetupControllerDeps } from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend } from './registry';
import { MODEL_CATALOG } from './modelCatalog';
import type { LfsOidVerdict } from './hfDigest';
import type { PipxLocateResult } from './pipxLocator';
import type { OllamaStatus, PullProgress } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';
import type { SetupProgress } from '../../shared/protocol';
import { homedir } from 'node:os';

/**
 * T7 (beta.6 §2.5): `setup.provisionModel` — the REFUSAL-ORDER spy table over
 * the REAL catalog (poisoned-fixture rows live in
 * `SetupController.provisionModel.fixtures.test.ts`, which mocks the catalog
 * module). Every ordering assertion here is spy-order-locked: the shared
 * `calls` array records host modals AND dep invocations in one sequence, so
 * "refuses BEFORE the modal / BEFORE any fetch" is proven by array equality,
 * not by absence alone.
 */

// --- §6 copy, verbatim (drift-locked) ----------------------------------------

const UNKNOWN_ID_REFUSAL = 'Unknown model — the catalog is fixed in this release.';
const VLLM_REFUSAL =
  'vLLM serves models from its own command line — nothing to download here. Copy the run command instead.';
const REMOTE_ENDPOINT_REFUSAL =
  'Verified downloads only run against a local Ollama (loopback). For a remote server, download and verify the model on that machine — see the guided instructions.';
const INTEGRITY_REFUSAL = 'integrity check failed — refusing to download';
const DOWNLOAD_UNAVAILABLE =
  "No vetted build of this model is published yet — it can't be downloaded automatically. Use the guided instructions below, or the vLLM path (official release).";
const TRUST_REFUSAL = 'Workspace is not trusted — Setup changes are disabled in Restricted Mode.';

const LIBRARY_MODAL = "Pull model 'qwen2.5-coder:1.5b-base' from the Ollama registry onto 'http://127.0.0.1:11434'?";

// live-oid ollama-ingest modal (§6 row "Provision modal — live-oid", endpoint arm).
const DEVSTRAL_LIVE_OID_MODAL =
  "Download 'Devstral-24B (2507)' (Q4_K_M, ~14.3 GB) from huggingface.co/mistralai/Devstral-Small-2507_gguf? " +
  'Publisher: Mistral AI — Mistral’s verified Hugging Face organization — the models’ own publisher. ' +
  "Talaria verifies the file's checksum against the publisher's manifest after downloading, " +
  'and Ollama verifies it again during install at http://127.0.0.1:11434.';

// live-oid llamacpp-file modal (§6 row "Provision modal — live-oid", dest arm; dest is ~-redacted).
const EMBED_LLAMACPP_MODAL =
  "Download 'Qwen3-Embedding 0.6B' (Q8_0, ~0.6 GB) from huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF? " +
  'Publisher: Qwen (Alibaba) — Alibaba’s verified Hugging Face organization — the models’ own publisher. ' +
  "Talaria verifies the file's checksum against the publisher's manifest after downloading, " +
  'then places it in ~/.local/share/talaria/models/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf.';

const GOOD_OID = 'a'.repeat(64);

// --- fakes -------------------------------------------------------------------

class FakeHost implements SetupHost {
  calls: string[];
  modalResponses: boolean[] = [];
  /** When set, showModal parks on it — lets latch-before-modal tests hold the modal open. */
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

/** A dep that never resolves until its signal aborts (then rejects AbortError) — the cancel-path probe. */
function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    if (signal.aborted) {
      reject(err);
      return;
    }
    signal.addEventListener('abort', () => reject(err), { once: true });
  });
}

interface Recorded {
  host: FakeHost;
  controller: SetupController;
  calls: string[];
  pullArgs: Array<{ endpoint: string; model: string }>;
  ingestArgs: Array<{ spec: unknown; endpoint: string }>;
  storeArgs: Array<{ spec: unknown; destDir: string; destFile: string }>;
  resolveArgs: Array<{ hfRepo: string; file: string }>;
  emitPullProgress: { fn?: (p: PullProgress) => void };
}

function makeProvController(
  overrides: Partial<SetupControllerDeps> = {},
  behaviors: {
    resolve?: LfsOidVerdict | 'reject';
    hang?: 'pull' | 'ingest' | 'store';
    destRefusal?: string;
  } = {},
): Recorded {
  const calls: string[] = [];
  const host = new FakeHost(calls);
  const pullArgs: Recorded['pullArgs'] = [];
  const ingestArgs: Recorded['ingestArgs'] = [];
  const storeArgs: Recorded['storeArgs'] = [];
  const resolveArgs: Recorded['resolveArgs'] = [];
  const emitPullProgress: Recorded['emitPullProgress'] = {};
  const deps: SetupControllerDeps = {
    locatePipx: async (): Promise<PipxLocateResult> => ({ ok: false, reason: 'pipx-missing', detail: 'unused' }),
    readOsRelease: async () => ({}),
    installHermes: async () => {
      throw new Error('not used here');
    },
    probeOllama: async (): Promise<OllamaStatus> => ({ running: false, detail: 'not running' }),
    pullModel: async (endpoint, model, onProgress, signal): Promise<void> => {
      calls.push('pullModel');
      pullArgs.push({ endpoint, model });
      emitPullProgress.fn = onProgress;
      if (behaviors.hang === 'pull') await hangUntilAbort(signal);
    },
    probeRemote: async (): Promise<ProbeOutcome> => ({ ok: true, detail: 'ok' }),
    registry: { AGENT_BACKENDS, FIM_BACKENDS, getBackend },
    getNextEditSource: () => 'off',
    getAdvertisedAuthMethods: () => undefined,
    verifyHfDigest: async () => {
      calls.push('verifyHfDigest');
      return { ok: true };
    },
    ingestGguf: async (spec, endpoint, onProgress, signal): Promise<void> => {
      calls.push('ingestGguf');
      ingestArgs.push({ spec, endpoint });
      emitPullProgress.fn = onProgress;
      if (behaviors.hang === 'ingest') await hangUntilAbort(signal);
    },
    resolveLfsOid: async (hfRepo, file): Promise<LfsOidVerdict> => {
      calls.push('resolveLfsOid');
      resolveArgs.push({ hfRepo, file });
      if (behaviors.resolve === 'reject') throw new Error('resolve seam rejected');
      return behaviors.resolve ?? { ok: true, oid: GOOD_OID };
    },
    locateLlamaServer: () => new Promise<never>(() => {}),
    scanStorePresence: async () => new Map<string, boolean>(),
    storeDest: () => ({ ok: false, reason: 'not used here' }),
    checkedStoreDest: async (hfRepo: string, file: string) => {
      calls.push('checkedStoreDest');
      if (behaviors.destRefusal !== undefined) {
        return { ok: false as const, reason: behaviors.destRefusal };
      }
      const destDir = `${homedir()}/.local/share/talaria/models/${hfRepo}`;
      return { ok: true as const, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    downloadGgufToStore: async (spec, destDir, destFile, onProgress, signal): Promise<void> => {
      calls.push('downloadGgufToStore');
      storeArgs.push({ spec, destDir, destFile });
      emitPullProgress.fn = onProgress;
      if (behaviors.hang === 'store') await hangUntilAbort(signal);
    },
    ...overrides,
  };
  const controller = new SetupController(host, deps);
  return { host, controller, calls, pullArgs, ingestArgs, storeArgs, resolveArgs, emitPullProgress };
}

// --- step 0: trust gate ------------------------------------------------------

describe('T7 step 0: trust gate (MUTATING_METHODS membership)', () => {
  it('refused when the workspace is untrusted — no modal, no dep call, no latch', async () => {
    const { host, controller, calls } = makeProvController();
    host.trusted = false;
    const result = await controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: TRUST_REFUSAL });
    expect(calls).toEqual([]);
  });
});

// --- step 1: params ----------------------------------------------------------

describe('T7 step 1: params (strict catalog id, strict backend enum)', () => {
  it('unknown modelId → §6 unknown-id refusal, nothing else runs', async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'gpt-5', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: UNKNOWN_ID_REFUSAL });
    expect(calls).toEqual([]);
  });

  it('missing / non-string modelId → unknown-id refusal', async () => {
    const { controller, calls } = makeProvController();
    expect(await controller.handle('setup.provisionModel', {})).toEqual({ ok: false, reason: UNKNOWN_ID_REFUSAL });
    expect(await controller.handle('setup.provisionModel', { modelId: 42, backend: 'ollama' })).toEqual({
      ok: false,
      reason: UNKNOWN_ID_REFUSAL,
    });
    expect(calls).toEqual([]);
  });

  it("modelId is STRICT — a padded ' devstral-24b ' does not match", async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.provisionModel', { modelId: ' devstral-24b ', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: UNKNOWN_ID_REFUSAL });
    expect(calls).toEqual([]);
  });

  it("backend 'vllm' → the §6 vllm refusal (refused, never ignored)", async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend: 'vllm' });
    expect(result).toEqual({ ok: false, reason: VLLM_REFUSAL });
    expect(calls).toEqual([]);
  });

  it('any other backend value → strict-enum refusal', async () => {
    const { controller, calls } = makeProvController();
    for (const backend of ['docker', '', undefined, 7]) {
      const result = await controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend });
      expect(result).toEqual({ ok: false, reason: "backend must be 'ollama' or 'llamacpp'." });
    }
    expect(calls).toEqual([]);
  });

  it('order: unknown modelId beats the vllm refusal (step 1 checks id first)', async () => {
    const { controller } = makeProvController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'nope', backend: 'vllm' });
    expect(result).toEqual({ ok: false, reason: UNKNOWN_ID_REFUSAL });
  });
});

// --- step 2: source closure over the REAL catalog (unreachable-but-tested) ---

describe('T7 step 2: assertProvisionSources closure over every shipping row', () => {
  for (const model of MODEL_CATALOG) {
    for (const backend of ['ollama', 'llamacpp'] as const) {
      it(`'${model.id}' × ${backend} passes the runtime source assert`, () => {
        expect(assertProvisionSources(model, backend)).toEqual({ ok: true });
      });
    }
  }
});

// --- step 4b: the library tier (ONE modal, extracted runLibraryPull) ---------

describe('T7 step 4b: library tier (qwen25-coder-1.5b via ollama)', () => {
  it('invalid endpoint → URL refusal BEFORE any modal/pull', async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'qwen25-coder-1.5b',
      backend: 'ollama',
      endpoint: 'not-a-url',
    });
    expect(result).toEqual({ ok: false, reason: 'Enter a valid http:// or https:// URL.' });
    expect(calls).toEqual([]);
  });

  it('happy path: EXACTLY ONE modal (§6 copy naming the endpoint) → deps.pullModel with the catalog tag', async () => {
    const { controller, calls, pullArgs } = makeProvController();
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'qwen25-coder-1.5b',
      backend: 'ollama',
      endpoint: '  http://127.0.0.1:11434  ', // trimmed before validation/modal
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([`showModal:${LIBRARY_MODAL}`, 'pullModel']);
    expect(pullArgs).toEqual([{ endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' }]);
  });

  it('endpoint defaults to the registry ollama endpoint when absent', async () => {
    const { controller, pullArgs } = makeProvController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'qwen25-coder-1.5b', backend: 'ollama' });
    expect(result).toEqual({ ok: true });
    expect(pullArgs).toEqual([{ endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' }]);
  });

  it('progress rides id = CATALOG id (not the tag); cancel key = pull:<catalog id>', async () => {
    const { controller, emitPullProgress } = makeProvController();
    const events: SetupProgress[] = [];
    controller.onProgress((e) => events.push(e));
    await controller.handle('setup.provisionModel', { modelId: 'qwen25-coder-1.5b', backend: 'ollama' });
    emitPullProgress.fn?.({ status: 'downloading', totalBytes: 10, completedBytes: 5 });
    expect(events).toContainEqual({
      op: 'pull',
      id: 'qwen25-coder-1.5b',
      phase: 'downloading',
      totalBytes: 10,
      completedBytes: 5,
    });
  });

  it('decline → declined; pull never runs; latch released (a retry shows the modal again)', async () => {
    const { host, controller, calls } = makeProvController();
    host.modalResponses = [false, true];
    const first = await controller.handle('setup.provisionModel', { modelId: 'qwen25-coder-1.5b', backend: 'ollama' });
    expect(first).toEqual({ ok: false, reason: 'declined' });
    expect(calls).toEqual([`showModal:${LIBRARY_MODAL}`]);
    const second = await controller.handle('setup.provisionModel', { modelId: 'qwen25-coder-1.5b', backend: 'ollama' });
    expect(second).toEqual({ ok: true });
    expect(calls).toEqual([`showModal:${LIBRARY_MODAL}`, `showModal:${LIBRARY_MODAL}`, 'pullModel']);
  });

  it('latch BEFORE the modal: a second call while the first modal is open → "pull already running"', async () => {
    const { host, controller } = makeProvController();
    let release: () => void = () => {};
    host.modalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.handle('setup.provisionModel', { modelId: 'qwen25-coder-1.5b', backend: 'ollama' });
    await vi.waitFor(() => {
      expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(true);
    });
    const second = await controller.handle('setup.provisionModel', { modelId: 'qwen25-coder-1.5b', backend: 'ollama' });
    expect(second).toEqual({ ok: false, reason: 'pull already running' });
    release();
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('setup.cancel {op:pull, id:<catalog id>} aborts the in-flight pull → "cancelled"', async () => {
    const { controller, calls } = makeProvController({}, { hang: 'pull' });
    const first = controller.handle('setup.provisionModel', { modelId: 'qwen25-coder-1.5b', backend: 'ollama' });
    await vi.waitFor(() => {
      expect(calls).toContain('pullModel');
    });
    await controller.handle('setup.cancel', { op: 'pull', id: 'qwen25-coder-1.5b' });
    await expect(first).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });
});

// --- legacy back-compat + the T1-M1 dash guard -------------------------------

describe('T7: legacy setup.pullModel stays behavior-compatible; runLibraryPull rejects option-shaped tags', () => {
  it("legacy free-text library pull is unchanged (modal copy + pull, tag-keyed progress id)", async () => {
    const { controller, calls, pullArgs, emitPullProgress } = makeProvController();
    const events: SetupProgress[] = [];
    controller.onProgress((e) => events.push(e));
    const result = await controller.handle('setup.pullModel', { model: 'qwen2.5-coder:1.5b-base' });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      "showModal:Pull model 'qwen2.5-coder:1.5b-base' from the Ollama registry to your local disk?",
      'pullModel',
    ]);
    expect(pullArgs).toEqual([{ endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' }]);
    emitPullProgress.fn?.({ status: 'downloading' });
    expect(events).toContainEqual({ op: 'pull', id: 'qwen2.5-coder:1.5b-base', phase: 'downloading' });
  });

  it("a leading-'-' free-text model is refused before deps.pullModel (arg-injection surface, T1-M1)", async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.pullModel', { model: '-rf' });
    expect(result).toEqual({ ok: false, reason: "model tag must not begin with '-'" });
    expect(calls).not.toContain('pullModel');
  });

  // T1 (beta.6 panel-fix PT1): the modal-forging sanitation sweep runs BEFORE
  // the Pull modal — an EARLIER gate than the leading-dash check above, never
  // a looser one. A bidi-override character must never reach the native modal.
  it('T1 sanitation sweep: a bidi-override free-text model is refused BEFORE the Pull modal, naming the param', async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.pullModel', { model: 'qwen2.5-coder\u202eevil:1.5b-base' });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/model/i);
    expect(calls).toEqual([]); // no modal shown, deps.pullModel never called
  });
});

// --- step 4c live-oid: the Devstral ingest row (rev 3) -----------------------

describe('T7 step 4c (live-oid): devstral-24b via ollama', () => {
  it('non-loopback endpoint → remote refusal BEFORE resolveLfsOid/modal/ingest', async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'devstral-24b',
      backend: 'ollama',
      endpoint: 'http://192.168.1.5:11434',
    });
    expect(result).toEqual({ ok: false, reason: REMOTE_ENDPOINT_REFUSAL });
    expect(calls).toEqual([]);
  });

  it('resolveLfsOid {ok:false} → integrity refusal BEFORE the modal', async () => {
    const { controller, calls } = makeProvController({}, { resolve: { ok: false, reason: 'tree API responded 503' } });
    const result = await controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL });
    expect(calls).toEqual(['resolveLfsOid']);
  });

  it('a REJECTING resolveLfsOid seam is the same refusal, never a crash', async () => {
    const { controller, calls } = makeProvController({}, { resolve: 'reject' });
    const result = await controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL });
    expect(calls).toEqual(['resolveLfsOid']);
  });

  it('happy path: resolve → DISTINCT live-oid modal (§6 verbatim) → ingestGguf with sha256 = resolved oid + created name', async () => {
    const { controller, calls, ingestArgs, resolveArgs } = makeProvController();
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'devstral-24b',
      backend: 'ollama',
      endpoint: ' http://127.0.0.1:11434 ',
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['resolveLfsOid', `showModal:${DEVSTRAL_LIVE_OID_MODAL}`, 'ingestGguf']);
    expect(resolveArgs).toEqual([
      { hfRepo: 'mistralai/Devstral-Small-2507_gguf', file: 'Devstral-Small-2507-Q4_K_M.gguf' },
    ]);
    expect(ingestArgs).toEqual([
      {
        spec: {
          gguf: {
            hfRepo: 'mistralai/Devstral-Small-2507_gguf',
            file: 'Devstral-Small-2507-Q4_K_M.gguf',
            quant: 'Q4_K_M',
            sha256: GOOD_OID,
            approxBytes: 14_333_915_904,
          },
          ollamaCreatedName: 'devstral-small-2507:24b',
        },
        endpoint: 'http://127.0.0.1:11434',
      },
    ]);
  });

  it('progress rides id = devstral-24b; setup.cancel {id: devstral-24b} aborts the ingest', async () => {
    const { controller, calls, emitPullProgress } = makeProvController({}, { hang: 'ingest' });
    const events: SetupProgress[] = [];
    controller.onProgress((e) => events.push(e));
    const first = controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend: 'ollama' });
    await vi.waitFor(() => {
      expect(calls).toContain('ingestGguf');
    });
    emitPullProgress.fn?.({ status: 'downloading', totalBytes: 100, completedBytes: 1 });
    expect(events).toContainEqual({
      op: 'pull',
      id: 'devstral-24b',
      phase: 'downloading',
      totalBytes: 100,
      completedBytes: 1,
    });
    await controller.handle('setup.cancel', { op: 'pull', id: 'devstral-24b' });
    await expect(first).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });

  it('single-flight keyed pull:devstral-24b — a second call while the modal is open is refused', async () => {
    const { host, controller } = makeProvController();
    let release: () => void = () => {};
    host.modalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend: 'ollama' });
    await vi.waitFor(() => {
      expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(true);
    });
    const second = await controller.handle('setup.provisionModel', { modelId: 'devstral-24b', backend: 'ollama' });
    expect(second).toEqual({ ok: false, reason: 'pull already running' });
    release();
    await expect(first).resolves.toEqual({ ok: true });
  });
});

// --- step 4c pinned (real catalog: empty pin) + NEXT re-route ----------------

describe('T7 step 4c (pinned, real catalog): sweep-next fail-closed — the NEXT re-route is refusal-equivalent', () => {
  it('provisionModel(sweep-next, ollama) with the shipping empty pin → beta.5 unavailable line, nothing runs', async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: DOWNLOAD_UNAVAILABLE });
    expect(calls).toEqual([]);
  });

  it('provisionModel(sweep-next, llamacpp) with the shipping empty pin → same fail-closed line', async () => {
    const { controller, calls } = makeProvController();
    const result = await controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'llamacpp' });
    expect(result).toEqual({ ok: false, reason: DOWNLOAD_UNAVAILABLE });
    expect(calls).toEqual([]);
  });
});

// --- step 5: llamacpp branch -------------------------------------------------

describe('T7 step 5: llamacpp file downloads (live-oid rows)', () => {
  it('resolveLfsOid failure → integrity refusal BEFORE dest/modal/download', async () => {
    const { controller, calls } = makeProvController({}, { resolve: { ok: false, reason: 'paginated' } });
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'qwen3-embedding-0.6b',
      backend: 'llamacpp',
    });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL });
    expect(calls).toEqual(['resolveLfsOid']);
  });

  it('checkedStoreDest {ok:false} (symlink/store-root refusal) → refuse BEFORE the modal', async () => {
    const { controller, calls } = makeProvController({}, { destRefusal: 'store path is a symlink — refusing' });
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'qwen3-embedding-0.6b',
      backend: 'llamacpp',
    });
    expect(result).toEqual({ ok: false, reason: 'store path is a symlink — refusing' });
    expect(calls).toEqual(['resolveLfsOid', 'checkedStoreDest']);
  });

  it('happy path: resolve → WRITE-gated dest → mode-distinct modal naming the ~-redacted dest → downloadGgufToStore', async () => {
    const { controller, calls, storeArgs } = makeProvController();
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'qwen3-embedding-0.6b',
      backend: 'llamacpp',
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      'resolveLfsOid',
      'checkedStoreDest',
      `showModal:${EMBED_LLAMACPP_MODAL}`,
      'downloadGgufToStore',
    ]);
    expect(storeArgs).toEqual([
      {
        spec: {
          catalogId: 'qwen3-embedding-0.6b',
          gguf: {
            hfRepo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
            file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
            quant: 'Q8_0',
            sha256: GOOD_OID,
            approxBytes: 639_150_592,
          },
        },
        destDir: `${homedir()}/.local/share/talaria/models/Qwen/Qwen3-Embedding-0.6B-GGUF`,
        destFile: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
      },
    ]);
  });

  it('the modal never leaks the raw home directory (dest is ~-redacted)', async () => {
    const { controller, calls } = makeProvController();
    await controller.handle('setup.provisionModel', { modelId: 'qwen3-embedding-0.6b', backend: 'llamacpp' });
    const modal = calls.find((c) => c.startsWith('showModal:'));
    expect(modal).toBeDefined();
    expect(modal).not.toContain(homedir());
  });

  it('a successful download fires onStatusChanged exactly once (presence flips on the next scan)', async () => {
    const { controller } = makeProvController();
    let fired = 0;
    controller.onStatusChanged(() => {
      fired += 1;
    });
    await controller.handle('setup.provisionModel', { modelId: 'qwen3-embedding-0.6b', backend: 'llamacpp' });
    expect(fired).toBe(1);
  });

  it('a refused/declined llamacpp provision does NOT fire onStatusChanged', async () => {
    const { host, controller } = makeProvController();
    host.modalResponses = [false];
    let fired = 0;
    controller.onStatusChanged(() => {
      fired += 1;
    });
    const result = await controller.handle('setup.provisionModel', {
      modelId: 'qwen3-embedding-0.6b',
      backend: 'llamacpp',
    });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(fired).toBe(0);
  });

  it('progress rides id = catalog id; setup.cancel aborts the download → "cancelled"; latch released after', async () => {
    const { controller, calls, emitPullProgress } = makeProvController({}, { hang: 'store' });
    const events: SetupProgress[] = [];
    controller.onProgress((e) => events.push(e));
    const first = controller.handle('setup.provisionModel', { modelId: 'qwen3-embedding-0.6b', backend: 'llamacpp' });
    await vi.waitFor(() => {
      expect(calls).toContain('downloadGgufToStore');
    });
    emitPullProgress.fn?.({ status: 'downloading', totalBytes: 9, completedBytes: 3 });
    expect(events).toContainEqual({
      op: 'pull',
      id: 'qwen3-embedding-0.6b',
      phase: 'downloading',
      totalBytes: 9,
      completedBytes: 3,
    });
    await controller.handle('setup.cancel', { op: 'pull', id: 'qwen3-embedding-0.6b' });
    await expect(first).resolves.toEqual({ ok: false, reason: 'cancelled' });
    // finally-release: a retry passes the latch again (it would be refused
    // 'pull already running' if the cancelled attempt had wedged the key).
    const retry = controller.handle('setup.provisionModel', {
      modelId: 'qwen3-embedding-0.6b',
      backend: 'llamacpp',
    });
    await vi.waitFor(() => {
      expect(calls.filter((c) => c === 'downloadGgufToStore')).toHaveLength(2);
    });
    await controller.handle('setup.cancel', { op: 'pull', id: 'qwen3-embedding-0.6b' });
    await expect(retry).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });
});
