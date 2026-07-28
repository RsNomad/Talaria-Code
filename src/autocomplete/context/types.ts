/**
 * Host-side cross-file context types (autocomplete v2, Wave 5 — cross-file only;
 * next-edit is deferred to W5.1 and deliberately has no representation here).
 *
 * The engine never sees `SnippetCandidate` — only the frozen `SnippetSnapshot` /
 * `ScannedSnippet[]` that has already passed the secret scanner. Nothing in this
 * file imports `vscode` or `fs`; it is pure and host-agnostic like `../types`.
 */
import type { CrossFileSnippet, CrossFileSnippetKind } from '../types';

/** The relevance key a background gather is tagged with (stale-drop, §2.4): a gather
 *  resolving after the cursor left this file/scope is dropped. */
export interface Anchor {
  uri: string;
  line: number;
}

export interface SnippetCandidate {
  uri: string;
  /** Workspace-relative POSIX path, computed at ingest (§2.5). */
  filepath: string;
  content: string; // immutable copy captured at ingest (no TOCTOU)
  kind: CrossFileSnippetKind;
  startLine: number;
  endLine: number;
  score?: number; // source-local relevance (recency rank / RRF); NEVER a cross-source priority
}

export interface SnippetSource {
  readonly kind: CrossFileSnippetKind;
  /** Background-only; MUST resolve or be raced out within GATHER_TIMEOUT_MS (100). */
  gather(anchor: Anchor, signal: AbortSignal): Promise<SnippetCandidate[]>;
}

/** EditTracker (T2) input — a raw edit observation. */
export interface EditEvent {
  uri: string;
  filepath: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** EditTracker (T2) output — a tracked recent edit (the ranges half only; no diff
 *  API this wave). */
export interface RecentEdit {
  uri: string;
  filepath: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** §3.2 — the by-construction security gate. `ScannedSnippet` is UNFORGEABLE outside
 *  ringBuffer.ts, which mints it ONLY inside `ingest`, after scanSnippetForSecrets
 *  returns allowed. No `as ScannedSnippet` anywhere else. */
declare const SCANNED: unique symbol;
export type ScannedSnippet = CrossFileSnippet & { readonly [SCANNED]: true };

/** The frozen, KV-stable snapshot handed to the provider (§2.4). */
export interface SnippetSnapshot {
  readonly snippets: readonly ScannedSnippet[];
}

/** Assembly mode per backend (§4.2) — the type; the `crossFileMode()` FUNCTION is T4. */
export type CrossFileMode = 'input-extra' | 'template' | 'comment-inject' | 'none';
