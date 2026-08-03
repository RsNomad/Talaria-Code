import { describe, it, expect } from 'vitest';
import { PANEL_SCOPE } from './protocol';
import type { DataPanel, Scope, SetupData, HostToWebview, SetupMethod, ControlRequestMethod } from './protocol';

/**
 * W6-FE Part 2 (3-way ARCH I-3a) — proves the explicit `PANEL_SCOPE` map
 * (which replaced the old `GlobalPanel = Exclude<DataPanel, ...>` silent
 * default) is BOTH exhaustive at compile time AND behavior-preserving at
 * runtime (every panel keeps its pre-refactor scope).
 */

describe('protocol — PANEL_SCOPE pins every panel\'s runtime scope UNCHANGED by the classification refactor', () => {
  it('matches the exact pre-refactor scope assignment (subagents:session, checkpoints:root, sessions:cwd, rest:global)', () => {
    expect(PANEL_SCOPE).toEqual({
      subagents: 'session',
      checkpoints: 'root',
      sessions: 'cwd',
      tools: 'global',
      mcp: 'global',
      skills: 'global',
      models: 'global',
      settings: 'global',
      setup: 'global',
    });
  });

  it('covers every DataPanel — no panel is silently omitted from the classification', () => {
    const panels: DataPanel[] = [
      'tools',
      'mcp',
      'skills',
      'checkpoints',
      'subagents',
      'sessions',
      'models',
      'settings',
      'setup',
    ];
    expect(Object.keys(PANEL_SCOPE).sort()).toEqual([...panels].sort());
  });
});

describe('protocol — PANEL_SCOPE is a COMPILE-TIME-exhaustive Record<DataPanel, Scope> (non-vacuous proof)', () => {
  it('a panel missing from the map fails `satisfies Record<DataPanel, Scope>` — the actual guarantee `PANEL_SCOPE`\'s own declaration enforces on every real edit', () => {
    // 'settings' is deliberately omitted below. This is the SAME compiler
    // check that fires against the real `PANEL_SCOPE` declaration
    // (protocol.ts) the moment a new panel is added to `PanelDataMap`
    // without a matching scope entry — a COMPILE error, not the old silent
    // global default. If this file ever fails to typecheck because the
    // `@ts-expect-error` below became unused, the exhaustiveness guarantee
    // itself has regressed.
    const incomplete = {
      subagents: 'session',
      checkpoints: 'root',
      sessions: 'cwd',
      tools: 'global',
      mcp: 'global',
      skills: 'global',
      models: 'global',
      setup: 'global',
      // @ts-expect-error — TS2741 "Property 'settings' is missing in type
      // ... but required in type 'Record<DataPanel, Scope>'."
    } satisfies Record<DataPanel, Scope>;
    expect(incomplete).toBeDefined();
  });

  it('a panel with an invalid Scope value also fails to compile (non-vacuous on the VALUE side too)', () => {
    const invalidValue = {
      subagents: 'session',
      checkpoints: 'root',
      sessions: 'cwd',
      tools: 'global',
      mcp: 'global',
      skills: 'global',
      models: 'global',
      setup: 'global',
      // @ts-expect-error — 'connection' is not a member of `Scope`.
      settings: 'connection',
    } satisfies Record<DataPanel, Scope>;
    expect(invalidValue).toBeDefined();
  });
});

/**
 * Task 8 (protocol v2, §6 of `docs_claude/onboarding-backend-setup-architecture.md`)
 * — the typed Setup panel contract. Types only: these are compile-time/shape
 * proofs, not behavior tests (the panel has no runtime yet).
 */
