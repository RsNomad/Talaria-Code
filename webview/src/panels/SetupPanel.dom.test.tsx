/**
 * DOM-level tests for the Setup / Talaria Config panel (Task 10, plan doc §6).
 *
 * Scope discipline (mirrors `SettingsPanel.dom.test.tsx`): these assert
 * WIRING — that a card state reaches the screen, that a click reaches
 * `dispatch` with the right method/params, that a gated control is actually
 * non-interactive. Copy-content assertions for the FROZEN NEXT rows live in
 * the pure `SetupPanel.test.ts`/`SettingsPanel.test.ts` locks, not here.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSetupPhase, SetupBackendOption, SetupCatalogModel, SetupData, SetupMethod } from '../protocol';
import { NEXT_EDIT_ROWS } from './nextEditCopy';
import { SetupPanel } from './SetupPanel';
import {
  agentPhaseLabel,
  FIM_LLAMACPP_MODEL_NOTE,
  NEXT_DOWNLOAD_UNAVAILABLE_TEXT,
  pendingSelectionLine,
  PIPX_INSTALL_DOCS_URL,
  PYTHON_VERSION_HELP_URL,
  TRUST_DISABLED_REASON,
} from './setupCards';
import { DECLINED } from '../state/panels';
import { must } from '../testing/must';

function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

const noopRetry = () => undefined;

function hermesOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return {
    id: 'hermes',
    kind: 'agent',
    status: 'available',
    displayName: 'Hermes',
    description: 'The default ACP agent backend.',
    localInstall: { flavor: 'pipx', effort: 'one-script' },
    ...overrides,
  };
}

function ollamaOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return {
    id: 'ollama',
    kind: 'fim',
    status: 'available',
    displayName: 'Ollama',
    description: 'Local FIM via Ollama.',
    remote: {
      endpointDefault: 'http://127.0.0.1:11434',
      endpointValue: 'http://127.0.0.1:11434',
      endpointPlaceholder: 'http://host:port',
      auth: 'none',
      apiKeySet: false,
      probe: 'ollama-tags',
    },
    localInstall: {
      flavor: 'guided-terminal',
      effort: 'one-script',
      models: [{ role: 'fim', model: 'qwen2.5-coder:1.5b-base', present: true }],
    },
    nextEditTransport: 'ollama',
    ...overrides,
  };
}

function codestralOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return {
    id: 'codestral',
    kind: 'fim',
    status: 'available',
    displayName: 'Codestral',
    description: 'Mistral Codestral (remote).',
    remote: {
      endpointDefault: 'https://codestral.mistral.ai',
      endpointValue: '',
      endpointPlaceholder: 'https://codestral.mistral.ai',
      auth: 'apiKey-required',
      apiKeySet: false,
      probe: 'none',
    },
    ...overrides,
  };
}

function llamacppOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return {
    id: 'llamacpp',
    kind: 'fim',
    status: 'available',
    displayName: 'llama.cpp',
    description: 'Local FIM via llama.cpp.',
    remote: {
      endpointDefault: 'http://127.0.0.1:8012',
      endpointValue: '',
      endpointPlaceholder: 'http://host:port',
      auth: 'none',
      apiKeySet: false,
      probe: 'llamacpp-health',
    },
    localInstall: { flavor: 'guided-terminal', effort: 'manual-guided' },
    ...overrides,
  };
}

function vllmOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return {
    id: 'vllm',
    kind: 'fim',
    status: 'available',
    displayName: 'vLLM',
    description: 'Local FIM via vLLM.',
    remote: {
      endpointDefault: 'http://127.0.0.1:8000',
      endpointValue: '',
      endpointPlaceholder: 'http://host:port',
      auth: 'none',
      apiKeySet: false,
      probe: 'openai-models',
    },
    localInstall: { flavor: 'docs-only', effort: 'manual-guided' },
    docsUrl: 'https://docs.vllm.ai/',
    ...overrides,
  };
}

function openaiCompatOption(overrides: Partial<SetupBackendOption> = {}): SetupBackendOption {
  return {
    id: 'openai-compat',
    kind: 'fim',
    status: 'available',
    displayName: 'OpenAI-compatible server',
    description: 'Bring your own OpenAI-compatible endpoint.',
    remote: {
      endpointDefault: 'http://127.0.0.1:8000',
      endpointValue: '',
      endpointPlaceholder: 'http://127.0.0.1:8000',
      auth: 'apiKey-optional',
      apiKeySet: false,
      probe: 'openai-models',
    },
    nextEditTransport: 'openai-compat',
    ...overrides,
  };
}

/**
 * T13 (§3.3): the pinned NEXT catalog row as `projectCatalogModel` ships it —
 * field values mirror the REAL `modelCatalog.ts` `sweep-next` row (id, names,
 * bytes, hf-ingest created name). The default cell is the POST-publication
 * state (`available: true` — pairs with `baseData()`'s `downloadReady: true`
 * steady state); the empty-pin fixtures override `llamacpp` to the shipping
 * `available: false` truth `composeLlamacppCell` produces while `sha256: ''`.
 */
function sweepNextRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'sweep-next',
    role: 'next',
    displayName: 'Sweep Next-Edit v2 (7B)',
    publisher: 'SyntinalCo',
    license: 'Apache-2.0',
    defaultForRole: true,
    contextWindow: 32768,
    vramLine: 'Q4 ≈ 5 GB',
    progressId: 'sweep-next',
    ollamaCreatedName: 'sweep-next-edit-v2-7b:q4_k_m',
    ollamaApproxBytes: 4_680_000_000,
    llamacpp: {
      file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
      approxBytes: 4_680_000_000,
      present: false,
      available: true,
    },
    vllm: { runCommand: 'vllm serve sweepai/sweep-next-edit-v2-7B' },
    ...overrides,
  };
}

/** A fully "you're ready" snapshot, overridable per test. */
function baseData(overrides: Partial<SetupData> = {}): SetupData {
  return {
    trusted: true,
    agent: {
      options: [
        hermesOption(),
        { id: 'openclaw', kind: 'agent', status: 'coming-soon', displayName: 'OpenClaw', description: 'Coming soon.' },
        { id: 'talaria-ai', kind: 'agent', status: 'coming-soon', displayName: 'Talaria AI', description: 'Coming soon.' },
      ],
      selectedId: 'hermes',
      phase: 'ready',
      version: 'hermes-acp 1.4.0',
    },
    provider: { phase: 'configured', providerId: 'anthropic' },
    fim: {
      options: [ollamaOption(), codestralOption()],
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
    },
    nextEdit: {
      source: 'generic',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:1.5b-base',
      dedicatedConfigured: false,
      genericSupported: true,
      // T15 (§4.2/§4.3): the dedicated NEXT model block — always populated
      // by the host since beta.5; `downloadReady: true` here is the
      // post-publication steady state, overridden per-test for the
      // pre-publication (R-3) fixtures.
      dedicated: {
        displayName: 'Sweep Next-Edit v2 (7B)',
        modelDefaults: { ollama: 'sweep-next-edit-v2-7b:q4_k_m', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
        downloadReady: true,
        downloadApproxBytes: 4_680_000_000,
        warning:
          'Needs ~15 GB of GPU memory at full precision, or ~5 GB for the 4-bit build. On a CPU-only machine a 7B model produces a few tokens per second — dedicated next-edit will feel slow; the Generic mode reuses your smaller FIM model instead.',
        guided: {
          vllm: 'Run: vllm serve sweepai/sweep-next-edit-v2-7B\n(official Sweep release, ~15 GB download)',
          llamacpp:
            'Run: llama-server -hf SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M --port 8012\nVerify the download: sha256sum should print abc123def456',
        },
      },
    },
    rag: {
      enabled: false,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'nomic-embed-text',
      embedModelPresent: false,
      tuning: { dims: 768, maxChunkTokens: 512, debounceMs: 500, excludeGlobs: [] },
      indexDir: '.talaria/index',
    },
    ollama: {
      running: true,
      version: '0.4.1',
      endpoint: 'http://127.0.0.1:11434',
      models: [{ name: 'qwen2.5-coder:1.5b-base', sizeBytes: 986_000_000 }],
    },
    // T13: the host projects `catalog` UNCONDITIONALLY since T6 — the NEXT
    // surface reads its pinned row (id/progress key) from here, never from a
    // webview literal. Role-filtered away by the FIM/Agent/RAG surfaces.
    catalog: { models: [sweepNextRow()] },
    ready: true,
    ...overrides,
  };
}

function renderPanel(data: SetupData, extra: Partial<Parameters<typeof SetupPanel>[0]> = {}) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const onToggleNextEdit = vi.fn().mockResolvedValue(undefined);
  const utils = setup(
    <SetupPanel
      data={{ status: 'success', data }}
      onRetry={noopRetry}
      progress={{}}
      nextEdit={{ next: false, generic: true }}
      onToggleNextEdit={onToggleNextEdit}
      dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
      {...extra}
    />,
  );
  return { ...utils, dispatch, onToggleNextEdit };
}

describe('Agent card — renders every AgentSetupPhase fixture (§6 card 1)', () => {
  const phases: AgentSetupPhase[] = [
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

  for (const phase of phases) {
    it(`shows the phase's status text for "${phase}"`, () => {
      const data = baseData({ agent: { ...baseData().agent, phase, detail: 'some detail' } });
      renderPanel(data);
      expect(screen.getByText(agentPhaseLabel(phase))).toBeInTheDocument();
    });
  }

  it('"missing" renders an actionable [Install Hermes] button', () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'missing' } });
    renderPanel(data);
    expect(screen.getByRole('button', { name: 'Install Hermes' })).toBeEnabled();
  });

  it('"installed-inactive" renders an actionable [Activate + Reload] button', () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'installed-inactive' } });
    renderPanel(data);
    expect(screen.getByRole('button', { name: 'Activate + Reload' })).toBeEnabled();
  });

  it('clicking [Install Hermes] dispatches setup.install with the selected backend id', async () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'missing', selectedId: 'hermes' } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Install Hermes' }));
    expect(dispatch).toHaveBeenCalledWith('setup.install', { backendId: 'hermes' });
  });
});

describe('Agent card — coming-soon entries are never selectable (§6)', () => {
  it('OpenClaw/Talaria AI render disabled with a "Coming soon" pill', () => {
    renderPanel(baseData());
    const openclaw = screen.getByRole('button', { name: /OpenClaw/ });
    expect(openclaw).toBeDisabled();
    expect(openclaw).toHaveAttribute('aria-disabled', 'true');
    expect(within(openclaw).getByText('Coming soon')).toBeInTheDocument();
  });

  it('a click on a coming-soon entry produces NO request', async () => {
    const { user, dispatch } = renderPanel(baseData());
    const openclaw = screen.getByRole('button', { name: /OpenClaw/ });
    await user.click(openclaw);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('FIM card — the two-mode question (§6 card 3)', () => {
  it('renders "Install locally, or connect to an existing endpoint?" for ollama (local-capable)', () => {
    const data = baseData({ fim: { ...baseData().fim, options: [ollamaOption()], selectedId: 'ollama' } });
    renderPanel(data);
    expect(screen.getByText(/Install locally, or connect to an existing endpoint\?/)).toBeInTheDocument();
  });

  it('does NOT render the two-mode question for codestral (remote-only)', () => {
    const data = baseData({
      fim: { ...baseData().fim, options: [codestralOption()], selectedId: 'codestral' },
    });
    renderPanel(data);
    expect(screen.queryByText(/Install locally, or connect to an existing endpoint\?/)).not.toBeInTheDocument();
  });

  it('does NOT render the two-mode question for openai-compat (remote-only)', () => {
    const openaiCompat = codestralOption({
      id: 'openai-compat',
      displayName: 'OpenAI-compatible',
      remote: {
        endpointDefault: 'http://127.0.0.1:8000',
        endpointValue: '',
        endpointPlaceholder: 'http://host:port',
        auth: 'apiKey-optional',
        apiKeySet: false,
        probe: 'openai-models',
      },
    });
    const data = baseData({ fim: { ...baseData().fim, options: [openaiCompat], selectedId: 'openai-compat' } });
    renderPanel(data);
    expect(screen.queryByText(/Install locally, or connect to an existing endpoint\?/)).not.toBeInTheDocument();
  });

  it('renders the two-mode question for llamacpp and vllm too (local-capable)', () => {
    for (const id of ['llamacpp', 'vllm']) {
      const option = ollamaOption({ id, displayName: id, nextEditTransport: 'openai-compat' });
      const { unmount } = renderPanel(baseData({ fim: { ...baseData().fim, options: [option], selectedId: id } }));
      expect(screen.getByText(/Install locally, or connect to an existing endpoint\?/)).toBeInTheDocument();
      unmount();
    }
  });
});

describe('FIM card — api-key flow (§6 card 3, D6)', () => {
  it('shows "key set ✓" when apiKeySet is true, and never renders a password field', () => {
    const withKey = codestralOption({ remote: { ...must(codestralOption().remote), apiKeySet: true } });
    const data = baseData({ fim: { ...baseData().fim, options: [withKey], selectedId: 'codestral' } });
    renderPanel(data);
    expect(screen.getByText('key set ✓')).toBeInTheDocument();
    // D6/§8: the raw key never lives in the webview DOM or state.
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('clicking [Set API key…] dispatches setup.setApiKey with no key value', async () => {
    const data = baseData({ fim: { ...baseData().fim, options: [codestralOption()], selectedId: 'codestral' } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set API key…' }));
    // The webview NEVER carries a key value — the host shows its own native
    // password box. Only the method name crosses the wire, never a params
    // object with anything key-shaped in it.
    expect(dispatch).toHaveBeenCalledWith('setup.setApiKey');
    // No call anywhere ever carries a plausible key string.
    for (const call of dispatch.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/sk-|api[-_]?key.{0,3}[:=].{4,}/i);
    }
  });
});

describe('FIM card — pull progress renders a percent (§6)', () => {
  it('shows a computed percent from setup.progress bytes (legacy tag-keyed pull via the configured-model row, T11)', async () => {
    // beta.6 T11: the Install tab no longer consumes `localInstall.models` —
    // with no catalog on the wire, `fim.model` (∉ empty catalog) renders the
    // CC-8 configured-model row, whose pull stays TAG-keyed (`pull:<model>`,
    // the legacy `handlePullModel` latch) — the same progress key beta.5 used.
    const data = baseData({
      fim: { ...baseData().fim, options: [ollamaOption()], selectedId: 'ollama' },
      // Empty daemon list ⇒ the configured model is honestly 'not present',
      // so the row shows its Pull affordance + the in-flight bar.
      ollama: { running: true, endpoint: 'http://127.0.0.1:11434', models: [] },
    });
    const progress = {
      'pull:qwen2.5-coder:1.5b-base': {
        op: 'pull' as const,
        id: 'qwen2.5-coder:1.5b-base',
        logTail: [],
        totalBytes: 1000,
        completedBytes: 250,
      },
    };
    const { user } = renderPanel(data, { progress });
    // The percent lives under the "Install locally" tab.
    await user.click(screen.getByRole('button', { name: 'Install locally' }));
    expect(screen.getByText('25%')).toBeInTheDocument();
  });
});

describe('NEXT card — info panel + dedicated setup button (§6 card 4)', () => {
  it('renders the frozen row copy and the [Set up dedicated NEXT] button when not configured', () => {
    renderPanel(baseData({ nextEdit: { ...baseData().nextEdit, dedicatedConfigured: false } }));
    for (const row of NEXT_EDIT_ROWS) {
      expect(screen.getByText(row.label)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Set up dedicated NEXT' })).toBeInTheDocument();
  });

  it('flips the button label to [Edit dedicated NEXT] once dedicatedConfigured is true', () => {
    renderPanel(baseData({ nextEdit: { ...baseData().nextEdit, dedicatedConfigured: true } }));
    expect(screen.getByRole('button', { name: 'Edit dedicated NEXT' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up dedicated NEXT' })).not.toBeInTheDocument();
  });

  it('opening the dedicated form and applying it dispatches setup.setNextEdit', async () => {
    const data = baseData({
      fim: { ...baseData().fim, options: [ollamaOption()], selectedId: 'ollama' },
      nextEdit: { ...baseData().nextEdit, dedicatedConfigured: false, endpoint: '', model: '' },
    });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    // Scoped to the NEXT card: the FIM card above also has its own
    // (unrelated) "Apply" button for `setup.applyFim`.
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'Apply' }));
    expect(dispatch).toHaveBeenCalledWith(
      'setup.setNextEdit',
      expect.objectContaining({ backend: 'ollama' }),
    );
  });
});

describe('RAG card — renders precondition text (§6 card 5)', () => {
  it('shows the preconditionDetail text when the codebase index is blocked', () => {
    const data = baseData({
      rag: { ...baseData().rag, preconditionDetail: 'The codebase index needs a trusted, open workspace.' },
    });
    renderPanel(data);
    expect(screen.getByText('The codebase index needs a trusted, open workspace.')).toBeInTheDocument();
  });

  it('renders nothing precondition-ish when unset', () => {
    renderPanel(baseData({ rag: { ...baseData().rag, preconditionDetail: undefined } }));
    expect(screen.queryByText(/needs a trusted/)).not.toBeInTheDocument();
  });
});

describe('!trusted disables every mutating button with an explanatory reason (§6, D9 FM-14)', () => {
  it('the Agent card\'s [Install Hermes] is disabled + aria-disabled + carries the reason as a tooltip', () => {
    const data = baseData({ trusted: false, agent: { ...baseData().agent, phase: 'missing' } });
    renderPanel(data);
    const button = screen.getByRole('button', { name: 'Install Hermes' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.getAttribute('title')).toMatch(/not trusted/i);
  });

  it('clicking a trust-gated button produces NO request', async () => {
    const data = baseData({ trusted: false, agent: { ...baseData().agent, phase: 'missing' } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Install Hermes' }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('read-only re-check style actions stay usable while untrusted (status page stays honest, §8)', () => {
    const data = baseData({ trusted: false, agent: { ...baseData().agent, phase: 'ready' } });
    renderPanel(data);
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeEnabled();
  });

  it('shows the Restricted Mode banner naming the reason in TEXT, not color alone', () => {
    renderPanel(baseData({ trusted: false }));
    expect(screen.getByText(/Setup changes are disabled in Restricted Mode/)).toBeInTheDocument();
  });
});

describe('"You\'re ready" banner (§6)', () => {
  it('renders when agent + provider + fim are all green', () => {
    renderPanel(baseData({ ready: true }));
    expect(screen.getByText(/You.re ready/)).toBeInTheDocument();
  });

  it('does not render when not ready', () => {
    renderPanel(baseData({ ready: false }));
    expect(screen.queryByText(/You.re ready/)).not.toBeInTheDocument();
  });
});

describe('Agent card — awaiting-reload gap-state (T11 IMPORTANT host-gap 1)', () => {
  it('renders a persistent [Reload window] button, not the old dead-end [Re-check]', () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'awaiting-reload' } });
    renderPanel(data);
    expect(screen.getByRole('button', { name: 'Reload window' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-check' })).not.toBeInTheDocument();
  });

  it('clicking [Reload window] dispatches setup.reload', async () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'awaiting-reload' } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Reload window' }));
    expect(dispatch).toHaveBeenCalledWith('setup.reload');
  });

  it('is trust-gated: disabled + aria-disabled + reason tooltip when untrusted', () => {
    const data = baseData({ trusted: false, agent: { ...baseData().agent, phase: 'awaiting-reload' } });
    renderPanel(data);
    const button = screen.getByRole('button', { name: 'Reload window' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.getAttribute('title')).toBe(TRUST_DISABLED_REASON);
  });
});

describe('Agent card — pipx-missing gap-state (T10, §6/§1.2): known distro', () => {
  // A NON-Fedora fixture command deliberately (any distro-specific
  // package-manager literal in webview SOURCE is banned — see the host-side
  // scan test) — the button must render whatever the host sends, verbatim,
  // never a guess.
  const bootstrap = {
    command: 'sudo apt-get update && sudo apt-get install pipx',
    guidance: 'pipx was not found on your PATH. Open a terminal to install it, then re-check.',
  };

  it('renders the host-composed bootstrap-terminal button + [Re-check], not a dead-end', () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing', bootstrap } });
    renderPanel(data);
    expect(screen.getByText(bootstrap.guidance)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Open terminal: ${bootstrap.command}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
  });

  it('clicking the bootstrap-terminal button dispatches setup.openBootstrapTerminal', async () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing', bootstrap } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: `Open terminal: ${bootstrap.command}` }));
    expect(dispatch).toHaveBeenCalledWith('setup.openBootstrapTerminal');
  });

  it('clicking [Re-check] dispatches setup.recheck', async () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing', bootstrap } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck');
  });

  it('the bootstrap-terminal button is trust-gated; [Re-check] stays usable (read-only, §8)', () => {
    const data = baseData({ trusted: false, agent: { ...baseData().agent, phase: 'pipx-missing', bootstrap } });
    renderPanel(data);
    const terminalButton = screen.getByRole('button', { name: `Open terminal: ${bootstrap.command}` });
    expect(terminalButton).toBeDisabled();
    expect(terminalButton.getAttribute('title')).toBe(TRUST_DISABLED_REASON);
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeEnabled();
  });
});

describe('Agent card — pipx-missing gap-state (T10, §6): unknown distro — no dead-end', () => {
  const unknownBootstrap = {
    guidance:
      "pipx was not found, and this Linux distribution wasn't recognized — install pipx with your system's package manager, then re-check.",
  };

  it('renders the guidance text + docs link, NO terminal button', () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing', bootstrap: unknownBootstrap } });
    renderPanel(data);
    expect(screen.getByText(unknownBootstrap.guidance)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open terminal:/ })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /pipx install/i });
    expect(link).toHaveAttribute('href', PIPX_INSTALL_DOCS_URL);
  });

  it('[Re-check] still works — never a dead-end', async () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing', bootstrap: unknownBootstrap } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck');
  });
});

describe('Agent card — python-unsuitable (T10, §6): command branch OR guidance branch, Re-check in BOTH', () => {
  it('command plan: renders {agent.detail} + [Open terminal: {command}] + [Re-check]', async () => {
    const data = baseData({
      agent: {
        ...baseData().agent,
        phase: 'python-unsuitable',
        detail: 'Found Python 3.14; Hermes needs 3.11-3.13.',
        pythonInstall: {
          kind: 'command',
          command: 'sudo apt-get install python3.11 python3.11-venv',
          sourceNote: "Debian/Ubuntu's own official archive.",
          docsUrl: 'https://packages.debian.org/search?keywords=python3.11',
        },
      },
    });
    const { user, dispatch } = renderPanel(data);
    expect(screen.getByText('Found Python 3.14; Hermes needs 3.11-3.13.')).toBeInTheDocument();
    const button = screen.getByRole('button', {
      name: 'Open terminal: sudo apt-get install python3.11 python3.11-venv',
    });
    expect(button).toBeInTheDocument();
    await user.click(button);
    expect(dispatch).toHaveBeenCalledWith('setup.openBootstrapTerminal', { target: 'python' });
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck');
  });

  it('command plan: the terminal button is trust-gated; [Re-check] stays usable', () => {
    const data = baseData({
      trusted: false,
      agent: {
        ...baseData().agent,
        phase: 'python-unsuitable',
        pythonInstall: {
          kind: 'command',
          command: 'sudo apt-get install python3.11',
          sourceNote: 'source',
          docsUrl: 'https://example.test',
        },
      },
    });
    renderPanel(data);
    const button = screen.getByRole('button', { name: 'Open terminal: sudo apt-get install python3.11' });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toBe(TRUST_DISABLED_REASON);
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeEnabled();
  });

  it('guidance plan: renders the §6 guidance text + docs link + [Re-check], NO terminal button — never a dead-end', async () => {
    const guidanceText =
      "Hermes needs Python 3.11–3.13, and your system's own package archive doesn't carry one in range. Install a supported Python yourself (see your distro's documentation or python.org), then press Re-check — Talaria will find it automatically.";
    const data = baseData({
      agent: {
        ...baseData().agent,
        phase: 'python-unsuitable',
        pythonInstall: { kind: 'guidance', text: guidanceText, docsUrl: 'https://www.python.org/downloads/' },
      },
    });
    const { user, dispatch } = renderPanel(data);
    expect(screen.getByText(guidanceText)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open terminal:/ })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /python/i });
    expect(link).toHaveAttribute('href', 'https://www.python.org/downloads/');
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck');
  });

  it('falls back to PYTHON_VERSION_HELP_URL when no pythonInstall plan is present at all (defensive)', () => {
    const data = baseData({
      agent: { ...baseData().agent, phase: 'python-unsuitable', detail: 'found 3.14; needs 3.11-3.13' },
    });
    renderPanel(data);
    const link = screen.getByRole('link', { name: /python/i });
    expect(link).toHaveAttribute('href', PYTHON_VERSION_HELP_URL);
  });
});

