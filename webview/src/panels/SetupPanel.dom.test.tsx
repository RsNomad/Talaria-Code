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
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSetupPhase, SetupBackendOption, SetupData, SetupMethod } from '../protocol';
import { NEXT_EDIT_ROWS } from './nextEditCopy';
import { SetupPanel } from './SetupPanel';
import { agentPhaseLabel, PYTHON_VERSION_HELP_URL, TRUST_DISABLED_REASON } from './setupCards';
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
    },
    rag: {
      enabled: false,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'nomic-embed-text',
      embedModelPresent: false,
      tuning: { dims: 768, maxChunkTokens: 512, debounceMs: 500, excludeGlobs: [] },
      indexDir: '.talaria/index',
    },
    ollama: { running: true, version: '0.4.1', models: [{ name: 'qwen2.5-coder:1.5b-base', sizeBytes: 986_000_000 }] },
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

describe('Agent card — pipx-missing gap-state (T11 IMPORTANT host-gap 2)', () => {
  it('renders the bootstrap-terminal button + [Re-check], not the old [Retry install]', () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing' } });
    renderPanel(data);
    expect(screen.getByRole('button', { name: 'Open terminal: sudo dnf install pipx' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry install' })).not.toBeInTheDocument();
  });

  it('clicking the bootstrap-terminal button dispatches setup.openBootstrapTerminal', async () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing' } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Open terminal: sudo dnf install pipx' }));
    expect(dispatch).toHaveBeenCalledWith('setup.openBootstrapTerminal');
  });

  it('clicking [Re-check] dispatches setup.recheck', async () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'pipx-missing' } });
    const { user, dispatch } = renderPanel(data);
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck');
  });

  it('the bootstrap-terminal button is trust-gated; [Re-check] stays usable (read-only, §8)', () => {
    const data = baseData({ trusted: false, agent: { ...baseData().agent, phase: 'pipx-missing' } });
    renderPanel(data);
    const terminalButton = screen.getByRole('button', { name: 'Open terminal: sudo dnf install pipx' });
    expect(terminalButton).toBeDisabled();
    expect(terminalButton.getAttribute('title')).toBe(TRUST_DISABLED_REASON);
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeEnabled();
  });
});

describe('Agent card — python-unsuitable docs link (T11 §6-parity minor)', () => {
  it('renders a docs link (falls back to PYTHON_VERSION_HELP_URL when the descriptor has no docsUrl)', () => {
    const data = baseData({ agent: { ...baseData().agent, phase: 'python-unsuitable', detail: 'found 3.14; needs 3.11-3.13' } });
    renderPanel(data);
    const link = screen.getByRole('link', { name: /python/i });
    expect(link).toHaveAttribute('href', PYTHON_VERSION_HELP_URL);
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
