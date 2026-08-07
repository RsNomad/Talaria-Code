/**
 * DOM-level tests for `LocalModelBlock` (beta.6 T10, plan doc §4.1) — the
 * shared "Local Model" component every future surface (FIM/Agent/NEXT/RAG,
 * T11-T14) embeds. Scope mirrors `SetupPanel.dom.test.tsx`: assert WIRING —
 * that a given wire fixture renders the right §4.1 cell text/buttons, and
 * that a click reaches `dispatch` with the right method/params. Pure
 * derivations (`catalogPresence`, button-label helpers, the preselect rule,
 * the two verify-mode modal copies, the scoped source-scan) live in the pure
 * `SetupPanel.test.ts` alongside `setupCards.ts`'s other helpers.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SetupCatalogModel, SetupData } from '../protocol';
import { DECLINED } from '../state/panels';
import { LocalModelBlock, type LocalModelBlockProps } from './localModel';

function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

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
    llamacpp: {
      file: 'qwen2.5-coder-1.5b-q8_0.gguf',
      approxBytes: 1_646_573_056,
      present: false,
      available: true,
    },
    ...overrides,
  };
}

function ollamaWire(overrides: Partial<SetupData['ollama']> = {}): SetupData['ollama'] {
  return { running: true, endpoint: 'http://127.0.0.1:11434', models: [], ...overrides };
}

function baseProps(overrides: Partial<LocalModelBlockProps> = {}): LocalModelBlockProps {
  return {
    backend: 'ollama',
    models: [catalogModel()],
    ollama: ollamaWire(),
    llamacppRuntime: { binary: 'found', version: 'b4500' },
    endpoint: 'http://127.0.0.1:11434',
    progress: {},
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function renderBlock(overrides: Partial<LocalModelBlockProps> = {}) {
  const dispatch = vi.fn().mockResolvedValue({ ok: true });
  const props = baseProps({ dispatch, ...overrides });
  const utils = setup(<LocalModelBlock {...props} />);
  return { ...utils, dispatch };
}

/* ------------------------------------------------------------------ *
 * §4.1 — Ollama backend
 * ------------------------------------------------------------------ */