describe('container-note banner (§1.2, T10)', () => {
  const CONTAINER_NOTE =
    "Talaria can't tell which system your terminal acts on (VS Code appears to run in a sandbox/container) — run the install commands in a terminal on your host system, then re-check.";

  it('renders the banner text when os.containerNote is present', () => {
    renderPanel(baseData({ os: { family: 'unknown', manager: 'unknown', containerNote: CONTAINER_NOTE } }));
    expect(screen.getByText(CONTAINER_NOTE)).toBeInTheDocument();
  });

  it('renders nothing when os is absent', () => {
    renderPanel(baseData({ os: undefined }));
    expect(screen.queryByText(/can't tell which system/)).not.toBeInTheDocument();
  });

  it('renders nothing when os is present but containerNote is unset (known distro)', () => {
    renderPanel(baseData({ os: { family: 'debian', manager: 'apt-get', prettyName: 'Debian GNU/Linux 12' } }));
    expect(screen.queryByText(/can't tell which system/)).not.toBeInTheDocument();
  });
});

describe('B5 "done / what next" one-line status under each card (§6, T10)', () => {
  it('Agent card shows the done line once ready', () => {
    renderPanel(baseData({ agent: { ...baseData().agent, phase: 'ready' } }));
    expect(screen.getByText('✓ Hermes is ready. Next: configure a chat provider below.')).toBeInTheDocument();
  });

  it('Provider card shows the done line once configured', () => {
    renderPanel(baseData({ provider: { phase: 'configured', providerId: 'anthropic' } }));
    expect(screen.getByText('✓ Provider connected — chat is ready to use.')).toBeInTheDocument();
  });

  it('FIM card shows the done line once green', () => {
    renderPanel(baseData({ fim: { ...baseData().fim, enabled: true } }));
    expect(screen.getByText('✓ Autocomplete is active — open a file and start typing.')).toBeInTheDocument();
  });

  it('NEXT card shows the dedicated-on done line', () => {
    renderPanel(baseData({ nextEdit: { ...baseData().nextEdit, source: 'dedicated' } }));
    expect(screen.getByText('✓ Next-edit suggestions are on (dedicated Sweep model).')).toBeInTheDocument();
  });

  it('NEXT card shows the generic-on done line', () => {
    renderPanel(baseData({ nextEdit: { ...baseData().nextEdit, source: 'generic' } }));
    expect(screen.getByText('✓ Next-edit suggestions are on (reusing your FIM model).')).toBeInTheDocument();
  });

  it('RAG card shows the done line once green (T14: green = endpoint-scoped presence, never the deprecated wire boolean)', () => {
    // The daemon at the CONFIGURED embed endpoint genuinely lists the model —
    // the wire's `embedModelPresent` stays FALSE to prove it is ignored.
    renderPanel(
      baseData({
        rag: { ...baseData().rag, enabled: true },
        ollama: { ...baseData().ollama, models: [...baseData().ollama.models, { name: 'nomic-embed-text', sizeBytes: 1 }] },
      }),
    );
    expect(screen.getByText('✓ Codebase index is ready — the agent can search your project.')).toBeInTheDocument();
  });

  it('renders no done line when a card is not done (icon+text is conditional, never a lingering lie)', () => {
    renderPanel(baseData({ provider: { phase: 'unconfigured' } }));
    expect(screen.queryByText(/Provider connected/)).not.toBeInTheDocument();
  });
});

describe('FimInstallTab — non-Ollama gets an honest Test affordance (⑨⑩, §2.6)', () => {
  async function openInstallTab(option: SetupBackendOption) {
    const data = baseData({ fim: { ...baseData().fim, options: [option], selectedId: option.id } });
    const utils = renderPanel(data);
    await utils.user.click(screen.getByRole('button', { name: 'Install locally' }));
    return utils;
  }

  it('llama.cpp (T11: the block\'s §4.1 states replace the old "no install detection" prose): missing ⇒ [Open terminal: {command}] + [Re-check] + [Test connection ({endpoint})]', async () => {
    // llama.cpp HAS install detection since beta.6 (`llamacppRuntime` probe) —
    // the beta.5 "has no install detection" line is retired for this pane; the
    // missing-branch renders the CC-4 host-projected install command instead.
    const data = baseData({
      fim: { ...baseData().fim, options: [llamacppOption()], selectedId: 'llamacpp' },
      llamacppRuntime: {
        binary: 'missing',
        install: { command: 'sudo pkgmgr install llama-cpp', guidance: 'Install via the detected package manager.', docsUrl: 'https://example.test/llamacpp' },
      },
    });
    const utils = renderPanel(data);
    await utils.user.click(screen.getByRole('button', { name: 'Install locally' }));
    const fimCard = must(screen.getByText('Autocomplete (FIM)').closest('section'));
    expect(within(fimCard).getByText('llama-server was not found on your PATH. Install llama.cpp, then re-check.')).toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: 'Open terminal: sudo pkgmgr install llama-cpp' })).toBeEnabled();
    // Scoped within the card — the Agent card's own ready-state [Re-check] is a different button.
    expect(within(fimCard).getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:8012)' })).toBeInTheDocument();
  });

  it('clicking [Test connection] dispatches setup.testRemote with the resolved backendId + endpoint', async () => {
    const { user, dispatch } = await openInstallTab(llamacppOption());
    await user.click(screen.getByRole('button', { name: 'Test connection (http://127.0.0.1:8012)' }));
    expect(dispatch).toHaveBeenCalledWith('setup.testRemote', {
      backendId: 'llamacpp',
      endpoint: 'http://127.0.0.1:8012',
    });
  });

  it('vLLM (docs-only, R-1b): the [Open terminal:] button is ABSENT; the §6 vLLM copy + docs link render; Test still renders', async () => {
    await openInstallTab(vllmOption());
    expect(screen.queryByRole('button', { name: /^Open terminal:/ })).not.toBeInTheDocument();
    expect(
      screen.getByText("vLLM's install depends on your GPU/CUDA setup — follow the official guide, then test the connection."),
    ).toBeInTheDocument();
    const docsLink = screen.getByRole('link', { name: 'Setup docs' });
    expect(docsLink).toHaveAttribute('href', 'https://docs.vllm.ai/');
    expect(screen.getByRole('button', { name: 'Test connection (http://127.0.0.1:8000)' })).toBeInTheDocument();
  });

  it('R-2: this option IS the selected/configured backend — the label shows its OWN saved endpoint', async () => {
    const option = llamacppOption({
      remote: { ...must(llamacppOption().remote), endpointValue: 'http://127.0.0.1:9999' },
    });
    await openInstallTab(option);
    expect(screen.getByRole('button', { name: 'Test connection (http://127.0.0.1:9999)' })).toBeInTheDocument();
  });

  it("R-2: browsing a DIFFERENT backend's Install tab never tests the ACTIVE backend's saved endpoint under this backend's label", async () => {
    // `talaria.autocomplete.endpoint` is ONE setting — every FIM option
    // echoes the SAME saved value on the wire. `ollama` is the ACTUALLY
    // configured backend (`fim.selectedId`); the user merely BROWSES vLLM's
    // card without having selected it.
    const sharedSavedValue = 'http://127.0.0.1:11434'; // Ollama's endpoint
    const ollama = ollamaOption({ remote: { ...must(ollamaOption().remote), endpointValue: sharedSavedValue } });
    const vllm = vllmOption({ remote: { ...must(vllmOption().remote), endpointValue: sharedSavedValue } });
    const data = baseData({ fim: { ...baseData().fim, options: [ollama, vllm], selectedId: 'ollama' } });
    const { user } = renderPanel(data);

    await user.click(screen.getByRole('button', { name: 'vLLM' }));
    await user.click(screen.getByRole('button', { name: 'Install locally' }));

    // vLLM's OWN default, never Ollama's foreign saved value. (The RAG
    // card, unrelated, legitimately shows that same address elsewhere on
    // the page — its own embed endpoint default — so this scopes to the
    // FIM card rather than asserting over the whole screen.)
    const fimCard = must(screen.getByText('Autocomplete (FIM)').closest('section'));
    expect(within(fimCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:8000)' })).toBeInTheDocument();
    expect(within(fimCard).queryByText(/127\.0\.0\.1:11434/)).not.toBeInTheDocument();
  });
});

describe('Agent card — error state [Copy log] button (T11 §6-parity minor)', () => {
  it('copies the detail + log tail to the clipboard', async () => {
    const data = baseData({
      agent: {
        ...baseData().agent,
        phase: 'error',
        detail: 'pipx-install failed: network unreachable',
        logTail: ['Resolving...', 'Connection timed out'],
      },
    });
    const { user } = renderPanel(data);
    // `renderPanel` calls `userEvent.setup()` internally, which installs ITS
    // OWN clipboard stub onto `navigator.clipboard` (so it can simulate
    // real copy/paste) — spying on THAT object's `writeText`, rather than
    // replacing `navigator.clipboard` beforehand, is what survives: an
    // earlier replacement gets silently clobbered the moment `setup()` runs.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Copy log' }));
    expect(writeText).toHaveBeenCalledWith(
      'pipx-install failed: network unreachable\nResolving...\nConnection timed out',
    );
  });
});

describe('NEXT card — DedicatedNextForm [Test] button (T11 §6-parity minor)', () => {
  it('dispatches setup.testRemote with the selected backend + endpoint, reusing the Connect tab\'s method', async () => {
    const data = baseData({
      fim: { ...baseData().fim, options: [ollamaOption()], selectedId: 'ollama' },
      nextEdit: { ...baseData().nextEdit, dedicatedConfigured: false, endpoint: 'http://127.0.0.1:11434', model: '' },
    });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'Test' }));
    expect(dispatch).toHaveBeenCalledWith(
      'setup.testRemote',
      expect.objectContaining({ backendId: 'ollama', endpoint: 'http://127.0.0.1:11434' }),
    );
  });
});

/*
 * T15 (beta.5 §4.2/§4.3/§6): presence tri-state, the fail-closed Download
 * button, guided lines, and the card-level warning.
 */

describe('NEXT card — card-level warning (§4.3 D4, critic C-14)', () => {
  it('shows the warning at CARD level when the dedicated toggle is ON, even with the form CLOSED', () => {
    renderPanel(baseData(), { nextEdit: { next: true, generic: false } });
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    expect(within(nextCard).getByText(baseData().nextEdit.dedicated!.warning)).toBeInTheDocument();
    expect(within(nextCard).queryByRole('textbox', { name: 'Endpoint' })).not.toBeInTheDocument();
  });

  it('shows the warning when the form is OPEN even if the dedicated toggle is off', async () => {
    const { user } = renderPanel(baseData(), { nextEdit: { next: false, generic: true } });
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    expect(within(nextCard).getByText(baseData().nextEdit.dedicated!.warning)).toBeInTheDocument();
  });

  it('renders NOTHING when the toggle is off AND the form is closed', () => {
    renderPanel(baseData(), { nextEdit: { next: false, generic: true } });
    expect(screen.queryByText(baseData().nextEdit.dedicated!.warning)).not.toBeInTheDocument();
  });
});

