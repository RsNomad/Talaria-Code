import { describe, it, expect, vi } from 'vitest';
import { SetupController, type SetupHost, type SetupControllerDeps } from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend, NEXT_DEDICATED_MODEL } from './registry';
import { verifyHfDigest } from './hfDigest';
import type { PipxLocateResult } from './pipxLocator';
import type { OllamaStatus } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';
import type { SetupProgress } from '../../shared/protocol';

/**
 * T13 (beta.5 §4.4 branches 3b-3d): the vetted-ingest branch BEYOND the
 * empty-sha gate. The real registry ships `gguf.sha256 === ''` (fail-closed
 * until the out-of-band publication), so this file — and ONLY this file —
 * mocks the registry module with a published pin to make branches (b)/(c)/(d)
 * reachable. Everything else about the registry stays the actual data.
 *
 * `deps.verifyHfDigest` here is the REAL `verifyHfDigest` over a canned-tree
 * fake fetch, so the file-set-mismatch / oid-without-lfs / HTTP-error
 * refusals are proven END-TO-END through the controller (refuse BEFORE
 * showModal/ingestGguf), not just at the unit seam.
 */

const TEST_PIN = vi.hoisted(() => 'e'.repeat(64));

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

// §6 copy, verbatim (drift-locked).
const REMOTE_ENDPOINT_REFUSAL_COPY =
  'Verified downloads only run against a local Ollama (loopback). For a remote server, download and verify the model on that machine — see the guided instructions.';
const INTEGRITY_REFUSAL_COPY = 'integrity check failed — refusing to download';
const PULL_MODAL_COPY =
  "Download 'Sweep Next-Edit v2 (7B)' (~4.7 GB) and install it into your local Ollama? Source: huggingface.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF — Syntinal's build converted from Sweep's official release. Talaria verifies the file's checksum against its pinned value after downloading, and Ollama verifies it again during install.";

const CREATED = 'sweep-next-edit-v2-7b:q4_k_m';

interface TreeEntry {
  type?: string;
  path: string;
  oid?: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

function goodTree(): TreeEntry[] {
  return [
    { type: 'file', path: '.gitattributes', oid: '0b1c', size: 1519 },
    { type: 'file', path: 'README.md', oid: '4a5b', size: 812 },
    { type: 'file', path: 'sweep-next-edit-v2-7B-Q4_K_M.gguf', oid: '8e9f', lfs: { oid: TEST_PIN } },
  ];
}

function treeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  })) as unknown as typeof fetch;
}

class FakeHost implements SetupHost {
  calls: string[];
  modalResponses: boolean[] = [];
  /** When set, showModal parks on it — lets the single-flight test hold the modal open. */
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

function makeGateController(opts: { tree?: unknown; treeStatus?: number } = {}): {
  host: FakeHost;
  controller: SetupController;
  calls: string[];
  ingestArgs: Array<{ spec: unknown; endpoint: string }>;
  emitIngestProgress: { fn?: (p: { status: string; totalBytes?: number; completedBytes?: number }) => void };
  ingestBehavior: { reject?: Error };
} {
  const calls: string[] = [];
  const host = new FakeHost(calls);
  const ingestArgs: Array<{ spec: unknown; endpoint: string }> = [];
  const emitIngestProgress: { fn?: (p: { status: string; totalBytes?: number; completedBytes?: number }) => void } = {};
  const ingestBehavior: { reject?: Error } = {};
  const fetchImpl = treeFetch(opts.tree ?? goodTree(), opts.treeStatus ?? 200);
  const deps: SetupControllerDeps = {
    locatePipx: async (): Promise<PipxLocateResult> => ({
      ok: false,
      reason: 'pipx-missing',
      detail: 'not used here',
    }),
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
    // The REAL checker over a canned tree — end-to-end refusal-order proof.
    verifyHfDigest: (gguf) => {
      calls.push('verifyHfDigest');
      return verifyHfDigest(fetchImpl, gguf);
    },
    ingestGguf: async (spec, endpoint, onProgress): Promise<void> => {
      calls.push('ingestGguf');
      ingestArgs.push({ spec, endpoint });
      emitIngestProgress.fn = onProgress;
      if (ingestBehavior.reject) throw ingestBehavior.reject;
    },
    // T7 (beta.6): the legacy pull-gate suite never provisions by catalog id
    // — fails closed if ever reached.
    resolveLfsOid: async () => ({ ok: false, reason: 'not used here' }),
    // T6 (beta.6): the pull-gate suite never calls status() — these exist
    // only to satisfy the deps shape (and to fail loudly if ever reached).
    locateLlamaServer: () => new Promise<never>(() => {}),
    scanStorePresence: async () => new Map<string, boolean>(),
    storeDest: () => ({ ok: false, reason: 'not used here' }),
    checkedStoreDest: async () => ({ ok: false, reason: 'not used here' }),
    downloadGgufToStore: async () => {
      throw new Error('not used here');
    },
  };
  const controller = new SetupController(host, deps);
  return { host, controller, calls, ingestArgs, emitIngestProgress, ingestBehavior };
}

describe('T13 vetted-ingest branch (§4.4.3, published pin)', () => {
  it('(3b) non-loopback endpoint → §6 remote-endpoint refusal BEFORE verify/modal/ingest', async () => {
    const { controller, calls } = makeGateController();
    const result = await controller.handle('setup.pullModel', {
      model: CREATED,
      endpoint: 'http://192.168.1.5:11434',
    });
    expect(result).toEqual({ ok: false, reason: REMOTE_ENDPOINT_REFUSAL_COPY });
    expect(calls).toEqual([]); // verifyHfDigest never ran, no modal, no ingest
  });

  it('(3c) file-set mismatch (smuggled `system` file) → integrity refusal BEFORE modal/ingest', async () => {
    const tree = [...goodTree(), { type: 'file', path: 'system', oid: 'ffff' }];
    const { controller, calls } = makeGateController({ tree });
    const result = await controller.handle('setup.pullModel', { model: CREATED });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL_COPY });
    expect(calls).toEqual(['verifyHfDigest']); // verify ran; modal/ingest did NOT
  });

