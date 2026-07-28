// nextedit/config.ts — DATA ONLY. The on/off toggles live in the Guard's store (guard.ts).
import * as vscode from 'vscode';
import type { NextEditTransportId } from './types';

const TRANSPORT_IDS: readonly NextEditTransportId[] = ['ollama', 'openai-compat'];

export interface HermesNextEditConfig {
  backend: NextEditTransportId;
  endpoint: string;
  model: string;
}

export function readNextEditConfig(): HermesNextEditConfig {
  const cfg = vscode.workspace.getConfiguration('hermes.nextEdit');
  const rawBackend = cfg.get<string>('backend', 'ollama').trim();
  return {
    backend: (TRANSPORT_IDS as readonly string[]).includes(rawBackend)
      ? (rawBackend as NextEditTransportId) : 'ollama',
    endpoint: cfg.get<string>('endpoint', '').trim(),
    model: cfg.get<string>('model', '').trim(),
  };
}