describe('NEXT card — Ollama presence + fail-closed Download button (§4.3 D2)', () => {
  // T13 (§2.5/T7-M2): the ONE entry point for the pinned artifact is
  // `setup.provisionModel` keyed `pull:sweep-next` — the legacy
  // `setup.pullModel` route latches a DIFFERENT key (`pull:<tag>`), so
  // surfacing both for the same artifact would defeat the single-flight
  // latch (a possible duplicate 4.7 GB download). One entry, one key.
  it('shows the Download button when downloadReady + ollama-picked + presence absent, and dispatches setup.provisionModel (id-keyed) — NEVER the legacy setup.pullModel route', async () => {
    const { user, dispatch } = renderPanel(baseData());
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    expect(within(nextCard).getByText('not present')).toBeInTheDocument();
    const button = within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' });
    await user.click(button);
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'sweep-next',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
    expect(dispatch).not.toHaveBeenCalledWith('setup.pullModel', expect.anything());
  });

  it('hides the Download button once the model is already present (green line instead)', async () => {
    const data = baseData({
      ollama: { ...baseData().ollama, models: [{ name: 'sweep-next-edit-v2-7b:q4_k_m', sizeBytes: 1 }] },
    });
    const { user } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    expect(within(nextCard).getByText('✓ Model present on this Ollama')).toBeInTheDocument();
    expect(within(nextCard).queryByRole('button', { name: 'Download model (~4.7 GB)' })).not.toBeInTheDocument();
  });

  it('recognizes a hand-pulled ollamaPullAlias model as present (rev 5 — not lied to)', async () => {
    const data = baseData({
      ollama: {
        ...baseData().ollama,
        models: [{ name: 'hf.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M', sizeBytes: 1 }],
      },
    });
    const { user } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    expect(within(nextCard).getByText('✓ Model present on this Ollama')).toBeInTheDocument();
  });

  it('presence is unknown when the typed endpoint does not match the endpoint status() probed (C-6/S-F11)', async () => {
    const { user } = renderPanel(baseData());
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    const endpointField = within(nextCard).getByRole('textbox', { name: 'Endpoint' });
    await user.clear(endpointField);
    await user.type(endpointField, 'http://127.0.0.1:9999');
    expect(within(nextCard).getByText('not verified here — Test the endpoint first.')).toBeInTheDocument();
    // Still offered — an untested endpoint must not strand the user.
    expect(within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' })).toBeInTheDocument();
  });

  it('the Download button is trust-gated with the standard disabledReason (S-F14)', async () => {
    const { user } = renderPanel(baseData({ trusted: false }));
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    const button = within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/not trusted/i);
  });

  it('renders the post-download nudge on a successful pull (C-18) — Apply remains a separate, required action', async () => {
    const { user, dispatch } = renderPanel(baseData());
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' }));
    expect(await within(nextCard).findByText('✓ Downloaded — press Apply to start using it.')).toBeInTheDocument();
    expect(dispatch).not.toHaveBeenCalledWith('setup.setNextEdit', expect.anything());
  });
});

describe('NEXT card — R-3: ollama picked + modelDefaults.ollama empty (!downloadReady)', () => {
  function notReadyData(): SetupData {
    return baseData({
      fim: { ...baseData().fim, options: [ollamaOption()], selectedId: 'ollama' },
      nextEdit: {
        ...baseData().nextEdit,
        dedicatedConfigured: false,
        endpoint: '',
        model: '',
        dedicated: {
          ...baseData().nextEdit.dedicated!,
          downloadReady: false,
          modelDefaults: { ollama: '', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
          guided: { vllm: baseData().nextEdit.dedicated!.guided.vllm }, // no llamacpp key
        },
      },
    });
  }

  it('the Model field starts EMPTY and the §6 "no vetted build published yet" line renders in the prefill\'s place', async () => {
    const { user } = renderPanel(notReadyData());
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    const modelField = within(nextCard).getByRole('textbox', { name: 'Model' }) as HTMLInputElement;
    expect(modelField.value).toBe('');
    expect(
      within(nextCard).getByText(
        "No vetted build of this model is published yet — it can't be downloaded automatically. Use the guided instructions below, or the vLLM path (official release).",
      ),
    ).toBeInTheDocument();
    expect(within(nextCard).queryByRole('button', { name: 'Download model (~4.7 GB)' })).not.toBeInTheDocument();
  });

  it("Apply with the empty field surfaces the controller's 'model is required' refusal via the unwrap", async () => {
    const { user, dispatch } = renderPanel(notReadyData());
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    dispatch.mockRejectedValueOnce(new Error('model is required.'));
    await user.click(within(nextCard).getByRole('button', { name: 'Apply' }));
    expect(await within(nextCard).findByText('✗ model is required.')).toBeInTheDocument();
  });
});

describe('NEXT card — the llama.cpp -hf guided line is RETIRED from that pane (beta.6 T13, §3.3)', () => {
  // The beta.5 `-hf` self-download line asked the user to fetch the artifact
  // OUTSIDE Talaria's verify chain; §3.3 replaces it with the block's
  // verified Download. The digest-verify hint (S-F5) is RETAINED — it now
  // rides the downloaded row's run-command caption (see the T13 pinned-cell
  // suite below). The vLLM guided line is UNCHANGED (§3.3) and keeps the
  // final-fixwave Fix-4 hover-title lock.
  it('no -hf line renders even when downloadReady — the verified Download stands in its place', async () => {
    const data = baseData({
      fim: {
        ...baseData().fim,
        options: [ollamaOption(), llamacppOption({ nextEditTransport: 'openai-compat' })],
        selectedId: 'llamacpp',
      },
      llamacppRuntime: { binary: 'found', version: 'b4500' },
    });
    const { user } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(nextCard).queryByText(/llama-server -hf/)).not.toBeInTheDocument();
    expect(within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' })).toBeEnabled();
  });

  it('the truncated guided-command span carries a title attribute with the full command, for hover reveal (final-fixwave Fix 4 — now locked on the surviving vLLM guided line)', async () => {
    const data = baseData({
      fim: {
        ...baseData().fim,
        options: [ollamaOption(), vllmOption({ nextEditTransport: 'openai-compat' })],
        selectedId: 'vllm',
      },
    });
    const { user } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'vLLM' }));
    const commandLine = 'Run: vllm serve sweepai/sweep-next-edit-v2-7B';
    expect(within(nextCard).getByText(commandLine)).toHaveAttribute('title', commandLine);
  });

  it('copy-to-clipboard copies the command fragment only (not the caption), stripped of the "Run: " display caption (final-fixwave Fix 3)', async () => {
    const data = baseData({
      fim: {
        ...baseData().fim,
        options: [ollamaOption(), vllmOption({ nextEditTransport: 'openai-compat' })],
        selectedId: 'vllm',
      },
    });
    const { user } = renderPanel(data);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'vLLM' }));
    // The displayed line still carries the "Run: " caption — only the
    // CLIPBOARD payload is stripped, so the pasted shell line is runnable.
    expect(within(nextCard).getByText('Run: vllm serve sweepai/sweep-next-edit-v2-7B')).toBeInTheDocument();
    await user.click(within(nextCard).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('vllm serve sweepai/sweep-next-edit-v2-7B');
  });
});

describe('RAG card — "Enable codebase index" toggle trust-gating parity (T11 §6-parity minor)', () => {
  it('carries aria-disabled + the trust reason as a title when untrusted', () => {
    renderPanel(baseData({ trusted: false }));
    const toggle = screen.getByRole('switch', { name: 'Enable codebase index' });
    const row = must(toggle.closest('[aria-disabled]'));
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(toggle.getAttribute('title')).toBe(TRUST_DISABLED_REASON);
  });

  it('carries no aria-disabled / title when trusted', () => {
    renderPanel(baseData({ trusted: true }));
    const toggle = screen.getByRole('switch', { name: 'Enable codebase index' });
    expect(toggle).not.toHaveAttribute('title');
    expect(toggle.closest('[aria-disabled]')).toBeNull();
  });
});

