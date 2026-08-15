import { describe, it, expect, vi } from 'vitest';
import { SetupController, type SetupHost, type SetupControllerDeps } from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend } from './registry';
import type { PipxLocateResult } from './pipxLocator';
import type { OllamaStatus } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';

/**
 * AU-30 (TC-7): before this fix, `handleVettedIngest` (the `setup.pullModel`
 * legacy route to the Sweep artifact, keyed `pull:<ollamaCreatedName>`) and
 * `handleProvisionModel`→`provisionOllama`'s pinned branch (the
 * `setup.provisionModel` catalog route to the SAME artifact, keyed
 * `pull:<catalog id>`) latched under DIFFERENT `inFlight` keys. Two
 * concurrent triggers for the same artifact — one via each RPC — each won
 * their own latch and BOTH started a download. This file drives both RPCs
 * concurrently and proves exactly ONE `ingestGguf` call reaches the download
 * seam; the other must join the latch and be refused with 'pull already
 * running'.
 *
 * Mocks BOTH `./registry` (fills the empty §5.4 pin so `handleVettedIngest`
 * reaches its latch) and `./modelCatalog` (fills the `sweep-next` row's own
 * pin so `provisionOllama` reaches ITS latch) — the real registry/catalog
 * ship `sha256: ''` fail-closed by design; same convention as
 * `SetupController.pullGate.test.ts` / `SetupController.provisionModel.
 * fixtures.test.ts`.
 */

const TEST_PIN = vi.hoisted(() => 'e'.repeat(64));
const CREATED = 'sweep-next-edit-v2-7b:q4_k_m';

vi.mock('./registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>();
  return {
    ...actual,
    NEXT_DEDICATED_MODEL: {
      ...actual.NEXT_DEDICATED_MODEL,
      gguf: { ...actual.NEXT_DEDICATED_MODEL.gguf, sha256: TEST_PIN },
    } as unknown as typeof actual.NEXT_DEDICATED_MODEL,
  };
});

vi.mock('./modelCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./modelCatalog')>();
  const MODEL_CATALOG = actual.MODEL_CATALOG.map((m) => {
    if (m.id !== 'sweep-next' || m.ollama === undefined || m.ollama.tier !== 'hf-ingest') return m;
    return { ...m, ollama: { ...m.ollama, verify: { mode: 'pinned' as const, sha256: TEST_PIN } } };
  });
  return { ...actual, MODEL_CATALOG };
});

class FakeHost implements SetupHost {
  calls: string[] = [];
  modalResponses: boolean[] = [];
  /** When set, showModal parks on it — lets the concurrency test hold both requests' modals open. */
  modalGate?: Promise<void>;
  settings = new Map<string, unknown>();
  globalStateStore = new Map<string, unknown>();
  trusted = true;

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

/** AU-30 cancel-latch fix: a real `AbortError` (name-shaped, matches the
 *  controller's own {@link isAbortError} check) — used by the ingestGguf
 *  overrides below so a `setup.cancel` that reaches the right
 *  `AbortController` produces the SAME `{ok:false, reason:'cancelled'}`
 *  the real ingest engine would on a genuine user cancel. */
function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function makeController(overrides: Partial<SetupControllerDeps> = {}): {
  host: FakeHost;
  controller: SetupController;
  ingestArgs: Array<{ spec: unknown; endpoint: string }>;
} {
  const host = new FakeHost();
  const ingestArgs: Array<{ spec: unknown; endpoint: string }> = [];
  const deps: SetupControllerDeps = {
    locatePipx: async (): Promise<PipxLocateResult> => ({ ok: false, reason: 'pipx-missing', detail: 'unused' }),
    readOsRelease: async () => ({}),
    installHermes: async () => {
      throw new Error('not used here');
    },
    probeOllama: async (): Promise<OllamaStatus> => ({ running: false, detail: 'not running' }),
    pullModel: async (): Promise<void> => {
      throw new Error('not used here — this test drives the vetted-ingest path only');
    },
    probeRemote: async (): Promise<ProbeOutcome> => ({ ok: true, detail: 'ok' }),
    registry: { AGENT_BACKENDS, FIM_BACKENDS, getBackend },
    getNextEditSource: () => 'off',
    getAdvertisedAuthMethods: () => undefined,
    verifyHfDigest: async () => ({ ok: true }),
    ingestGguf: async (spec, endpoint): Promise<void> => {
      ingestArgs.push({ spec, endpoint });
    },
    resolveLfsOid: async () => ({ ok: false, reason: 'not used here' }),
    locateLlamaServer: () => new Promise<never>(() => {}),
    scanStorePresence: async () => new Map<string, boolean>(),
    storeDest: () => ({ ok: false, reason: 'not used here' }),
    checkedStoreDest: async () => ({ ok: false, reason: 'not used here' }),
    downloadGgufToStore: async () => {
      throw new Error('not used here');
    },
    ...overrides,
  };
  const controller = new SetupController(host, deps);
  return { host, controller, ingestArgs };
}

/** An `ingestGguf` that never resolves on its own — it hangs until its
 *  `signal` aborts, then rejects with {@link abortError}, exactly like the
 *  real download engine reacting to a genuine `setup.cancel`. Lets these
 *  tests observe cancellation through the SAME `{ok:false,
 *  reason:'cancelled'}` path production code takes, rather than reaching
 *  into controller internals. */
function hangingIngestGguf(
  ingestArgs: Array<{ spec: unknown; endpoint: string }>,
): SetupControllerDeps['ingestGguf'] {
  return (spec, endpoint, _onProgress, signal) => {
    ingestArgs.push({ spec, endpoint });
    return new Promise<void>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()));
    });
  };
}

