/**
 * Host-side context/menu resolution seam — port & shape definitions ONLY.
 *
 * S0 scaffolding (`docs/research/wave-2/00-architecture-and-paths.md` §2a
 * "Host-side context/menu resolution seam"): this file carries the pure
 * TYPES the later resolution work (T2) implements against — `resolver.ts`
 * (the impure shell, over these ports), `ports.vscode.ts` (the ONLY
 * `vscode`-importing file in this directory), `format.ts`, `sanitize.ts`,
 * `terminalCapture.ts`. `resolver.ts`/`ports.vscode.ts`/`terminalCapture.ts`/
 * `gitPort.ts` are still unbuilt (T2b) — `AgentBackend.sendPrompt`'s
 * `mentions` parameter (S0) stays unused until then. T2a (this pass) built
 * the pure units: `sanitize.ts`, `format.ts`, `acp/mentions.ts`.
 *
 * PURITY (§2a: "the port interfaces carry no `vscode` types, so every
 * consumer and every test stays headless"): this file imports NOTHING but
 * `shared/protocol.ts` (plain data types, no `vscode`/`node:fs`) — by
 * construction. Every port below is satisfied by an in-memory fake in tests
 * (the vscode-journal `InMemoryFileSystem` pattern) and by a thin
 * `vscode`-backed adapter at runtime (`ports.vscode.ts`, T2b).
 *
 * UNIFICATION DECIDED (T2a, closes the S0 Minor): `LineRange` /
 * `ContextRefKind` / `ContextRef` were structurally identical to the wire
 * shapes of the same names in `src/shared/protocol.ts` (§2e), previously
 * declared a second time, locally, in this file. `shared/protocol.ts` is now
 * the single source of truth — this file re-exports the three names instead
 * of redeclaring them, so existing importers of `context/types.ts` keep
 * working with zero drift risk (`tsc` proves it: one shape, one place).
 */

export type { ContextRef, ContextRefKind, LineRange } from '../../shared/protocol';
import type { ContextRef, LineRange } from '../../shared/protocol';

/**
 * The result of resolving one {@link ContextRef} against the workspace.
 * Per-ref failure/skip is DATA, not an exception (Cline's error-isolation
 * lesson, doc 01 §2.1) — a resolver never throws; it returns a `skipped`
 * entry instead, and the caller reports it into the transcript rather than
 * silently dropping it (§2a: "never a silent partial send").
 */
export interface ResolvedContext {
  ref: ContextRef;
  /** Synthetic or file:// uri — the structural boundary the mapper emits. */
  uri: string;
  title: string;
  /** Present for inlined kinds; absent for link-only (file/folder). */
  text?: string;
  /** true ⇒ emit resource_link, not an embedded resource. */
  linkOnly?: boolean;
  truncated?: boolean;
  /** Per-ref failure/skip is DATA, not an exception (Cline's error-isolation lesson, doc 01 §2.1). */
  skipped?: { reason: 'secret' | 'error' | 'unavailable'; detail: string };
}

/** Port over VS Code's diagnostics collection (the `problems` mention kind). */
export interface DiagnosticsPort {
  all(): { path: string; severity: 'error' | 'warning'; line: number; message: string; source?: string }[];
}

/** Port over the active editor's selection (the `selection` mention kind). */
export interface EditorPort {
  activeSelection(): { path: string; text: string; range: LineRange } | undefined;
}

/** Port over the workspace root(s) and file search (the `file`/`folder` mention kinds). */
export interface WorkspacePort {
  roots(): string[];
  findFiles(query: string, maxResults: number): Promise<string[]>;
}

/**
 * Port over the passive shell-integration terminal capture ring buffer (the
 * `terminal` mention kind). Backed by `terminalCapture.ts` (T2) — an impure,
 * disposable ring buffer, NOT a live PTY read (Hermes runs its own PTY;
 * source impossible without core edits — §3.1).
 */
export interface TerminalPort {
  capturedTail(maxLines: number): { name: string; text: string } | undefined;
}

/**
 * Port over the built-in `git` extension (the `git` mention kind, and
 * shared with commit-message generation — F-C). Backed by `gitPort.ts` (T2)
 * over the vendored `git.d.ts` API (`src/host/scm/`).
 */
export interface GitPort {
  stagedDiff(): Promise<string>;
  workingDiff(): Promise<string>;
  changedPaths(): Promise<{ path: string; staged: boolean }[]>;
  recentSubjects(n: number, author?: 'user'): Promise<string[]>;
  readInputBox(): string;
  writeInputBox(text: string): void;
  commitTemplate(): Promise<string | undefined>;
}
