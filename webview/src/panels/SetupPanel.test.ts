/*
 * Pure-logic tests for the Setup / Talaria Config panel's card-state
 * derivation helpers (`setupCards.ts`) — no React, no DOM (this repo's
 * `webview-pure` vitest project runs `*.test.ts` under `environment: 'node'`;
 * see `vitest.config.ts`). Rendered wiring (does the derived state actually
 * reach the screen, does a click actually dispatch) lives in the sibling
 * `SetupPanel.dom.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import type { AgentSetupPhase, SetupBackendOption, SetupProgress } from '../protocol';
import {
  agentPhaseLabel,
  agentPrimaryAction,
  clampLogTail,
  fimHasLocalInstall,
  foldSetupProgress,
  formatBytes,
  isComingSoon,
  mutationDisabledReason,
  nextEditButtonLabel,
  progressKey,
  pullPercent,
  PROGRESS_LOG_TAIL_MAX,
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
  it('every phase maps to SOME action descriptor (exhaustive, no throw)', () => {
    for (const phase of ALL_PHASES) {
      expect(() => agentPrimaryAction(phase)).not.toThrow();
    }
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
