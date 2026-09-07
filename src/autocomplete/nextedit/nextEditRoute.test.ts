import { describe, it, expect, vi } from 'vitest';

/**
 * WS-F3 F3-3 (FI-06) — the DIRECT whole-shape pin `nextEditRoute.ts`'s move
 * makes possible: `resolveRoute` was module-private in `shell.vscode.ts`, so
 * F3-1's golden could only observe `RouteResolution` INDIRECTLY, through the
 * route projected onto a mocked backend's construction options — it never
 * asserted `.route.format` at all (F3-1's own report named this the deferred
 * item this task discharges). Now that `resolveRoute` is exported, this file
 * calls it directly and asserts the WHOLE `RouteResolution` shape, format
 * field included, for every `kind` the type can produce.
 *
 * Kept in its own file (not added to `nextedit.golden.pure.test.ts` /
 * `nextedit.golden.shell.test.ts`) so those two stay pristine/0-edit, exactly
 * as F3-2's precedent already established for `nextEditText.ts`.
 *
 * `./config` is mocked (its own `config.test.ts` does the same, for the same
 * reason: `readNextEditConfig` reads `vscode.workspace.getConfiguration`
 * under the hood, and this file has no other reason to touch `vscode` at
 * all) — driving `cfg.backend`/`cfg.endpoint`/`cfg.model` per row without
 * pulling the vscode module into a file that has no other need of it.
 * `nextEditRoute.ts` itself imports `NextEditShellDeps` `type`-only from
 * `./shell.vscode`, which is erased at compile time — so importing
 * `resolveRoute` here never runtime-imports `shell.vscode.ts`, and this file
 * needs no `vi.mock('vscode', ...)` of its own.
 */

const nextEditCfg: { backend: 'ollama' | 'openai-compat'; endpoint: string; model: string } = {
  backend: 'ollama',
  endpoint: '',
  model: '',
};

vi.mock('./config', () => ({
  readNextEditConfig: () => ({
    backend: nextEditCfg.backend,
    endpoint: nextEditCfg.endpoint,
    model: nextEditCfg.model,
  }),
}));

import { resolveRoute, endpointLabel, DEFAULT_NEXT_EDIT_ENDPOINTS, type RouteResolution } from './nextEditRoute';
import { sweepV2Format } from './formats/sweepV2';
import { genericInstructFormat } from './formats/genericInstruct';
import type { NextEditShellDeps } from './shell.vscode';

function resetNextEditCfg(): void {
  nextEditCfg.backend = 'ollama';
  nextEditCfg.endpoint = '';
  nextEditCfg.model = '';
}

interface FakeGenericConfig {
  backend: string;
  endpoint: string;
  model: string;
  apiKey?: string;
}

function makeDeps(generic: FakeGenericConfig): NextEditShellDeps {
  return {
    reportFailure: () => {},
    getAutocompleteEndpoint: () => generic.endpoint,
    getAutocompleteModel: () => generic.model,
    getAutocompleteBackend: () => generic.backend,
    getAutocompleteApiKey: () => generic.apiKey,
  };
}

const NO_GENERIC_DEPS: NextEditShellDeps = makeDeps({ backend: 'ollama', endpoint: '', model: '' });

