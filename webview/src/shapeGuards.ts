/**
 * WS-BG (SYN-BOUNDARY): the webview's runtime shape-guard kit for RPC
 * results resolved off `bridge.request(...)` — which only ever promises
 * `unknown`; the host's real return shape is a wire contract, not a
 * compile-time fact. Same thin single-source-of-truth posture as
 * `protocol.ts` (see its header): `isRecord`/`asShape` have exactly ONE
 * definition, in `src/shared/typeGuards.ts`, imported by both build targets.
 *
 * Guards are SHALLOW by design (ADR-BG: guards at ingress, never deep
 * validation) — they check the discriminating/top-level fields a panel
 * dereferences plus `Array.isArray` for list fields, never element shapes
 * (the panels' own defensive rendering carries element-level tolerance).
 * Server-enum fields (`HubScan.verdict`/`.policy`) are checked as STRINGS,
 * not literal sets, so a newer Hermes adding an enum member degrades in the
 * panel instead of refusing the whole result.
 */
import { isRecord } from '../../src/shared/typeGuards';
import type {
  CheckpointRestoreResult,
  HubInstallResult,
  HubPreview,
  HubScan,
  McpAddResult,
  McpCatalogData,
  McpCatalogInstallResult,
  McpTestResult,
} from './protocol';

export { asShape, isRecord } from '../../src/shared/typeGuards';

export function isMcpAddResult(x: unknown): x is McpAddResult {
  return isRecord(x) && x.ok === true && typeof x.name === 'string' && (x.transport === 'stdio' || x.transport === 'http');
}

export function isMcpTestResult(x: unknown): x is McpTestResult {
  return (
    isRecord(x) &&
    typeof x.ok === 'boolean' &&
    (x.error === undefined || typeof x.error === 'string') &&
    Array.isArray(x.tools)
  );
}

export function isMcpCatalogData(x: unknown): x is McpCatalogData {
  return isRecord(x) && Array.isArray(x.entries);
}

export function isMcpCatalogInstallResult(x: unknown): x is McpCatalogInstallResult {
  return isRecord(x) && x.ok === true && typeof x.name === 'string';
}

export function isHubPreview(x: unknown): x is HubPreview {
  return (
    isRecord(x) &&
    typeof x.name === 'string' &&
    typeof x.description === 'string' &&
    typeof x.source === 'string' &&
    typeof x.identifier === 'string' &&
    typeof x.trust_level === 'string' &&
    typeof x.skill_md === 'string' &&
    Array.isArray(x.files)
  );
}

export function isHubScan(x: unknown): x is HubScan {
  return (
    isRecord(x) &&
    typeof x.name === 'string' &&
    typeof x.identifier === 'string' &&
    typeof x.source === 'string' &&
    typeof x.trust_level === 'string' &&
    typeof x.verdict === 'string' &&
    typeof x.summary === 'string' &&
    typeof x.policy === 'string' &&
    typeof x.policy_reason === 'string' &&
    Array.isArray(x.findings) &&
    isRecord(x.severity_counts)
  );
}

export function isHubInstallResult(x: unknown): x is HubInstallResult {
  return isRecord(x) && x.ok === true && typeof x.name === 'string';
}

export function isCheckpointRestoreResult(x: unknown): x is CheckpointRestoreResult {
  if (!isRecord(x)) return false;
  if (x.restored === true) {
    return (
      typeof x.filesChanged === 'number' &&
      Array.isArray(x.changedPaths) &&
      (x.skippedPaths === undefined || Array.isArray(x.skippedPaths))
    );
  }
  if (x.restored === false) return typeof x.reason === 'string';
  return false;
}
