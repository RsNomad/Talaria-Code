/*
 * Pure-logic tests for the Setup / Talaria Config panel's card-state
 * derivation helpers (`setupCards.ts`) — no React, no DOM (this repo's
 * `webview-pure` vitest project runs `*.test.ts` under `environment: 'node'`;
 * see `vitest.config.ts`). Rendered wiring (does the derived state actually
 * reach the screen, does a click actually dispatch) lives in the sibling
 * `SetupPanel.dom.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import type { AgentSetupPhase, SetupBackendOption, SetupData, SetupProgress } from '../protocol';
import { NEXT_DEDICATED_MODEL } from '../../../src/host/setup/registry';
import {
  agentDoneLine,
  agentPhaseLabel,
  agentPrimaryAction,
  buildCopyLogText,
  clampLogTail,
  dedicatedFieldDefaults,
  fimDoneLine,
  fimHasLocalInstall,
  fimInstallTestEndpoint,
  foldSetupProgress,
  formatBytes,
  initDedicatedFormFieldState,
  isComingSoon,
  mutationDisabledReason,
  NEXT_DOWNLOAD_BUTTON_LABEL,
  NEXT_DOWNLOAD_UNAVAILABLE_TEXT,
  NEXT_POST_DOWNLOAD_NUDGE,
  nextDoneLine,
  nextDownloadButtonVisible,
  nextEditButtonLabel,
  nextModelLine,
  nextPresence,
  nextPresenceText,
  PIPX_INSTALL_DOCS_URL,
  progressKey,
  providerDoneLine,
  PYTHON_VERSION_HELP_URL,
  pullPercent,
  PROGRESS_LOG_TAIL_MAX,
  ragDoneLine,
  reconcileDedicatedFormFields,
  splitGuidedLine,
  TRUST_DISABLED_REASON,
  type SetupProgressMap,
} from './setupCards';

const ALL_PHASES: AgentSetupPhase[] = [
  'unknown',
  'pipx-missing',
  'python-unsuitable',
  'missing',
  'installing',
  'installed-inactive',
  'awaiting-reload',
  'ready',
  'error',
];

describe('agentPhaseLabel', () => {
  it('gives every AgentSetupPhase a non-empty, distinct human label', () => {
    const labels = ALL_PHASES.map(agentPhaseLabel);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // T11 (§3, critic C-8): a recheck-time probe-timeout maps to the 'error'
  // phase too, but it is NOT an install failure — the old "Install failed"
  // label overclaimed; the detail line (not this label) carries specifics.
  it("'error' phase label is honestly generic: 'Failed', not 'Install failed'", () => {
    expect(agentPhaseLabel('error')).toBe('Failed');
  });
});

describe('agentPrimaryAction', () => {
  it('missing -> install', () => {
    expect(agentPrimaryAction('missing')).toEqual({ kind: 'install', label: 'Install Hermes' });
  });
  it('installed-inactive -> activate', () => {
    expect(agentPrimaryAction('installed-inactive').kind).toBe('activate');
  });
  it('awaiting-reload -> reload (persistent, no dead-end)', () => {
    expect(agentPrimaryAction('awaiting-reload').kind).toBe('reload');
  });
  it('ready -> recheck', () => {
    expect(agentPrimaryAction('ready').kind).toBe('recheck');
  });
  it('error -> retry', () => {
    expect(agentPrimaryAction('error').kind).toBe('retry');
  });
  it('installing -> installing (no primary action while in flight)', () => {
    expect(agentPrimaryAction('installing').kind).toBe('installing');
  });
  it('python-unsuitable -> none (honest text + docs link only, per §6)', () => {
    expect(agentPrimaryAction('python-unsuitable').kind).toBe('none');
  });
  it('pipx-missing -> none (T11: bespoke bootstrap-terminal + Re-check buttons render instead of the generic single action)', () => {
    expect(agentPrimaryAction('pipx-missing').kind).toBe('none');
  });
  it('every phase maps to SOME action descriptor (exhaustive, no throw)', () => {
    for (const phase of ALL_PHASES) {
      expect(() => agentPrimaryAction(phase)).not.toThrow();
    }
  });
});

describe('PYTHON_VERSION_HELP_URL — python-unsuitable docs-link fallback (T11 §6-parity minor)', () => {
  it('is a real absolute URL', () => {
    expect(PYTHON_VERSION_HELP_URL).toMatch(/^https:\/\//);
  });
});

describe('buildCopyLogText — the error state\'s [Copy log] payload (T11 §6-parity minor)', () => {
  it('joins detail + log tail lines with newlines', () => {
    expect(buildCopyLogText('pipx-install failed: network unreachable', ['line 1', 'line 2'])).toBe(
      'pipx-install failed: network unreachable\nline 1\nline 2',
    );
  });
  it('omits an absent detail (no leading blank line)', () => {
    expect(buildCopyLogText(undefined, ['line 1'])).toBe('line 1');
  });
  it('omits an empty log tail (no trailing blank lines)', () => {
    expect(buildCopyLogText('boom', [])).toBe('boom');
  });
  it('is empty when both are absent (never throws)', () => {
    expect(buildCopyLogText(undefined, [])).toBe('');
  });
});

function fimOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return {
    id: 'ollama',
    kind: 'fim',
    status: 'available',
    displayName: 'Ollama',
    description: 'Local FIM via Ollama.',
    ...overrides,
  };
}

describe('fimHasLocalInstall — drives the two-mode question (§6 card 3)', () => {
  it('true for ollama/llamacpp/vllm-shaped entries (localInstall present)', () => {
    const withLocal = fimOption({ localInstall: { flavor: 'guided-terminal', effort: 'one-script' } });
    expect(fimHasLocalInstall(withLocal)).toBe(true);
  });
  it('false for codestral/openai-compat-shaped entries (remote-only, no localInstall)', () => {
    const remoteOnly = fimOption({ id: 'codestral', localInstall: undefined });
    expect(fimHasLocalInstall(remoteOnly)).toBe(false);
  });
});

describe('isComingSoon', () => {
  it('true for a coming-soon backend option', () => {
    expect(isComingSoon(fimOption({ status: 'coming-soon' }))).toBe(true);
  });
  it('false for an available backend option', () => {
    expect(isComingSoon(fimOption({ status: 'available' }))).toBe(false);
  });
});

describe('nextEditButtonLabel', () => {
  it('"Set up dedicated NEXT" when not yet configured', () => {
    expect(nextEditButtonLabel(false)).toBe('Set up dedicated NEXT');
  });
  it('"Edit dedicated NEXT" once endpoint+model are both set', () => {
    expect(nextEditButtonLabel(true)).toBe('Edit dedicated NEXT');
  });
});

describe('formatBytes', () => {
  it('renders bytes under 1024 verbatim', () => {
    expect(formatBytes(512)).toBe('512 B');
  });
  it('renders megabytes (no decimal once the value is >= 10, for legibility)', () => {
    expect(formatBytes(986_000_000)).toBe('940 MB');
  });
  it('renders a sub-10 unit value with one decimal (precision matters at small sizes)', () => {
    expect(formatBytes(9_500_000)).toBe('9.1 MB');
  });
  it('renders undefined as empty (no byte total known yet)', () => {
    expect(formatBytes(undefined)).toBe('');
  });
});

describe('pullPercent', () => {
  it('computes a rounded 0-100 percent from completed/total bytes', () => {
    expect(pullPercent(1000, 250)).toBe(25);
  });
  it('is undefined while total is unknown (never fabricates a bar)', () => {
    expect(pullPercent(undefined, 250)).toBeUndefined();
  });
  it('clamps to 100 even if completed briefly overshoots total', () => {
    expect(pullPercent(1000, 1050)).toBe(100);
  });
});

describe('clampLogTail', () => {
  it('keeps the array under the max unchanged', () => {
    expect(clampLogTail(['a', 'b'], 5)).toEqual(['a', 'b']);
  });
  it('keeps only the LAST `max` lines once the tail overflows', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const clamped = clampLogTail(lines, PROGRESS_LOG_TAIL_MAX);
    expect(clamped.length).toBe(PROGRESS_LOG_TAIL_MAX);
    expect(clamped[0]).toBe('line 50'); // 250 - 200 = the first 50 dropped
    expect(clamped[clamped.length - 1]).toBe('line 249');
  });
  it('the default cap is 200 lines, per the task brief ("log tail last 200 lines")', () => {
    expect(PROGRESS_LOG_TAIL_MAX).toBe(200);
  });
});

describe('foldSetupProgress — the client-side accumulation of `setup.progress` pushes', () => {
  it('starts a fresh entry for a new (op, id) pair', () => {
    const msg: SetupProgress = { op: 'install', id: 'hermes', phase: 'pipx-install', line: 'Installing…' };
    const next = foldSetupProgress({}, msg);
    const entry = next[progressKey('install', 'hermes')];
    expect(entry?.phase).toBe('pipx-install');
    expect(entry?.logTail).toEqual(['Installing…']);
  });

  it('appends log lines across successive pushes for the same id, capped at 200', () => {
    let map: SetupProgressMap = {};
    for (let i = 0; i < 205; i++) {
      map = foldSetupProgress(map, { op: 'pull', id: 'qwen2.5-coder:1.5b-base', line: `line ${i}` });
    }
    const entry = map[progressKey('pull', 'qwen2.5-coder:1.5b-base')];
    expect(entry?.logTail.length).toBe(200);
    expect(entry?.logTail[0]).toBe('line 5');
    expect(entry?.logTail[199]).toBe('line 204');
  });

  it('carries byte totals forward across pushes that omit them (throttled partial updates)', () => {
    let map = foldSetupProgress({}, { op: 'pull', id: 'm', totalBytes: 1000, completedBytes: 100 });
    map = foldSetupProgress(map, { op: 'pull', id: 'm', completedBytes: 500 });
    const entry = map[progressKey('pull', 'm')];
    expect(entry?.totalBytes).toBe(1000);
    expect(entry?.completedBytes).toBe(500);
  });

  it('keeps install and pull entries for the same id fully separate', () => {
    let map = foldSetupProgress({}, { op: 'install', id: 'hermes', line: 'installing' });
    map = foldSetupProgress(map, { op: 'pull', id: 'hermes', line: 'pulling' });
    expect(map[progressKey('install', 'hermes')]?.logTail).toEqual(['installing']);
    expect(map[progressKey('pull', 'hermes')]?.logTail).toEqual(['pulling']);
  });

  it('a phase-only push (no line) does not clear the accumulated log tail', () => {
    let map = foldSetupProgress({}, { op: 'install', id: 'hermes', line: 'first' });
    map = foldSetupProgress(map, { op: 'install', id: 'hermes', phase: 'verify' });
    const entry = map[progressKey('install', 'hermes')];
    expect(entry?.logTail).toEqual(['first']);
    expect(entry?.phase).toBe('verify');
  });
});

describe('mutationDisabledReason — the !trusted gate (§6, D9 FM-14)', () => {
  it('is undefined (nothing disabled) when the workspace is trusted', () => {
    expect(mutationDisabledReason(true)).toBeUndefined();
  });
  it('names WHY, never color-only, when untrusted', () => {
    const reason = mutationDisabledReason(false);
    expect(reason).toBe(TRUST_DISABLED_REASON);
    expect(reason).toMatch(/not trusted/i);
  });
});

/*
 * T10 (§2.5 B5 — "done / what next" affordances): five pure per-card helpers,
 * each returning the exact §6-verbatim copy once its card is genuinely
 * "done", and '' otherwise (never fabricated, never color-only — the DOM
 * side pairs this string with a `pass-filled` icon, `SetupPanel.dom.test.tsx`).
 */