  it('(3c) gguf entry with git-SHA1 `oid` === pin but NO `lfs` → integrity refusal (never falls back to `oid`)', async () => {
    const tree = goodTree();
    tree[2] = { type: 'file', path: 'sweep-next-edit-v2-7B-Q4_K_M.gguf', oid: TEST_PIN };
    const { controller, calls } = makeGateController({ tree });
    const result = await controller.handle('setup.pullModel', { model: CREATED });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL_COPY });
    expect(calls).toEqual(['verifyHfDigest']);
  });

  it('(3c) tree API HTTP error → integrity refusal BEFORE modal/ingest', async () => {
    const { controller, calls } = makeGateController({ treeStatus: 503 });
    const result = await controller.handle('setup.pullModel', { model: CREATED });
    expect(result).toEqual({ ok: false, reason: INTEGRITY_REFUSAL_COPY });
    expect(calls).toEqual(['verifyHfDigest']);
  });

  it('(3d) happy path: verify → §6-verbatim modal → ingestGguf(spec, normalized endpoint); deps.pullModel NEVER called', async () => {
    const { controller, calls, ingestArgs } = makeGateController();
    const result = await controller.handle('setup.pullModel', {
      model: CREATED,
      endpoint: '  http://127.0.0.1:11434  ', // normalize(trim) applies to the endpoint too
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['verifyHfDigest', `showModal:${PULL_MODAL_COPY}`, 'ingestGguf']);
    expect(ingestArgs).toEqual([
      {
        spec: { gguf: NEXT_DEDICATED_MODEL.gguf, ollamaCreatedName: CREATED },
        endpoint: 'http://127.0.0.1:11434',
      },
    ]);
  });

  it('(3d) case-insensitive vetted match: the UPPERCASE name reaches the download modal, not the library pull modal', async () => {
    const { controller, calls } = makeGateController();
    const result = await controller.handle('setup.pullModel', { model: CREATED.toUpperCase() });
    expect(result).toEqual({ ok: true });
    expect(calls).toContain(`showModal:${PULL_MODAL_COPY}`);
    expect(calls).not.toContain('pullModel');
  });

  it('(3d) modal decline → {ok:false, reason:"declined"}, ingest never called', async () => {
    const { host, controller, calls } = makeGateController();
    host.modalResponses = [false];
    const result = await controller.handle('setup.pullModel', { model: CREATED });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(calls).toEqual(['verifyHfDigest', `showModal:${PULL_MODAL_COPY}`]);
  });

  it('ingest progress rides the existing pull progress stream (op:pull, id: ollamaCreatedName)', async () => {
    const { controller, emitIngestProgress } = makeGateController();
    const events: SetupProgress[] = [];
    controller.onProgress((e) => events.push(e));
    await controller.handle('setup.pullModel', { model: CREATED });
    emitIngestProgress.fn?.({ status: 'downloading', totalBytes: 10, completedBytes: 5 });
    expect(events).toContainEqual({
      op: 'pull',
      id: CREATED,
      phase: 'downloading',
      totalBytes: 10,
      completedBytes: 5,
    });
  });

  it('an AbortError out of ingestGguf reports "cancelled"', async () => {
    const { controller, ingestBehavior } = makeGateController();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    ingestBehavior.reject = abortErr;
    const result = await controller.handle('setup.pullModel', { model: CREATED });
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('single-flight: a second vetted pull is refused while the first modal is still pending', async () => {
    const { host, controller } = makeGateController();
    let release: () => void = () => {};
    host.modalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.handle('setup.pullModel', { model: CREATED });
    await vi.waitFor(() => {
      expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(true);
    });
    const second = await controller.handle('setup.pullModel', { model: CREATED });
    expect(second).toEqual({ ok: false, reason: 'pull already running' });
    release();
    await expect(first).resolves.toEqual({ ok: true });
  });
});

describe('T13 presence wire with a published pin (§4.2 downloadReady truth table, R-3 other row)', () => {
  it('downloadReady=true (sha256 alone drives it); modelDefaults.ollama = ollamaCreatedName; guided.llamacpp present with the pin', async () => {
    const { controller } = makeGateController();
    const data = await controller.status();
    expect(data.nextEdit.dedicated).toEqual({
      displayName: 'Sweep Next-Edit v2 (7B)',
      modelDefaults: { ollama: CREATED, openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
      downloadReady: true,
      downloadApproxBytes: 4_680_000_000,
      warning:
        'Needs ~15 GB of GPU memory at full precision, or ~5 GB for the 4-bit build. On a CPU-only machine a 7B model produces a few tokens per second — dedicated next-edit will feel slow; the Generic mode reuses your smaller FIM model instead.',
      guided: {
        vllm: 'Run: vllm serve sweepai/sweep-next-edit-v2-7B\n(official Sweep release, ~15 GB download)',
        llamacpp: `Run: llama-server -hf SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M --port 8012\nVerify the download: sha256sum should print ${TEST_PIN}`,
      },
    });
  });
});
