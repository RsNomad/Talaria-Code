/*
 * Pure-logic tests for the Setup / Talaria Config panel's card-state
 * derivation helpers (`setupCards.ts`) — no React, no DOM (this repo's
 * `webview-pure` vitest project runs `*.test.ts` under `environment: 'node'`;
 * see `vitest.config.ts`). Rendered wiring (does the derived state actually
 * reach the screen, does a click actually dispatch) lives in the sibling
 * `SetupPanel.dom.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSetupPhase, SetupBackendOption, SetupCatalogModel, SetupData, SetupProgress } from '../protocol';
import { NEXT_DEDICATED_MODEL } from '../../../src/host/setup/registry';
import { MODEL_CATALOG } from '../../../src/host/setup/modelCatalog';
import {
  AGENT_BLOCK_HEADING,
  AGENT_DEFAULT_MODEL_CAPTION,
  AGENT_PRE_READY_NOTE,
  AGENT_PRESAVE_RUN_COMMAND_CAPTION,
  agentDoneLine,
  agentEndpointInit,
  agentInitialBackend,
  agentPhaseLabel,
  agentPrimaryAction,
  agentRowCaption,
  agentSavedSummaryLine,
  ggufPublisherCaption,
  backendReadyText,
  buildCopyLogText,
  cancelPullParams,
  CANCEL_LABEL,
  CATALOG_DEFAULT_CHIP_LABEL,
  catalogPresence,
  catalogPresenceText,
  catalogPreselectId,
  clampLogTail,
  configuredModelOutsideCatalog,
  dedicatedFieldDefaults,
  dedicatedInitialCandidateId,
  fimDoneLine,
  fimHasLocalInstall,
  fimInstallTestEndpoint,
  FIM_LLAMACPP_NUDGE,
  FIM_OLLAMA_PULL_NUDGE,
  foldSetupProgress,
  formatBytes,
  initDedicatedFormFieldState,
  isComingSoon,
  llamacppDownloadButtonLabel,
  LLAMACPP_CHECKING_TEXT,
  LLAMACPP_HONEST_ABSENCE_TEXT,
  LLAMACPP_MISSING_TEXT,
  LLAMACPP_UNKNOWN_TEXT,
  llamacppPresenceText,
  mutationDisabledReason,
  NEXT_DOWNLOAD_BUTTON_LABEL,
  NEXT_DOWNLOAD_UNAVAILABLE_TEXT,
  NEXT_POST_DOWNLOAD_NUDGE,
  nextDoneLine,
  nextDownloadButtonVisible,
  nextEditButtonLabel,
  nextLlamacppDigestHint,
  nextModelLine,
  nextPresence,
  nextPresenceText,
  OLLAMA_DAEMON_DOWN_PULL_REASON,
  OLLAMA_MISSING_TEXT,
  ollamaPullButtonLabel,
  PIPX_INSTALL_DOCS_URL,
  progressKey,
  provisionModalCopyLiveOid,
  provisionModalCopyPinned,
  providerDoneLine,
  PYTHON_VERSION_HELP_URL,
  pullPercent,
  PROGRESS_LOG_TAIL_MAX,
  RAG_APPLY_NUDGE,
  ragBlockBackend,
  ragDoneLine,
  ragEmbedPresence,
  ragInitialBackend,
  recheckScopeParams,
  reconcileDedicatedFormFields,
  servingLine,
  splitGuidedLine,
  testConnectionLabel,
  TRUST_DISABLED_REASON,
  type SetupProgressMap,
  // beta.6 T18 (§3.5) — start-screen model recommendations
  deriveRecommendations,
  divergenceCaptionText,
  formatGiB,
  meterSegments,
  RECS_DISCLOSURE_SUMMARY,
  RECS_MOE_NOTE,
  RECS_STRIP_HEADING,
  RECS_STRIP_INTRO,
  roleLineText,
  roundGiB,
  stackLineText,
  USABLE_VRAM_24GB_GIB,
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

describe('ragDoneLine — B5 done line, T14 endpoint-scoped honesty (§3.4 truth table)', () => {
  // T14: the second argument is the CLIENT-derived, endpoint-scoped presence
  // of the configured embed model (`ragEmbedPresence`) — the deprecated wire
  // boolean rides along inside `rag` in every case below (`ragData()` pins it
  // TRUE) and must be IGNORED entirely.
  it("is the exact §6 copy when enabled + unblocked + genuinely 'present' at the configured endpoint", () => {
    expect(ragDoneLine(ragData(), 'present')).toBe('✓ Codebase index is ready — the agent can search your project.');
  });
  it('is empty when disabled, even with presence proven', () => {
    expect(ragDoneLine(ragData({ enabled: false }), 'present')).toBe('');
  });
  it("is empty when the embed model is provably 'absent' at the configured endpoint", () => {
    expect(ragDoneLine(ragData(), 'absent')).toBe('');
  });
  it('is empty when blocked by a precondition (never overclaims readiness)', () => {
    expect(
      ragDoneLine(ragData({ preconditionDetail: 'The codebase index needs a trusted, open workspace.' }), 'present'),
    ).toBe('');
  });
  it("presence 'unknown' (configured endpoint ≠ the probed daemon) makes NO claim — even while the deprecated wire boolean says true (the beta.5 wrong-daemon lie, pinned dead)", () => {
    expect(ragDoneLine(ragData({ embedModelPresent: true }), 'unknown')).toBe('');
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

/* ------------------------------------------------------------------ *
 * beta.6 T10 — LocalModelBlock helpers (§4.1/§6). `localModel.dom.
 * test.tsx` covers the rendered wiring; these are the pure derivations
 * every §4.1 cell's TEXT/logic reduces to, generalized from `nextPresence`
 * (above) the same way `catalogPresence` generalizes it.
 * ------------------------------------------------------------------ */

function catalogModel(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'qwen25-coder-1.5b',
    role: 'fim',
    displayName: 'Qwen2.5-Coder 1.5B (base)',
    publisher: 'Qwen',
    license: 'apache-2.0',
    vramLine: 'any modern GPU (~1–2 GB)',
    progressId: 'qwen25-coder-1.5b',
    ollamaTag: 'qwen2.5-coder:1.5b-base',
    ollamaApproxBytes: 986_000_000,
    ...overrides,
  };
}

function ollamaWire(overrides: Partial<SetupData['ollama']> = {}): SetupData['ollama'] {
  return { running: true, endpoint: 'http://127.0.0.1:11434', models: [], ...overrides };
}

describe('catalogPresence — generalizes nextPresence over ANY catalog row (library tag OR hf-ingest createdName)', () => {
  it('daemon not running -> unknown, regardless of endpoint match', () => {
    const ollama = ollamaWire({ running: false });
    expect(catalogPresence(ollama, 'http://127.0.0.1:11434', catalogModel())).toBe('unknown');
  });

  it('endpoint mismatch -> unknown (never inherits a DIFFERENT endpoint\'s presence)', () => {
    const ollama = ollamaWire({ endpoint: 'http://127.0.0.1:11434' });
    expect(catalogPresence(ollama, 'http://10.0.0.5:11434', catalogModel())).toBe('unknown');
  });

  it('library-tier row: matches on ollamaTag, :latest-tolerant', () => {
    const ollama = ollamaWire({ models: [{ name: 'qwen2.5-coder:1.5b-base:latest', sizeBytes: 1 }] });
    expect(catalogPresence(ollama, 'http://127.0.0.1:11434', catalogModel())).toBe('present');
  });

  it('library-tier row: no matching daemon model -> absent', () => {
    const ollama = ollamaWire({ models: [{ name: 'llama3:8b', sizeBytes: 1 }] });
    expect(catalogPresence(ollama, 'http://127.0.0.1:11434', catalogModel())).toBe('absent');
  });

  it('hf-ingest-tier row (Devstral/Sweep shape): matches on ollamaCreatedName, NOT ollamaTag (undefined)', () => {
    const devstral = catalogModel({
      id: 'devstral-24b',
      role: 'agent',
      ollamaTag: undefined,
      ollamaApproxBytes: 14_333_915_904,
      ollamaCreatedName: 'devstral-small-2507:24b',
    });
    const ollama = ollamaWire({ models: [{ name: 'devstral-small-2507:24b', sizeBytes: 1 }] });
    expect(catalogPresence(ollama, 'http://127.0.0.1:11434', devstral)).toBe('present');
  });

  it('row with neither ollamaTag nor ollamaCreatedName -> unknown (defensive, no ollama entry to check)', () => {
    const ollama = ollamaWire({ models: [{ name: 'anything', sizeBytes: 1 }] });
    const noOllamaEntry = catalogModel({ ollamaTag: undefined, ollamaApproxBytes: undefined });
    expect(catalogPresence(ollama, 'http://127.0.0.1:11434', noOllamaEntry)).toBe('unknown');
  });
});