describe('agentDoneLine — B5 done line (§6)', () => {
  it('is the exact §6 copy once the agent is ready', () => {
    expect(agentDoneLine('ready')).toBe('✓ Hermes is ready. Next: configure a chat provider below.');
  });
  it('is empty for every other phase', () => {
    for (const phase of ALL_PHASES) {
      if (phase === 'ready') continue;
      expect(agentDoneLine(phase)).toBe('');
    }
  });
});

describe('providerDoneLine — B5 done line (§6)', () => {
  it('is the exact §6 copy once configured', () => {
    expect(providerDoneLine('configured')).toBe('✓ Provider connected — chat is ready to use.');
  });
  it('is empty for waiting-agent/unconfigured/unknown', () => {
    for (const phase of ['waiting-agent', 'unconfigured', 'unknown'] as const) {
      expect(providerDoneLine(phase)).toBe('');
    }
  });
});

function fimData(overrides: Partial<SetupData['fim']> = {}): SetupData['fim'] {
  return {
    options: [fimOption({ id: 'ollama', status: 'available' })],
    selectedId: 'ollama',
    enabled: true,
    model: 'qwen2.5-coder:1.5b-base',
    endpointValue: 'http://127.0.0.1:11434',
    tuning: {
      debounceMs: 250,
      maxPromptTokens: 2048,
      temperature: 0.2,
      crossFileEnabled: true,
      prefixInjection: true,
      prefixInjectionRemote: false,
      warmUp: true,
    },
    ...overrides,
  };
}