describe('direct pin: resolveRoute — whole-shape RouteResolution, format included (F3-1 deferred item #1, discharged)', () => {
  it('next / model set / empty endpoint: falls back to the ollama default, loopback, sweepV2Format', () => {
    resetNextEditCfg();
    nextEditCfg.backend = 'ollama';
    nextEditCfg.endpoint = '';
    nextEditCfg.model = 'sweep-next-edit-v2-7B';

    const resolution = resolveRoute('next', NO_GENERIC_DEPS);
    const expected: RouteResolution = {
      kind: 'route',
      route: {
        format: sweepV2Format,
        transport: 'ollama',
        apiBase: DEFAULT_NEXT_EDIT_ENDPOINTS.ollama,
        model: 'sweep-next-edit-v2-7B',
        remote: false,
      },
    };
    expect(resolution).toEqual(expected);
    if (resolution.kind === 'route') {
      expect(resolution.route.format).toBe(sweepV2Format);
      expect('apiKey' in resolution.route).toBe(false);
    }
  });

  it('next / openai-compat backend / empty endpoint: falls back to the openai-compat default', () => {
    resetNextEditCfg();
    nextEditCfg.backend = 'openai-compat';
    nextEditCfg.endpoint = '';
    nextEditCfg.model = 'sweep-next-edit-v2-7B';

    const resolution = resolveRoute('next', NO_GENERIC_DEPS);
    expect(resolution).toEqual({
      kind: 'route',
      route: {
        format: sweepV2Format,
        transport: 'openai-compat',
        apiBase: DEFAULT_NEXT_EDIT_ENDPOINTS['openai-compat'],
        model: 'sweep-next-edit-v2-7B',
        remote: false,
      },
    });
  });

  it('next / a REMOTE endpoint: remote true, everything else unchanged', () => {
    resetNextEditCfg();
    nextEditCfg.backend = 'ollama';
    nextEditCfg.endpoint = 'http://192.0.2.10:11434';
    nextEditCfg.model = 'sweep-next-edit-v2-7B';

    const resolution = resolveRoute('next', NO_GENERIC_DEPS);
    expect(resolution).toEqual({
      kind: 'route',
      route: {
        format: sweepV2Format,
        transport: 'ollama',
        apiBase: 'http://192.0.2.10:11434',
        model: 'sweep-next-edit-v2-7B',
        remote: true,
      },
    });
  });

  it("next / cfg.model === '': next-model-unset, no route built at all", () => {
    resetNextEditCfg();
    nextEditCfg.backend = 'ollama';
    nextEditCfg.endpoint = '';
    nextEditCfg.model = '';

    const resolution = resolveRoute('next', NO_GENERIC_DEPS);
    expect(resolution).toEqual({ kind: 'next-model-unset' });
  });

  it('generic / ollama backend, no key: route, genericInstructFormat, apiKey absent', () => {
    const deps = makeDeps({ backend: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' });
    const resolution = resolveRoute('generic', deps);
    const expected: RouteResolution = {
      kind: 'route',
      route: {
        format: genericInstructFormat,
        transport: 'ollama',
        apiBase: 'http://127.0.0.1:11434',
        model: 'qwen2.5-coder:7b',
        remote: false,
      },
    };
    expect(resolution).toEqual(expected);
    if (resolution.kind === 'route') {
      expect(resolution.route.format).toBe(genericInstructFormat);
      expect('apiKey' in resolution.route).toBe(false);
    }
  });

  it('generic / ollama backend, WITH a key: the key rides the route', () => {
    const deps = makeDeps({
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
      apiKey: 'sk-test-key',
    });
    const resolution = resolveRoute('generic', deps);
    expect(resolution).toEqual({
      kind: 'route',
      route: {
        format: genericInstructFormat,
        transport: 'ollama',
        apiBase: 'http://127.0.0.1:11434',
        model: 'qwen2.5-coder:7b',
        remote: false,
        apiKey: 'sk-test-key',
      },
    });
  });

  it('generic / vllm backend derives openai-compat', () => {
    const deps = makeDeps({ backend: 'vllm', endpoint: 'http://127.0.0.1:8000', model: 'm' });
    const resolution = resolveRoute('generic', deps);
    expect(resolution).toEqual({
      kind: 'route',
      route: {
        format: genericInstructFormat,
        transport: 'openai-compat',
        apiBase: 'http://127.0.0.1:8000',
        model: 'm',
        remote: false,
      },
    });
  });

  it('generic / a REMOTE endpoint: remote true', () => {
    const deps = makeDeps({ backend: 'ollama', endpoint: 'http://192.0.2.20:11434', model: 'm' });
    const resolution = resolveRoute('generic', deps);
    expect(resolution).toEqual({
      kind: 'route',
      route: {
        format: genericInstructFormat,
        transport: 'ollama',
        apiBase: 'http://192.0.2.20:11434',
        model: 'm',
        remote: true,
      },
    });
    if (resolution.kind === 'route') {
      expect(resolution.route.remote).toBe(true);
    }
  });

  it('generic / codestral backend: UNSUPPORTED, no route', () => {
    const deps = makeDeps({ backend: 'codestral', endpoint: 'http://127.0.0.1:8000', model: 'm' });
    const resolution = resolveRoute('generic', deps);
    expect(resolution).toEqual({ kind: 'generic-unsupported-backend', fimBackend: 'codestral' });
  });

  it('generic / openai-compat backend: ALSO unsupported (re-templates server-side)', () => {
    const deps = makeDeps({ backend: 'openai-compat', endpoint: 'http://127.0.0.1:8000', model: 'm' });
    const resolution = resolveRoute('generic', deps);
    expect(resolution).toEqual({ kind: 'generic-unsupported-backend', fimBackend: 'openai-compat' });
  });

  it('generic / empty endpoint: generic-unconfigured', () => {
    const deps = makeDeps({ backend: 'ollama', endpoint: '', model: 'm' });
    const resolution = resolveRoute('generic', deps);
    expect(resolution).toEqual({ kind: 'generic-unconfigured' });
  });

  it('generic / empty model: generic-unconfigured', () => {
    const deps = makeDeps({ backend: 'ollama', endpoint: 'http://127.0.0.1:11434', model: '' });
    const resolution = resolveRoute('generic', deps);
    expect(resolution).toEqual({ kind: 'generic-unconfigured' });
  });

  it("mode 'off': mode-off", () => {
    const resolution = resolveRoute('off', NO_GENERIC_DEPS);
    expect(resolution).toEqual({ kind: 'mode-off' });
  });

  it('endpointLabel: the host only, never userinfo, degrading gracefully on a malformed url', () => {
    expect(endpointLabel('http://example.test:8000')).toBe('example.test:8000');
    expect(endpointLabel('http://user:pass@example.test:8000')).toBe('example.test:8000');
    expect(endpointLabel('not a url')).toBe('the configured endpoint');
  });

  it('reach: both format singletons are actually exercised as .route.format (the point of this whole file)', () => {
    resetNextEditCfg();
    nextEditCfg.backend = 'ollama';
    nextEditCfg.endpoint = '';
    nextEditCfg.model = 'sweep-next-edit-v2-7B';
    const nextResolution = resolveRoute('next', NO_GENERIC_DEPS);
    const genericResolution = resolveRoute(
      'generic',
      makeDeps({ backend: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'm' }),
    );
    expect(nextResolution.kind).toBe('route');
    expect(genericResolution.kind).toBe('route');
    if (nextResolution.kind === 'route' && genericResolution.kind === 'route') {
      expect(nextResolution.route.format).toBe(sweepV2Format);
      expect(genericResolution.route.format).toBe(genericInstructFormat);
      expect(nextResolution.route.format).not.toBe(genericResolution.route.format);
    }
  });
});