describe('catalogPresenceText / llamacppPresenceText — §6 verbatim per state', () => {
  it('ollama present -> "present ✓" (distinct from the NEXT card\'s own D2 wording)', () => {
    expect(catalogPresenceText('present')).toBe('present ✓');
  });
  it('ollama absent -> "not present"', () => {
    expect(catalogPresenceText('absent')).toBe('not present');
  });
  it('ollama unknown -> "not verified here — Test the endpoint first."', () => {
    expect(catalogPresenceText('unknown')).toBe('not verified here — Test the endpoint first.');
  });
  it('llamacpp present -> "present in Talaria\'s model folder ✓" (sidecar-rule honesty, never "verified")', () => {
    expect(llamacppPresenceText(true)).toBe("present in Talaria's model folder ✓");
  });
  it('llamacpp absent -> "not downloaded"', () => {
    expect(llamacppPresenceText(false)).toBe('not downloaded');
  });
});

describe('ollamaPullButtonLabel / llamacppDownloadButtonLabel — §6 "Pull {tag} (~{size})" / "Download {name} (~{size})"', () => {
  it('library tier: uses ollamaTag', () => {
    expect(ollamaPullButtonLabel(catalogModel())).toBe('Pull qwen2.5-coder:1.5b-base (~940 MB)');
  });

  it('hf-ingest tier (no ollamaTag): falls back to ollamaCreatedName', () => {
    const devstral = catalogModel({ ollamaTag: undefined, ollamaCreatedName: 'devstral-small-2507:24b', ollamaApproxBytes: 14_333_915_904 });
    expect(ollamaPullButtonLabel(devstral)).toBe('Pull devstral-small-2507:24b (~13 GB)');
  });

  it('llamacpp: names the model\'s displayName, not the raw GGUF filename', () => {
    expect(llamacppDownloadButtonLabel(catalogModel({ displayName: 'Qwen2.5-Coder 1.5B (base)' }), 1_646_573_056)).toBe(
      'Download Qwen2.5-Coder 1.5B (base) (~1.5 GB)',
    );
  });
});

describe('catalogPreselectId — the ONE picker-preselect rule (A-F8): saved wins, else defaultForRole, else first row', () => {
  const models = [
    catalogModel({ id: 'ornith-9b', defaultForRole: undefined }),
    catalogModel({ id: 'devstral-24b', defaultForRole: true }),
    catalogModel({ id: 'ornith-35b', defaultForRole: undefined }),
  ];

  it('a saved modelId that exists in the row set wins over the default row', () => {
    expect(catalogPreselectId(models, 'ornith-35b')).toBe('ornith-35b');
  });

  it('no saved id -> falls back to the defaultForRole row', () => {
    expect(catalogPreselectId(models, undefined)).toBe('devstral-24b');
  });

  it('a saved id that no longer exists in the row set -> falls back to defaultForRole, not a dangling id', () => {
    expect(catalogPreselectId(models, 'no-such-row')).toBe('devstral-24b');
  });

  it('no saved id and no defaultForRole row -> falls back to the first row (never undefined for a non-empty set)', () => {
    const noDefaults = [catalogModel({ id: 'a' }), catalogModel({ id: 'b' })];
    expect(catalogPreselectId(noDefaults, undefined)).toBe('a');
  });

  it('empty row set -> undefined (nothing to preselect)', () => {
    expect(catalogPreselectId([], undefined)).toBeUndefined();
  });
});

describe('configuredModelOutsideCatalog — the CC-8 "configured model" row predicate (FIM/RAG free-text tier)', () => {
  const models = [catalogModel({ ollamaTag: 'qwen2.5-coder:1.5b-base' }), catalogModel({ id: 'qwen25-coder-7b', ollamaTag: 'qwen2.5-coder:7b-base' })];

  it('empty configured model -> false (nothing to show a row for)', () => {
    expect(configuredModelOutsideCatalog(models, '')).toBe(false);
  });

  it('configured model matches a catalog row (:latest-tolerant) -> false', () => {
    expect(configuredModelOutsideCatalog(models, 'qwen2.5-coder:1.5b-base:latest')).toBe(false);
  });

  it('configured model matches NO catalog row -> true (the free-text row must render)', () => {
    expect(configuredModelOutsideCatalog(models, 'nomic-embed-text')).toBe(true);
  });
});

describe('testConnectionLabel / servingLine — §6 verbatim', () => {
  it('testConnectionLabel names the endpoint', () => {
    expect(testConnectionLabel('http://127.0.0.1:8012')).toBe('Test connection (http://127.0.0.1:8012)');
  });
  it('servingLine comma-joins the served model names', () => {
    expect(servingLine(['qwen2.5-coder:1.5b-base'])).toBe('Serving: qwen2.5-coder:1.5b-base');
    expect(servingLine(['a', 'b'])).toBe('Serving: a, b');
  });
});

describe('cancelPullParams / recheckScopeParams — the exact dispatch payload shapes (CC-9 / scoped recheck)', () => {
  it('cancelPullParams keys the SAME catalogId used for progress (rule 7)', () => {
    expect(cancelPullParams('devstral-24b')).toEqual({ op: 'pull', id: 'devstral-24b' });
  });
  it('recheckScopeParams narrows to ollama or llamacpp only', () => {
    expect(recheckScopeParams('ollama')).toEqual({ scope: 'ollama' });
    expect(recheckScopeParams('llamacpp')).toEqual({ scope: 'llamacpp' });
  });
});

describe('backendReadyText — §6 "Backend ready" row, shared template', () => {
  it('ollama, no version', () => {
    expect(backendReadyText('ollama')).toBe('Ollama: Ready ✓');
  });
  it('ollama, with version appends " — {version}"', () => {
    expect(backendReadyText('ollama', '0.4.1')).toBe('Ollama: Ready ✓ — 0.4.1');
  });
  it('llamacpp, with version', () => {
    expect(backendReadyText('llamacpp', 'b4500')).toBe('llama.cpp: Ready ✓ — b4500');
  });
});

describe('§6 static copy constants — verbatim', () => {
  it('OLLAMA_MISSING_TEXT', () => expect(OLLAMA_MISSING_TEXT).toBe('Ollama daemon not detected.'));
  it('LLAMACPP_MISSING_TEXT', () =>
    expect(LLAMACPP_MISSING_TEXT).toBe('llama-server was not found on your PATH. Install llama.cpp, then re-check.'));
  it('LLAMACPP_CHECKING_TEXT', () => expect(LLAMACPP_CHECKING_TEXT).toBe('Checking for llama-server…'));
  it('LLAMACPP_UNKNOWN_TEXT', () => expect(LLAMACPP_UNKNOWN_TEXT).toBe("Couldn't check for llama-server here — press Re-check."));
  it('LLAMACPP_HONEST_ABSENCE_TEXT', () =>
    expect(LLAMACPP_HONEST_ABSENCE_TEXT).toBe(
      'No build of this model from a verified publisher exists for llama.cpp — use it via Ollama instead.',
    ));
  it('OLLAMA_DAEMON_DOWN_PULL_REASON', () => expect(OLLAMA_DAEMON_DOWN_PULL_REASON).toBe('Install Ollama first — it performs the download.'));
  it('CATALOG_DEFAULT_CHIP_LABEL', () => expect(CATALOG_DEFAULT_CHIP_LABEL).toBe('Default'));
  it('CANCEL_LABEL', () => expect(CANCEL_LABEL).toBe('Cancel'));
});