describe("fimDoneLine — B5 done line (§6), mirrors SetupController's own fimGreen", () => {
  it('is the exact §6 copy when the selected backend is available + enabled + auth satisfied (no remote entry at all)', () => {
    expect(fimDoneLine(fimData())).toBe('✓ Autocomplete is active — open a file and start typing.');
  });
  it('is empty when the FIM toggle is off', () => {
    expect(fimDoneLine(fimData({ enabled: false }))).toBe('');
  });
  it('is empty when the selected option is coming-soon', () => {
    const data = fimData({ options: [fimOption({ id: 'ollama', status: 'coming-soon' })] });
    expect(fimDoneLine(data)).toBe('');
  });
  it('is empty when apiKey-required and no key is set', () => {
    const data = fimData({
      options: [
        fimOption({
          id: 'codestral',
          remote: {
            endpointDefault: 'https://codestral.mistral.ai',
            endpointValue: '',
            endpointPlaceholder: '',
            auth: 'apiKey-required',
            apiKeySet: false,
            probe: 'none',
          },
        }),
      ],
      selectedId: 'codestral',
    });
    expect(fimDoneLine(data)).toBe('');
  });
  it('is green once apiKey-required AND a key IS set', () => {
    const data = fimData({
      options: [
        fimOption({
          id: 'codestral',
          remote: {
            endpointDefault: 'https://codestral.mistral.ai',
            endpointValue: '',
            endpointPlaceholder: '',
            auth: 'apiKey-required',
            apiKeySet: true,
            probe: 'none',
          },
        }),
      ],
      selectedId: 'codestral',
    });
    expect(fimDoneLine(data)).toBe('✓ Autocomplete is active — open a file and start typing.');
  });
  it('is empty when the selected id matches no option (defensive, never throws)', () => {
    expect(fimDoneLine(fimData({ selectedId: 'missing' }))).toBe('');
  });
});