describe('RemoteData gate — loading/error render honestly (Part X2 convention)', () => {
  it('shows the loading hint while idle/loading', () => {
    setup(
      <SetupPanel
        data={{ status: 'loading' }}
        onRetry={noopRetry}
        progress={{}}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={vi.fn()}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByText(/Loading setup status/)).toBeInTheDocument();
  });

  it('shows Error + Retry on a rejected fetch', async () => {
    const onRetry = vi.fn();
    const { user } = setup(
      <SetupPanel
        data={{ status: 'error', error: { message: 'host unreachable', retryable: true } }}
        onRetry={onRetry}
        progress={{}}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={vi.fn()}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByText('host unreachable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalled();
  });
});

/*
 * T9 (§2.4 B4 — "Test (and friends) speak on success"): `ActionButton` gains
 * `successLabel?: string`. These tests exercise the mechanism through real
 * production call sites (never a bespoke test-only ActionButton instance) —
 * the FIM Connect tab's [Test]/[Apply] (both get a successLabel) and its
 * [Clear key] (deliberately does NOT, §2.4's "no successLabel ⇒ today's
 * behavior" clause).
 */
describe('ActionButton — success labels + the DECLINED lock (T9, §2.4)', () => {
  function fimSetupData(): SetupData {
    return baseData({ fim: { ...baseData().fim, options: [ollamaOption()], selectedId: 'ollama' } });
  }

  it('resolve + successLabel: announces "✓ Endpoint reachable" and auto-clears after 4s (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn().mockResolvedValue({ ok: true });
      render(
        <SetupPanel
          data={{ status: 'success', data: fimSetupData() }}
          onRetry={noopRetry}
          progress={{}}
          nextEdit={{ next: false, generic: true }}
          onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
          dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
        />,
      );
      const button = screen.getByRole('button', { name: 'Test' });

      await act(async () => {
        button.click();
        // Let the already-resolved `dispatch` promise's `.then` callback run
        // (and any React state-update microtask it schedules) before we assert.
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText('✓ Endpoint reachable')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByText('✓ Endpoint reachable')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolve + successLabel: unmounting WHILE the 4s auto-clear timer is still pending clears it (no leaked timer)', async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn().mockResolvedValue({ ok: true });
      const { unmount } = render(
        <SetupPanel
          data={{ status: 'success', data: fimSetupData() }}
          onRetry={noopRetry}
          progress={{}}
          nextEdit={{ next: false, generic: true }}
          onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
          dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
        />,
      );
      const button = screen.getByRole('button', { name: 'Test' });

      await act(async () => {
        button.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText('✓ Endpoint reachable')).toBeInTheDocument();
      // The auto-clear timer must still be pending here — this is the whole
      // point of the test. Advancing anywhere near the full 4000ms first
      // would let the timer self-consume before `unmount()` runs, which
      // would make the `getTimerCount()` assertion below pass trivially even
      // for a version of the effect with NO cleanup at all.
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two resolves in succession do not stack auto-clear timers: timer count stays at 1, never 2', async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn().mockResolvedValue({ ok: true });
      render(
        <SetupPanel
          data={{ status: 'success', data: fimSetupData() }}
          onRetry={noopRetry}
          progress={{}}
          nextEdit={{ next: false, generic: true }}
          onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
          dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
        />,
      );
      const button = screen.getByRole('button', { name: 'Test' });

      await act(async () => {
        button.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText('✓ Endpoint reachable')).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(1);

      // Click again WHILE the first timer is still pending (well inside the
      // 4s window) — a fresh success re-arms the timer, it does not stack a
      // second one alongside the first.
      await act(async () => {
        button.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText('✓ Endpoint reachable')).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reject: renders the ✗-prefixed failure line, not the success label', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('endpoint unreachable'));
    const { user } = setup(
      <SetupPanel
        data={{ status: 'success', data: fimSetupData() }}
        onRetry={noopRetry}
        progress={{}}
        nextEdit={{ next: false, generic: true }}
        onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
        dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('✗ endpoint unreachable')).toBeInTheDocument();
    expect(screen.queryByText('✓ Applied')).not.toBeInTheDocument();
  });

  it('focus stays on the button after a successful resolve (no remount, no layout-shifting swap)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });
    const { user } = setup(
      <SetupPanel
        data={{ status: 'success', data: fimSetupData() }}
        onRetry={noopRetry}
        progress={{}}
        nextEdit={{ next: false, generic: true }}
        onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
        dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
      />,
    );
    const button = screen.getByRole('button', { name: 'Test' });
    await user.click(button);
    expect(await screen.findByText('✓ Endpoint reachable')).toBeInTheDocument();
    expect(document.activeElement).toBe(button);
  });

  it('resolve with the DECLINED sentinel renders NEITHER success nor failure (the C-2 lock)', async () => {
    const dispatch = vi.fn().mockResolvedValue(DECLINED);
    const { user } = setup(
      <SetupPanel
        data={{ status: 'success', data: fimSetupData() }}
        onRetry={noopRetry}
        progress={{}}
        nextEdit={{ next: false, generic: true }}
        onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
        dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
      />,
    );
    const button = screen.getByRole('button', { name: 'Apply' });
    await user.click(button);

    // Back to idle (not stuck on "Working…") once the resolution settles.
    await waitFor(() => expect(button).toHaveTextContent('Apply'));
    expect(screen.queryByText('✓ Applied')).not.toBeInTheDocument();
    expect(screen.queryByText(/^✗/)).not.toBeInTheDocument();
  });

  it('no successLabel ⇒ resolve announces nothing (Clear key deliberately carries none)', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const withKey = codestralOption({ remote: { ...must(codestralOption().remote), apiKeySet: true } });
    const data = baseData({ fim: { ...baseData().fim, options: [withKey], selectedId: 'codestral' } });
    const { user } = setup(
      <SetupPanel
        data={{ status: 'success', data }}
        onRetry={noopRetry}
        progress={{}}
        nextEdit={{ next: false, generic: true }}
        onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
        dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
      />,
    );
    const button = screen.getByRole('button', { name: 'Clear key' });
    await user.click(button);

    await waitFor(() => expect(button).toHaveTextContent('Clear key'));
    // Scoped to THIS button's own live region: the page can legitimately
    // carry OTHER "✓ …" text now (the B5 done-lines, T10) — this assertion
    // is about what [Clear key] itself announced, not the whole screen.
    const container = must(button.parentElement);
    expect(within(container).queryByText(/^✓/)).not.toBeInTheDocument();
    expect(within(container).queryByText(/^✗/)).not.toBeInTheDocument();
  });

  it('pending is unaffected by the success mechanism: shows "Working…" and announces nothing while in flight', async () => {
    let resolveDispatch!: (v: unknown) => void;
    const dispatch = vi.fn(() => new Promise((resolve) => { resolveDispatch = resolve; }));
    const { user } = setup(
      <SetupPanel
        data={{ status: 'success', data: fimSetupData() }}
        onRetry={noopRetry}
        progress={{}}
        nextEdit={{ next: false, generic: true }}
        onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
        dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
      />,
    );
    const button = screen.getByRole('button', { name: 'Test' });
    await user.click(button);

    expect(screen.getByRole('button', { name: 'Working…' })).toBeInTheDocument();
    expect(screen.queryByText('✓ Endpoint reachable')).not.toBeInTheDocument();
    expect(screen.queryByText(/^✗/)).not.toBeInTheDocument();

    // Settle so no unresolved promise / act warning leaks into later tests.
    resolveDispatch({ ok: true });
    await screen.findByText('✓ Endpoint reachable');
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T11 (§3.2): the FIM Install tab IS the shared LocalModelBlock.
 * The card's existing 5-option picker is the block's ① (ONE picker);
 * catalog fim-rows render per pane; the Ollama running branch gains the
 * §0.3 Re-check; the CC-8 configured-model row keeps the legacy
 * free-text `setup.pullModel` tier alive.
 * ------------------------------------------------------------------ */

function fimCatalogRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'qwen25-coder-1.5b',
    role: 'fim',
    displayName: 'Qwen2.5-Coder 1.5B (base)',
    publisher: 'Qwen',
    license: 'apache-2.0',
    defaultForRole: true,
    vramLine: 'any modern GPU (~1–2 GB)',
    note: 'Base build (Q8) from ggml-org — the llama.cpp project’s own packaging of Qwen’s base model.',
    progressId: 'qwen25-coder-1.5b',
    ollamaTag: 'qwen2.5-coder:1.5b-base',
    ollamaApproxBytes: 986_000_000,
    llamacpp: { file: 'qwen2.5-coder-1.5b-q8_0.gguf', approxBytes: 1_646_573_056, present: false, available: true },
    ...overrides,
  };
}

/** rev 3: THREE fim rows (1.5b ★ / 7b / 14b), all with llama.cpp cells (no
 *  absence cells on this surface) — plus one agent-role row to prove the
 *  role filter. */
function fimCatalog(): SetupCatalogModel[] {
  return [
    fimCatalogRow(),
    fimCatalogRow({
      id: 'qwen25-coder-7b',
      displayName: 'Qwen2.5-Coder 7B (base)',
      defaultForRole: undefined,
      vramLine: '~8 GB GPUs',
      ollamaTag: 'qwen2.5-coder:7b-base',
      ollamaApproxBytes: 4_700_000_000,
      llamacpp: { file: 'qwen2.5-coder-7b-q8_0.gguf', approxBytes: 8_100_000_000, present: false, available: true },
    }),
    fimCatalogRow({
      id: 'qwen25-coder-14b',
      displayName: 'Qwen2.5-Coder 14B (base)',
      defaultForRole: undefined,
      vramLine: 'Q8 wants a 24 GB card (the Ollama 14b-base tag is the Q4 build at 9.0 GB)',
      ollamaTag: 'qwen2.5-coder:14b-base',
      ollamaApproxBytes: 9_000_000_000,
      llamacpp: { file: 'qwen2.5-coder-14b-q8_0.gguf', approxBytes: 15_700_000_000, present: false, available: true },
    }),
    fimCatalogRow({
      id: 'devstral-24b',
      role: 'agent',
      displayName: 'Devstral-24B (2507)',
      defaultForRole: true,
      vramLine: '24 GB',
      ollamaTag: undefined,
      ollamaApproxBytes: 14_333_915_904,
      ollamaCreatedName: 'devstral-small-2507:24b',
      llamacpp: undefined,
      note: undefined,
    }),
  ];
}

function fimBlockData(overrides: Partial<SetupData> = {}): SetupData {
  return baseData({
    fim: { ...baseData().fim, options: [ollamaOption(), llamacppOption(), vllmOption()], selectedId: 'ollama' },
    // Empty daemon list by default so catalog rows are honestly 'not present'
    // (each test overrides as needed).
    ollama: { running: true, version: '0.4.1', endpoint: 'http://127.0.0.1:11434', models: [] },
    catalog: { models: fimCatalog() },
    llamacppRuntime: { binary: 'found', version: 'b4500' },
    ...overrides,
  });
}

async function openFimInstallTab(data: SetupData, pickerName?: string) {
  const utils = renderPanel(data);
  if (pickerName !== undefined) {
    await utils.user.click(screen.getByRole('button', { name: pickerName }));
  }
  await utils.user.click(screen.getByRole('button', { name: 'Install locally' }));
  const fimCard = must(screen.getByText('Autocomplete (FIM)').closest('section'));
  return { ...utils, fimCard };
}

describe('T11 — the card picker IS ① (one picker, never a second one inside the Install tab)', () => {
  it('renders exactly ONE selectable "Ollama" BACKEND row in the FIM card; catalog rows are MODEL selectors, not a second backend picker', async () => {
    const { fimCard } = await openFimInstallTab(fimBlockData());
    expect(within(fimCard).getAllByRole('button', { name: 'Ollama' })).toHaveLength(1);
    // beta.6 panel-fix PT4: catalog rows are now SELECTABLE (the pending-
    // model draft, §3.2) — a MODEL pick, named by the model's displayName,
    // never a second backend named 'Ollama'. T11's one-backend-picker rule
    // holds via the length assertion above.
    expect(within(fimCard).getByRole('button', { name: 'Qwen2.5-Coder 1.5B (base)' })).toHaveAttribute('aria-pressed');
  });
});

describe('T11 — Ollama running branch has Re-check (the §0.3 regression-lock)', () => {
  it('running branch: renders "Ollama: Ready ✓ — {version}" AND a [Re-check] button', async () => {
    const { fimCard } = await openFimInstallTab(fimBlockData());
    expect(within(fimCard).getByText('Ollama: Ready ✓ — 0.4.1')).toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
  });

  it('[Re-check] dispatches the SCOPED setup.recheck {scope:"ollama"}', async () => {
    const { fimCard, user, dispatch } = await openFimInstallTab(fimBlockData());
    await user.click(within(fimCard).getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck', { scope: 'ollama' });
  });

  it('not-running branch keeps install + Re-check (unchanged affordances)', async () => {
    const data = fimBlockData({ ollama: { running: false, models: [] } });
    const { fimCard } = await openFimInstallTab(data);
    expect(within(fimCard).getByText('Ollama daemon not detected.')).toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: 'Open terminal: install Ollama' })).toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
  });
});

describe('T11 — THREE catalog fim rows render (1.5b ★ / 7b / 14b), role-filtered', () => {
  it('renders all three fim rows with the Default chip on the 1.5b row only', async () => {
    const { fimCard } = await openFimInstallTab(fimBlockData());
    expect(within(fimCard).getByText('Qwen2.5-Coder 1.5B (base)')).toBeInTheDocument();
    expect(within(fimCard).getByText('Qwen2.5-Coder 7B (base)')).toBeInTheDocument();
    expect(within(fimCard).getByText('Qwen2.5-Coder 14B (base)')).toBeInTheDocument();
    expect(within(fimCard).getAllByText('Default')).toHaveLength(1);
  });

  it('the agent-role catalog row does NOT render on the FIM surface', async () => {
    const { fimCard } = await openFimInstallTab(fimBlockData());
    expect(within(fimCard).queryByText('Devstral-24B (2507)')).not.toBeInTheDocument();
  });

  it('present→skip: a row already on the daemon shows "present ✓" and no Pull; absent rows keep Pull {tag} (~{size})', async () => {
    const data = fimBlockData({
      ollama: { running: true, version: '0.4.1', endpoint: 'http://127.0.0.1:11434', models: [{ name: 'qwen2.5-coder:1.5b-base', sizeBytes: 1 }] },
    });
    const { fimCard } = await openFimInstallTab(data);
    expect(within(fimCard).getByText('present ✓')).toBeInTheDocument();
    expect(within(fimCard).queryByRole('button', { name: /Pull qwen2\.5-coder:1\.5b-base/ })).not.toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: 'Pull qwen2.5-coder:7b-base (~4.4 GB)' })).toBeEnabled();
    expect(within(fimCard).getByRole('button', { name: 'Pull qwen2.5-coder:14b-base (~8.4 GB)' })).toBeEnabled();
  });

  it('a catalog Pull dispatches setup.provisionModel keyed by catalog id, then flashes the §6 FIM post-pull nudge', async () => {
    const { fimCard, user, dispatch } = await openFimInstallTab(fimBlockData());
    await user.click(within(fimCard).getByRole('button', { name: 'Pull qwen2.5-coder:7b-base (~4.4 GB)' }));
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'qwen25-coder-7b',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
    expect(
      await within(fimCard).findByText('✓ Downloaded and selected — Apply on the Connect tab saves it as your autocomplete model.'),
    ).toBeInTheDocument();
  });
});

describe('T11 — the CC-8 configured-model row (legacy free-text tier preserved)', () => {
  it('renders when fim.model names something OUTSIDE the catalog, with a Pull wired to the legacy setup.pullModel', async () => {
    const data = fimBlockData({ fim: { ...fimBlockData().fim, model: 'deepseek-coder:6.7b-base' } });
    const { fimCard, user, dispatch } = await openFimInstallTab(data);
    expect(within(fimCard).getByText('deepseek-coder:6.7b-base')).toBeInTheDocument();
    expect(within(fimCard).getByText('Configured')).toBeInTheDocument();
    await user.click(within(fimCard).getByRole('button', { name: 'Pull deepseek-coder:6.7b-base' }));
    expect(dispatch).toHaveBeenCalledWith('setup.pullModel', {
      model: 'deepseek-coder:6.7b-base',
      endpoint: 'http://127.0.0.1:11434',
    });
  });

  it('does NOT render when fim.model IS a catalog row (:latest-tolerant)', async () => {
    const data = fimBlockData({ fim: { ...fimBlockData().fim, model: 'qwen2.5-coder:1.5b-base:latest' } });
    const { fimCard } = await openFimInstallTab(data);
    expect(within(fimCard).queryByText('Configured')).not.toBeInTheDocument();
  });

  it('does NOT render on the not-running branch (§3.2: it is a running-branch affordance)', async () => {
    const data = fimBlockData({
      fim: { ...fimBlockData().fim, model: 'deepseek-coder:6.7b-base' },
      ollama: { running: false, models: [] },
    });
    const { fimCard } = await openFimInstallTab(data);
    expect(within(fimCard).queryByText('Configured')).not.toBeInTheDocument();
  });
});

describe('T11 — Ollama pane surface-level Test (T10 Minor #4: the "Test the endpoint first" copy points here)', () => {
  it('renders [Test connection ({endpoint})] and dispatches setup.testRemote {backendId:"ollama"}', async () => {
    const { fimCard, user, dispatch } = await openFimInstallTab(fimBlockData());
    const test = within(fimCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:11434)' });
    await user.click(test);
    expect(dispatch).toHaveBeenCalledWith('setup.testRemote', {
      backendId: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
  });
});

describe('T11 — llama.cpp pane: three downloadable rows, base-build note, no absence cells, nudge on present', () => {
  it('ready runtime: renders "llama.cpp: Ready ✓ — b4500" + THREE enabled Download buttons + the §6 base-build note; never the honest-absence line', async () => {
    const { fimCard } = await openFimInstallTab(fimBlockData(), 'llama.cpp');
    expect(within(fimCard).getByText('llama.cpp: Ready ✓ — b4500')).toBeInTheDocument();
    const downloads = within(fimCard).getAllByRole('button', { name: /^Download / });
    expect(downloads).toHaveLength(3);
    for (const button of downloads) expect(button).toBeEnabled();
    expect(
      within(fimCard).getAllByText('Base build (Q8) from ggml-org — the llama.cpp project’s own packaging of Qwen’s base model.').length,
    ).toBeGreaterThan(0);
    expect(
      within(fimCard).queryByText('No build of this model from a verified publisher exists for llama.cpp — use it via Ollama instead.'),
    ).not.toBeInTheDocument();
  });

  it('a Download dispatches setup.provisionModel {backend:"llamacpp"} keyed by catalog id', async () => {
    const { fimCard, user, dispatch } = await openFimInstallTab(fimBlockData(), 'llama.cpp');
    await user.click(within(fimCard).getByRole('button', { name: 'Download Qwen2.5-Coder 1.5B (base) (~1.5 GB)' }));
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'qwen25-coder-1.5b',
      backend: 'llamacpp',
      endpoint: 'http://127.0.0.1:8012',
    });
  });

  it('on present: start command + [Copy] + the §6 "Then switch the Connect tab to llama.cpp and Apply." nudge', async () => {
    const models = fimCatalog();
    models[0] = fimCatalogRow({
      llamacpp: {
        file: 'qwen2.5-coder-1.5b-q8_0.gguf',
        approxBytes: 1_646_573_056,
        present: true,
        available: true,
        runCommand: 'llama-server -m /store/qwen2.5-coder-1.5b-q8_0.gguf --port 8080',
      },
    });
    const data = fimBlockData({ catalog: { models } });
    const { fimCard } = await openFimInstallTab(data, 'llama.cpp');
    expect(within(fimCard).getByText("present in Talaria's model folder ✓")).toBeInTheDocument();
    expect(within(fimCard).getByText('llama-server -m /store/qwen2.5-coder-1.5b-q8_0.gguf --port 8080')).toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(within(fimCard).getByText('Then switch the Connect tab to llama.cpp and Apply.')).toBeInTheDocument();
  });

  it('no row present ⇒ the nudge does not render (it explains a state that does not exist yet)', async () => {
    const { fimCard } = await openFimInstallTab(fimBlockData(), 'llama.cpp');
    expect(within(fimCard).queryByText('Then switch the Connect tab to llama.cpp and Apply.')).not.toBeInTheDocument();
  });
});

describe('T11 — vLLM pane: the ⑪ copy verbatim + run-command rows + docs + Test', () => {
  it('keeps the beta.5 ⑪ string, the Setup docs link, and adds the catalog row run commands', async () => {
    const models = fimCatalog().map((m) =>
      m.role === 'fim' ? { ...m, vllm: { runCommand: `vllm serve Qwen/${m.id}` } } : m,
    );
    const data = fimBlockData({ catalog: { models } });
    const { fimCard } = await openFimInstallTab(data, 'vLLM');
    expect(
      within(fimCard).getByText("vLLM's install depends on your GPU/CUDA setup — follow the official guide, then test the connection."),
    ).toBeInTheDocument();
    expect(within(fimCard).getByRole('link', { name: 'Setup docs' })).toHaveAttribute('href', 'https://docs.vllm.ai/');
    expect(within(fimCard).getByText('vllm serve Qwen/qwen25-coder-1.5b')).toBeInTheDocument();
    expect(within(fimCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:8000)' })).toBeInTheDocument();
    // vLLM never pulls/downloads anything.
    expect(within(fimCard).queryByRole('button', { name: /Pull|Download/ })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T12 (§3.1): the Agent card's "Configure Local Agent Model"
 * collapsible section — the block with role='agent', the 6-model picker
 * (ONE preselect rule, A-F8), the §3.1 captions (Devstral default +
 * `GGUF by {publisher}`, A-F7), endpoint init from `endpointDefaults`
 * (saved wins), Save/Change/Clear via `setup.saveAgentModel`, and the
 * host-composed `providerGuidance` line.
 * ------------------------------------------------------------------ */

const T12_MOE_NOTE = 'MoE ≠ smaller: a 35B MoE still needs ~20 GiB for weights — only compute is light (~3B active per token).';
const T12_MMPROJ_NOTE =
  'Vision input is optional — llama-server needs the separate mmproj file (not downloaded here); text works without it.';

function agentCatalogRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'devstral-24b',
    role: 'agent',
    defaultForRole: true,
    displayName: 'Devstral-24B (2507)',
    publisher: 'mistralai',
    license: 'Apache-2.0',
    vramLine: '24GB-comfortable — the sweet spot: ~55K ctx fp16-KV / ~110K Q8-KV; 128K window',
    progressId: 'devstral-24b',
    ollamaApproxBytes: 14_333_915_904,
    ollamaCreatedName: 'devstral-small-2507:24b',
    llamacpp: { file: 'Devstral-Small-2507-Q4_K_M.gguf', approxBytes: 14_333_915_904, present: false, available: true },
    vllm: { runCommand: 'vllm serve mistralai/Devstral-Small-2507' },
    ...overrides,
  };
}

/** The six REAL agent rows (ids/names/publishers/notes mirror MODEL_CATALOG)
 *  + one fim row to prove the role filter. */
function agentCatalog(): SetupCatalogModel[] {
  return [
    agentCatalogRow(),
    agentCatalogRow({
      id: 'ornith-9b',
      defaultForRole: undefined,
      displayName: 'Ornith-1.0 9B',
      publisher: 'ornith-ai',
      vramLine: '24GB-easy (128K+ ctx headroom)',
      progressId: 'ornith-9b',
      ollamaCreatedName: undefined,
      ollamaTag: 'ornith:9b',
      ollamaApproxBytes: 5_600_000_000,
      llamacpp: { file: 'ornith-1.0-9b-Q4_K_M.gguf', approxBytes: 5_629_108_704, present: false, available: true },
      vllm: { runCommand: 'vllm serve ornith-ai/Ornith-1.0-9B' },
    }),
    agentCatalogRow({
      id: 'ornith-35b',
      defaultForRole: undefined,
      displayName: 'Ornith-1.0 35B (MoE)',
      publisher: 'ornith-ai',
      vramLine: '24GB-stretch (CPU-offload) / 32GB-comfortable',
      note: T12_MOE_NOTE,
      progressId: 'ornith-35b',
      ollamaCreatedName: undefined,
      ollamaTag: 'ornith:35b',
      ollamaApproxBytes: 21_000_000_000,
      llamacpp: { file: 'ornith-1.0-35b-Q4_K_M.gguf', approxBytes: 21_166_757_760, present: false, available: true },
      vllm: { runCommand: 'vllm serve ornith-ai/Ornith-1.0-35B' },
    }),
    agentCatalogRow({
      id: 'qwen36-27b',
      defaultForRole: undefined,
      displayName: 'Qwen3.6-27B',
      publisher: 'unsloth',
      vramLine: '24GB-comfortable, tighter ctx (~24–40K)',
      note: T12_MMPROJ_NOTE,
      progressId: 'qwen36-27b',
      ollamaCreatedName: undefined,
      ollamaTag: 'qwen3.6:27b',
      ollamaApproxBytes: 17_000_000_000,
      llamacpp: { file: 'Qwen3.6-27B-Q4_K_M.gguf', approxBytes: 16_817_244_384, present: false, available: true },
      vllm: { runCommand: 'vllm serve Qwen/Qwen3.6-27B' },
    }),
    agentCatalogRow({
      id: 'gpt-oss-20b',
      defaultForRole: undefined,
      displayName: 'gpt-oss-20b',
      publisher: 'ggml-org',
      vramLine: '24GB-easy (100K+ ctx)',
      progressId: 'gpt-oss-20b',
      ollamaCreatedName: undefined,
      ollamaTag: 'gpt-oss:20b',
      ollamaApproxBytes: 14_000_000_000,
      llamacpp: { file: 'gpt-oss-20b-MXFP4.gguf', approxBytes: 12_109_566_624, present: false, available: true },
      vllm: { runCommand: 'vllm serve openai/gpt-oss-20b' },
    }),
    agentCatalogRow({
      id: 'qwen36-35b-a3b',
      defaultForRole: undefined,
      displayName: 'Qwen3.6-35B-A3B',
      publisher: 'unsloth',
      vramLine: '24GB-stretch (offload) / 32GB-comfortable',
      note: T12_MOE_NOTE,
      progressId: 'qwen36-35b-a3b',
      ollamaCreatedName: undefined,
      ollamaTag: 'qwen3.6:35b',
      ollamaApproxBytes: 24_000_000_000,
      llamacpp: { file: 'Qwen3.6-35B-A3B-UD-Q4_K_S.gguf', approxBytes: 20_893_015_008, present: false, available: true },
      vllm: { runCommand: 'vllm serve Qwen/Qwen3.6-35B-A3B' },
    }),
    fimCatalogRow(),
  ];
}

const T12_ENDPOINT_DEFAULTS = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8013',
  vllm: 'http://127.0.0.1:8000',
};

function agentBlockData(overrides: Partial<SetupData> = {}): SetupData {
  return baseData({
    catalog: { models: agentCatalog() },
    llamacppRuntime: { binary: 'found', version: 'b4500' },
    ollama: { running: true, version: '0.4.1', endpoint: 'http://127.0.0.1:11434', models: [] },
    agentLocalModel: { endpointDefaults: T12_ENDPOINT_DEFAULTS },
    ...overrides,
  });
}

/** A `saved` fixture (ollama flavor — no runCommand, per the host: the daemon serves it). */
function savedOrnith() {
  return {
    modelId: 'ornith-9b',
    backend: 'ollama' as const,
    endpoint: 'http://127.0.0.1:11434',
    servedName: 'ornith:9b',
  };
}

async function openAgentSection(data: SetupData) {
  const utils = renderPanel(data);
  await utils.user.click(screen.getByText('Configure Local Agent Model'));
  const agentCard = must(screen.getByText('Agent').closest('section'));
  return { ...utils, agentCard };
}

describe('T12 — the section renders in EVERY agent.phase (§3.1 CC-7)', () => {
  const phases: AgentSetupPhase[] = [
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

  for (const phase of phases) {
    it(`renders the "Configure Local Agent Model" section at phase "${phase}"`, () => {
      renderPanel(agentBlockData({ agent: { ...baseData().agent, phase } }));
      expect(screen.getByText('Configure Local Agent Model')).toBeInTheDocument();
    });
  }

  it('shows the §6 pre-ready note when agent.phase !== "ready"', async () => {
    const { agentCard } = await openAgentSection(agentBlockData({ agent: { ...baseData().agent, phase: 'missing' } }));
    expect(
      within(agentCard).getByText(
        "Hermes isn't installed yet — you can prepare the model now and configure the provider after the install.",
      ),
    ).toBeInTheDocument();
  });

  it('does NOT show the pre-ready note at phase "ready"', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(
      within(agentCard).queryByText(/you can prepare the model now and configure the provider after the install/),
    ).not.toBeInTheDocument();
  });

  it('the picker is usable pre-Hermes (model prep is install-independent)', async () => {
    const { agentCard } = await openAgentSection(agentBlockData({ agent: { ...baseData().agent, phase: 'missing' } }));
    expect(within(agentCard).getByRole('button', { name: 'Devstral-24B (2507)' })).toBeEnabled();
  });
});

describe('T12 — the 6-model picker: buttons, role-filtered, ONE Default chip + Devstral caption (§3.1)', () => {
  it('renders all six agent rows as PICKER BUTTONS (unlike the FIM surface, where rows are plain text)', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    for (const name of [
      'Devstral-24B (2507)',
      'Ornith-1.0 9B',
      'Ornith-1.0 35B (MoE)',
      'Qwen3.6-27B',
      'gpt-oss-20b',
      'Qwen3.6-35B-A3B',
    ]) {
      expect(within(agentCard).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('the fim-role catalog row does NOT render in the Agent card', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(within(agentCard).queryByText('Qwen2.5-Coder 1.5B (base)')).not.toBeInTheDocument();
  });

  it('exactly ONE Default chip (devstral-24b is the role default)', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(within(agentCard).getAllByText('Default')).toHaveLength(1);
  });

  it('the §6 Devstral-recommended caption renders on the default row', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(
      within(agentCard).getByText("Recommended — Talaria's agent pipeline is tuned on Devstral-24B (2507)."),
    ).toBeInTheDocument();
  });
});

describe('T12 — preselect/prefill = the ONE A-F8 rule (saved.modelId else defaultForRole)', () => {
  it('no save: the defaultForRole row (devstral) is preselected', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(within(agentCard).getByRole('button', { name: 'Devstral-24B (2507)', pressed: true })).toBeInTheDocument();
    expect(within(agentCard).getByRole('button', { name: 'Ornith-1.0 9B', pressed: false })).toBeInTheDocument();
  });

  it('clicking another row moves the selection (onSelect wiring)', async () => {
    const { agentCard, user } = await openAgentSection(agentBlockData());
    await user.click(within(agentCard).getByRole('button', { name: 'Ornith-1.0 9B' }));
    expect(within(agentCard).getByRole('button', { name: 'Ornith-1.0 9B', pressed: true })).toBeInTheDocument();
    expect(within(agentCard).getByRole('button', { name: 'Devstral-24B (2507)', pressed: false })).toBeInTheDocument();
  });

  it('[Change model] re-opens the picker prefilled with saved.modelId — the SAME rule', async () => {
    const data = agentBlockData({
      agentLocalModel: { endpointDefaults: T12_ENDPOINT_DEFAULTS, saved: savedOrnith() },
    });
    const { agentCard, user } = await openAgentSection(data);
    await user.click(within(agentCard).getByRole('button', { name: 'Change model' }));
    expect(within(agentCard).getByRole('button', { name: 'Ornith-1.0 9B', pressed: true })).toBeInTheDocument();
    expect(within(agentCard).getByRole('button', { name: 'Devstral-24B (2507)', pressed: false })).toBeInTheDocument();
  });
});

describe('T12 — the §6 MoE + mmproj notes ride the agent rows', () => {
  it('the MoE honesty note renders on BOTH MoE rows (ornith-35b, qwen36-35b-a3b)', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(within(agentCard).getAllByText(T12_MOE_NOTE)).toHaveLength(2);
  });

  it('the mmproj note renders on qwen36-27b (exactly once)', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(within(agentCard).getAllByText(T12_MMPROJ_NOTE)).toHaveLength(1);
  });
});

describe('T12 — `GGUF by {publisher}` caption on the llama.cpp pane only (A-F7)', () => {
  it('llama.cpp pane: unsloth ×2 + ggml-org ×1; NEVER on vendor-published rows', async () => {
    const { agentCard, user } = await openAgentSection(agentBlockData());
    await user.click(within(agentCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(agentCard).getAllByText('GGUF by unsloth')).toHaveLength(2);
    expect(within(agentCard).getAllByText('GGUF by ggml-org')).toHaveLength(1);
    expect(within(agentCard).queryByText('GGUF by mistralai')).not.toBeInTheDocument();
    expect(within(agentCard).queryByText('GGUF by ornith-ai')).not.toBeInTheDocument();
  });

  it('ollama pane: NO GGUF-publisher captions at all', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(within(agentCard).queryByText(/^GGUF by /)).not.toBeInTheDocument();
  });
});

describe('T12 — endpoint field: init from endpointDefaults, saved wins, per-backend reset (CC-6)', () => {
  it('no save: the field initializes to the ollama default and follows the backend tab', async () => {
    const { agentCard, user } = await openAgentSection(agentBlockData());
    expect(within(agentCard).getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:11434');
    await user.click(within(agentCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(agentCard).getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:8013');
    await user.click(within(agentCard).getByRole('button', { name: 'vLLM' }));
    expect(within(agentCard).getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:8000');
  });

  it('saved wins for ITS backend; other backends fall back to their defaults', async () => {
    const data = agentBlockData({
      agentLocalModel: {
        endpointDefaults: T12_ENDPOINT_DEFAULTS,
        saved: {
          modelId: 'devstral-24b',
          backend: 'llamacpp',
          endpoint: 'http://127.0.0.1:9999',
          servedName: 'Devstral-Small-2507-Q4_K_M.gguf',
        },
      },
    });
    const { agentCard, user } = await openAgentSection(data);
    await user.click(within(agentCard).getByRole('button', { name: 'Change model' }));
    // Restoration (§4.2): the saved backend's tab is active, its endpoint wins.
    expect(within(agentCard).getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:9999');
    await user.click(within(agentCard).getByRole('button', { name: 'Ollama' }));
    expect(within(agentCard).getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:11434');
    await user.click(within(agentCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(agentCard).getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:9999');
  });

  it('an in-flight edit survives an unrelated re-render (no reset while the backend is unchanged)', async () => {
    const { agentCard, user } = await openAgentSection(agentBlockData());
    const field = within(agentCard).getByLabelText('Endpoint');
    await user.clear(field);
    await user.type(field, 'http://127.0.0.1:7777');
    expect(field).toHaveValue('http://127.0.0.1:7777');
  });
});

describe('T12 — pre-save run-command caption (§6, llama.cpp pane)', () => {
  function withPresentLlamacpp(): SetupData {
    const models = agentCatalog().map((m) =>
      m.id === 'devstral-24b'
        ? {
            ...m,
            llamacpp: {
              file: 'Devstral-Small-2507-Q4_K_M.gguf',
              approxBytes: 14_333_915_904,
              present: true,
              available: true,
              runCommand:
                'llama-server -m ~/.local/share/talaria/models/mistralai/Devstral-Small-2507_gguf/Devstral-Small-2507-Q4_K_M.gguf --jinja --port 8013',
            },
          }
        : m,
    );
    return agentBlockData({ catalog: { models } });
  }

  it('a present llama.cpp row shows its run command WITH the §6 default-port caption', async () => {
    const { agentCard, user } = await openAgentSection(withPresentLlamacpp());
    await user.click(within(agentCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(agentCard).getByText(/llama-server -m .* --jinja --port 8013/)).toBeInTheDocument();
    expect(
      within(agentCard).getByText('Uses the default port — Save updates this command to your endpoint.'),
    ).toBeInTheDocument();
  });

  it('the caption does NOT render on the ollama pane', async () => {
    const { agentCard } = await openAgentSection(withPresentLlamacpp());
    expect(within(agentCard).queryByText(/Uses the default port/)).not.toBeInTheDocument();
  });

  it('the caption does NOT render on the vLLM pane (vllm serve carries no port to update)', async () => {
    const { agentCard, user } = await openAgentSection(withPresentLlamacpp());
    await user.click(within(agentCard).getByRole('button', { name: 'vLLM' }));
    expect(within(agentCard).getByText('vllm serve mistralai/Devstral-Small-2507')).toBeInTheDocument();
    expect(within(agentCard).queryByText(/Uses the default port/)).not.toBeInTheDocument();
  });
});

describe('T12 — Save row: setup.saveAgentModel, trust-gated, allowed in any phase', () => {
  it('Save dispatches {modelId, backend, endpoint} for the current picker state', async () => {
    const { agentCard, user, dispatch } = await openAgentSection(agentBlockData());
    await user.click(within(agentCard).getByRole('button', { name: 'Save' }));
    expect(dispatch).toHaveBeenCalledWith('setup.saveAgentModel', {
      modelId: 'devstral-24b',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
    expect(await within(agentCard).findByText('✓ Saved')).toBeInTheDocument();
  });

  it('Save reflects a changed model + backend + edited endpoint', async () => {
    const { agentCard, user, dispatch } = await openAgentSection(agentBlockData());
    await user.click(within(agentCard).getByRole('button', { name: 'Ornith-1.0 9B' }));
    await user.click(within(agentCard).getByRole('button', { name: 'llama.cpp' }));
    const field = within(agentCard).getByLabelText('Endpoint');
    await user.clear(field);
    await user.type(field, 'http://127.0.0.1:9013');
    await user.click(within(agentCard).getByRole('button', { name: 'Save' }));
    expect(dispatch).toHaveBeenCalledWith('setup.saveAgentModel', {
      modelId: 'ornith-9b',
      backend: 'llamacpp',
      endpoint: 'http://127.0.0.1:9013',
    });
  });

  it('untrusted: Save is disabled and names why; Test stays actionable (read-only)', async () => {
    const { agentCard } = await openAgentSection(agentBlockData({ trusted: false, ready: false }));
    const save = within(agentCard).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', TRUST_DISABLED_REASON);
    expect(within(agentCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:11434)' })).toBeEnabled();
  });

  it('Save is allowed pre-Hermes (phase "missing") — Talaria-side state', async () => {
    const { agentCard } = await openAgentSection(agentBlockData({ agent: { ...baseData().agent, phase: 'missing' } }));
    expect(within(agentCard).getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('T12 — saved state: collapsed summary + [Change model]/[Clear] (§4.2 restoration, CC-10)', () => {
  it('renders the saved summary (name via backend at endpoint) and NOT the picker', async () => {
    const data = agentBlockData({
      agentLocalModel: { endpointDefaults: T12_ENDPOINT_DEFAULTS, saved: savedOrnith() },
    });
    const { agentCard } = await openAgentSection(data);
    expect(within(agentCard).getByText('Ornith-1.0 9B via ollama at http://127.0.0.1:11434')).toBeInTheDocument();
    expect(within(agentCard).queryByRole('button', { name: 'Devstral-24B (2507)' })).not.toBeInTheDocument();
    expect(within(agentCard).getByRole('button', { name: 'Change model' })).toBeInTheDocument();
    expect(within(agentCard).getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('post-save the summary shows saved.runCommand (recomposed for the SAVED endpoint) with a Copy', async () => {
    const data = agentBlockData({
      agentLocalModel: {
        endpointDefaults: T12_ENDPOINT_DEFAULTS,
        saved: {
          modelId: 'devstral-24b',
          backend: 'llamacpp',
          endpoint: 'http://127.0.0.1:9999',
          servedName: 'Devstral-Small-2507-Q4_K_M.gguf',
          runCommand:
            'llama-server -m ~/.local/share/talaria/models/mistralai/Devstral-Small-2507_gguf/Devstral-Small-2507-Q4_K_M.gguf --jinja --port 9999',
        },
      },
    });
    const { agentCard } = await openAgentSection(data);
    expect(within(agentCard).getByText(/--jinja --port 9999/)).toBeInTheDocument();
    expect(within(agentCard).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('[Clear] dispatches the modal-gated unset {clear:true}; untrusted disables it with the reason', async () => {
    const data = agentBlockData({
      agentLocalModel: { endpointDefaults: T12_ENDPOINT_DEFAULTS, saved: savedOrnith() },
    });
    const { agentCard, user, dispatch, unmount } = await openAgentSection(data);
    await user.click(within(agentCard).getByRole('button', { name: 'Clear' }));
    expect(dispatch).toHaveBeenCalledWith('setup.saveAgentModel', { clear: true });
    unmount();

    const untrusted = agentBlockData({
      trusted: false,
      ready: false,
      agentLocalModel: { endpointDefaults: T12_ENDPOINT_DEFAULTS, saved: savedOrnith() },
    });
    const { agentCard: card2 } = await openAgentSection(untrusted);
    const clear = within(card2).getByRole('button', { name: 'Clear' });
    expect(clear).toBeDisabled();
    expect(clear).toHaveAttribute('title', TRUST_DISABLED_REASON);
  });

  it('[Change model] toggles the picker open and closed (escape route, no copy invented)', async () => {
    const data = agentBlockData({
      agentLocalModel: { endpointDefaults: T12_ENDPOINT_DEFAULTS, saved: savedOrnith() },
    });
    const { agentCard, user } = await openAgentSection(data);
    await user.click(within(agentCard).getByRole('button', { name: 'Change model' }));
    expect(within(agentCard).getByRole('button', { name: 'Devstral-24B (2507)' })).toBeInTheDocument();
    await user.click(within(agentCard).getByRole('button', { name: 'Change model' }));
    expect(within(agentCard).queryByRole('button', { name: 'Devstral-24B (2507)' })).not.toBeInTheDocument();
  });
});

describe('T12 — providerGuidance renders from the wire; the copy never points at an unrendered control (CC-7)', () => {
  const GUIDANCE_UNCONFIGURED =
    '✓ Local model ready. Next: press "Configure provider" on the Provider card below → choose the OpenAI-compatible (custom URL) provider → base URL: http://127.0.0.1:11434/v1 · model: ornith:9b. Test shows the served model if unsure.';
  const GUIDANCE_WAITING =
    '✓ Local model ready. The provider step unlocks once Hermes is installed and connected — the Provider card below will show "Configure provider".';
  const GUIDANCE_CONFIGURED =
    '✓ Local model saved. Your provider is already configured — update it to http://127.0.0.1:11434/v1 · ornith:9b if you want the agent on this model.';

  function guidanceData(phase: SetupData['provider']['phase'], guidance: string): SetupData {
    return agentBlockData({
      provider: { phase, providerId: phase === 'configured' ? 'custom' : undefined },
      ready: false,
      agentLocalModel: {
        endpointDefaults: T12_ENDPOINT_DEFAULTS,
        saved: savedOrnith(),
        providerGuidance: guidance,
      },
    });
  }

  it('unconfigured: the full wizard-pointing §6 line renders AND the wizard button exists', async () => {
    const { agentCard } = await openAgentSection(guidanceData('unconfigured', GUIDANCE_UNCONFIGURED));
    expect(within(agentCard).getByText(GUIDANCE_UNCONFIGURED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure provider' })).toBeInTheDocument();
  });

  it('waiting-agent: the waiting §6 line renders AND no "Configure provider" button is rendered anywhere', async () => {
    const { agentCard } = await openAgentSection(guidanceData('waiting-agent', GUIDANCE_WAITING));
    expect(within(agentCard).getByText(GUIDANCE_WAITING)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure provider' })).not.toBeInTheDocument();
  });

  it('unknown: the same waiting line renders AND no wizard button (shares the waiting variant)', async () => {
    const { agentCard } = await openAgentSection(guidanceData('unknown', GUIDANCE_WAITING));
    expect(within(agentCard).getByText(GUIDANCE_WAITING)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure provider' })).not.toBeInTheDocument();
  });

  it('configured: the done variant renders', async () => {
    const { agentCard } = await openAgentSection(guidanceData('configured', GUIDANCE_CONFIGURED));
    expect(within(agentCard).getByText(GUIDANCE_CONFIGURED)).toBeInTheDocument();
  });

  it('no guidance on the wire: none of the variants render', async () => {
    const { agentCard } = await openAgentSection(agentBlockData());
    expect(within(agentCard).queryByText(/Local model (ready|saved)\./)).not.toBeInTheDocument();
  });
});

describe('T12 — Test endpoint in the label + the Serving line (§3.1 flow)', () => {
  it('ollama pane: surface-level Test names the endpoint, dispatches setup.testRemote, and shows Serving on models', async () => {
    const { agentCard, user, dispatch } = await openAgentSection(agentBlockData());
    dispatch.mockResolvedValue({ models: ['devstral-small-2507:24b'] });
    await user.click(within(agentCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:11434)' }));
    expect(dispatch).toHaveBeenCalledWith('setup.testRemote', {
      backendId: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
    expect(await within(agentCard).findByText('Serving: devstral-small-2507:24b')).toBeInTheDocument();
  });

  it('llama.cpp pane: the block-rendered Test carries the llamacpp endpoint in its label', async () => {
    const { agentCard, user } = await openAgentSection(agentBlockData());
    await user.click(within(agentCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(agentCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:8013)' })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T13 (§3.3/§4.2/§6): the NEXT surface — pinned Sweep row on the
 * block's NEW llama.cpp pane, provisionModel single entry (T7-M2),
 * dedicatedBackendId restoration (CC-10). Ollama/vLLM/OpenAI-compatible
 * panes preserved.
 * ------------------------------------------------------------------ */

/** The §6 "Pinned-mode disabled (Sweep)" line — beta.5 string unchanged. */
const NO_VETTED_BUILD_LINE =
  "No vetted build of this model is published yet — it can't be downloaded automatically. Use the guided instructions below, or the vLLM path (official release).";

/** T13: a NEXT-form fixture with all four candidate backends, a found
 *  llama-server, and the pinned sweep-next catalog row in a given state. */
function nextSurfaceData(
  opts: {
    row?: SetupCatalogModel;
    downloadReady?: boolean;
    dedicatedBackendId?: 'ollama' | 'llamacpp' | 'vllm' | 'openai-compat';
  } = {},
): SetupData {
  const base = baseData();
  const downloadReady = opts.downloadReady ?? true;
  return baseData({
    fim: {
      ...base.fim,
      options: [
        ollamaOption(),
        llamacppOption({ nextEditTransport: 'openai-compat' }),
        vllmOption({ nextEditTransport: 'openai-compat' }),
        openaiCompatOption(),
      ],
      selectedId: 'ollama',
    },
    llamacppRuntime: { binary: 'found', version: 'b4500' },
    ...(opts.row !== undefined ? { catalog: { models: [opts.row] } } : {}),
    nextEdit: {
      ...base.nextEdit,
      ...(opts.dedicatedBackendId !== undefined ? { dedicatedBackendId: opts.dedicatedBackendId } : {}),
      dedicated: downloadReady
        ? base.nextEdit.dedicated
        : {
            ...base.nextEdit.dedicated!,
            downloadReady: false,
            modelDefaults: { ollama: '', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
            guided: { vllm: base.nextEdit.dedicated!.guided.vllm },
          },
    },
  });
}

/** T13: the empty-pin shipping wire truth — `composeLlamacppCell` while
 *  `sha256: ''` ships `available: false` WITHOUT an `unavailableReason`
 *  (the NEXT card's wire truth owns the pinned-disabled copy). */
function emptyPinData(): SetupData {
  return nextSurfaceData({
    downloadReady: false,
    row: sweepNextRow({
      llamacpp: {
        file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
        approxBytes: 4_680_000_000,
        present: false,
        available: false,
      },
    }),
  });
}

async function openNextForm(data: SetupData, extra: Partial<Parameters<typeof SetupPanel>[0]> = {}) {
  const utils = renderPanel(data, extra);
  await utils.user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
  const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
  return { ...utils, nextCard };
}

describe('T13 — the pinned model line; NO model picker on any pane (§3.3)', () => {
  it('the llama.cpp pane renders the sweep row as plain text — never an aria-pressed picker button', async () => {
    const { user, nextCard } = await openNextForm(nextSurfaceData());
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(
      within(nextCard).getByText('Sweep Next-Edit v2 (7B) — the one supported dedicated model.'),
    ).toBeInTheDocument();
    expect(within(nextCard).getByText('Sweep Next-Edit v2 (7B)')).toBeInTheDocument();
    expect(within(nextCard).queryByRole('button', { name: 'Sweep Next-Edit v2 (7B)' })).not.toBeInTheDocument();
  });
});

describe('T13 — Ollama pane in-flight: progress + Cancel keyed pull:sweep-next (rule 7/CC-9)', () => {
  const inFlight = {
    'pull:sweep-next': { op: 'pull' as const, id: 'sweep-next', logTail: [], totalBytes: 1000, completedBytes: 250 },
  };

  it('renders the percent from the CATALOG-id key and offers Cancel dispatching setup.cancel {op:pull, id:sweep-next}', async () => {
    const { user, nextCard, dispatch } = await openNextForm(nextSurfaceData(), { progress: inFlight });
    expect(within(nextCard).getByText('25%')).toBeInTheDocument();
    await user.click(within(nextCard).getByRole('button', { name: 'Cancel' }));
    expect(dispatch).toHaveBeenCalledWith('setup.cancel', { op: 'pull', id: 'sweep-next' });
  });

  it('progress under the beta.5 TAG key no longer renders a bar — the key moved WITH the route (T7-M2)', async () => {
    const stale = {
      'pull:sweep-next-edit-v2-7b:q4_k_m': {
        op: 'pull' as const,
        id: 'sweep-next-edit-v2-7b:q4_k_m',
        logTail: [],
        totalBytes: 1000,
        completedBytes: 250,
      },
    };
    const { nextCard } = await openNextForm(nextSurfaceData(), { progress: stale });
    expect(within(nextCard).queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('T13 — llama.cpp pane: the empty-pin cell (§3.3, fail-closed)', () => {
  it('renders the §6 no-vetted-build line + the Download button DISABLED naming why', async () => {
    const { user, nextCard } = await openNextForm(emptyPinData());
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(nextCard).getByText(NO_VETTED_BUILD_LINE)).toBeInTheDocument();
    const button = within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', NO_VETTED_BUILD_LINE);
  });

  it('NO guided line at all in that state — no -hf command, no sha256sum hint — and never the generic honest-absence misdirect', async () => {
    const { user, nextCard } = await openNextForm(emptyPinData());
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(nextCard).queryByText(/llama-server -hf/)).not.toBeInTheDocument();
    expect(within(nextCard).queryByText(/sha256sum/)).not.toBeInTheDocument();
    expect(within(nextCard).queryByText(/use it via Ollama instead/)).not.toBeInTheDocument();
  });

  it('the block binary status still renders (§4.1 — the backend cell is pin-independent)', async () => {
    const { user, nextCard } = await openNextForm(emptyPinData());
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(nextCard).getByText('llama.cpp: Ready ✓ — b4500')).toBeInTheDocument();
  });
});

describe('T13 — llama.cpp pane: pinned cell — Download → present → run command + digest hint (§3.3/SC-3)', () => {
  it('absent + pinned: Download ENABLED, dispatches setup.provisionModel {modelId:sweep-next, backend:llamacpp} — never setup.pullModel', async () => {
    const { user, nextCard, dispatch } = await openNextForm(nextSurfaceData());
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    const button = within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'sweep-next',
      backend: 'llamacpp',
      endpoint: 'http://127.0.0.1:8012',
    });
    expect(dispatch).not.toHaveBeenCalledWith('setup.pullModel', expect.anything());
  });

  it('present: the host-composed --port 8012 run command + [Copy] + the RETAINED pinned digest hint; no -hf line', async () => {
    const runCommand =
      'llama-server -m ~/.local/share/talaria/models/SyntinalCo/sweep-next-edit-v2-7B-GGUF/sweep-next-edit-v2-7B-Q4_K_M.gguf --port 8012';
    const data = nextSurfaceData({
      row: sweepNextRow({
        llamacpp: {
          file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
          approxBytes: 4_680_000_000,
          present: true,
          available: true,
          runCommand,
        },
      }),
    });
    const { user, nextCard } = await openNextForm(data);
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(nextCard).getByText("present in Talaria's model folder ✓")).toBeInTheDocument();
    expect(within(nextCard).getByText(runCommand)).toBeInTheDocument();
    expect(within(nextCard).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(within(nextCard).getByText('Verify the download: sha256sum should print abc123def456')).toBeInTheDocument();
    expect(within(nextCard).queryByText(/llama-server -hf/)).not.toBeInTheDocument();
  });

  it('ONE Test on the pane: the block-rendered "Test connection ({endpoint})" — the generic [Test] does not double it; Apply stays', async () => {
    const { user, nextCard } = await openNextForm(nextSurfaceData());
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(nextCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:8012)' })).toBeInTheDocument();
    expect(within(nextCard).queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(within(nextCard).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });
});

describe('T13 — vLLM pane unchanged (§3.3): guided line + generic Test; the block never renders here', () => {
  it('keeps the guided run line + [Test] + [Apply]; no Download, no block Test-connection', async () => {
    const { user, nextCard } = await openNextForm(nextSurfaceData());
    await user.click(within(nextCard).getByRole('button', { name: 'vLLM' }));
    expect(within(nextCard).getByText('Run: vllm serve sweepai/sweep-next-edit-v2-7B')).toBeInTheDocument();
    expect(within(nextCard).getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(within(nextCard).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(within(nextCard).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(within(nextCard).queryByRole('button', { name: /Test connection/ })).not.toBeInTheDocument();
  });
});

describe('T13 — OpenAI-compatible pane KEPT (CC-8): endpoint + model + Test + Apply, no catalog rows', () => {
  it('renders the two fields (openai-compat prefill) + Test + Apply and none of the catalog affordances', async () => {
    const { user, nextCard } = await openNextForm(nextSurfaceData());
    await user.click(within(nextCard).getByRole('button', { name: 'OpenAI-compatible server' }));
    expect(within(nextCard).getByRole('textbox', { name: 'Endpoint' })).toHaveValue('http://127.0.0.1:8000');
    expect(within(nextCard).getByRole('textbox', { name: 'Model' })).toHaveValue('sweepai/sweep-next-edit-v2-7B');
    expect(within(nextCard).getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(within(nextCard).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(within(nextCard).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(within(nextCard).queryByText('not present')).not.toBeInTheDocument();
    expect(within(nextCard).queryByText(/llama-server/)).not.toBeInTheDocument();
  });

  it('Apply from this pane writes backend openai-compat + dedicatedBackendId openai-compat (CC-10)', async () => {
    const { user, nextCard, dispatch } = await openNextForm(nextSurfaceData());
    await user.click(within(nextCard).getByRole('button', { name: 'OpenAI-compatible server' }));
    await user.click(within(nextCard).getByRole('button', { name: 'Apply' }));
    expect(dispatch).toHaveBeenCalledWith(
      'setup.setNextEdit',
      expect.objectContaining({ backend: 'openai-compat', dedicatedBackendId: 'openai-compat' }),
    );
  });
});

describe('T13 — dedicatedBackendId restoration + Apply write-back (CC-10, §4.2)', () => {
  it('the initial pane is the restored dedicatedBackendId candidate', async () => {
    const { nextCard } = await openNextForm(nextSurfaceData({ dedicatedBackendId: 'llamacpp' }));
    expect(within(nextCard).getByRole('button', { name: 'llama.cpp', pressed: true })).toBeInTheDocument();
    expect(within(nextCard).getByText('llama.cpp: Ready ✓ — b4500')).toBeInTheDocument();
  });

  it("absent ⇒ today's transport heuristic (backend ollama → the Ollama pane)", async () => {
    const { nextCard } = await openNextForm(nextSurfaceData());
    expect(within(nextCard).getByRole('button', { name: 'Ollama', pressed: true })).toBeInTheDocument();
  });

  it('a dedicatedBackendId naming NO live candidate falls back to the heuristic (stale settings degrade honestly)', async () => {
    const base = baseData();
    const data = baseData({
      fim: { ...base.fim, options: [ollamaOption()], selectedId: 'ollama' },
      nextEdit: { ...base.nextEdit, dedicatedBackendId: 'llamacpp' },
    });
    const { nextCard } = await openNextForm(data);
    expect(within(nextCard).getByRole('button', { name: 'Ollama', pressed: true })).toBeInTheDocument();
  });

  it('Apply records the selected pane via the ADDITIVE dedicatedBackendId param', async () => {
    const { user, nextCard, dispatch } = await openNextForm(nextSurfaceData());
    await user.click(within(nextCard).getByRole('button', { name: 'Apply' }));
    expect(dispatch).toHaveBeenCalledWith(
      'setup.setNextEdit',
      expect.objectContaining({ backend: 'ollama', dedicatedBackendId: 'ollama' }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T14 (§3.4): RAG surface on LocalModelBlock.
 * ------------------------------------------------------------------ */

/** T14: the three REAL embedding catalog rows as `projectCatalogModel` ships
 *  them — field values mirror `modelCatalog.ts` byte-for-byte (T13's
 *  fixture-fidelity discipline; the ctx note is the row's own wire `note`). */
function qwen3Embedding06Row(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'qwen3-embedding-0.6b',
    role: 'embedding',
    displayName: 'Qwen3-Embedding 0.6B',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    defaultForRole: true,
    vramLine: '< 1.5 GB',
    progressId: 'qwen3-embedding-0.6b',
    ollamaTag: 'qwen3-embedding:0.6b',
    ollamaApproxBytes: 639_000_000,
    llamacpp: { file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', approxBytes: 639_150_592, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen3-Embedding-0.6B' },
    ...overrides,
  };
}

function qwen3Embedding4bRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'qwen3-embedding-4b',
    role: 'embedding',
    displayName: 'Qwen3-Embedding 4B',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    contextWindow: 40960,
    vramLine: '≈ 3 GB',
    progressId: 'qwen3-embedding-4b',
    ollamaTag: 'qwen3-embedding:4b',
    ollamaApproxBytes: 2_500_000_000,
    llamacpp: { file: 'Qwen3-Embedding-4B-Q4_K_M.gguf', approxBytes: 2_496_703_776, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen3-Embedding-4B' },
    ...overrides,
  };
}

function embeddingGemmaRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'embeddinggemma-300m',
    role: 'embedding',
    displayName: 'EmbeddingGemma 300M',
    publisher: 'ggml-org',
    license: 'Gemma',
    contextWindow: 2048,
    vramLine: '< 1 GB',
    note: '2K context on the Ollama build — fine for Talaria’s chunk sizes (≤512 tokens).',
    progressId: 'embeddinggemma-300m',
    ollamaTag: 'embeddinggemma:300m',
    ollamaApproxBytes: 622_000_000,
    llamacpp: { file: 'embeddinggemma-300M-Q8_0.gguf', approxBytes: 333_590_944, present: false, available: true },
    vllm: { runCommand: 'vllm serve google/embeddinggemma-300m' },
    ...overrides,
  };
}

/** T13 note 4 honored: EXTENDS `baseData()`'s catalog (sweep-next stays in),
 *  never replaces the array. */
function ragSurfaceData(overrides: Partial<SetupData> = {}, rows?: SetupCatalogModel[]): SetupData {
  const base = baseData();
  return baseData({
    catalog: {
      models: [...(base.catalog?.models ?? []), ...(rows ?? [qwen3Embedding06Row(), qwen3Embedding4bRow(), embeddingGemmaRow()])],
    },
    ...overrides,
  });
}

async function openRagSection(data: SetupData, extra: Partial<Parameters<typeof SetupPanel>[0]> = {}) {
  const utils = renderPanel(data, extra);
  await utils.user.click(screen.getByRole('button', { name: 'Configure embedding model' }));
  const ragCard = must(screen.getByText('Codebase index (RAG)').closest('section'));
  return { ...utils, ragCard };
}

describe('T14 — RAG card grows the block: a collapsible section CREATES endpoint field + Test + Apply (§3.4, Part 0.1)', () => {
  it('default-closed toggle (T12 pattern, not <details>): no tabs / endpoint field / Apply in the DOM until opened', () => {
    renderPanel(ragSurfaceData());
    const toggle = screen.getByRole('button', { name: 'Configure embedding model' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const ragCard = must(screen.getByText('Codebase index (RAG)').closest('section'));
    expect(within(ragCard).queryByRole('button', { name: 'llama.cpp' })).not.toBeInTheDocument();
    expect(within(ragCard).queryByRole('textbox', { name: 'Endpoint' })).not.toBeInTheDocument();
    expect(within(ragCard).queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('opening reveals the three-pane switch (aria-pressed), the Endpoint field prefilled from rag.embedEndpoint, and Apply', async () => {
    const { ragCard } = await openRagSection(ragSurfaceData());
    expect(within(ragCard).getByRole('button', { name: 'Ollama', pressed: true })).toBeInTheDocument();
    expect(within(ragCard).getByRole('button', { name: 'llama.cpp', pressed: false })).toBeInTheDocument();
    expect(within(ragCard).getByRole('button', { name: 'vLLM / OpenAI-compatible', pressed: false })).toBeInTheDocument();
    expect(within(ragCard).getByRole('textbox', { name: 'Endpoint' })).toHaveValue('http://127.0.0.1:11434');
    expect(within(ragCard).getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('Apply dispatches setup.setRag with the edited endpoint + the selected pane as embedBackend (CC-10 rides the same method)', async () => {
    const { user, dispatch, ragCard } = await openRagSection(ragSurfaceData());
    const field = within(ragCard).getByRole('textbox', { name: 'Endpoint' });
    await user.clear(field);
    await user.type(field, 'http://127.0.0.1:9999');
    await user.click(within(ragCard).getByRole('button', { name: 'Apply' }));
    expect(dispatch).toHaveBeenCalledWith('setup.setRag', { embedEndpoint: 'http://127.0.0.1:9999', embedBackend: 'ollama' });
  });

  it("Apply on the llama.cpp pane writes embedBackend 'llamacpp'; the third pane writes 'openai-compat'", async () => {
    const { user, dispatch, ragCard } = await openRagSection(ragSurfaceData());
    await user.click(within(ragCard).getByRole('button', { name: 'llama.cpp' }));
    await user.click(within(ragCard).getByRole('button', { name: 'Apply' }));
    expect(dispatch).toHaveBeenLastCalledWith('setup.setRag', expect.objectContaining({ embedBackend: 'llamacpp' }));
    await user.click(within(ragCard).getByRole('button', { name: 'vLLM / OpenAI-compatible' }));
    await user.click(within(ragCard).getByRole('button', { name: 'Apply' }));
    expect(dispatch).toHaveBeenLastCalledWith('setup.setRag', expect.objectContaining({ embedBackend: 'openai-compat' }));
  });

  it('Apply is trust-gated with the shared reason; the pane switch and Test stay usable (read-only, §8)', async () => {
    const { ragCard } = await openRagSection(ragSurfaceData({ trusted: false }));
    const apply = within(ragCard).getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    expect(apply.getAttribute('title')).toBe(TRUST_DISABLED_REASON);
    expect(within(ragCard).getByRole('button', { name: 'llama.cpp' })).toBeEnabled();
    expect(within(ragCard).getByRole('button', { name: 'Test connection (http://127.0.0.1:11434)' })).toBeEnabled();
  });
});

describe('T14 — RAG ollama pane: the three embedding rows + endpoint-scoped presence (C-6)', () => {
  it('renders all three §3.4 rows with ONE Default chip, the embeddinggemma ctx note, and NO sweep-next row (role-filtered)', async () => {
    const { ragCard } = await openRagSection(ragSurfaceData());
    expect(within(ragCard).getByText('Qwen3-Embedding 0.6B')).toBeInTheDocument();
    expect(within(ragCard).getByText('Qwen3-Embedding 4B')).toBeInTheDocument();
    expect(within(ragCard).getByText('EmbeddingGemma 300M')).toBeInTheDocument();
    expect(within(ragCard).getAllByText('Default')).toHaveLength(1);
    expect(within(ragCard).getByText('2K context on the Ollama build — fine for Talaria’s chunk sizes (≤512 tokens).')).toBeInTheDocument();
    expect(within(ragCard).queryByText('Sweep Next-Edit v2 (7B)')).not.toBeInTheDocument();
  });

  it('rows are informational (no picker): model names are NOT buttons, unlike the Agent picker', async () => {
    const { ragCard } = await openRagSection(ragSurfaceData());
    expect(within(ragCard).queryByRole('button', { name: 'Qwen3-Embedding 0.6B' })).not.toBeInTheDocument();
  });

  it('a row on the probed daemon at the matching endpoint shows present ✓ (no Pull); absent rows keep Pull {tag} (~{size})', async () => {
    const { ragCard } = await openRagSection(
      ragSurfaceData({
        ollama: { ...baseData().ollama, models: [{ name: 'qwen3-embedding:0.6b', sizeBytes: 639_000_000 }] },
      }),
    );
    expect(within(ragCard).getByText('present ✓')).toBeInTheDocument();
    expect(within(ragCard).queryByRole('button', { name: /^Pull qwen3-embedding:0\.6b/ })).not.toBeInTheDocument();
    expect(within(ragCard).getByRole('button', { name: /^Pull qwen3-embedding:4b/ })).toBeEnabled();
    expect(within(ragCard).getByRole('button', { name: /^Pull embeddinggemma:300m/ })).toBeEnabled();
  });

  it("editing the endpoint field away from the probed daemon flips every row to 'not verified here — Test the endpoint first.' with Pull REMAINING", async () => {
    const { user, ragCard } = await openRagSection(ragSurfaceData());
    const field = within(ragCard).getByRole('textbox', { name: 'Endpoint' });
    await user.clear(field);
    await user.type(field, 'http://10.0.0.9:11434');
    expect(within(ragCard).getAllByText('not verified here — Test the endpoint first.').length).toBeGreaterThanOrEqual(3);
    expect(within(ragCard).getByRole('button', { name: /^Pull qwen3-embedding:0\.6b/ })).toBeEnabled();
  });

  it('a row Pull dispatches setup.provisionModel {modelId, backend: ollama, endpoint: the FIELD value}', async () => {
    const { user, dispatch, ragCard } = await openRagSection(ragSurfaceData());
    await user.click(within(ragCard).getByRole('button', { name: /^Pull embeddinggemma:300m/ }));
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'embeddinggemma-300m',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
  });

  it('exactly ONE Test on the pane — the surface-level Test connection ({endpoint}) dispatching {backendId: ollama}', async () => {
    const { user, dispatch, ragCard } = await openRagSection(ragSurfaceData());
    const tests = within(ragCard).getAllByRole('button', { name: /^Test connection/ });
    expect(tests).toHaveLength(1);
    await user.click(must(tests[0]));
    expect(dispatch).toHaveBeenCalledWith('setup.testRemote', { backendId: 'ollama', endpoint: 'http://127.0.0.1:11434' });
  });
});

describe('T14 — RAG configured-model row (CC-8): free-text rag.embedModel outside the catalog', () => {
  it('renders with a Configured pill + Pull wired to the legacy setup.pullModel {model, endpoint}', async () => {
    // `baseData()`'s rag.embedModel ('nomic-embed-text') names no catalog row.
    const { user, dispatch, ragCard } = await openRagSection(ragSurfaceData());
    expect(within(ragCard).getByText('Configured')).toBeInTheDocument();
    await user.click(within(ragCard).getByRole('button', { name: 'Pull nomic-embed-text' }));
    expect(dispatch).toHaveBeenCalledWith('setup.pullModel', { model: 'nomic-embed-text', endpoint: 'http://127.0.0.1:11434' });
  });

  it('tag-keyed progress + Cancel (pull:<model> — the legacy handlePullModel latch, not a catalog id)', async () => {
    const { user, dispatch, ragCard } = await openRagSection(ragSurfaceData(), {
      progress: {
        'pull:nomic-embed-text': { op: 'pull', id: 'nomic-embed-text', logTail: [], totalBytes: 100, completedBytes: 25 },
      },
    });
    expect(within(ragCard).getByRole('progressbar', { name: 'Pulling nomic-embed-text' })).toBeInTheDocument();
    expect(within(ragCard).getByText('25%')).toBeInTheDocument();
    await user.click(within(ragCard).getByRole('button', { name: 'Cancel' }));
    expect(dispatch).toHaveBeenCalledWith('setup.cancel', { op: 'pull', id: 'nomic-embed-text' });
  });

  it('NOT rendered when the configured model IS a catalog row', async () => {
    const { ragCard } = await openRagSection(ragSurfaceData({ rag: { ...baseData().rag, embedModel: 'qwen3-embedding:0.6b' } }));
    expect(within(ragCard).queryByText('Configured')).not.toBeInTheDocument();
  });

  it('NOT rendered while the daemon is down (the legacy tier needs a live daemon to pull onto)', async () => {
    const { ragCard } = await openRagSection(
      ragSurfaceData({ ollama: { running: false, endpoint: 'http://127.0.0.1:11434', models: [] } }),
    );
    expect(within(ragCard).queryByText('Configured')).not.toBeInTheDocument();
  });
});

describe('T14 — RAG llama.cpp pane: verified downloads for ALL three rows (F-3 closed — no absence cells)', () => {
  async function openLlamacppPane(data: SetupData) {
    const utils = await openRagSection(data);
    await utils.user.click(within(utils.ragCard).getByRole('button', { name: 'llama.cpp' }));
    return utils;
  }

  it('all three rows offer the generic verified Download — never the honest-absence line, never the NEXT pinned label', async () => {
    const { ragCard } = await openLlamacppPane(ragSurfaceData({ llamacppRuntime: { binary: 'found', version: 'b4600' } }));
    expect(within(ragCard).getByRole('button', { name: /^Download Qwen3-Embedding 0\.6B/ })).toBeEnabled();
    expect(within(ragCard).getByRole('button', { name: /^Download Qwen3-Embedding 4B/ })).toBeEnabled();
    expect(within(ragCard).getByRole('button', { name: /^Download EmbeddingGemma 300M/ })).toBeEnabled();
    expect(within(ragCard).queryByText(/use it via Ollama instead/)).not.toBeInTheDocument();
    expect(within(ragCard).queryByRole('button', { name: 'Download model (~4.7 GB)' })).not.toBeInTheDocument();
  });

  it('a Download dispatches provisionModel {modelId, backend: llamacpp, endpoint: the field value}', async () => {
    const { user, dispatch, ragCard } = await openLlamacppPane(ragSurfaceData());
    await user.click(within(ragCard).getByRole('button', { name: /^Download EmbeddingGemma 300M/ }));
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'embeddinggemma-300m',
      backend: 'llamacpp',
      endpoint: 'http://127.0.0.1:11434',
    });
  });

  it('a present row renders the host-composed --embeddings run command + the §6 Apply nudge', async () => {
    const presentRow = qwen3Embedding06Row({
      llamacpp: {
        file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
        approxBytes: 639_150_592,
        present: true,
        available: true,
        runCommand:
          'llama-server -m ~/.local/share/talaria/models/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf --embeddings --port 8081',
      },
    });
    const { ragCard } = await openLlamacppPane(ragSurfaceData({}, [presentRow, qwen3Embedding4bRow(), embeddingGemmaRow()]));
    expect(within(ragCard).getByText(/--embeddings --port 8081/)).toBeInTheDocument();
    expect(within(ragCard).getByText("present in Talaria's model folder ✓")).toBeInTheDocument();
    expect(within(ragCard).getByText('Then Apply the endpoint below.')).toBeInTheDocument();
  });

  it('the nudge is ABSENT while nothing is downloaded (it explains a next step that does not exist yet)', async () => {
    const { ragCard } = await openLlamacppPane(ragSurfaceData());
    expect(within(ragCard).queryByText('Then Apply the endpoint below.')).not.toBeInTheDocument();
  });

  it("ONE Test on the pane — the block's endpoint-labeled Test dispatching {backendId: llamacpp} (no second surface Test)", async () => {
    const { user, dispatch, ragCard } = await openLlamacppPane(ragSurfaceData());
    const tests = within(ragCard).getAllByRole('button', { name: /^Test connection/ });
    expect(tests).toHaveLength(1);
    await user.click(must(tests[0]));
    expect(dispatch).toHaveBeenCalledWith('setup.testRemote', { backendId: 'llamacpp', endpoint: 'http://127.0.0.1:11434' });
  });
});

describe('T14 — RAG vLLM / OpenAI-compatible pane: Test + run command only (§3.4)', () => {
  async function openThirdPane(data: SetupData) {
    const utils = await openRagSection(data);
    await utils.user.click(within(utils.ragCard).getByRole('button', { name: 'vLLM / OpenAI-compatible' }));
    return utils;
  }

  it("renders each row's vllm run command, no Pull/Download anywhere, and the block's Test ({backendId: vllm})", async () => {
    const { user, dispatch, ragCard } = await openThirdPane(ragSurfaceData());
    expect(within(ragCard).getByText('vllm serve Qwen/Qwen3-Embedding-0.6B')).toBeInTheDocument();
    expect(within(ragCard).getByText('vllm serve google/embeddinggemma-300m')).toBeInTheDocument();
    expect(within(ragCard).queryByRole('button', { name: /^Pull / })).not.toBeInTheDocument();
    expect(within(ragCard).queryByRole('button', { name: /^Download / })).not.toBeInTheDocument();
    const tests = within(ragCard).getAllByRole('button', { name: /^Test connection/ });
    expect(tests).toHaveLength(1);
    await user.click(must(tests[0]));
    expect(dispatch).toHaveBeenCalledWith('setup.testRemote', { backendId: 'vllm', endpoint: 'http://127.0.0.1:11434' });
  });
});

describe('T14 — embedBackend restoration (§4.2): the initial pane reads rag.embedBackend, else ollama', () => {
  it("rag.embedBackend 'llamacpp' opens on the llama.cpp pane", async () => {
    const { ragCard } = await openRagSection(ragSurfaceData({ rag: { ...baseData().rag, embedBackend: 'llamacpp' } }));
    expect(within(ragCard).getByRole('button', { name: 'llama.cpp', pressed: true })).toBeInTheDocument();
  });

  it("'openai-compat' opens on the third pane", async () => {
    const { ragCard } = await openRagSection(ragSurfaceData({ rag: { ...baseData().rag, embedBackend: 'openai-compat' } }));
    expect(within(ragCard).getByRole('button', { name: 'vLLM / OpenAI-compatible', pressed: true })).toBeInTheDocument();
  });

  it('an absent embedBackend (old-host wire) degrades to the Ollama pane', async () => {
    const { ragCard } = await openRagSection(ragSurfaceData());
    expect(within(ragCard).getByRole('button', { name: 'Ollama', pressed: true })).toBeInTheDocument();
  });
});

describe('T14 — card-level presence honesty (the §3.4 truth table, dom half)', () => {
  it('the deprecated wire boolean can no longer fake a green line: endpoint mismatch ⇒ NO done line even with the boolean true', () => {
    renderPanel(
      baseData({ rag: { ...baseData().rag, enabled: true, embedModelPresent: true, embedEndpoint: 'http://10.0.0.9:11434' } }),
    );
    expect(screen.queryByText('✓ Codebase index is ready — the agent can search your project.')).not.toBeInTheDocument();
  });

  it("an unverifiable configured endpoint surfaces the honest 'not verified here' text at card level — neither a presence lie nor an absence lie", () => {
    renderPanel(baseData({ rag: { ...baseData().rag, embedEndpoint: 'http://10.0.0.9:11434' } }));
    const ragCard = must(screen.getByText('Codebase index (RAG)').closest('section'));
    expect(within(ragCard).getByText('not verified here — Test the endpoint first.')).toBeInTheDocument();
    expect(within(ragCard).queryByText('not present')).not.toBeInTheDocument();
  });

  it('a genuinely present model at the configured endpoint (:latest-tolerant) turns the done line green with the boolean FALSE', () => {
    renderPanel(
      baseData({
        rag: { ...baseData().rag, enabled: true },
        ollama: { ...baseData().ollama, models: [{ name: 'nomic-embed-text:latest', sizeBytes: 1 }] },
      }),
    );
    expect(screen.getByText('✓ Codebase index is ready — the agent can search your project.')).toBeInTheDocument();
  });

  it("provable absence at the configured endpoint keeps the card-level 'not present' text", () => {
    renderPanel(ragSurfaceData());
    const ragCard = must(screen.getByText('Codebase index (RAG)').closest('section'));
    expect(within(ragCard).getByText('not present')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T18 (§3.5): `RecommendationsBlock` — the dynamic Home 1 strip,
 * mounted above the Agent card. Pure derivation is covered in the pure
 * `SetupPanel.test.ts`; this file asserts WIRING — that the gate actually
 * withholds/renders the DOM, that the jump actually scrolls+focuses with
 * NO dispatch, and that the meter is genuinely `aria-hidden`.
 * ------------------------------------------------------------------ */

describe('T18 — RecommendationsBlock strip (§3.5)', () => {
  function recsAgentRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
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
  function recsFimRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
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
  function recsEmbeddingRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
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
  function recsNextRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
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

  function recsCatalog(): SetupCatalogModel[] {
    return [recsAgentRow(), recsFimRow(), recsEmbeddingRow(), recsNextRow()];
  }

  function recsData(overrides: Partial<SetupData> = {}): SetupData {
    return baseData({ catalog: { models: recsCatalog() }, ...overrides });
  }

  describe('render gate (B-F7)', () => {
    // Structural check (not just "no heading text") — the Agent card must
    // be the VERY FIRST element in the panel body, proving
    // `RecommendationsBlock` returned `null` (no DOM node at all), not some
    // OTHER, unlabelled markup. `ready: false` suppresses the (unrelated)
    // "You're ready" banner, which would otherwise be a legitimate
    // preceding sibling of its own and mask this check.
    function agentCardHasNoPrecedingSibling(): void {
      const agentSection = must(document.getElementById('setup-card-agent'));
      expect(agentSection.previousElementSibling).toBeNull();
    }

    it('renders NOTHING when catalog is absent', () => {
      renderPanel(recsData({ catalog: undefined, ready: false }));
      expect(screen.queryByText('Recommended local models')).not.toBeInTheDocument();
      agentCardHasNoPrecedingSibling();
    });

    it('renders NOTHING when a defaultForRole row is missing (embedding, here)', () => {
      const models = recsCatalog().filter((m) => m.role !== 'embedding');
      renderPanel(recsData({ catalog: { models }, ready: false }));
      expect(screen.queryByText('Recommended local models')).not.toBeInTheDocument();
      agentCardHasNoPrecedingSibling();
    });

    it('renders the strip once all four defaults resolve', () => {
      renderPanel(recsData());
      expect(screen.getByText('Recommended local models')).toBeInTheDocument();
    });
  });

  it('renders the four role lines, each template-derived from the wire (B-F1/B-F5)', () => {
    renderPanel(recsData());
    expect(screen.getByText('Agent · Devstral-24B (2507) — 13.3 GiB')).toBeInTheDocument();
    expect(screen.getByText('FIM · Qwen2.5-Coder 1.5B (base) — 0.9 GiB')).toBeInTheDocument();
    expect(screen.getByText('Embedder · Qwen3-Embedding 0.6B — 0.6 GiB')).toBeInTheDocument();
    expect(screen.getByText('NEXT · Sweep Next-Edit v2 (7B) — 4.4 GiB')).toBeInTheDocument();
  });

  it('a catalog byte/name edit re-renders the strip correctly (B-F1 self-truing, no second drift-lock)', () => {
    const edited = recsCatalog().map((m) =>
      m.id === 'devstral-24b' ? { ...m, displayName: 'Mock-Agent-X', ollamaApproxBytes: 10_000_000_000 } : m,
    );
    renderPanel(recsData({ catalog: { models: edited } }));
    expect(screen.getByText(/Mock-Agent-X — 9\.3 GiB/)).toBeInTheDocument();
    expect(screen.queryByText(/Devstral-24B \(2507\)/)).not.toBeInTheDocument();
  });

  it('renders the strip ABOVE (before, in DOM order) the Agent card', () => {
    renderPanel(recsData());
    const recsHeading = screen.getByText('Recommended local models');
    const agentHeading = screen.getByText('Agent');
    // eslint-disable-next-line no-bitwise
    expect(recsHeading.compareDocumentPosition(agentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('every role line carries a Default chip (color-not-only: text chip, never color alone)', () => {
    renderPanel(recsData());
    const chips = screen.getAllByText('Default');
    // Four roles; NEXT's chip counts too because downloadReady defaults true in baseData()'s dedicated fixture.
    expect(chips.length).toBeGreaterThanOrEqual(4);
  });

  it('FIM divergence caption renders where the rounded tiers actually diverge (0.9 vs 1.5)', () => {
    renderPanel(recsData());
    expect(screen.getByText('llama.cpp build differs: 1.5 GiB')).toBeInTheDocument();
  });

  it('Agent/Embedding/NEXT carry NO divergence caption (rounded tiers equal)', () => {
    renderPanel(recsData());
    expect(screen.queryAllByText(/llama\.cpp build differs/)).toHaveLength(1);
  });

  /** The NEXT role line's OUTER row container (role text + chip live in an
   *  inner flex-wrap div; walking up once more reaches the row that also
   *  holds the vramLine/fail-closed paragraph + jump button) — scoping here
   *  is required because `Default`/the fail-closed text are NOT unique
   *  across the strip's four rows. */
  function nextRowContainer(): HTMLElement {
    const roleSpan = screen.getByText('NEXT · Sweep Next-Edit v2 (7B) — 4.4 GiB');
    const innerDiv = must(roleSpan.closest('div'));
    return must(innerDiv.parentElement);
  }

  describe('NEXT/Sweep fail-closed (§3.5) — never "recommended" while unpinned', () => {
    it('downloadReady: true -> Default chip + vramLine (same vocabulary as the other three roles)', () => {
      renderPanel(
        recsData({
          nextEdit: {
            ...baseData().nextEdit,
            dedicated: { ...must(baseData().nextEdit.dedicated), downloadReady: true },
          },
        }),
      );
      const nextLine = must(nextRowContainer());
      expect(within(nextLine).getByText('Default')).toBeInTheDocument();
      expect(within(nextLine).getByText('Q4 ≈ 5 GB')).toBeInTheDocument();
      expect(screen.queryByText(NEXT_DOWNLOAD_UNAVAILABLE_TEXT)).not.toBeInTheDocument();
    });

    it("downloadReady: false -> the NEXT card's own fail-closed text, NO Default chip on that row", () => {
      renderPanel(
        recsData({
          nextEdit: {
            ...baseData().nextEdit,
            dedicated: { ...must(baseData().nextEdit.dedicated), downloadReady: false },
          },
        }),
      );
      const nextLine = must(nextRowContainer());
      expect(within(nextLine).getByText(NEXT_DOWNLOAD_UNAVAILABLE_TEXT)).toBeInTheDocument();
      expect(within(nextLine).queryByText('Default')).not.toBeInTheDocument();
      expect(within(nextLine).queryByText(/recommended/i)).not.toBeInTheDocument();
    });
  });

  describe('stack line + meter (B-F1/B-F3) — one derivation, two renderings', () => {
    it('the stack line (text-equivalent) is present', () => {
      renderPanel(recsData());
      expect(
        screen.getByText(
          'A 24 GB GPU runs the full stack: Devstral-24B (2507) (13.3 GiB) + Qwen2.5-Coder 1.5B (base) (0.9 GiB) + ' +
            'Qwen3-Embedding 0.6B (0.6 GiB) ≈ 14.9 GiB — about 7.1 GiB left for context (roughly 45K tokens at ' +
            "fp16 KV — see Part 0.2's fit model).",
        ),
      ).toBeInTheDocument();
    });

    it('the meter is aria-hidden (decorative only — the stack line above it is the text-equivalent)', () => {
      renderPanel(recsData());
      const recsSection = must(screen.getByText('Recommended local models').closest('section'));
      const meter = recsSection.querySelector('[aria-hidden="true"]');
      expect(meter).toBeInTheDocument();
      // Exactly 3 fill segments inside the aria-hidden track (agent/fim/embedding).
      expect(meter?.children).toHaveLength(3);
    });
  });

  describe('<details> disclosure (B-F1/B-F4) — default-closed, tier lines + MoE note', () => {
    it('is closed by default', () => {
      renderPanel(recsData());
      const recsSection = must(screen.getByText('Recommended local models').closest('section'));
      const details = recsSection.querySelector('details');
      expect(details?.open).toBe(false);
    });

    it('contains all four tier lines with gpt-oss-20b in the 16 GB bucket (fallback text when the 7B/gpt-oss rows are absent from this fixture)', () => {
      renderPanel(recsData());
      const summary = screen.getByText('What fits my hardware?');
      const details = must(summary.closest('details'));
      expect(within(details).getByText(/~8 GB:/)).toBeInTheDocument();
      expect(within(details).getByText(/12–16 GB:/)).toBeInTheDocument();
      expect(within(details).getByText(/24 GB:/)).toBeInTheDocument();
      expect(within(details).getByText(/32 GB\+:/)).toBeInTheDocument();
    });

    it('carries the MoE honesty note verbatim', () => {
      renderPanel(recsData());
      expect(
        screen.getByText(
          'MoE ≠ smaller: a 35B MoE still needs ~20 GiB for weights — only compute is light (~3B active per token).',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('Set up → jump (B-F6) — in-panel scroll + focus, NEVER dispatch/expand', () => {
    it('clicking the Agent row’s jump scrolls + focuses the Agent card heading, and issues NO dispatch', async () => {
      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
      const { user, dispatch } = renderPanel(recsData());
      const btn = screen.getByRole('button', { name: 'Set up → Agent card' });
      await user.click(btn);
      expect(scrollSpy).toHaveBeenCalled();
      expect(document.activeElement?.id).toBe('setup-card-agent-heading');
      expect(dispatch).not.toHaveBeenCalled();
      scrollSpy.mockRestore();
    });

    it('clicking the NEXT row’s jump targets the NEXT card, not the Agent card', async () => {
      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
      const { user, dispatch } = renderPanel(recsData());
      const btn = screen.getByRole('button', { name: 'Set up → NEXT card' });
      await user.click(btn);
      expect(document.activeElement?.id).toBe('setup-card-next-heading');
      expect(dispatch).not.toHaveBeenCalled();
      scrollSpy.mockRestore();
    });

    it('clicking a jump does NOT expand any card (e.g. the NEXT card’s "Manage dedicated setup" form stays collapsed)', async () => {
      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
      const { user } = renderPanel(recsData());
      await user.click(screen.getByRole('button', { name: 'Set up → NEXT card' }));
      // Scoped to the NEXT card itself (other cards render their OWN,
      // unrelated "Endpoint" fields unconditionally) — the dedicated-NEXT
      // form's Endpoint field only renders once the form is expanded, and
      // must still be absent there after the jump.
      const nextCard = must(document.getElementById('setup-card-next'));
      expect(within(nextCard).queryByLabelText('Endpoint')).not.toBeInTheDocument();
      scrollSpy.mockRestore();
    });
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 panel-fix PT4 (architecture T4, §3.2): the FIM card's model-
 * selection surface — Connect-tab Model field, selectable catalog rows,
 * the one pending draft, and the honest presence-scoped done line.
 * FIM ≠ RAG: nothing here may ever touch a `talaria.rag.*` write —
 * `setup.applyFim` is the ONLY save this surface dispatches.
 * ------------------------------------------------------------------ */

/** A library-tier FIM catalog row matching `baseData()`'s SAVED fim.model. */
function qwenFimRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'qwen-fim',
    role: 'fim',
    displayName: 'Qwen2.5 Coder 1.5B (base)',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    defaultForRole: true,
    vramLine: '~1 GB',
    progressId: 'qwen-fim',
    ollamaTag: 'qwen2.5-coder:1.5b-base',
    ollamaApproxBytes: 986_000_000,
    ...overrides,
  };
}

/** A second FIM row that is NOT on the fixture daemon — its Pull is live. */
function deepseekFimRow(overrides: Partial<SetupCatalogModel> = {}): SetupCatalogModel {
  return {
    id: 'deepseek-fim',
    role: 'fim',
    displayName: 'DeepSeek Coder 6.7B (base)',
    publisher: 'DeepSeek',
    license: 'MIT',
    vramLine: '~4 GB',
    progressId: 'deepseek-fim',
    ollamaTag: 'deepseek-coder:6.7b-base',
    ollamaApproxBytes: 3_800_000_000,
    ...overrides,
  };
}

/** `baseData` + a role-filtered FIM catalog (qwen = saved/present, deepseek = pullable). */
function fimSelectionData(overrides: Partial<SetupData> = {}): SetupData {
  return baseData({
    catalog: { models: [sweepNextRow(), qwenFimRow(), deepseekFimRow()] },
    ...overrides,
  });
}

function fimCardEl() {
  return must(screen.getByText('Autocomplete (FIM)').closest('section'));
}

describe('PT4 — FIM Connect-tab Model field (§3.2)', () => {
  it('(b) Apply carries the trimmed pending model in params (visible-value rule)', async () => {
    const { user, dispatch } = renderPanel(fimSelectionData());
    const field = screen.getByRole('textbox', { name: 'Model' });
    await user.clear(field);
    await user.type(field, 'starcoder2:3b');
    await user.click(within(fimCardEl()).getByRole('button', { name: 'Apply' }));
    expect(dispatch).toHaveBeenCalledWith('setup.applyFim', {
      backendId: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'starcoder2:3b',
    });
  });

  it('(c) an EMPTY Model field omits the model key entirely — Apply never writes an empty model', async () => {
    const { user, dispatch } = renderPanel(fimSelectionData());
    await user.clear(screen.getByRole('textbox', { name: 'Model' }));
    await user.click(within(fimCardEl()).getByRole('button', { name: 'Apply' }));
    const call = dispatch.mock.calls.find((c) => c[0] === 'setup.applyFim');
    expect(call?.[1]).toEqual({ backendId: 'ollama', endpoint: 'http://127.0.0.1:11434' });
    expect(call?.[1]).not.toHaveProperty('model');
  });

  it('(e) llamacpp Connect tab: NO Model field — the honest no-model-name note instead', () => {
    renderPanel(baseData({ fim: { ...baseData().fim, options: [llamacppOption()], selectedId: 'llamacpp' } }));
    expect(screen.queryByRole('textbox', { name: 'Model' })).not.toBeInTheDocument();
    expect(screen.getByText(FIM_LLAMACPP_MODEL_NOTE)).toBeInTheDocument();
  });

  it('(h) after typing a draft, switching to llamacpp and Applying never carries a model key (C1-1)', async () => {
    const data = baseData({
      fim: { ...baseData().fim, options: [ollamaOption(), llamacppOption()], selectedId: 'ollama' },
    });
    const { user, dispatch } = renderPanel(data);
    const field = screen.getByRole('textbox', { name: 'Model' });
    await user.clear(field);
    await user.type(field, 'starcoder2:3b');
    await user.click(screen.getByRole('button', { name: 'llama.cpp' }));
    await user.click(within(fimCardEl()).getByRole('button', { name: 'Apply' }));
    const call = dispatch.mock.calls.find((c) => c[0] === 'setup.applyFim');
    expect(call?.[1]).toEqual({ backendId: 'llamacpp', endpoint: 'http://127.0.0.1:8012' });
    expect(call?.[1]).not.toHaveProperty('model');
  });

  it('(i) a backend switch resets the pending draft to the SAVED model (C1-4)', async () => {
    const { user } = renderPanel(fimSelectionData());
    const field = screen.getByRole('textbox', { name: 'Model' });
    await user.clear(field);
    await user.type(field, 'starcoder2:3b');
    await user.click(screen.getByRole('button', { name: 'Codestral' }));
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('qwen2.5-coder:1.5b-base');
  });

  it('(g) an EXTERNAL fim.selectedId change re-highlights the backend picker (A6)', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const mk = (d: SetupData) => (
      <SetupPanel
        data={{ status: 'success', data: d }}
        onRetry={noopRetry}
        progress={{}}
        nextEdit={{ next: false, generic: true }}
        onToggleNextEdit={vi.fn().mockResolvedValue(undefined)}
        dispatch={dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>}
      />
    );
    const { rerender } = render(mk(fimSelectionData()));
    expect(screen.getByRole('button', { name: 'Ollama' })).toHaveAttribute('aria-pressed', 'true');
    rerender(mk(fimSelectionData({ fim: { ...baseData().fim, selectedId: 'codestral' } })));
    expect(screen.getByRole('button', { name: 'Codestral' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Ollama' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('PT4 — FIM Install-tab selectable rows + pending draft (§3.2)', () => {
  it('(a) catalog Pull success selects the row: highlight + pending line + Connect Model field — and NO settings write (pull ≠ save)', async () => {
    const { user, dispatch } = renderPanel(fimSelectionData());
    await user.click(screen.getByRole('button', { name: 'Install locally' }));
    await user.click(screen.getByRole('button', { name: /^Pull deepseek-coder:6\.7b-base/ }));
    const row = screen.getByRole('button', { name: 'DeepSeek Coder 6.7B (base)' });
    await waitFor(() => expect(row).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText(pendingSelectionLine('fim', 'deepseek-coder:6.7b-base'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('deepseek-coder:6.7b-base');
    // The ONLY dispatch was the pull itself — no applyFim, no settings write.
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['setup.provisionModel']);
  });

  it('(d) free text un-highlights every catalog row (selection is DERIVED from the draft)', async () => {
    const { user } = renderPanel(fimSelectionData());
    await user.click(screen.getByRole('button', { name: 'Install locally' }));
    // The saved model matches the qwen row — highlighted via the derived rule.
    expect(screen.getByRole('button', { name: 'Qwen2.5 Coder 1.5B (base)' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const field = screen.getByRole('textbox', { name: 'Model' });
    await user.clear(field);
    await user.type(field, 'my-custom-model');
    await user.click(screen.getByRole('button', { name: 'Install locally' }));
    for (const name of ['Qwen2.5 Coder 1.5B (base)', 'DeepSeek Coder 6.7B (base)']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('(j) a pull completing AFTER a newer free-text edit does NOT overwrite it (C1-6 snapshot/no-clobber)', async () => {
    let resolvePull: ((v: unknown) => void) | undefined;
    const dispatch = vi.fn().mockImplementation((method: SetupMethod) =>
      method === 'setup.provisionModel'
        ? new Promise((resolve) => {
            resolvePull = resolve;
          })
        : Promise.resolve(undefined),
    );
    const { user } = renderPanel(fimSelectionData(), {
      dispatch: dispatch as (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>,
    });
    await user.click(screen.getByRole('button', { name: 'Install locally' }));
    await user.click(screen.getByRole('button', { name: /^Pull deepseek-coder:6\.7b-base/ }));
    // A newer edit lands while the multi-GB pull is still in flight.
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const field = screen.getByRole('textbox', { name: 'Model' });
    await user.clear(field);
    await user.type(field, 'my-newer-choice');
    await act(async () => {
      must(resolvePull)(undefined);
    });
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('my-newer-choice');
  });

  it("(k) the ConfiguredModelRow's pull success selects ITS (out-of-catalog) model (C1-2)", async () => {
    const data = fimSelectionData({
      fim: { ...baseData().fim, model: 'my-legacy-model' },
      ollama: { ...baseData().ollama, models: [] },
    });
    const { user, dispatch } = renderPanel(data);
    const field = screen.getByRole('textbox', { name: 'Model' });
    await user.clear(field);
    await user.type(field, 'typed-draft');
    await user.click(screen.getByRole('button', { name: 'Install locally' }));
    await user.click(screen.getByRole('button', { name: 'Pull my-legacy-model' }));
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith('setup.pullModel', { model: 'my-legacy-model', endpoint: 'http://127.0.0.1:11434' }),
    );
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('my-legacy-model'));
  });
});

describe('PT4 — FIM done line is endpoint-scoped presence for ollama (audit A4)', () => {
  const FIM_GREEN = '✓ Autocomplete is active — open a file and start typing.';

  it('daemon down ⇒ NO green line', () => {
    renderPanel(baseData({ ollama: { ...baseData().ollama, running: false } }));
    expect(screen.queryByText(FIM_GREEN)).not.toBeInTheDocument();
  });

  it('model absent from the daemon ⇒ NO green line', () => {
    renderPanel(baseData({ ollama: { ...baseData().ollama, models: [] } }));
    expect(screen.queryByText(FIM_GREEN)).not.toBeInTheDocument();
  });

  it('saved endpoint ≠ probed endpoint ⇒ NO green line (unknown, never a guess)', () => {
    const opt = ollamaOption({ remote: { ...must(ollamaOption().remote), endpointValue: 'http://127.0.0.1:9999' } });
    renderPanel(baseData({ fim: { ...baseData().fim, options: [opt, codestralOption()], selectedId: 'ollama' } }));
    expect(screen.queryByText(FIM_GREEN)).not.toBeInTheDocument();
  });

  it('present at the saved endpoint ⇒ green', () => {
    renderPanel(baseData());
    expect(screen.getByText(FIM_GREEN)).toBeInTheDocument();
  });

  it('non-ollama backend: TODAY\'s auth-based rule, presence never consulted (daemon down stays green)', () => {
    const withKey = codestralOption({ remote: { ...must(codestralOption().remote), apiKeySet: true } });
    renderPanel(
      baseData({
        fim: { ...baseData().fim, options: [withKey], selectedId: 'codestral' },
        ollama: { ...baseData().ollama, running: false },
      }),
    );
    expect(screen.getByText(FIM_GREEN)).toBeInTheDocument();
  });
});