describe('provisionModalCopyPinned / provisionModalCopyLiveOid — the two verify-mode copies stay DISTINCT (§2.2.5 A-2)', () => {
  it('for the SAME displayName/bytes/hfRepo/endpoint, the two templates never collapse into the same string', () => {
    const pinned = provisionModalCopyPinned('Sweep Next-Edit v2 (7B)', 4_680_000_000, 'SyntinalCo/sweep-next-edit-v2-7B-GGUF', 'http://127.0.0.1:11434');
    const liveOid = provisionModalCopyLiveOid(
      'Sweep Next-Edit v2 (7B)',
      'Q4_K_M',
      4_680_000_000,
      'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
      'Syntinal (us)',
      'Our own publishing account; artifacts additionally self-pinned by code-committed SHA-256.',
      'http://127.0.0.1:11434',
    );
    expect(pinned).not.toBe(liveOid);
  });

  it('pinned copy makes the STRONG claim ("against its pinned value") — never the weaker manifest wording', () => {
    const pinned = provisionModalCopyPinned('X', 1_000_000_000, 'Owner/Repo', 'http://127.0.0.1:11434');
    expect(pinned).toContain("checksum against its pinned value");
    expect(pinned).not.toContain("publisher's manifest");
  });

  it("live-oid copy makes the WEAKER claim (\"against the publisher's manifest\") + names the publisher/trustBasis — never the pinned wording", () => {
    const liveOid = provisionModalCopyLiveOid('X', 'Q4_K_M', 1_000_000_000, 'Owner/Repo', 'Some Publisher', 'a trust sentence.', 'http://127.0.0.1:11434');
    expect(liveOid).toContain("checksum against the publisher's manifest");
    expect(liveOid).toContain('Publisher: Some Publisher — a trust sentence.');
    expect(liveOid).not.toContain('against its pinned value');
  });
});