describe('nextDoneLine — B5 done line (§6)', () => {
  it('dedicated source -> the dedicated-model copy', () => {
    expect(nextDoneLine('dedicated')).toBe('✓ Next-edit suggestions are on (dedicated Sweep model).');
  });
  it('generic source -> the reusing-FIM-model copy', () => {
    expect(nextDoneLine('generic')).toBe('✓ Next-edit suggestions are on (reusing your FIM model).');
  });
  it('off -> empty', () => {
    expect(nextDoneLine('off')).toBe('');
  });
});

function ragData(overrides: Partial<SetupData['rag']> = {}): SetupData['rag'] {
  return {
    enabled: true,
    embedEndpoint: 'http://127.0.0.1:11434',
    embedModel: 'nomic-embed-text',
    embedModelPresent: true,
    tuning: { dims: 768, maxChunkTokens: 512, debounceMs: 500, excludeGlobs: [] },
    indexDir: '.talaria/index',
    ...overrides,
  };
}

describe('ragDoneLine — B5 done line (§6)', () => {
  it('is the exact §6 copy when enabled + the embed model is present + unblocked', () => {
    expect(ragDoneLine(ragData())).toBe('✓ Codebase index is ready — the agent can search your project.');
  });
  it('is empty when disabled', () => {
    expect(ragDoneLine(ragData({ enabled: false }))).toBe('');
  });
  it('is empty when the embed model is not present yet', () => {
    expect(ragDoneLine(ragData({ embedModelPresent: false }))).toBe('');
  });
  it('is empty when blocked by a precondition (never overclaims readiness)', () => {
    expect(
      ragDoneLine(ragData({ preconditionDetail: 'The codebase index needs a trusted, open workspace.' })),
    ).toBe('');
  });
});

