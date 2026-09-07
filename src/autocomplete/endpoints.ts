import type { FimBackendName } from './types';

/** The shipped default endpoint per FIM backend. Single source of truth —
 *  config.ts (the vscode adapter) and the pure backendFactory.ts /
 *  nextEditRoute.ts all import this, rather than restating literals to keep
 *  their dependency surface off vscode (the reason the copies existed). */
export const DEFAULT_ENDPOINTS: Readonly<Record<FimBackendName, string>> = Object.freeze({
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8080',
  vllm: 'http://127.0.0.1:8000',
  codestral: 'https://codestral.mistral.ai',
  'openai-compat': 'http://127.0.0.1:8000',
});