describe('LocalModelBlock — Ollama backend missing', () => {
  it('renders "Ollama daemon not detected." + Install + Re-check, AND the model row still renders', () => {
    renderBlock({ ollama: ollamaWire({ running: false }) });
    expect(screen.getByText('Ollama daemon not detected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /install ollama/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
    expect(screen.getByText('Qwen2.5-Coder 1.5B (base)')).toBeInTheDocument();
  });

  it('[Install] dispatches setup.openInstallTerminal for the ollama backend', async () => {
    const { user, dispatch } = renderBlock({ ollama: ollamaWire({ running: false }) });
    await user.click(screen.getByRole('button', { name: /install ollama/i }));
    expect(dispatch).toHaveBeenCalledWith('setup.openInstallTerminal', { backendId: 'ollama' });
  });

  it('[Re-check] dispatches the SCOPED setup.recheck {scope:"ollama"}', async () => {
    const { user, dispatch } = renderBlock({ ollama: ollamaWire({ running: false }) });
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck', { scope: 'ollama' });
  });

  it('daemon-down-disabled-Pull: the row Pull button is disabled WITH a reason (title names why)', () => {
    renderBlock({ ollama: ollamaWire({ running: false }) });
    const pull = screen.getByRole('button', { name: /Pull qwen2\.5-coder/ });
    expect(pull).toBeDisabled();
    expect(pull).toHaveAttribute('title', 'Install Ollama first — it performs the download.');
  });
});

describe('LocalModelBlock — Ollama backend ready', () => {
  it('renders "Ollama: Ready" and the row immediately (no gating)', () => {
    renderBlock({ ollama: ollamaWire({ running: true, version: '0.4.1' }) });
    expect(screen.getByText('Ollama: Ready — 0.4.1')).toBeInTheDocument();
    expect(screen.getByText('Qwen2.5-Coder 1.5B (base)')).toBeInTheDocument();
  });
});

describe('LocalModelBlock — Ollama model presence', () => {
  it('absent: shows "not present" + an ENABLED Pull button labeled with the tag + size', () => {
    renderBlock({ ollama: ollamaWire({ running: true, models: [] }) });
    expect(screen.getByText('not present')).toBeInTheDocument();
    const pull = screen.getByRole('button', { name: 'Pull qwen2.5-coder:1.5b-base (~940 MB)' });
    expect(pull).toBeEnabled();
  });

  it('clicking Pull dispatches setup.provisionModel keyed by the catalog id', async () => {
    const { user, dispatch } = renderBlock({ ollama: ollamaWire({ running: true, models: [] }) });
    await user.click(screen.getByRole('button', { name: /Pull qwen2\.5-coder/ }));
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'qwen25-coder-1.5b',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
  });

  it('present: shows "present" and NO Pull button', () => {
    renderBlock({ ollama: ollamaWire({ running: true, models: [{ name: 'qwen2.5-coder:1.5b-base', sizeBytes: 1 }] }) });
    expect(screen.getByText('present')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pull/ })).not.toBeInTheDocument();
  });

  it('presence unknowable (endpoint mismatch): shows the honest "Test the endpoint first" text, and the Pull button REMAINS', () => {
    renderBlock({
      ollama: ollamaWire({ running: true, endpoint: 'http://127.0.0.1:11434' }),
      endpoint: 'http://10.0.0.5:11434',
    });
    expect(screen.getByText('not verified here — Test the endpoint first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pull qwen2\.5-coder/ })).toBeInTheDocument();
  });
});

describe('LocalModelBlock — Ollama in-flight pull (CC-9)', () => {
  const inFlightProgress = {
    'pull:qwen25-coder-1.5b': { op: 'pull' as const, id: 'qwen25-coder-1.5b', logTail: [], totalBytes: 1000, completedBytes: 400 },
  };

  it('renders a progress bar keyed pull:<catalogId> + a Cancel button', () => {
    renderBlock({ ollama: ollamaWire({ running: true, models: [] }), progress: inFlightProgress });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Cancel dispatches setup.cancel {op:"pull", id:<catalogId>}', async () => {
    const { user, dispatch } = renderBlock({ ollama: ollamaWire({ running: true, models: [] }), progress: inFlightProgress });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dispatch).toHaveBeenCalledWith('setup.cancel', { op: 'pull', id: 'qwen25-coder-1.5b' });
  });

  it('Cancel is NEVER trust-gated (stays enabled while disabledReason is set)', () => {
    renderBlock({ ollama: ollamaWire({ running: true, models: [] }), progress: inFlightProgress, disabledReason: 'Workspace is not trusted.' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });
});

/* ------------------------------------------------------------------ *
 * §4.1 — llama.cpp backend
 * ------------------------------------------------------------------ */

describe('LocalModelBlock — llama.cpp backend missing', () => {
  it('command available: renders the missing text + "Open terminal: {command}" + Re-check, rows render, Download stays ENABLED (SC-A-11)', () => {
    renderBlock({
      backend: 'llamacpp',
      llamacppRuntime: { binary: 'missing', install: { command: 'sudo pkgmgr install llama-cpp', guidance: 'Install via the detected package manager.', docsUrl: 'https://example.test/llamacpp' } },
    });
    expect(screen.getByText('llama-server was not found on your PATH. Install llama.cpp, then re-check.')).toBeInTheDocument();
    const install = screen.getByRole('button', { name: 'Open terminal: sudo pkgmgr install llama-cpp' });
    expect(install).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
    const download = screen.getByRole('button', { name: /Download Qwen2\.5-Coder/ });
    expect(download).toBeEnabled();
  });

  it('no command (guidance-only distro): shows guidance text + docs link, NO install button', () => {
    renderBlock({
      backend: 'llamacpp',
      llamacppRuntime: { binary: 'missing', install: { guidance: 'See the docs for your distro.', docsUrl: 'https://example.test/llamacpp' } },
    });
    expect(screen.getByText('See the docs for your distro.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /docs/i })).toHaveAttribute('href', 'https://example.test/llamacpp');
    expect(screen.queryByRole('button', { name: /Open terminal/ })).not.toBeInTheDocument();
  });

  it('[Re-check] dispatches the SCOPED setup.recheck {scope:"llamacpp"}', async () => {
    const { user, dispatch } = renderBlock({
      backend: 'llamacpp',
      llamacppRuntime: { binary: 'missing', install: { guidance: 'x', docsUrl: 'https://example.test' } },
    });
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(dispatch).toHaveBeenCalledWith('setup.recheck', { scope: 'llamacpp' });
  });
});

describe('LocalModelBlock — llama.cpp backend checking', () => {
  it('renders "Checking for llama-server…", rows render, Download stays enabled', () => {
    renderBlock({ backend: 'llamacpp', llamacppRuntime: { binary: 'checking' } });
    expect(screen.getByText('Checking for llama-server…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download Qwen2\.5-Coder/ })).toBeEnabled();
  });
});

describe('LocalModelBlock — llama.cpp backend unknown (probe-timeout / win32)', () => {
  it('renders the distinct "Couldn\'t check…" text and NEVER an install button, even when install.command is present', () => {
    renderBlock({
      backend: 'llamacpp',
      llamacppRuntime: { binary: 'unknown', install: { command: 'should never render', guidance: 'x', docsUrl: 'https://example.test' } },
    });
    expect(screen.getByText("Couldn't check for llama-server here — press Re-check.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open terminal/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeInTheDocument();
  });
});

describe('LocalModelBlock — llama.cpp backend ready', () => {
  it('renders "llama.cpp: Ready — {version}" and the row immediately', () => {
    renderBlock({ backend: 'llamacpp', llamacppRuntime: { binary: 'found', version: 'b4500' } });
    expect(screen.getByText('llama.cpp: Ready — b4500')).toBeInTheDocument();
  });
});

describe('LocalModelBlock — llama.cpp model presence', () => {
  it('honest absence (no llamacpp cell): renders the F-3/F-4 honest-absence line, no Download button', () => {
    renderBlock({ backend: 'llamacpp', models: [catalogModel({ llamacpp: undefined })] });
    expect(screen.getByText('No build of this model from a verified publisher exists for llama.cpp — use it via Ollama instead.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('unavailableReason overrides the generic honest-absence line when the host provides one', () => {
    renderBlock({
      backend: 'llamacpp',
      models: [catalogModel({ llamacpp: { file: 'x.gguf', approxBytes: 1, present: false, available: false, unavailableReason: 'a specific host reason' } })],
    });
    expect(screen.getByText('a specific host reason')).toBeInTheDocument();
  });

  it('absent: shows "not downloaded" + an ENABLED Download button labeled with displayName + size', () => {
    renderBlock({ backend: 'llamacpp' });
    expect(screen.getByText('not downloaded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Qwen2.5-Coder 1.5B (base) (~1.5 GB)' })).toBeEnabled();
  });

  it('clicking Download dispatches setup.provisionModel keyed by the catalog id, backend:"llamacpp"', async () => {
    const { user, dispatch } = renderBlock({ backend: 'llamacpp' });
    await user.click(screen.getByRole('button', { name: /Download Qwen2\.5-Coder/ }));
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'qwen25-coder-1.5b',
      backend: 'llamacpp',
      endpoint: 'http://127.0.0.1:11434',
    });
  });

  it('present: shows the sidecar-honest text, the start command, and a [Copy] button — never "verified" in the persistent line', () => {
    renderBlock({
      backend: 'llamacpp',
      models: [
        catalogModel({
          llamacpp: { file: 'x.gguf', approxBytes: 1_646_573_056, present: true, available: true, runCommand: 'llama-server -m /x/x.gguf --port 8080' },
        }),
      ],
    });
    expect(screen.getByText("present in Talaria's model folder")).toBeInTheDocument();
    expect(screen.getByText('llama-server -m /x/x.gguf --port 8080')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('[Copy] copies the exact run command to the clipboard', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const { user } = renderBlock({
      backend: 'llamacpp',
      models: [
        catalogModel({
          llamacpp: { file: 'x.gguf', approxBytes: 1, present: true, available: true, runCommand: 'llama-server -m /x/x.gguf --port 8080' },
        }),
      ],
    });
    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('llama-server -m /x/x.gguf --port 8080');
  });

  it('renders the wire\'s §6 note (base-build / mmproj / MoE / ctx) verbatim when present', () => {
    renderBlock({ backend: 'llamacpp', models: [catalogModel({ note: 'Base build (Q8) from ggml-org — the llama.cpp project’s own packaging of Qwen’s base model.' })] });
    expect(screen.getByText('Base build (Q8) from ggml-org — the llama.cpp project’s own packaging of Qwen’s base model.')).toBeInTheDocument();
  });
});

describe('LocalModelBlock — llama.cpp in-flight download (CC-9)', () => {
  const inFlightProgress = {
    'pull:qwen25-coder-1.5b': { op: 'pull' as const, id: 'qwen25-coder-1.5b', logTail: [], totalBytes: 2000, completedBytes: 1000 },
  };

  it('renders a progress bar keyed pull:<catalogId> + Cancel', () => {
    renderBlock({ backend: 'llamacpp', progress: inFlightProgress });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Cancel dispatches setup.cancel {op:"pull", id:<catalogId>} — the SAME op as the Ollama tier', async () => {
    const { user, dispatch } = renderBlock({ backend: 'llamacpp', progress: inFlightProgress });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dispatch).toHaveBeenCalledWith('setup.cancel', { op: 'pull', id: 'qwen25-coder-1.5b' });
  });
});

describe('LocalModelBlock — llama.cpp "everything done" (all rows present)', () => {
  it('shows the ready header + present rows + run commands, and NO Download buttons anywhere', () => {
    renderBlock({
      backend: 'llamacpp',
      llamacppRuntime: { binary: 'found', version: 'b4500' },
      models: [
        catalogModel({ id: 'a', displayName: 'Model A', llamacpp: { file: 'a.gguf', approxBytes: 1, present: true, available: true, runCommand: 'run a' } }),
        catalogModel({ id: 'b', displayName: 'Model B', llamacpp: { file: 'b.gguf', approxBytes: 1, present: true, available: true, runCommand: 'run b' } }),
      ],
    });
    expect(screen.getByText('llama.cpp: Ready — b4500')).toBeInTheDocument();
    expect(screen.getAllByText("present in Talaria's model folder")).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * §4.1 — vLLM backend
 * ------------------------------------------------------------------ */

describe('LocalModelBlock — vLLM backend (stateless: docs + Test, never "missing")', () => {
  it('renders Test + docs link regardless of any "status" — vLLM has no missing/checking/ready distinction', () => {
    renderBlock({ backend: 'vllm', vllmDocsUrl: 'https://docs.vllm.ai/' });
    expect(screen.getByRole('button', { name: /Test connection/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /docs/i })).toHaveAttribute('href', 'https://docs.vllm.ai/');
    expect(screen.queryByText(/not detected|missing|Checking/)).not.toBeInTheDocument();
  });

  it('model row with a composed run command: shows it + Copy — never a Pull/Download button', () => {
    renderBlock({ backend: 'vllm', models: [catalogModel({ vllm: { runCommand: 'vllm serve Qwen/Qwen2.5-Coder-1.5B' } })] });
    expect(screen.getByText('vllm serve Qwen/Qwen2.5-Coder-1.5B')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pull|Download/ })).not.toBeInTheDocument();
  });

  it('model row with NO composed command (compose-gate failed): renders no run-command block, never fabricates one', () => {
    renderBlock({ backend: 'vllm', models: [catalogModel({ vllm: undefined })] });
    expect(screen.queryByText(/^vllm serve/)).not.toBeInTheDocument();
  });

  it('Test connection label names the endpoint', () => {
    renderBlock({ backend: 'vllm', endpoint: 'http://127.0.0.1:8000' });
    expect(screen.getByRole('button', { name: 'Test connection (http://127.0.0.1:8000)' })).toBeInTheDocument();
  });
});

describe('LocalModelBlock — Serving line from the widened testRemote result', () => {
  it('after a green Test that returns models, renders "Serving: {models}"', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true, models: ['qwen2.5-coder:1.5b-base'] });
    const { user } = setup(<LocalModelBlock {...baseProps({ backend: 'llamacpp', dispatch })} />);
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    expect(await screen.findByText('Serving: qwen2.5-coder:1.5b-base')).toBeInTheDocument();
  });

  it('a Test with no models field renders no Serving line', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });
    const { user } = setup(<LocalModelBlock {...baseProps({ backend: 'llamacpp', dispatch })} />);
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/^Serving:/)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Cross-cutting: DECLINED, disabledReason scope, Default chip, picker
 * ------------------------------------------------------------------ */

describe('LocalModelBlock — DECLINED renders neutral (the C-2 lock, generalized)', () => {
  it('a Pull resolved with DECLINED shows neither a success flash nor an error line', async () => {
    const dispatch = vi.fn().mockResolvedValue(DECLINED);
    const { user } = setup(<LocalModelBlock {...baseProps({ dispatch, ollama: ollamaWire({ running: true, models: [] }), ollamaPullSuccessLabel: '✓ nudge' })} />);
    await user.click(screen.getByRole('button', { name: /Pull qwen2\.5-coder/ }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('✓ nudge')).not.toBeInTheDocument();
    expect(screen.queryByText(/^✗/)).not.toBeInTheDocument();
  });
});

describe('LocalModelBlock — disabledReason gates MUTATING actions only', () => {
  it('Pull is disabled with the trust reason; Test/Re-check/Cancel/Copy stay enabled', () => {
    const inFlightProgress = {
      'pull:qwen25-coder-1.5b': { op: 'pull' as const, id: 'qwen25-coder-1.5b', logTail: [], totalBytes: 100, completedBytes: 10 },
    };
    renderBlock({
      backend: 'llamacpp',
      llamacppRuntime: { binary: 'found', version: '1' },
      disabledReason: 'Workspace is not trusted — Setup changes are disabled in Restricted Mode.',
      progress: inFlightProgress,
      vllmDocsUrl: undefined,
    });
    const download = screen.getByRole('button', { name: /Download Qwen2\.5-Coder/ });
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute('title', 'Workspace is not trusted — Setup changes are disabled in Restricted Mode.');
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('llama.cpp install-terminal IS trust-gated (a mutating action)', () => {
    renderBlock({
      backend: 'llamacpp',
      llamacppRuntime: { binary: 'missing', install: { command: 'install it', guidance: 'x', docsUrl: 'https://example.test' } },
      disabledReason: 'Workspace is not trusted.',
    });
    expect(screen.getByRole('button', { name: 'Open terminal: install it' })).toBeDisabled();
  });
});

describe('LocalModelBlock — Default chip + picker preselect', () => {
  it('renders the "Default" chip on the row whose defaultForRole is true, and NOT on others', () => {
    renderBlock({
      models: [catalogModel({ id: 'a', displayName: 'Model A', defaultForRole: undefined }), catalogModel({ id: 'b', displayName: 'Model B', defaultForRole: true })],
    });
    const rowB = screen.getByText('Model B').closest('div');
    expect(rowB ? within(rowB).getByText('Default') : null).toBeInTheDocument();
    const rowA = screen.getByText('Model A').closest('div');
    expect(rowA ? within(rowA).queryByText('Default') : null).toBeNull();
  });

  it('when onSelect is provided, the preselected (selectedId) row is aria-pressed and clicking another row calls onSelect with its id', async () => {
    const onSelect = vi.fn();
    const models = [catalogModel({ id: 'a', displayName: 'Model A', defaultForRole: undefined }), catalogModel({ id: 'b', displayName: 'Model B', defaultForRole: true })];
    const { user } = renderBlock({ models, selectedId: 'b', onSelect });
    expect(screen.getByRole('button', { name: /Model B/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Model A/ })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: /Model A/ }));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('when onSelect is omitted, the row name renders as plain (non-interactive) text', () => {
    renderBlock({ models: [catalogModel({ displayName: 'Model A' })] });
    expect(screen.queryByRole('button', { name: /Model A/ })).not.toBeInTheDocument();
    expect(screen.getByText('Model A')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T12 — the two additive per-row slots the Agent surface uses
 * (`rowCaption`, `runCommandCaption`). Both are OPT-IN: omitted props
 * change nothing (every pre-T12 test above runs unchanged).
 * ------------------------------------------------------------------ */

describe('LocalModelBlock — rowCaption (T12): a per-row quiet caption slot', () => {
  it('renders the caption for rows the fn names, and nothing for rows it declines', () => {
    const models = [
      catalogModel(),
      catalogModel({ id: 'qwen25-coder-7b', displayName: 'Qwen2.5-Coder 7B (base)', ollamaTag: 'qwen2.5-coder:7b-base' }),
    ];
    renderBlock({ models, rowCaption: (m) => (m.id === 'qwen25-coder-1.5b' ? 'caption for the 1.5b row' : undefined) });
    expect(screen.getByText('caption for the 1.5b row')).toBeInTheDocument();
    expect(screen.getAllByText(/caption for the/)).toHaveLength(1);
  });
});

describe('LocalModelBlock — runCommandCaption (T12): rendered under a RENDERED run command only', () => {
  it('a present llamacpp row with a runCommand renders the caption under it', () => {
    const models = [
      catalogModel({
        llamacpp: {
          file: 'f.gguf',
          approxBytes: 1_000,
          present: true,
          available: true,
          runCommand: 'llama-server -m f.gguf --jinja --port 8013',
        },
      }),
    ];
    renderBlock({ backend: 'llamacpp', models, runCommandCaption: 'the pre-save caption' });
    expect(screen.getByText('llama-server -m f.gguf --jinja --port 8013')).toBeInTheDocument();
    expect(screen.getByText('the pre-save caption')).toBeInTheDocument();
  });

  it('an absent row (no run command) renders NO caption', () => {
    renderBlock({ backend: 'llamacpp', models: [catalogModel()], runCommandCaption: 'the pre-save caption' });
    expect(screen.queryByText('the pre-save caption')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 T13 — the additive `pinnedDownload` slot the NEXT surface uses
 * (§3.3: pinned-model semantics on the llama.cpp pane). OPT-IN: omitted,
 * every pre-T13 test above runs unchanged.
 * ------------------------------------------------------------------ */

describe('LocalModelBlock — pinnedDownload (T13, §3.3): the NEXT pinned-model llama.cpp cell', () => {
  const pinned = { label: 'Download model (~4.7 GB)', unavailableReason: 'No vetted build — fail closed.' };
  const sweepRow = (llamacpp: NonNullable<SetupCatalogModel['llamacpp']>) =>
    catalogModel({
      id: 'sweep-next',
      role: 'next',
      displayName: 'Sweep Next-Edit v2 (7B)',
      ollamaTag: undefined,
      ollamaCreatedName: 'sweep-next-edit-v2-7b:q4_k_m',
      llamacpp,
    });

  it('available:false WITHOUT a wire reason: renders the surface reason + the SAME button disabled-with-reason — never the generic honest-absence text', () => {
    renderBlock({
      backend: 'llamacpp',
      models: [sweepRow({ file: 's.gguf', approxBytes: 4_680_000_000, present: false, available: false })],
      pinnedDownload: pinned,
    });
    expect(screen.getByText('No vetted build — fail closed.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Download model (~4.7 GB)' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No vetted build — fail closed.');
    expect(screen.queryByText(/use it via Ollama instead/)).not.toBeInTheDocument();
    expect(screen.queryByText('not downloaded')).not.toBeInTheDocument();
  });

  it('a wire unavailableReason still WINS over pinnedDownload (host-asserted absence keeps its copy, no button)', () => {
    renderBlock({
      backend: 'llamacpp',
      models: [
        sweepRow({
          file: 's.gguf',
          approxBytes: 4_680_000_000,
          present: false,
          available: false,
          unavailableReason: 'a specific host reason',
        }),
      ],
      pinnedDownload: pinned,
    });
    expect(screen.getByText('a specific host reason')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download model (~4.7 GB)' })).not.toBeInTheDocument();
  });

  it('available:true + absent: the download button carries the PINNED label and dispatches setup.provisionModel', async () => {
    const { user, dispatch } = renderBlock({
      backend: 'llamacpp',
      models: [sweepRow({ file: 's.gguf', approxBytes: 4_680_000_000, present: false, available: true })],
      pinnedDownload: pinned,
      endpoint: 'http://127.0.0.1:8012',
    });
    const button = screen.getByRole('button', { name: 'Download model (~4.7 GB)' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'sweep-next',
      backend: 'llamacpp',
      endpoint: 'http://127.0.0.1:8012',
    });
  });

  it('the OLLAMA pane ignores pinnedDownload (llamacpp-scope lock): Pull keeps its own tag+size label', () => {
    renderBlock({ backend: 'ollama', models: [catalogModel()], pinnedDownload: pinned });
    expect(screen.getByRole('button', { name: 'Pull qwen2.5-coder:1.5b-base (~940 MB)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download model (~4.7 GB)' })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * beta.6 panel-fix T6 — `onOllamaPullSuccess` (opt-in): fires exactly when
 * an OLLAMA-pane Pull dispatch resolves with a result ≠ DECLINED. Never on
 * rejection, never on DECLINED, never on llama.cpp/vLLM Download. OPT-IN —
 * omitted, the ollama Pull path stays byte-identical.
 * ------------------------------------------------------------------ */

describe('LocalModelBlock — onOllamaPullSuccess (panel-fix T6)', () => {
  it('ollama Pull resolves non-DECLINED: calls onOllamaPullSuccess once with the row model', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });
    const onOllamaPullSuccess = vi.fn();
    const { user } = setup(
      <LocalModelBlock {...baseProps({ dispatch, ollama: ollamaWire({ running: true, models: [] }), onOllamaPullSuccess })} />,
    );
    await user.click(screen.getByRole('button', { name: /Pull qwen2\.5-coder/ }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOllamaPullSuccess).toHaveBeenCalledTimes(1);
    expect(onOllamaPullSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'qwen25-coder-1.5b' }));
  });

  it('ollama Pull REJECTS: onOllamaPullSuccess is NOT called, and the error still surfaces on the button', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('boom'));
    const onOllamaPullSuccess = vi.fn();
    const { user } = setup(
      <LocalModelBlock {...baseProps({ dispatch, ollama: ollamaWire({ running: true, models: [] }), onOllamaPullSuccess })} />,
    );
    await user.click(screen.getByRole('button', { name: /Pull qwen2\.5-coder/ }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOllamaPullSuccess).not.toHaveBeenCalled();
    expect(await screen.findByText('✗ boom')).toBeInTheDocument();
  });

  it('ollama Pull resolves DECLINED: onOllamaPullSuccess is NOT called (C-2 preserved: no success flash either)', async () => {
    const dispatch = vi.fn().mockResolvedValue(DECLINED);
    const onOllamaPullSuccess = vi.fn();
    const { user } = setup(
      <LocalModelBlock
        {...baseProps({ dispatch, ollama: ollamaWire({ running: true, models: [] }), onOllamaPullSuccess, ollamaPullSuccessLabel: '✓ nudge' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Pull qwen2\.5-coder/ }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOllamaPullSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText('✓ nudge')).not.toBeInTheDocument();
  });

  it('llama.cpp Download resolves: onOllamaPullSuccess is NOT called (wrong branch)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });
    const onOllamaPullSuccess = vi.fn();
    const { user } = renderBlock({ backend: 'llamacpp', dispatch, onOllamaPullSuccess });
    await user.click(screen.getByRole('button', { name: /Download Qwen2\.5-Coder/ }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOllamaPullSuccess).not.toHaveBeenCalled();
  });

  it('prop omitted: the ollama Pull still works and nothing throws (byte-identical path)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });
    const { user } = renderBlock({ dispatch, ollama: ollamaWire({ running: true, models: [] }) });
    await user.click(screen.getByRole('button', { name: /Pull qwen2\.5-coder/ }));
    expect(dispatch).toHaveBeenCalledWith('setup.provisionModel', {
      modelId: 'qwen25-coder-1.5b',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
  });
});