describe('§6 copy — verbatim + single-sourced (SCOPED source-scan: hand-written panel sources only)', () => {
  // Scoped to the two hand-written files T10 owns — NOT a bundle-wide grep
  // (which would trip on `registry.ts`'s own `hf.co` alias string, an
  // unrelated data literal) and NOT `modelCatalog.ts`/`registry.ts`
  // themselves (pure DATA, not panel copy).
  const setupCardsSrc = readFileSync(join(__dirname, 'setupCards.ts'), 'utf-8');
  const localModelSrc = readFileSync(join(__dirname, 'localModel.tsx'), 'utf-8');

  // Every §6 string this task owns — long/distinctive enough that an
  // accidental substring match elsewhere would itself be suspicious.
  const OWNED_VERBATIM_STRINGS = [
    'Ollama daemon not detected.',
    'llama-server was not found on your PATH. Install llama.cpp, then re-check.',
    'Checking for llama-server…',
    "Couldn't check for llama-server here — press Re-check.",
    "present in Talaria's model folder ✓",
    'No build of this model from a verified publisher exists for llama.cpp — use it via Ollama instead.',
    'Install Ollama first — it performs the download.',
    'not verified here — Test the endpoint first.',
  ];

  it('every owned §6 string is defined VERBATIM in setupCards.ts (the single source of truth)', () => {
    for (const s of OWNED_VERBATIM_STRINGS) {
      expect(setupCardsSrc).toContain(s);
    }
  });

  it('localModel.tsx never RESTATES these strings inline — it only references the setupCards.ts helpers/constants', () => {
    for (const s of OWNED_VERBATIM_STRINGS) {
      expect(localModelSrc).not.toContain(s);
    }
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T11 (§3.2/§6): FIM-surface nudge constants + the
 * `localInstall.models` deprecation lock.
 * ------------------------------------------------------------------ */

describe('§6 FIM-surface nudges (T11) — verbatim + single-sourced', () => {
  it('FIM_OLLAMA_PULL_NUDGE — §6 "Post-pull nudge (FIM ollama)"', () => {
    expect(FIM_OLLAMA_PULL_NUDGE).toBe('✓ Downloaded — set it as your FIM model in the Connect tab (Apply).');
  });

  it('FIM_LLAMACPP_NUDGE — §6 "llama.cpp FIM nudge"', () => {
    expect(FIM_LLAMACPP_NUDGE).toBe('Then switch the Connect tab to llama.cpp and Apply.');
  });

  it('SetupPanel.tsx never RESTATES the nudges inline — it renders the setupCards.ts constants', () => {
    const setupPanelSrc = readFileSync(join(__dirname, 'SetupPanel.tsx'), 'utf-8');
    expect(setupPanelSrc).not.toContain('set it as your FIM model in the Connect tab');
    expect(setupPanelSrc).not.toContain('Then switch the Connect tab to llama.cpp');
  });
});

describe('T11 — the registry `localInstall.models` wire projection: deprecated-in-comment, NOT removed', () => {
  const registrySrc = readFileSync(join(__dirname, '..', '..', '..', 'src', 'host', 'setup', 'registry.ts'), 'utf-8');
  const setupPanelSrc = readFileSync(join(__dirname, 'SetupPanel.tsx'), 'utf-8');

  it('registry.ts still carries the models projection (wire compat — never removed by T11)', () => {
    expect(registrySrc).toContain("{ role: 'fim', model: 'qwen2.5-coder:1.5b-base', settingKey: 'talaria.autocomplete.model' }");
    expect(registrySrc).toContain("{ role: 'embedding', model: 'qwen3-embedding:0.6b', settingKey: 'talaria.rag.embedModel' }");
  });

  it('registry.ts marks the projection @deprecated (beta.6 T11 — the unified UI reads catalog.models)', () => {
    expect(registrySrc).toContain('@deprecated beta.6 T11');
  });

  it('SetupPanel.tsx no longer consumes localInstall.models (the block reads catalog.models instead)', () => {
    expect(setupPanelSrc).not.toMatch(/localInstall\??\.models/);
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T12 (§3.1/§6): Agent-block helpers + copy.
 * ------------------------------------------------------------------ */

describe('§6 Agent-block copy (T12) — verbatim + single-sourced', () => {
  it('AGENT_BLOCK_HEADING — §6 "Agent block heading"', () => {
    expect(AGENT_BLOCK_HEADING).toBe('Configure Local Agent Model');
  });

  it('AGENT_PRE_READY_NOTE — §6 "Agent pre-ready note"', () => {
    expect(AGENT_PRE_READY_NOTE).toBe(
      "Hermes isn't installed yet — you can prepare the model now and configure the provider after the install.",
    );
  });

  it('AGENT_DEFAULT_MODEL_CAPTION — §6 "Devstral default caption"', () => {
    expect(AGENT_DEFAULT_MODEL_CAPTION).toBe("Recommended — Talaria's agent pipeline is tuned on Devstral-24B (2507).");
  });

  it('AGENT_PRESAVE_RUN_COMMAND_CAPTION — §6 "Run command caption (agent, pre-save)"', () => {
    expect(AGENT_PRESAVE_RUN_COMMAND_CAPTION).toBe('Uses the default port — Save updates this command to your endpoint.');
  });

  it('SetupPanel.tsx never RESTATES the T12 copy inline — it renders the setupCards.ts constants', () => {
    const setupPanelSrc = readFileSync(join(__dirname, 'SetupPanel.tsx'), 'utf-8');
    expect(setupPanelSrc).not.toContain('Configure Local Agent Model');
    expect(setupPanelSrc).not.toContain('you can prepare the model now');
    expect(setupPanelSrc).not.toContain('tuned on Devstral-24B (2507)');
    expect(setupPanelSrc).not.toContain('Uses the default port');
    expect(setupPanelSrc).not.toContain('GGUF by ');
  });

  it('localModel.tsx never hardcodes the T12 captions either — they arrive via props', () => {
    const localModelSrc = readFileSync(join(__dirname, 'localModel.tsx'), 'utf-8');
    expect(localModelSrc).not.toContain('tuned on Devstral-24B (2507)');
    expect(localModelSrc).not.toContain('Uses the default port');
    expect(localModelSrc).not.toContain('GGUF by ');
  });
});

describe('ggufPublisherCaption (T12, A-F7) — publisher ≠ vendor over the REAL catalog agent rows', () => {
  const byId = (id: string) => {
    const row = MODEL_CATALOG.find((m) => m.id === id);
    if (!row) throw new Error(`catalog row ${id} missing`);
    return { id: row.id, publisher: row.publisher };
  };

  it('vendor-published rows carry NO caption (devstral-24b, ornith-9b, ornith-35b)', () => {
    expect(ggufPublisherCaption(byId('devstral-24b'))).toBeUndefined();
    expect(ggufPublisherCaption(byId('ornith-9b'))).toBeUndefined();
    expect(ggufPublisherCaption(byId('ornith-35b'))).toBeUndefined();
  });

  it('packaging-org rows carry the caption (qwen36-27b/qwen36-35b-a3b → unsloth, gpt-oss-20b → ggml-org)', () => {
    expect(ggufPublisherCaption(byId('qwen36-27b'))).toBe('GGUF by unsloth');
    expect(ggufPublisherCaption(byId('qwen36-35b-a3b'))).toBe('GGUF by unsloth');
    expect(ggufPublisherCaption(byId('gpt-oss-20b'))).toBe('GGUF by ggml-org');
  });

  it('an id outside the catalog (fixture rows) yields NO caption — never a guess', () => {
    expect(ggufPublisherCaption({ id: 'not-a-row', publisher: 'unsloth' })).toBeUndefined();
  });

  it('self-truing: for EVERY agent row, caption presence ⇔ vllm serveRepo owner ≠ publisher', () => {
    for (const row of MODEL_CATALOG.filter((m) => m.role === 'agent')) {
      const owner = row.vllm?.serveRepo.split('/')[0];
      const caption = ggufPublisherCaption({ id: row.id, publisher: row.publisher });
      if (owner !== undefined && owner.toLowerCase() !== row.publisher.toLowerCase()) {
        expect(caption).toBe(`GGUF by ${row.publisher}`);
      } else {
        expect(caption).toBeUndefined();
      }
    }
  });
});

describe('agentRowCaption (T12) — Devstral caption on the default row; GGUF caption llamacpp-pane-only', () => {
  it('the defaultForRole row carries the §6 Devstral caption on EVERY pane', () => {
    const devstral = { id: 'devstral-24b', publisher: 'mistralai', defaultForRole: true as const };
    expect(agentRowCaption(devstral, 'ollama')).toBe(AGENT_DEFAULT_MODEL_CAPTION);
    expect(agentRowCaption(devstral, 'llamacpp')).toBe(AGENT_DEFAULT_MODEL_CAPTION);
    expect(agentRowCaption(devstral, 'vllm')).toBe(AGENT_DEFAULT_MODEL_CAPTION);
  });

  it('a packaging-org row carries the GGUF caption on the llamacpp pane ONLY', () => {
    const qwen = { id: 'qwen36-27b', publisher: 'unsloth' };
    expect(agentRowCaption(qwen, 'llamacpp')).toBe('GGUF by unsloth');
    expect(agentRowCaption(qwen, 'ollama')).toBeUndefined();
    expect(agentRowCaption(qwen, 'vllm')).toBeUndefined();
  });

  it('a vendor-published non-default row carries nothing anywhere', () => {
    const ornith = { id: 'ornith-9b', publisher: 'ornith-ai' };
    expect(agentRowCaption(ornith, 'ollama')).toBeUndefined();
    expect(agentRowCaption(ornith, 'llamacpp')).toBeUndefined();
    expect(agentRowCaption(ornith, 'vllm')).toBeUndefined();
  });
});

describe('agentEndpointInit (T12, CC-6) — endpointDefaults init, saved wins for ITS backend only', () => {
  const defaults = { ollama: 'http://127.0.0.1:11434', llamacpp: 'http://127.0.0.1:8013', vllm: 'http://127.0.0.1:8000' };

  it('no saved state: each backend initializes to its own default', () => {
    const local = { endpointDefaults: defaults };
    expect(agentEndpointInit(local, 'ollama')).toBe('http://127.0.0.1:11434');
    expect(agentEndpointInit(local, 'llamacpp')).toBe('http://127.0.0.1:8013');
    expect(agentEndpointInit(local, 'vllm')).toBe('http://127.0.0.1:8000');
  });

  it('saved wins for the SAVED backend; the other backends keep their defaults', () => {
    const local = {
      endpointDefaults: defaults,
      saved: { modelId: 'devstral-24b', backend: 'llamacpp' as const, endpoint: 'http://127.0.0.1:9999', servedName: 'x' },
    };
    expect(agentEndpointInit(local, 'llamacpp')).toBe('http://127.0.0.1:9999');
    expect(agentEndpointInit(local, 'ollama')).toBe('http://127.0.0.1:11434');
    expect(agentEndpointInit(local, 'vllm')).toBe('http://127.0.0.1:8000');
  });

  it('an absent agentLocalModel wire block degrades to an empty field — never a fabricated URL', () => {
    expect(agentEndpointInit(undefined, 'ollama')).toBe('');
  });
});

describe('agentInitialBackend (T12, §4.2) — saved.backend restores, else the ollama default', () => {
  it('no save: ollama', () => {
    expect(agentInitialBackend(undefined)).toBe('ollama');
    expect(
      agentInitialBackend({ endpointDefaults: { ollama: 'a', llamacpp: 'b', vllm: 'c' } }),
    ).toBe('ollama');
  });

  it('saved: the saved backend', () => {
    expect(
      agentInitialBackend({
        endpointDefaults: { ollama: 'a', llamacpp: 'b', vllm: 'c' },
        saved: { modelId: 'devstral-24b', backend: 'vllm', endpoint: 'http://127.0.0.1:8000', servedName: 'x' },
      }),
    ).toBe('vllm');
  });
});

describe('agentSavedSummaryLine (T12) — mirrors the save modal vocabulary', () => {
  it('composes "{displayName} via {backend} at {endpoint}"', () => {
    expect(agentSavedSummaryLine('Ornith-1.0 9B', 'ollama', 'http://127.0.0.1:11434')).toBe(
      'Ornith-1.0 9B via ollama at http://127.0.0.1:11434',
    );
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T13 (§3.3/§4.2): NEXT-surface helpers — pane restoration (CC-10)
 * and the retained SC-3 digest hint.
 * ------------------------------------------------------------------ */

describe('dedicatedInitialCandidateId (T13, CC-10) — restored pane wins, else the transport heuristic', () => {
  const candidates = [
    { id: 'ollama', nextEditTransport: 'ollama' as const },
    { id: 'llamacpp', nextEditTransport: 'openai-compat' as const },
    { id: 'vllm', nextEditTransport: 'openai-compat' as const },
    { id: 'openai-compat', nextEditTransport: 'openai-compat' as const },
  ];

  it('a dedicatedBackendId naming a live candidate wins — even over the transport heuristic', () => {
    expect(dedicatedInitialCandidateId({ backend: 'ollama', dedicatedBackendId: 'vllm' }, candidates)).toBe('vllm');
    expect(dedicatedInitialCandidateId({ backend: 'openai-compat', dedicatedBackendId: 'ollama' }, candidates)).toBe('ollama');
  });

  it("absent ⇒ today's heuristic: the FIRST candidate whose transport matches nextEdit.backend", () => {
    expect(dedicatedInitialCandidateId({ backend: 'ollama' }, candidates)).toBe('ollama');
    // three candidates share the openai-compat transport — the first wins,
    // exactly as the pre-T13 `candidates.find(...)` did.
    expect(dedicatedInitialCandidateId({ backend: 'openai-compat' }, candidates)).toBe('llamacpp');
  });

  it('an id naming NO live candidate (stale/edited settings) degrades to the heuristic, never a dead selection', () => {
    const ollamaOnly = [{ id: 'ollama', nextEditTransport: 'ollama' as const }];
    expect(dedicatedInitialCandidateId({ backend: 'ollama', dedicatedBackendId: 'llamacpp' }, ollamaOnly)).toBe('ollama');
  });

  it('no transport match either ⇒ the first candidate (pre-T13 fallback preserved)', () => {
    const ollamaOnly = [{ id: 'ollama', nextEditTransport: 'ollama' as const }];
    expect(dedicatedInitialCandidateId({ backend: 'openai-compat' }, ollamaOnly)).toBe('ollama');
  });

  it('empty candidates ⇒ undefined', () => {
    expect(dedicatedInitialCandidateId({ backend: 'ollama', dedicatedBackendId: 'ollama' }, [])).toBeUndefined();
  });
});

describe('nextLlamacppDigestHint (T13, SC-3) — the retained beta.5 manual-verify hint, WIRE-sourced', () => {
  const dedicatedBase: NonNullable<SetupData['nextEdit']['dedicated']> = {
    displayName: 'Sweep Next-Edit v2 (7B)',
    modelDefaults: { ollama: 'sweep-next-edit-v2-7b:q4_k_m', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
    downloadReady: true,
    downloadApproxBytes: 4_680_000_000,
    warning: 'w',
    guided: {
      vllm: 'Run: vllm serve sweepai/sweep-next-edit-v2-7B\n(official Sweep release, ~15 GB download)',
      llamacpp:
        'Run: llama-server -hf SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M --port 8012\n' +
        'Verify the download: sha256sum should print abc123def456',
    },
  };

  it("returns the guided.llamacpp CAPTION line (the host's own digest hint) — never the -hf command", () => {
    expect(nextLlamacppDigestHint(dedicatedBase)).toBe('Verify the download: sha256sum should print abc123def456');
  });

  it('undefined while the pin is unpublished (no guided.llamacpp on the wire) — the hint cannot outrun the pin', () => {
    expect(nextLlamacppDigestHint({ ...dedicatedBase, guided: { vllm: dedicatedBase.guided.vllm } })).toBeUndefined();
  });

  it('undefined for a caption-less guided line and for an absent dedicated block — never an empty caption', () => {
    expect(
      nextLlamacppDigestHint({ ...dedicatedBase, guided: { ...dedicatedBase.guided, llamacpp: 'Run: x --port 8012' } }),
    ).toBeUndefined();
    expect(nextLlamacppDigestHint(undefined)).toBeUndefined();
  });
});

describe('T13 — the §6 pinned-disabled copy stays single-sourced (scoped source-scan)', () => {
  it('neither SetupPanel.tsx nor localModel.tsx restates the no-vetted-build line inline — both reference the setupCards constant', () => {
    const setupPanelSrc = readFileSync(join(__dirname, 'SetupPanel.tsx'), 'utf-8');
    const localModelSrc = readFileSync(join(__dirname, 'localModel.tsx'), 'utf-8');
    expect(setupPanelSrc).not.toContain('No vetted build of this model is published yet');
    expect(localModelSrc).not.toContain('No vetted build of this model is published yet');
    expect(setupPanelSrc).not.toContain('Download model (~4.7 GB)');
    expect(localModelSrc).not.toContain('Download model (~4.7 GB)');
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T14 (§3.4/§6): RAG embedding-surface helpers + copy.
 * ------------------------------------------------------------------ */

describe('T14 — ragInitialBackend (§4.2 restoration: rag.embedBackend, else ollama)', () => {
  it("returns the wire's embedBackend for each of the 3-enum values", () => {
    expect(ragInitialBackend({ embedBackend: 'ollama' })).toBe('ollama');
    expect(ragInitialBackend({ embedBackend: 'llamacpp' })).toBe('llamacpp');
    expect(ragInitialBackend({ embedBackend: 'openai-compat' })).toBe('openai-compat');
  });
  it('degrades an absent embedBackend (old-host wire) to ollama', () => {
    expect(ragInitialBackend({})).toBe('ollama');
  });
});

describe("T14 — ragBlockBackend: the pane→block mapping ('openai-compat' renders the block's vllm pane)", () => {
  it("maps 'openai-compat' to 'vllm' (§3.4: Test + run command only)", () => {
    expect(ragBlockBackend('openai-compat')).toBe('vllm');
  });
  it('is the identity for ollama and llamacpp', () => {
    expect(ragBlockBackend('ollama')).toBe('ollama');
    expect(ragBlockBackend('llamacpp')).toBe('llamacpp');
  });
});

describe('T14 — ragEmbedPresence: the CONFIGURED embed model, endpoint-scoped (the C-6 rule — never the wrong daemon)', () => {
  const daemon = (names: string[], endpoint = 'http://127.0.0.1:11434') => ({
    running: true,
    endpoint,
    models: names.map((name) => ({ name, sizeBytes: 1 })),
  });
  const ragCfg = (embedEndpoint: string, embedModel: string) => ({ embedEndpoint, embedModel });

  it("'present' when the daemon at the CONFIGURED endpoint lists the model", () => {
    expect(ragEmbedPresence(daemon(['nomic-embed-text']), ragCfg('http://127.0.0.1:11434', 'nomic-embed-text'))).toBe('present');
  });
  it(":latest-tolerant in BOTH directions (the beta.5 exact-`===` gap, fixed by derivation)", () => {
    expect(ragEmbedPresence(daemon(['nomic-embed-text:latest']), ragCfg('http://127.0.0.1:11434', 'nomic-embed-text'))).toBe('present');
    expect(ragEmbedPresence(daemon(['nomic-embed-text']), ragCfg('http://127.0.0.1:11434', 'nomic-embed-text:latest'))).toBe('present');
  });
  it("'absent' when the configured endpoint IS the probed daemon but the model is not in its list", () => {
    expect(ragEmbedPresence(daemon(['qwen2.5-coder:1.5b-base']), ragCfg('http://127.0.0.1:11434', 'nomic-embed-text'))).toBe('absent');
  });
  it("'unknown' when the configured endpoint is NOT the probed daemon — even if THAT daemon has the name (the wrong-daemon anti-lie, pinned)", () => {
    expect(ragEmbedPresence(daemon(['nomic-embed-text']), ragCfg('http://10.0.0.9:11434', 'nomic-embed-text'))).toBe('unknown');
  });
  it("'unknown' while the daemon is not running", () => {
    expect(
      ragEmbedPresence({ running: false, endpoint: 'http://127.0.0.1:11434', models: [] }, ragCfg('http://127.0.0.1:11434', 'nomic-embed-text')),
    ).toBe('unknown');
  });
});

describe('T14 — §6 RAG copy: verbatim + single-sourced', () => {
  it('RAG_APPLY_NUDGE — §6 "llama.cpp RAG nudge"', () => {
    expect(RAG_APPLY_NUDGE).toBe('Then Apply the endpoint below.');
  });
  it('the embeddinggemma ctx note is CATALOG data — §6 verbatim at its single source (the wire `note` carries it to the row)', () => {
    const row = MODEL_CATALOG.find((m) => m.id === 'embeddinggemma-300m');
    expect(row?.note).toBe('2K context on the Ollama build — fine for Talaria’s chunk sizes (≤512 tokens).');
  });
  it('SetupPanel.tsx never RESTATES the nudge inline — it renders the setupCards.ts constant', () => {
    const setupPanelSrc = readFileSync(join(__dirname, 'SetupPanel.tsx'), 'utf-8');
    expect(setupPanelSrc).not.toContain('Then Apply the endpoint below.');
  });
});

describe('T14 — F-3 closed: every embedding row has a verified llama.cpp build (no absence cells on the RAG surface)', () => {
  const embedRows = MODEL_CATALOG.filter((m) => m.role === 'embedding');
  it('the catalog carries exactly the three §3.4 rows, 0.6b the role default', () => {
    expect(embedRows.map((m) => m.id)).toEqual(['qwen3-embedding-0.6b', 'qwen3-embedding-4b', 'embeddinggemma-300m']);
    expect(embedRows.filter((m) => m.defaultForRole).map((m) => m.id)).toEqual(['qwen3-embedding-0.6b']);
  });
  it('all three carry a llamacpp gguf — embeddinggemma via ggml-org (F-3)', () => {
    for (const row of embedRows) {
      expect(row.llamacpp).toBeDefined();
    }
    expect(embedRows.find((m) => m.id === 'embeddinggemma-300m')?.llamacpp?.gguf.hfRepo).toBe('ggml-org/embeddinggemma-300M-GGUF');
  });
});

describe('T14 — the beta.5 wrong-daemon presence boolean: webview consumption REMOVED, wire kept (deprecated-in-comment)', () => {
  // The identifier is spelled out only HERE (test file) — the three scanned
  // sources must not carry it at all, comments included.
  const WIRE_BOOLEAN = 'embedModelPresent';

  it('SetupPanel.tsx / localModel.tsx / setupCards.ts no longer mention the wire boolean (endpoint-scoped derivation replaced it)', () => {
    expect(readFileSync(join(__dirname, 'SetupPanel.tsx'), 'utf-8')).not.toContain(WIRE_BOOLEAN);
    expect(readFileSync(join(__dirname, 'localModel.tsx'), 'utf-8')).not.toContain(WIRE_BOOLEAN);
    expect(readFileSync(join(__dirname, 'setupCards.ts'), 'utf-8')).not.toContain(WIRE_BOOLEAN);
  });

  it('the wire field + host computation SURVIVE (compat), marked @deprecated beta.6 T14', () => {
    const protocolSrc = readFileSync(join(__dirname, '..', '..', '..', 'src', 'shared', 'protocol.ts'), 'utf-8');
    const controllerSrc = readFileSync(join(__dirname, '..', '..', '..', 'src', 'host', 'setup', 'SetupController.ts'), 'utf-8');
    expect(protocolSrc).toContain(`${WIRE_BOOLEAN}: boolean`);
    expect(protocolSrc).toContain('@deprecated beta.6 T14');
    expect(controllerSrc).toContain(`${WIRE_BOOLEAN}: ollamaStatus.running`);
    expect(controllerSrc).toContain('@deprecated beta.6 T14');
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T18 (§3.5/§6): start-screen model recommendations —
 * `RecommendationsBlock`'s pure derivation (the strip's DOM wiring lives
 * in `SetupPanel.dom.test.tsx`; the walkthrough's anchor-parity lock lives
 * in `src/host/walkthroughRecs.test.ts`).
 * ------------------------------------------------------------------ */

describe('T18 — recs strip pure derivation (§3.5, B-F1..B-F8)', () => {
  // Byte-exact fixtures mirroring MODEL_CATALOG's own rows (test-local copies
  // are fine here — the "zero hardcoded model data" rule (B-F1) binds the
  // PRODUCTION sources scanned below, not test fixtures).
  function agentDefaultRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
    return {
      id: 'devstral-24b',
      role: 'agent',
      defaultForRole: true,
      displayName: 'Devstral-24B (2507)',
      publisher: 'mistralai',
      license: 'Apache-2.0',
      vramLine: '24GB-comfortable — the sweet spot: ~55K ctx fp16-KV / ~110K Q8-KV; 128K window',
      progressId: 'devstral-24b',
      ollamaCreatedName: 'devstral-small-2507:24b',
      ollamaApproxBytes: 14_333_915_904,
      llamacpp: { file: 'Devstral-Small-2507-Q4_K_M.gguf', approxBytes: 14_333_915_904, present: false, available: true },
      vllm: { runCommand: 'vllm serve mistralai/Devstral-Small-2507' },
      ...overrides,
    };
  }
  function fimDefaultRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
    return {
      id: 'qwen25-coder-1.5b',
      role: 'fim',
      defaultForRole: true,
      displayName: 'Qwen2.5-Coder 1.5B (base)',
      publisher: 'ggml-org',
      license: 'Apache-2.0',
      vramLine: 'any modern GPU (~1–2 GB)',
      progressId: 'qwen25-coder-1.5b',
      ollamaTag: 'qwen2.5-coder:1.5b-base',
      ollamaApproxBytes: 986_000_000,
      llamacpp: { file: 'qwen2.5-coder-1.5b-q8_0.gguf', approxBytes: 1_646_573_056, present: false, available: true },
      vllm: { runCommand: 'vllm serve Qwen/Qwen2.5-Coder-1.5B' },
      ...overrides,
    };
  }
  function fim7bRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
    return {
      id: 'qwen25-coder-7b',
      role: 'fim',
      displayName: 'Qwen2.5-Coder 7B (base)',
      publisher: 'ggml-org',
      license: 'Apache-2.0',
      vramLine: 'Ollama Q4 ≈ 6 GB · llama.cpp Q8 ≈ 9–10 GB',
      progressId: 'qwen25-coder-7b',
      ollamaTag: 'qwen2.5-coder:7b-base',
      ollamaApproxBytes: 4_700_000_000,
      llamacpp: { file: 'qwen2.5-coder-7b-q8_0.gguf', approxBytes: 8_098_525_600, present: false, available: true },
      vllm: { runCommand: 'vllm serve Qwen/Qwen2.5-Coder-7B' },
      ...overrides,
    };
  }
  function embeddingDefaultRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
    return {
      id: 'qwen3-embedding-0.6b',
      role: 'embedding',
      defaultForRole: true,
      displayName: 'Qwen3-Embedding 0.6B',
      publisher: 'Qwen',
      license: 'Apache-2.0',
      vramLine: '< 1.5 GB',
      progressId: 'qwen3-embedding-0.6b',
      ollamaTag: 'qwen3-embedding:0.6b',
      ollamaApproxBytes: 639_000_000,
      llamacpp: { file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', approxBytes: 639_150_592, present: false, available: true },
      vllm: { runCommand: 'vllm serve Qwen/Qwen3-Embedding-0.6B' },
      ...overrides,
    };
  }
  function gptOssRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
    return {
      id: 'gpt-oss-20b',
      role: 'agent',
      displayName: 'gpt-oss-20b',
      publisher: 'ggml-org',
      license: 'Apache-2.0',
      vramLine: '24GB-easy (100K+ ctx)',
      progressId: 'gpt-oss-20b',
      ollamaTag: 'gpt-oss:20b',
      ollamaApproxBytes: 14_000_000_000,
      llamacpp: { file: 'gpt-oss-20b-MXFP4.gguf', approxBytes: 12_109_566_624, present: false, available: true },
      vllm: { runCommand: 'vllm serve openai/gpt-oss-20b' },
      ...overrides,
    };
  }
  function sweepNextDefaultRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
    return {
      id: 'sweep-next',
      role: 'next',
      defaultForRole: true,
      displayName: 'Sweep Next-Edit v2 (7B)',
      publisher: 'SyntinalCo',
      license: 'Apache-2.0',
      vramLine: 'Q4 ≈ 5 GB',
      progressId: 'sweep-next',
      ollamaCreatedName: 'sweep-next-edit-v2-7b:q4_k_m',
      ollamaApproxBytes: 4_680_000_000,
      llamacpp: { file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf', approxBytes: 4_680_000_000, present: false, available: true },
      vllm: { runCommand: 'vllm serve sweepai/sweep-next-edit-v2-7B' },
      ...overrides,
    };
  }

  const FULL_CATALOG: SetupCatalogModel[] = [
    agentDefaultRow(),
    fimDefaultRow(),
    fim7bRow(),
    embeddingDefaultRow(),
    gptOssRow(),
    sweepNextDefaultRow(),
  ];

  function nextEditFixture(overrides: Partial<SetupData['nextEdit']> = {}): SetupData['nextEdit'] {
    return {
      source: 'off',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: '',
      dedicatedConfigured: false,
      genericSupported: true,
      dedicated: {
        displayName: 'Sweep Next-Edit v2 (7B)',
        modelDefaults: { ollama: 'sweep-next-edit-v2-7b:q4_k_m', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
        downloadReady: true,
        downloadApproxBytes: 4_680_000_000,
        warning: 'warn',
        guided: { vllm: 'vllm serve x' },
      },
      ...overrides,
    };
  }

  function setupFixture(
    catalogModels: SetupCatalogModel[] | undefined,
    nextEditOverrides: Partial<SetupData['nextEdit']> = {},
  ): Pick<SetupData, 'catalog' | 'nextEdit'> {
    return {
      catalog: catalogModels ? { models: catalogModels } : undefined,
      nextEdit: nextEditFixture(nextEditOverrides),
    };
  }

  describe('§6 rounding rule — bytes/2^30, 1dp, half-up, exact-bytes only', () => {
    it('USABLE_VRAM_24GB_GIB is the pinned 22 GiB constant (B-F3)', () => {
      expect(USABLE_VRAM_24GB_GIB).toBe(22);
    });

    it('roundGiB: Devstral (14_333_915_904) -> 13.3', () => {
      expect(roundGiB(14_333_915_904)).toBe(13.3);
    });
    it('roundGiB: FIM-1.5B ollama bytes (986_000_000) -> 0.9', () => {
      expect(roundGiB(986_000_000)).toBe(0.9);
    });
    it('roundGiB: embed-0.6B (639_000_000) -> 0.6', () => {
      expect(roundGiB(639_000_000)).toBe(0.6);
    });
    it('roundGiB: half-up tie (1.25 GiB exactly) rounds to 1.3, never 1.2', () => {
      expect(roundGiB(1_342_177_280)).toBe(1.3);
    });
    it('formatGiB always prints exactly one decimal, even for a whole number', () => {
      expect(formatGiB(2 * 2 ** 30)).toBe('2.0');
    });
  });

  describe('render gate (B-F7) — nothing unless catalog present AND all four defaults resolve', () => {
    it('undefined catalog -> undefined (no strip)', () => {
      expect(deriveRecommendations(setupFixture(undefined))).toBeUndefined();
    });
    it('catalog present but missing the agent default -> undefined', () => {
      const models = FULL_CATALOG.filter((m) => !(m.role === 'agent' && m.defaultForRole));
      expect(deriveRecommendations(setupFixture(models))).toBeUndefined();
    });
    it('catalog present but missing the fim default -> undefined', () => {
      const models = FULL_CATALOG.filter((m) => !(m.role === 'fim' && m.defaultForRole));
      expect(deriveRecommendations(setupFixture(models))).toBeUndefined();
    });
    it('catalog present but missing the embedding default -> undefined', () => {
      const models = FULL_CATALOG.filter((m) => !(m.role === 'embedding' && m.defaultForRole));
      expect(deriveRecommendations(setupFixture(models))).toBeUndefined();
    });
    it('catalog present but missing the next default -> undefined', () => {
      const models = FULL_CATALOG.filter((m) => !(m.role === 'next' && m.defaultForRole));
      expect(deriveRecommendations(setupFixture(models))).toBeUndefined();
    });
    it('a defaultForRole row with no ollamaApproxBytes does not "resolve" (no truthful size to print)', () => {
      const models = FULL_CATALOG.map((m) =>
        m.id === 'devstral-24b' ? { ...m, ollamaApproxBytes: undefined } : m,
      );
      expect(deriveRecommendations(setupFixture(models))).toBeUndefined();
    });
    it('all four defaults present -> resolves', () => {
      expect(deriveRecommendations(setupFixture(FULL_CATALOG))).toBeDefined();
    });
  });

  describe('role lines (B-F1/B-F5) — template-derived from the wire, zero hardcoded data', () => {
    const recs = deriveRecommendations(setupFixture(FULL_CATALOG));

    it('agent line', () => {
      expect(roleLineText(mustRec(recs).agent)).toBe('Agent · Devstral-24B (2507) — 13.3 GiB');
    });
    it('fim line', () => {
      expect(roleLineText(mustRec(recs).fim)).toBe('FIM · Qwen2.5-Coder 1.5B (base) — 0.9 GiB');
    });
    it('embedding line', () => {
      expect(roleLineText(mustRec(recs).embedding)).toBe('Embedder · Qwen3-Embedding 0.6B — 0.6 GiB');
    });
    it('next line', () => {
      expect(roleLineText(mustRec(recs).next)).toBe('NEXT · Sweep Next-Edit v2 (7B) — 4.4 GiB');
    });

    it('self-truing (B-F1): editing the catalog byte/name re-derives correctly, no second drift-lock', () => {
      const edited = FULL_CATALOG.map((m) =>
        m.id === 'devstral-24b' ? { ...m, displayName: 'Mock-Agent-X', ollamaApproxBytes: 10_000_000_000 } : m,
      );
      const edRecs = mustRec(deriveRecommendations(setupFixture(edited)));
      expect(roleLineText(edRecs.agent)).toBe(`Agent · Mock-Agent-X — ${formatGiB(10_000_000_000)} GiB`);
    });
  });

  describe('divergence caption (B-F5) — present only where the rounded tiers actually diverge', () => {
    const recs = mustRec(deriveRecommendations(setupFixture(FULL_CATALOG)));

    it('FIM: 0.9 (ollama) vs 1.5 (llama.cpp Q8) -> caption present', () => {
      expect(divergenceCaptionText(recs.fim)).toBe('llama.cpp build differs: 1.5 GiB');
    });
    it('Agent: identical bytes on both tiers -> no caption', () => {
      expect(divergenceCaptionText(recs.agent)).toBeUndefined();
    });
    it('Embedding: 0.6 vs 0.6 (rounds equal despite differing raw bytes) -> no caption', () => {
      expect(divergenceCaptionText(recs.embedding)).toBeUndefined();
    });
    it('NEXT: identical bytes on both tiers -> no caption', () => {
      expect(divergenceCaptionText(recs.next)).toBeUndefined();
    });
  });

  describe('stack line + meter (B-F1/B-F3) — one derivation, shared by both renderings', () => {
    const recs = mustRec(deriveRecommendations(setupFixture(FULL_CATALOG)));

    it('sumGiB is the EXACT byte sum, rounded once (not sum-of-rounded-parts)', () => {
      expect(recs.stack.sumGiB).toBe('14.9');
    });
    it('leftGiB = rule-rounded (USABLE_VRAM_24GB_GIB - exact byte sum)', () => {
      expect(recs.stack.leftGiB).toBe('7.1');
    });
    it('stackLineText matches the §6 TEMPLATE verbatim with today’s data', () => {
      // The architecture doc's inline illustration abbreviates the FIM
      // display name (drops "(base)"); the real catalog row's displayName
      // carries it, and B-F1 requires interpolating the REAL wire value —
      // this expectation matches `MODEL_CATALOG`'s actual `displayName`.
      expect(stackLineText(recs.agent, recs.fim, recs.embedding, recs.stack)).toBe(
        'A 24 GB GPU runs the full stack: Devstral-24B (2507) (13.3 GiB) + Qwen2.5-Coder 1.5B (base) (0.9 GiB) + ' +
          'Qwen3-Embedding 0.6B (0.6 GiB) ≈ 14.9 GiB — about 7.1 GiB left for context (roughly 45K tokens at ' +
          "fp16 KV — see Part 0.2's fit model).",
      );
    });
    it('meterSegments: three segments, rule-rounded values against the 22 GiB track', () => {
      const segs = meterSegments(recs.agent, recs.fim, recs.embedding);
      expect(segs.map((s) => s.role)).toEqual(['agent', 'fim', 'embedding']);
      expect(segs[0]?.pct).toBeCloseTo((13.3 / 22) * 100, 5);
      expect(segs[1]?.pct).toBeCloseTo((0.9 / 22) * 100, 5);
      expect(segs[2]?.pct).toBeCloseTo((0.6 / 22) * 100, 5);
    });
  });

  describe('tier lines + MoE note (B-F1/B-F4) — frame text static, names/sizes interpolated', () => {
    it('all four tier lines + gpt-oss in the 16 GB bucket (never 12 GB)', () => {
      const recs = mustRec(deriveRecommendations(setupFixture(FULL_CATALOG)));
      expect(recs.tiers.tier8).toBe('~8 GB: Qwen2.5-Coder 1.5B (base) · all embedders — agent models need more');
      expect(recs.tiers.tier1216).toBe('12–16 GB: + Qwen2.5-Coder 7B (base); at 16 GB: gpt-oss-20b (tight)');
      expect(recs.tiers.tier24).toBe(
        '24 GB: any single agent model — Devstral-24B (2507) is the sweet spot; MoE 35Bs need CPU-offload',
      );
      expect(recs.tiers.tier32).toBe('32 GB+: everything, incl. MoE 35Bs fully resident');
    });

    it('gracefully degrades (no crash) when the non-default 7B/gpt-oss rows are absent from the wire', () => {
      const minimal = FULL_CATALOG.filter((m) => m.defaultForRole);
      const recs = mustRec(deriveRecommendations(setupFixture(minimal)));
      expect(recs.tiers.tier1216).not.toContain('undefined');
    });

    it('RECS_MOE_NOTE — §6 MoE honesty note, verbatim', () => {
      expect(RECS_MOE_NOTE).toBe(
        'MoE ≠ smaller: a 35B MoE still needs ~20 GiB for weights — only compute is light (~3B active per token).',
      );
    });
  });

  describe('NEXT/Sweep fail-closed (B-F5, §3.5) — mirrors the NEXT card, never "recommended" while unpinned', () => {
    it('absent `dedicated` entirely -> fail-closed by default (R-3 posture), nextReady false', () => {
      const recs = mustRec(deriveRecommendations(setupFixture(FULL_CATALOG, { dedicated: undefined })));
      expect(recs.next.nextReady).toBe(false);
    });
    it('downloadReady: true (published pin) -> nextReady true', () => {
      const recs = mustRec(
        deriveRecommendations(
          setupFixture(FULL_CATALOG, {
            dedicated: {
              displayName: 'Sweep Next-Edit v2 (7B)',
              modelDefaults: { ollama: 'sweep-next-edit-v2-7b:q4_k_m', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
              downloadReady: true,
              downloadApproxBytes: 4_680_000_000,
              warning: 'warn',
              guided: { vllm: 'vllm serve x' },
            },
          }),
        ),
      );
      expect(recs.next.nextReady).toBe(true);
    });
    it('downloadReady: false (unpinned, today’s actual state) -> nextReady false', () => {
      const recs = mustRec(
        deriveRecommendations(
          setupFixture(FULL_CATALOG, {
            dedicated: {
              displayName: 'Sweep Next-Edit v2 (7B)',
              modelDefaults: { ollama: '', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
              downloadReady: false,
              downloadApproxBytes: 4_680_000_000,
              warning: 'warn',
              guided: { vllm: 'vllm serve x' },
            },
          }),
        ),
      );
      expect(recs.next.nextReady).toBe(false);
    });
    it('the strip NEVER hardcodes the word "recommended" for NEXT — it reuses the NEXT card’s own fail-closed text', () => {
      // NEXT_DOWNLOAD_UNAVAILABLE_TEXT is the single source of truth the NEXT
      // card itself renders (setupCards.ts) — the recs strip must reuse it,
      // not restate a second copy.
      expect(NEXT_DOWNLOAD_UNAVAILABLE_TEXT).not.toMatch(/recommended/i);
    });
  });

  describe('strip frame copy (§6) — verbatim + single-sourced', () => {
    it('RECS_STRIP_HEADING', () => {
      expect(RECS_STRIP_HEADING).toBe('Recommended local models');
    });
    it('RECS_STRIP_INTRO', () => {
      expect(RECS_STRIP_INTRO).toBe('Pick by your GPU — sizes are the download; running adds context memory + ~2 GiB buffers.');
    });
    it('RECS_DISCLOSURE_SUMMARY', () => {
      expect(RECS_DISCLOSURE_SUMMARY).toBe('What fits my hardware?');
    });
  });

  function mustRec(value: RecsResult): NonNullable<RecsResult> {
    if (value === undefined) throw new Error('fixture bug: deriveRecommendations resolved to undefined');
    return value;
  }
  type RecsResult = ReturnType<typeof deriveRecommendations>;
});

describe('T18 — scoped source-scan: ZERO hardcoded model data in the recs strip sources (rule 5, B-F1)', () => {
  // Scoped to the two hand-written files T18 touches — NOT modelCatalog.ts
  // (pure DATA, the legitimate single source) and NOT the test fixtures
  // above (which intentionally mirror catalog data to exercise the pure
  // derivation without a live wire fetch).
  const setupCardsSrc = readFileSync(join(__dirname, 'setupCards.ts'), 'utf-8');
  const setupPanelSrc = readFileSync(join(__dirname, 'SetupPanel.tsx'), 'utf-8');

  // Long/distinctive catalog facts (exact byte counts + full display-name
  // phrases) that must NEVER appear as source literals — every one of these
  // must instead flow from a `SetupCatalogModel` wire row at render time.
  const FORBIDDEN_HARDCODED_MODEL_DATA = [
    '14_333_915_904',
    '14333915904',
    '986_000_000',
    '986000000',
    '1_646_573_056',
    '1646573056',
    '639_000_000',
    '639000000',
    '639_150_592',
    '639150592',
    '4_680_000_000',
    '4680000000',
    '8_098_525_600',
    '8098525600',
    // NOTE: 'Devstral-24B (2507)' is intentionally NOT in this list — T12's
    // pre-existing `AGENT_DEFAULT_MODEL_CAPTION` (§6 "Devstral default
    // caption") already carries it as its own owned, unrelated §6 string;
    // T18's OWN functions (`roleLineText`/`stackLineText`/`recsTiers`) never
    // write it as a literal — they interpolate `row.displayName` — so this
    // list stays scoped to facts T18 alone would ever hardcode.
    'Qwen2.5-Coder 1.5B (base)',
    'Qwen2.5-Coder 7B (base)',
    'Qwen3-Embedding 0.6B',
    'Sweep Next-Edit v2 (7B)',
  ];

  it('setupCards.ts carries none of these literals', () => {
    for (const s of FORBIDDEN_HARDCODED_MODEL_DATA) {
      expect(setupCardsSrc, `found forbidden literal "${s}" in setupCards.ts`).not.toContain(s);
    }
  });
  it('SetupPanel.tsx carries none of these literals', () => {
    for (const s of FORBIDDEN_HARDCODED_MODEL_DATA) {
      expect(setupPanelSrc, `found forbidden literal "${s}" in SetupPanel.tsx`).not.toContain(s);
    }
  });
});