describe('PIPX_INSTALL_DOCS_URL — the unknown-distro pipx-missing fallback link (§6)', () => {
  it('is the exact pipx install docs URL', () => {
    expect(PIPX_INSTALL_DOCS_URL).toBe('https://pipx.pypa.io/stable/installation/');
  });
});

/*
 * T10 (§2.6 ⑨⑩, R-2): `talaria.autocomplete.endpoint` is ONE setting shared
 * by every FIM backend — `remote.endpointValue` on the wire is the SAME
 * saved string for every option regardless of which backend it belongs to.
 * It is only trustworthy for the backend it was saved FOR: the one actually
 * `selectedId`'d on the wire. Browsing a DIFFERENT backend's Install tab
 * must fall back to THAT option's own default, never test the foreign value
 * under this backend's label.
 */
function vllmLikeOption(endpointValue: string): SetupBackendOption {
  return fimOption({
    id: 'vllm',
    displayName: 'vLLM',
    remote: {
      endpointDefault: 'http://127.0.0.1:8000',
      endpointValue,
      endpointPlaceholder: 'http://host:port',
      auth: 'none',
      apiKeySet: false,
      probe: 'openai-models',
    },
    localInstall: { flavor: 'docs-only', effort: 'manual-guided' },
  });
}

describe('fimInstallTestEndpoint — ⑨⑩ R-2 honest endpoint resolution', () => {
  it('uses the saved endpointValue when THIS option is the currently selected/configured backend', () => {
    const option = vllmLikeOption('http://127.0.0.1:8012');
    expect(fimInstallTestEndpoint('vllm', option)).toBe('http://127.0.0.1:8012');
  });

  it("R-2: a saved endpointValue belonging to a DIFFERENT selected backend never leaks — falls back to this option's own default", () => {
    // Saved FOR ollama (the currently selected backend); we are merely
    // BROWSING vLLM's card.
    const option = vllmLikeOption('http://127.0.0.1:11434');
    expect(fimInstallTestEndpoint('ollama', option)).toBe('http://127.0.0.1:8000');
  });

  it("falls back to the option's own default when it IS selected but has no saved value yet", () => {
    const option = vllmLikeOption('');
    expect(fimInstallTestEndpoint('vllm', option)).toBe('http://127.0.0.1:8000');
  });

  it('falls back to empty when the option carries no remote entry at all (defensive)', () => {
    const option = fimOption({ id: 'vllm', remote: undefined });
    expect(fimInstallTestEndpoint('vllm', option)).toBe('');
  });
});

/*
 * T15 (beta.5 §4.2/§4.3/§6) — DedicatedNextForm's pure derivation helpers:
 * presence, download-button gating, the guided-line wire split, the
 * per-backend field prefill + its reconcile-on-switch, and the frozen §6
 * copy those helpers surface. `SetupPanel.dom.test.tsx` proves these reach
 * the screen; this file proves the logic itself, headlessly.
 */

function ollamaStatus(overrides: Partial<SetupData['ollama']> = {}): SetupData['ollama'] {
  return { running: true, endpoint: 'http://127.0.0.1:11434', models: [], ...overrides };
}

