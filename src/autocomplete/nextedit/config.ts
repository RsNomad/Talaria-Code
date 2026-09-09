// nextedit/config.ts — DATA ONLY. The on/off toggles live in the Guard's store (guard.ts).
import * as vscode from 'vscode';
import { isHttpUrl } from '../../shared/url';
import type { HermesNextEditConfig, NextEditTransportId } from './types';

const TRANSPORT_IDS: readonly NextEditTransportId[] = ['ollama', 'openai-compat'];

export function readNextEditConfig(): HermesNextEditConfig {
  const cfg = vscode.workspace.getConfiguration('talaria.nextEdit');
  const rawBackend = cfg.get<string>('backend', 'ollama').trim();
  const rawEndpoint = cfg.get<string>('endpoint', '').trim();
  return {
    backend: (TRANSPORT_IDS as readonly string[]).includes(rawBackend)
      ? (rawBackend as NextEditTransportId) : 'ollama',
    endpoint: rawEndpoint !== '' && isHttpUrl(rawEndpoint) ? rawEndpoint : '',
    model: cfg.get<string>('model', '').trim(),
  };
}
