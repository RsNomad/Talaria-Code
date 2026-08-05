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
import type { AgentSetupPhase, SetupBackendOption, SetupData, SetupMethod } from '../protocol';
import { NEXT_EDIT_ROWS } from './nextEditCopy';
import { SetupPanel } from './SetupPanel';
import { agentPhaseLabel, PIPX_INSTALL_DOCS_URL, PYTHON_VERSION_HELP_URL, TRUST_DISABLED_REASON } from './setupCards';
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
  it('shows a computed percent from setup.progress bytes', async () => {
    const data = baseData({
      fim: {
        ...baseData().fim,
        options: [
          ollamaOption({
            localInstall: {
              flavor: 'guided-terminal',
              effort: 'one-script',
              models: [{ role: 'fim', model: 'qwen2.5-coder:1.5b-base', present: false }],
            },
          }),
        ],
        selectedId: 'ollama',
      },
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

  it('RAG card shows the done line once green', () => {
    renderPanel(baseData({ rag: { ...baseData().rag, enabled: true, embedModelPresent: true } }));
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

  it('llama.cpp (guided-terminal): keeps [Open terminal: install …] AND adds the §6 copy line + [Test connection ({endpoint})]', async () => {
    await openInstallTab(llamacppOption());
    expect(screen.getByRole('button', { name: /^Open terminal: install /i })).toBeInTheDocument();
    expect(
      screen.getByText('llama.cpp has no install detection — start your server, then test the connection.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection (http://127.0.0.1:8012)' })).toBeInTheDocument();
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
  it('shows the Download button when downloadReady + ollama-picked + presence absent, and dispatches setup.pullModel on click', async () => {
    const { user, dispatch } = renderPanel(baseData());
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    expect(within(nextCard).getByText('not present')).toBeInTheDocument();
    const button = within(nextCard).getByRole('button', { name: 'Download model (~4.7 GB)' });
    await user.click(button);
    expect(dispatch).toHaveBeenCalledWith('setup.pullModel', {
      model: 'sweep-next-edit-v2-7b:q4_k_m',
      endpoint: 'http://127.0.0.1:11434',
    });
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

describe('NEXT card — llama.cpp guided line (§4.3 point 5, S-F5 digest-verify hint)', () => {
  it('hidden when !downloadReady (no guided.llamacpp on the wire)', async () => {
    const data = baseData({
      fim: {
        ...baseData().fim,
        options: [ollamaOption(), llamacppOption({ nextEditTransport: 'openai-compat' })],
        selectedId: 'llamacpp',
      },
      nextEdit: {
        ...baseData().nextEdit,
        dedicated: {
          ...baseData().nextEdit.dedicated!,
          downloadReady: false,
          guided: { vllm: baseData().nextEdit.dedicated!.guided.vllm },
        },
      },
    });
    const { user } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(within(nextCard).queryByText(/llama-server -hf/)).not.toBeInTheDocument();
  });

  it('shown with the pinned digest + sha256sum hint when downloadReady', async () => {
    const data = baseData({
      fim: {
        ...baseData().fim,
        options: [ollamaOption(), llamacppOption({ nextEditTransport: 'openai-compat' })],
        selectedId: 'llamacpp',
      },
    });
    const { user } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    expect(
      within(nextCard).getByText('Run: llama-server -hf SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M --port 8012'),
    ).toBeInTheDocument();
    expect(within(nextCard).getByText(/Verify the download: sha256sum should print/)).toBeInTheDocument();
  });

  it('the truncated guided-command span carries a title attribute with the full command, for hover reveal (final-fixwave Fix 4)', async () => {
    const data = baseData({
      fim: {
        ...baseData().fim,
        options: [ollamaOption(), llamacppOption({ nextEditTransport: 'openai-compat' })],
        selectedId: 'llamacpp',
      },
    });
    const { user } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Set up dedicated NEXT' }));
    const nextCard = must(screen.getByText('Next Edit (NEXT)').closest('section'));
    await user.click(within(nextCard).getByRole('button', { name: 'llama.cpp' }));
    const commandLine = 'Run: llama-server -hf SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M --port 8012';
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