describe('protocol — Setup panel contract (Task 8)', () => {
  it("PANEL_SCOPE['setup'] is 'global', like 'settings'", () => {
    expect(PANEL_SCOPE['setup']).toBe('global');
  });

  it('a full SetupData fixture type-checks, including the nextEdit and rag blocks', () => {
    const fixture: SetupData = {
      trusted: true,
      agent: {
        options: [
          {
            id: 'hermes',
            kind: 'agent',
            status: 'available',
            displayName: 'Hermes',
            description: 'The default ACP agent backend.',
            remote: {
              endpointDefault: '',
              endpointValue: '',
              endpointPlaceholder: '',
              auth: 'none',
              apiKeySet: false,
              probe: 'none',
            },
            localInstall: {
              flavor: 'pipx',
              effort: 'one-script',
              models: [{ role: 'fim', model: 'qwen2.5-coder:1.5b-base', present: false }],
            },
            docsUrl: 'https://example.invalid/hermes',
          },
          {
            id: 'openclaw',
            kind: 'agent',
            status: 'coming-soon',
            displayName: 'OpenClaw',
            description: 'Coming soon.',
          },
        ],
        selectedId: 'hermes',
        phase: 'ready',
        version: '1.2.3',
        detail: undefined,
        logTail: ['pipx found', 'installing…', 'verifying', 'done'],
      },
      provider: {
        phase: 'configured',
        providerId: 'anthropic',
      },
      fim: {
        options: [
          {
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
          },
        ],
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
        probe: { ok: true, detail: 'reachable', models: ['qwen2.5-coder:1.5b-base'] },
      },
      nextEdit: {
        source: 'generic',
        backend: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        model: 'qwen2.5-coder:1.5b-base',
        dedicatedConfigured: false,
        genericSupported: true,
        refusalDetail: undefined,
      },
      rag: {
        enabled: false,
        embedEndpoint: 'http://127.0.0.1:11434',
        embedModel: 'nomic-embed-text',
        embedModelPresent: false,
        tuning: { dims: 768, maxChunkTokens: 512, debounceMs: 500, excludeGlobs: ['node_modules/**'] },
        indexDir: '.talaria/index',
        preconditionDetail: 'FIM must be configured first.',
      },
      ollama: {
        running: true,
        version: '0.4.1',
        models: [{ name: 'qwen2.5-coder:1.5b-base', sizeBytes: 986_000_000 }],
      },
      ready: false,
    };

    expect(fixture.nextEdit.source).toBe('generic');
    expect(fixture.nextEdit.genericSupported).toBe(true);
    expect(fixture.rag.enabled).toBe(false);
    expect(fixture.rag.tuning.excludeGlobs).toEqual(['node_modules/**']);
    expect(fixture.agent.phase).toBe('ready');
  });

  it("'setup.progress' narrows on 'type' to expose SetupProgress's fields", () => {
    const msg: HostToWebview = {
      type: 'setup.progress',
      op: 'pull',
      id: 'qwen2.5-coder:1.5b-base',
      phase: 'downloading',
      line: 'pulling manifest',
      totalBytes: 1_000_000,
      completedBytes: 250_000,
    };

    // Narrowing proof: outside the `if`, these fields are not known to exist
    // on the full HostToWebview union — only after discriminating on `type`
    // does TypeScript let us read SetupProgress's own fields.
    if (msg.type === 'setup.progress') {
      expect(msg.op).toBe('pull');
      expect(msg.id).toBe('qwen2.5-coder:1.5b-base');
      expect(msg.completedBytes).toBe(250_000);
    } else {
      throw new Error('unreachable — msg.type was set to setup.progress above');
    }
  });

  it('SetupMethod includes setup.setNextEdit | setup.setRag | setup.setTunable, and they flow into ControlRequestMethod', () => {
    const methods: SetupMethod[] = ['setup.setNextEdit', 'setup.setRag', 'setup.setTunable'];
    expect(methods).toEqual(['setup.setNextEdit', 'setup.setRag', 'setup.setTunable']);

    // Compile-time proof these three (and SetupMethod generally) are valid
    // ControlRequestMethod values — the surface `control.request` actually
    // carries on the wire.
    const asControlRequest: ControlRequestMethod[] = methods;
    expect(asControlRequest).toHaveLength(3);
  });
});
