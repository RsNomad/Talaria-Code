import { describe, it, expect } from 'vitest';
import { selectBackendKind, shouldActivateRag, shouldActivateLib } from './trustGate';

describe('selectBackendKind', () => {
  it('chooses acp only when configured AND the workspace is trusted', () => {
    expect(selectBackendKind('acp', true)).toBe('acp');
  });

  it('falls back to mock when acp is configured but the workspace is untrusted (C1: no RCE via pythonPath)', () => {
    expect(selectBackendKind('acp', false)).toBe('mock');
  });

  it('stays mock for the default backend regardless of trust', () => {
    expect(selectBackendKind('mock', true)).toBe('mock');
    expect(selectBackendKind('mock', false)).toBe('mock');
  });

  it('treats any unknown backend value as mock', () => {
    expect(selectBackendKind('', true)).toBe('mock');
    expect(selectBackendKind('something-else', true)).toBe('mock');
  });
});

describe('shouldActivateRag', () => {
  it('activates only when enabled, a workspace is open, trust is granted, AND the backend is acp', () => {
    expect(shouldActivateRag(true, true, true, 'acp')).toBe(true);
  });

  it('does NOT activate under the mock backend (CF-05: mock has no agent to call codebase_search — activating would walk/embed/index/watch the workspace for zero consumers, wasting egress+cost+disk)', () => {
    expect(shouldActivateRag(true, true, true, 'mock')).toBe(false);
  });

  it('does not activate in an untrusted workspace (C1: no file walk / embeddings POST)', () => {
    expect(shouldActivateRag(true, true, false, 'acp')).toBe(false);
  });

  it('does not activate when disabled or with no workspace', () => {
    expect(shouldActivateRag(false, true, true, 'acp')).toBe(false);
    expect(shouldActivateRag(true, false, true, 'acp')).toBe(false);
  });

  it('requires ALL FOUR conditions — acp backend alone is not sufficient without enabled/workspace/trust', () => {
    expect(shouldActivateRag(false, true, true, 'acp')).toBe(false);
    expect(shouldActivateRag(true, false, true, 'acp')).toBe(false);
    expect(shouldActivateRag(true, true, false, 'acp')).toBe(false);
  });
});

describe('shouldActivateLib', () => {
  it('activates only when enabled, a workspace is open, and trust is granted', () => {
    expect(shouldActivateLib(true, true, true)).toBe(true);
  });

  it('does not activate in an untrusted workspace (LIB never binds/advertises/exposes tools untrusted)', () => {
    expect(shouldActivateLib(true, true, false)).toBe(false);
  });

  it('does not activate when disabled or with no workspace', () => {
    expect(shouldActivateLib(false, true, true)).toBe(false);
    expect(shouldActivateLib(true, false, true)).toBe(false);
  });

  it('does not activate when all three are false', () => {
    expect(shouldActivateLib(false, false, false)).toBe(false);
  });
});