describe('nextPresence — client-side derivation against live form state (§4.2, critics C-6/S-F11)', () => {
  const endpoint = 'http://127.0.0.1:11434';
  const createdName = NEXT_DEDICATED_MODEL.ollamaCreatedName;
  const pullAlias = NEXT_DEDICATED_MODEL.ollamaPullAlias;

  it('unknown when the daemon is not running, even if endpoint + model would otherwise match', () => {
    const setup = { ollama: ollamaStatus({ running: false, models: [{ name: createdName, sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, createdName)).toBe('unknown');
  });

  it('unknown when formEndpoint does not match the endpoint status() actually probed', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: createdName, sizeBytes: 1 }] }) };
    expect(nextPresence(setup, 'http://127.0.0.1:9999', createdName)).toBe('unknown');
  });

  it('unknown when ollama.endpoint was never probed (undefined) — a string can never equal undefined', () => {
    const setup = { ollama: ollamaStatus({ endpoint: undefined, models: [{ name: createdName, sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, createdName)).toBe('unknown');
  });

  it('present when the vetted model is on the daemon under the exact created name', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: createdName, sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, createdName)).toBe('present');
  });

  it('case-insensitive match (critic C-13)', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: createdName.toUpperCase(), sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, createdName)).toBe('present');
  });

  it(':latest-tolerant match for a general (non-vetted) model name (critic C-13)', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: 'llama3:latest', sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, 'llama3')).toBe('present');
  });

  it(':latest-tolerant the other direction (form carries the explicit tag)', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: 'llama3', sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, 'llama3:latest')).toBe('present');
  });

  it('recognizes the manual-pull ollamaPullAlias as present when the form still shows the standard prefill (rev 5)', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: pullAlias, sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, createdName)).toBe('present');
  });

  it('the symmetric direction: form carries the pull alias, daemon carries the created name', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: createdName, sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, pullAlias)).toBe('present');
  });

  it('absent when the daemon has no matching model at all', () => {
    const setup = { ollama: ollamaStatus({ models: [{ name: 'qwen2.5-coder:1.5b-base', sizeBytes: 1 }] }) };
    expect(nextPresence(setup, endpoint, createdName)).toBe('absent');
  });

  it('absent (not unknown) for an empty form model — the R-3 no-prefill state', () => {
    const setup = { ollama: ollamaStatus({ models: [] }) };
    expect(nextPresence(setup, endpoint, '')).toBe('absent');
  });
});

describe('nextPresenceText — §6 presence copy (D2), verbatim', () => {
  it('present', () => {
    expect(nextPresenceText('present')).toBe('✓ Model present on this Ollama');
  });
  it('absent', () => {
    expect(nextPresenceText('absent')).toBe('not present');
  });
  it('unknown', () => {
    expect(nextPresenceText('unknown')).toBe('not verified here — Test the endpoint first.');
  });
});

function dedicatedBlock(
  overrides: Partial<NonNullable<SetupData['nextEdit']['dedicated']>> = {},
): NonNullable<SetupData['nextEdit']['dedicated']> {
  return {
    displayName: NEXT_DEDICATED_MODEL.displayName,
    modelDefaults: { ollama: NEXT_DEDICATED_MODEL.ollamaCreatedName, openaiCompat: NEXT_DEDICATED_MODEL.upstream.hfRepo },
    downloadReady: true,
    downloadApproxBytes: NEXT_DEDICATED_MODEL.gguf.approxBytes,
    warning: 'Needs ~15 GB of GPU memory at full precision, or ~5 GB for the 4-bit build.',
    guided: {
      vllm: `Run: vllm serve ${NEXT_DEDICATED_MODEL.upstream.hfRepo}\n(official Sweep release, ~15 GB download)`,
      llamacpp: `Run: llama-server -hf ${NEXT_DEDICATED_MODEL.gguf.hfRepo}:${NEXT_DEDICATED_MODEL.gguf.quant} --port 8012\nVerify the download: sha256sum should print abc123`,
    },
    ...overrides,
  };
}

