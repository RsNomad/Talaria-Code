import { describe, it, expect } from 'vitest';
import { SetupPanelSource, type SetupStatusSource } from './setupPanelSource';
import type { SetupData } from '../../shared/protocol';

const FIXTURE: SetupData = {
  trusted: true,
  agent: { options: [], selectedId: 'hermes', phase: 'missing' },
  provider: { phase: 'waiting-agent' },
  fim: {
    options: [],
    selectedId: 'ollama',
    enabled: true,
    model: 'qwen2.5-coder:1.5b-base',
    endpointValue: '',
    tuning: {
      debounceMs: 350,
      maxPromptTokens: 1024,
      temperature: 0.01,
      crossFileEnabled: true,
      prefixInjection: false,
      prefixInjectionRemote: false,
      warmUp: false,
    },
  },
  nextEdit: {
    source: 'off',
    backend: 'ollama',
    endpoint: '',
    model: '',
    dedicatedConfigured: false,
    genericSupported: true,
  },
  rag: {
    enabled: true,
    embedEndpoint: 'http://127.0.0.1:11434',
    embedModel: 'qwen3-embedding:0.6b',
    embedModelPresent: false,
    tuning: { dims: 0, maxChunkTokens: 512, debounceMs: 500, excludeGlobs: [] },
    indexDir: '.hermes/index',
  },
  ollama: { running: false, models: [] },
  ready: false,
};

describe('SetupPanelSource: PanelSource<"setup"> wrapper over SetupController.status()', () => {
  it('resolves {data} with exactly what status() returns', async () => {
    let calls = 0;
    const controller: SetupStatusSource = {
      status: async () => {
        calls++;
        return FIXTURE;
      },
    };
    const source = new SetupPanelSource(controller);
    const outcome = await source.fetch();
    expect(outcome.data).toBe(FIXTURE);
    expect(calls).toBe(1);
  });

  it('propagates a status() rejection (no swallowing)', async () => {
    const controller: SetupStatusSource = {
      status: async () => {
        throw new Error('boom');
      },
    };
    const source = new SetupPanelSource(controller);
    await expect(source.fetch()).rejects.toThrow('boom');
  });
});
