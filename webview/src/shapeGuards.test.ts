import { describe, it, expect } from 'vitest';
import {
  isCheckpointRestoreResult,
  isHubInstallResult,
  isHubPreview,
  isHubScan,
  isMcpAddResult,
  isMcpCatalogData,
  isMcpCatalogInstallResult,
  isMcpTestResult,
} from './shapeGuards';

describe('webview RPC result guards — WS-BG (shallow by ADR-BG)', () => {
  it('isMcpAddResult', () => {
    expect(isMcpAddResult({ ok: true, name: 'gh', transport: 'stdio' })).toBe(true);
    expect(isMcpAddResult({ ok: true, name: 'gh', transport: 'http' })).toBe(true);
    expect(isMcpAddResult({ ok: true, name: 'gh', transport: 'ws' })).toBe(false);
    expect(isMcpAddResult({ ok: false, name: 'gh', transport: 'stdio' })).toBe(false);
    expect(isMcpAddResult(undefined)).toBe(false);
  });

  it('isMcpTestResult', () => {
    expect(isMcpTestResult({ ok: true, tools: [] })).toBe(true);
    expect(isMcpTestResult({ ok: false, error: 'x', tools: [] })).toBe(true);
    expect(isMcpTestResult({ ok: 'yes', tools: [] })).toBe(false);
    expect(isMcpTestResult({ ok: true, tools: 'none' })).toBe(false);
    expect(isMcpTestResult({ ok: true, error: 7, tools: [] })).toBe(false);
  });

  it('isMcpCatalogData / isMcpCatalogInstallResult / isHubInstallResult', () => {
    expect(isMcpCatalogData({ entries: [] })).toBe(true);
    expect(isMcpCatalogData({ entries: {} })).toBe(false);
    expect(isMcpCatalogInstallResult({ ok: true, name: 'gh' })).toBe(true);
    expect(isMcpCatalogInstallResult({ ok: true })).toBe(false);
    expect(isHubInstallResult({ ok: true, name: 's' })).toBe(true);
    expect(isHubInstallResult([])).toBe(false);
  });

  it('isHubPreview checks its top-level strings + files array', () => {
    const good = {
      name: 'n', description: 'd', source: 's', identifier: 'i',
      trust_level: 't', skill_md: 'md', files: ['SKILL.md'],
    };
    expect(isHubPreview(good)).toBe(true);
    expect(isHubPreview({ ...good, skill_md: 7 })).toBe(false);
    expect(isHubPreview({ ...good, files: 'SKILL.md' })).toBe(false);
  });

  it('isHubScan is type-shallow on verdict/policy (forward-compatible with new enum members)', () => {
    const good = {
      name: 'n', identifier: 'i', source: 's', trust_level: 't',
      verdict: 'safe', summary: 'ok', policy: 'allow', policy_reason: 'r',
      findings: [], severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
    };
    expect(isHubScan(good)).toBe(true);
    expect(isHubScan({ ...good, verdict: 'future-new-verdict' })).toBe(true);
    expect(isHubScan({ ...good, verdict: 7 })).toBe(false);
    expect(isHubScan({ ...good, findings: {} })).toBe(false);
    expect(isHubScan({ ...good, severity_counts: null })).toBe(false);
  });

  it('isCheckpointRestoreResult handles both discriminant arms', () => {
    expect(isCheckpointRestoreResult({ restored: true, filesChanged: 2, changedPaths: ['a'] })).toBe(true);
    expect(isCheckpointRestoreResult({ restored: true, filesChanged: 2, changedPaths: ['a'], skippedPaths: [] })).toBe(true);
    expect(isCheckpointRestoreResult({ restored: false, reason: 'dirty worktree' })).toBe(true);
    expect(isCheckpointRestoreResult({ restored: true, changedPaths: ['a'] })).toBe(false);
    expect(isCheckpointRestoreResult({ restored: false })).toBe(false);
    expect(isCheckpointRestoreResult({ restored: 'yes' })).toBe(false);
  });
});