describe('nextDownloadButtonVisible — Download button gating matrix (§4.3 D2)', () => {
  it('visible: downloadReady + ollama-picked + presence absent', () => {
    expect(nextDownloadButtonVisible(dedicatedBlock(), true, 'absent')).toBe(true);
  });
  it('visible: presence unknown (untested endpoint) still offers the download', () => {
    expect(nextDownloadButtonVisible(dedicatedBlock(), true, 'unknown')).toBe(true);
  });
  it('hidden: !downloadReady', () => {
    expect(nextDownloadButtonVisible(dedicatedBlock({ downloadReady: false }), true, 'absent')).toBe(false);
  });
  it('hidden: not the ollama backend', () => {
    expect(nextDownloadButtonVisible(dedicatedBlock(), false, 'absent')).toBe(false);
  });
  it('hidden: presence already present', () => {
    expect(nextDownloadButtonVisible(dedicatedBlock(), true, 'present')).toBe(false);
  });
  it('hidden when the dedicated block itself is absent (defensive)', () => {
    expect(nextDownloadButtonVisible(undefined, true, 'absent')).toBe(false);
  });
});

describe('splitGuidedLine — the wire guided.* two-fragment split (T13 implementer note)', () => {
  it('splits the vLLM line into the command and the release-size caption', () => {
    expect(splitGuidedLine('Run: vllm serve sweepai/sweep-next-edit-v2-7B\n(official Sweep release, ~15 GB download)')).toEqual({
      command: 'Run: vllm serve sweepai/sweep-next-edit-v2-7B',
      caption: '(official Sweep release, ~15 GB download)',
    });
  });

  it('splits the llama.cpp line into the command and the digest-verify hint (S-F5)', () => {
    const text =
      'Run: llama-server -hf SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M --port 8012\n' +
      'Verify the download: sha256sum should print abc123';
    expect(splitGuidedLine(text)).toEqual({
      command: 'Run: llama-server -hf SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M --port 8012',
      caption: 'Verify the download: sha256sum should print abc123',
    });
  });

  it('a line with no newline is all command, empty caption (defensive)', () => {
    expect(splitGuidedLine('Run: something')).toEqual({ command: 'Run: something', caption: '' });
  });
});

describe('nextModelLine — §6 D1 copy, composed from the wire displayName', () => {
  it('matches the verbatim §6 line for the pinned displayName', () => {
    expect(nextModelLine('Sweep Next-Edit v2 (7B)')).toBe('Sweep Next-Edit v2 (7B) — the one supported dedicated model.');
  });
});

describe('§6 dedicated-NEXT copy constants — verbatim locks', () => {
  it('NEXT_DOWNLOAD_BUTTON_LABEL', () => {
    expect(NEXT_DOWNLOAD_BUTTON_LABEL).toBe('Download model (~4.7 GB)');
  });
  it('NEXT_POST_DOWNLOAD_NUDGE', () => {
    expect(NEXT_POST_DOWNLOAD_NUDGE).toBe('✓ Downloaded — press Apply to start using it.');
  });
  it('NEXT_DOWNLOAD_UNAVAILABLE_TEXT', () => {
    expect(NEXT_DOWNLOAD_UNAVAILABLE_TEXT).toBe(
      "No vetted build of this model is published yet — it can't be downloaded automatically. Use the guided instructions below, or the vLLM path (official release).",
    );
  });
});

function nextEditState(overrides: Partial<SetupData['nextEdit']> = {}): SetupData['nextEdit'] {
  return {
    source: 'off',
    backend: 'ollama',
    endpoint: '',
    model: '',
    dedicatedConfigured: false,
    genericSupported: true,
    dedicated: dedicatedBlock(),
    ...overrides,
  };
}

function ollamaBackendOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return fimOption({
    id: 'ollama',
    remote: {
      endpointDefault: 'http://127.0.0.1:11434',
      endpointValue: 'http://127.0.0.1:11434',
      endpointPlaceholder: 'http://host:port',
      auth: 'none',
      apiKeySet: false,
      probe: 'ollama-tags',
    },
    nextEditTransport: 'ollama',
    ...overrides,
  });
}

function llamacppBackendOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return fimOption({
    id: 'llamacpp',
    displayName: 'llama.cpp',
    remote: {
      endpointDefault: 'http://127.0.0.1:8012',
      endpointValue: '',
      endpointPlaceholder: 'http://host:port',
      auth: 'none',
      apiKeySet: false,
      probe: 'llamacpp-health',
    },
    nextEditTransport: 'openai-compat',
    ...overrides,
  });
}

describe('dedicatedFieldDefaults — Endpoint/Model prefill per picked backend (§4.3 D1)', () => {
  it("R-3: ollama picked, unconfigured, modelDefaults.ollama empty (!downloadReady) ⇒ model starts EMPTY", () => {
    const setup = {
      nextEdit: nextEditState({
        backend: 'ollama',
        dedicated: dedicatedBlock({ downloadReady: false, modelDefaults: { ollama: '', openaiCompat: NEXT_DEDICATED_MODEL.upstream.hfRepo } }),
      }),
    };
    expect(dedicatedFieldDefaults(setup, ollamaBackendOption()).model).toBe('');
  });

  it('ollama picked + downloadReady ⇒ model prefills to the ingest-created name', () => {
    const setup = { nextEdit: nextEditState({ backend: 'ollama' }) };
    expect(dedicatedFieldDefaults(setup, ollamaBackendOption()).model).toBe(NEXT_DEDICATED_MODEL.ollamaCreatedName);
  });

  it('the openai-compat prefill is unaffected by ollama\'s !downloadReady carve-out (R-3 scope)', () => {
    const setup = {
      nextEdit: nextEditState({
        backend: 'ollama',
        dedicated: dedicatedBlock({ downloadReady: false, modelDefaults: { ollama: '', openaiCompat: NEXT_DEDICATED_MODEL.upstream.hfRepo } }),
      }),
    };
    expect(dedicatedFieldDefaults(setup, llamacppBackendOption()).model).toBe(NEXT_DEDICATED_MODEL.upstream.hfRepo);
  });

  it('editing an already-configured backend keeps the SAVED model + endpoint, not the registry default', () => {
    const setup = {
      nextEdit: nextEditState({
        backend: 'ollama',
        endpoint: 'http://10.0.0.5:11434',
        model: 'custom-model:latest',
        dedicatedConfigured: true,
      }),
    };
    const result = dedicatedFieldDefaults(setup, ollamaBackendOption());
    expect(result.model).toBe('custom-model:latest');
    expect(result.endpoint).toBe('http://10.0.0.5:11434');
  });

  it("switching to a DIFFERENT backend than the one currently configured falls back to that backend's own default endpoint", () => {
    const setup = {
      nextEdit: nextEditState({ backend: 'ollama', endpoint: 'http://10.0.0.5:11434', model: 'qwen', dedicatedConfigured: true }),
    };
    expect(dedicatedFieldDefaults(setup, llamacppBackendOption()).endpoint).toBe('http://127.0.0.1:8012');
  });
});

describe("reconcileDedicatedFormFields — field-reconcile on backend switch (settingsField.ts's own pattern)", () => {
  it('is a no-op while selectedId has not moved (an in-flight local edit survives an unrelated re-render)', () => {
    const state = initDedicatedFormFieldState('ollama', { endpoint: 'edited-by-hand', model: 'edited-model' });
    const result = reconcileDedicatedFormFields(state, 'ollama', { endpoint: 'default-endpoint', model: 'default-model' });
    expect(result).toBe(state);
    expect(result.endpoint).toBe('edited-by-hand');
  });

  it("resets to the new backend's defaults the moment selectedId changes", () => {
    const state = initDedicatedFormFieldState('ollama', { endpoint: 'ollama-endpoint', model: 'ollama-model' });
    const result = reconcileDedicatedFormFields(state, 'llamacpp', { endpoint: 'llamacpp-endpoint', model: 'llamacpp-model' });
    expect(result).toEqual({ lastSelectedId: 'llamacpp', endpoint: 'llamacpp-endpoint', model: 'llamacpp-model' });
  });
});