/** Races `promise` against a bounded timeout so a still-unfixed regression
 *  fails FAST with a clear assertion mismatch instead of hanging the run
 *  out to vitest's default per-test timeout. */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms))]);
}
const TIMED_OUT = Symbol('timed-out');

describe('AU-30 (TC-7): pull latch unification — setup.pullModel vs setup.provisionModel, SAME Sweep artifact', () => {
  it('two concurrent triggers for the same artifact: ingestGguf runs exactly once (the second joins the latch)', async () => {
    const { host, controller, ingestArgs } = makeController();
    let release: () => void = () => {};
    host.modalGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // First trigger: the legacy `setup.pullModel` route (created-name match).
    const first = controller.handle('setup.pullModel', { model: CREATED });
    await vi.waitFor(() => {
      expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(true);
    });

    // Second trigger, dispatched WHILE the first is parked on its modal:
    // the catalog route to the exact same artifact.
    const second = controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // The load-bearing assertion: only ONE download ever reaches the
    // injectable download seam, regardless of which RPC won the latch.
    expect(ingestArgs).toHaveLength(1);

    const results = [firstResult, secondResult];
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'pull already running')).toHaveLength(1);
  });
});

/**
 * AU-30 follow-up (review-caught regression): TC-7 unified the LATCH key
 * `handleVettedIngest` sets to the canonical catalog id (`pull:sweep-next`)
 * but left `handleCancel`'s latch LOOKUP keyed on the raw `created` name it
 * receives over the wire. The webview's ONLY cancel affordance for this row
 * (`cancelPullParams`, `ConfiguredModelRow` in `SetupPanel.tsx`) dispatches
 * `{op:'pull', id: model}` where `model` is the created-name string the user
 * typed/saved — never the canonical id — so `handleCancel` was looking up a
 * key nothing ever latches under. Cancel silently no-op'd; dedup itself
 * still held (this file's block above) and `dispose()` still aborted it
 * (TC-6), so this was narrow but real: the Cancel button did nothing.
 */
describe('AU-30 follow-up: setup.cancel latch-lookup canonicalization', () => {
  it('setup.cancel({op:"pull", id: createdName}) cancels the in-flight setup.pullModel vetted-ingest pull', async () => {
    const ingestArgs: Array<{ spec: unknown; endpoint: string }> = [];
    const { controller } = makeController({ ingestGguf: hangingIngestGguf(ingestArgs) });

    const first = controller.handle('setup.pullModel', { model: CREATED });
    await vi.waitFor(() => {
      expect(ingestArgs).toHaveLength(1);
    });

    // The exact payload `cancelPullParams(model)` sends: `id` is the raw
    // created name, NOT the canonical catalog id the latch is keyed under.
    await controller.handle('setup.cancel', { op: 'pull', id: CREATED });

    const result = await raceTimeout(first, 300);
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('setup.cancel({op:"pull", id: catalogId}) still cancels the setup.provisionModel pull path (id already canonical)', async () => {
    const ingestArgs: Array<{ spec: unknown; endpoint: string }> = [];
    const { controller } = makeController({ ingestGguf: hangingIngestGguf(ingestArgs) });

    const first = controller.handle('setup.provisionModel', { modelId: 'sweep-next', backend: 'ollama' });
    await vi.waitFor(() => {
      expect(ingestArgs).toHaveLength(1);
    });

    await controller.handle('setup.cancel', { op: 'pull', id: 'sweep-next' });

    const result = await raceTimeout(first, 300);
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });
});
