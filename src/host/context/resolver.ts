/**
 * `ContextResolver` — the impure-shell-but-headless core (§2a "Host-side
 * context/menu resolution seam") that turns webview-supplied `ContextRef[]`
 * into `ResolvedContext[]` over INJECTED ports. Never touches `vscode`
 * directly — every effectful operation is a port (T2c supplies the
 * `vscode`-backed adapters) or the injected `confine` fn, so this file (and
 * its tests) stay headless per §2a: "resolver.ts is tested with in-memory
 * port fakes ... port interfaces have zero `vscode` types so the tests
 * import no `vscode`."
 *
 * `resolveAll` NEVER throws (§2a): each ref resolves independently under a
 * per-ref try/catch AND a wall-clock deadline; a failed/slow resolver yields
 * a `skipped` entry instead of aborting the batch or rejecting — skips are
 * DATA, reported into the transcript later, never a silent partial send.
 *
 * Two fail-closed steps for `file`/`folder`, IN THIS ORDER (§2a/§2d):
 *   1. Workspace confinement FIRST — `confine(ref.path, workspace.roots())`.
 *   2. Secret gate SECOND — `isSecretPath` on the CONFINED canonical path.
 * A ref that is both secret-looking AND outside the workspace is skipped as
 * `error` (confinement denied it before the secret gate ever ran) — never
 * `secret`. See `resolver.test.ts`'s "ORDERING" test, which pins this.
 */

import { basename } from 'node:path';

import type { ContextRef } from '../../shared/protocol';
import { resolveWithinWorkspaceReal } from '../backend/acp/pathConfine';
import { formatDiagnostics, formatGit, formatSelection, formatTerminal } from './format';
import { CONTEXT_BUDGET, clampText, isSecretPath } from './sanitize';
import type { DiagnosticsPort, EditorPort, GitPort, ResolvedContext, TerminalPort, WorkspacePort } from './types';

export interface ResolverPorts {
  diagnostics: DiagnosticsPort;
  editor: EditorPort;
  workspace: WorkspacePort;
  terminal: TerminalPort;
  git: GitPort;
}

/** The confine primitive's shape (`resolveWithinWorkspaceReal`'s signature) — injected so tests stay headless. */
export type ConfineFn = (path: string, roots: readonly string[]) => Promise<string | null>;

export interface ResolverOptions {
  /** default: {@link resolveWithinWorkspaceReal} — injected so resolver tests need no real FS/vscode. */
  confine?: ConfineFn;
  /** Per-ref wall-clock budget; a resolver exceeding it yields `skipped{reason:'error', detail:'timed out'}`. */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 2000;

/** A stable, non-leaking synthetic uri for skipped entries — never rendered as a link (only `.skipped` is read). */
function skippedUri(kind: ContextRef['kind']): string {
  return `skipped:${kind}`;
}

function skip(
  ref: ContextRef,
  reason: 'secret' | 'error' | 'unavailable',
  detail: string,
  title: string,
): ResolvedContext {
  return { ref, uri: skippedUri(ref.kind), title, skipped: { reason, detail } };
}

/** Best-effort human title for an error/timeout skip, when no more specific title is available. */
function fallbackTitle(ref: ContextRef): string {
  return ref.path ? basename(ref.path) : ref.id;
}

function toErrorSkip(ref: ContextRef, err: unknown): ResolvedContext {
  const detail = err instanceof Error ? err.message : String(err);
  return skip(ref, 'error', detail, fallbackTitle(ref));
}

export class ContextResolver {
  private readonly ports: ResolverPorts;
  private readonly confine: ConfineFn;
  private readonly deadlineMs: number;

  constructor(ports: ResolverPorts, opts: ResolverOptions = {}) {
    this.ports = ports;
    this.confine = opts.confine ?? resolveWithinWorkspaceReal;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /**
   * Resolve every ref concurrently, preserving input order in the output
   * (`Promise.all` resolves by index regardless of completion timing).
   * `.catch` here is the aggregate guard (§2a): `resolveOne` already never
   * rejects (its own try/catch + deadline race only ever `resolve`s), so
   * this is defense-in-depth — `resolveAll` itself can never reject.
   */
  async resolveAll(refs: ContextRef[]): Promise<ResolvedContext[]> {
    return Promise.all(refs.map((ref) => this.resolveOne(ref).catch((err: unknown) => toErrorSkip(ref, err))));
  }

  private async resolveOne(ref: ContextRef): Promise<ResolvedContext> {
    try {
      return await this.withDeadline(this.dispatch(ref), ref);
    } catch (err) {
      return toErrorSkip(ref, err);
    }
  }

  /**
   * Race `work` against a `deadlineMs` timer. The timer settles (never
   * rejects) with a `timed out` skip, so a hanging port degrades to data,
   * not an unhandled rejection or a stuck batch. The timer is `unref`'d and
   * always cleared on the winning path so a hung fake never keeps the
   * process alive.
   */
  private withDeadline(work: Promise<ResolvedContext>, ref: ContextRef): Promise<ResolvedContext> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const settle = (result: ResolvedContext): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(result);
      };

      timer = setTimeout(() => settle(skip(ref, 'error', 'timed out', fallbackTitle(ref))), this.deadlineMs);
      timer.unref?.();

      work.then(settle, (err: unknown) => settle(toErrorSkip(ref, err)));
    });
  }

  private dispatch(ref: ContextRef): Promise<ResolvedContext> {
    switch (ref.kind) {
      case 'file':
      case 'folder':
        return this.resolveFileOrFolder(ref);
      case 'problems':
        return this.resolveProblems(ref);
      case 'selection':
        return this.resolveSelection(ref);
      case 'terminal':
        return this.resolveTerminal(ref);
      case 'git':
        return this.resolveGit(ref);
      default: {
        // Exhaustiveness check: a new ContextRefKind added without updating
        // this switch fails `tsc`. Also a runtime defensive floor for
        // webview-supplied refs that bypass the type system (§2a's
        // "untrusted-ish") — caught by resolveOne's try/catch as an error skip.
        const exhaustive: never = ref.kind;
        throw new Error(`unhandled context ref kind: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * `file`/`folder` — link-only (§3.1: the agent reads the file itself via
   * its own tools, so no text is inlined here). Confinement FIRST, secret
   * gate SECOND, both on the CONFINED canonical path (§2a/§2d).
   */
  private async resolveFileOrFolder(ref: ContextRef): Promise<ResolvedContext> {
    const rawPath = ref.path ?? '';
    const canonical = await this.confine(rawPath, this.ports.workspace.roots());
    if (canonical === null) {
      return skip(ref, 'error', 'outside workspace', rawPath ? basename(rawPath) : ref.id);
    }
    if (isSecretPath(canonical)) {
      return skip(ref, 'secret', 'secret-classified path', basename(canonical));
    }
    return { ref, uri: `file://${canonical}`, title: basename(canonical), linkOnly: true };
  }

  /** `problems` — whole-workspace Error+Warning, capped; empty is honest text, never a skip (§3.1). */
  private async resolveProblems(ref: ContextRef): Promise<ResolvedContext> {
    const rows = this.ports.diagnostics.all();
    const formatted = rows.length === 0 ? '(no problems reported)' : formatDiagnostics(rows, CONTEXT_BUDGET.diagnosticsMax);
    const { text, truncated } = clampText(formatted, CONTEXT_BUDGET.perItemChars);
    return { ref, uri: 'diagnostics://workspace', title: 'Problems', text, truncated };
  }

  /** `selection` — active editor selection at send-time; no selection is an honest `unavailable` skip (§3.1). */
  private async resolveSelection(ref: ContextRef): Promise<ResolvedContext> {
    const selection = this.ports.editor.activeSelection();
    if (selection === undefined) {
      return skip(ref, 'unavailable', 'no active selection', 'Selection');
    }
    const { text, truncated } = clampText(formatSelection(selection), CONTEXT_BUDGET.perItemChars);
    return { ref, uri: 'selection://active', title: 'Selection', text, truncated };
  }

  /** `terminal` — passive shell-integration capture; no capture yet is honest-empty TEXT, never a skip (§3.1). */
  private async resolveTerminal(ref: ContextRef): Promise<ResolvedContext> {
    const tail = this.ports.terminal.capturedTail(CONTEXT_BUDGET.terminalLines);
    const formatted = formatTerminal(tail ?? { name: '', text: '' });
    const { text, truncated } = clampText(formatted, CONTEXT_BUDGET.perItemChars);
    return { ref, uri: 'terminal://capture', title: 'Terminal', text, truncated };
  }

  /**
   * `git` — working-tree diff + short status (§3.1 v1 scope). Fail-closed
   * stopgap (T2b): `repository.diff()` returns ONE unified-diff blob across
   * ALL changed files, so a secret file's added content can appear anywhere
   * in that blob — there is no safe way to show "the diff minus the secret
   * file" without per-file redaction. So when ANY changed path is
   * secret-classified, the whole diff BODY is withheld (status list of the
   * non-secret paths only, plus an honest note that the body was withheld —
   * never a note claiming secrets were "excluded" from a diff still shown).
   * When no path is secret, behavior is unchanged: `formatGit` + `clampText`
   * over the full diff. Pinned v1 limit (T2b scope guard, do not expand
   * here): per-file diff-body secret redaction is T5/commit-gen's job,
   * where per-file diff budgeting actually lives.
   */
  private async resolveGit(ref: ContextRef): Promise<ResolvedContext> {
    const [diff, changedPaths] = await Promise.all([this.ports.git.workingDiff(), this.ports.git.changedPaths()]);
    const nonSecret = changedPaths.filter((p) => !isSecretPath(p.path));
    const droppedCount = changedPaths.length - nonSecret.length;

    let formatted: string;
    if (droppedCount > 0) {
      // fail-closed: a secret file's content can appear anywhere in the unified diff blob,
      // and repository.diff() returns one blob across all files — so withhold the whole body
      // until T5's per-file redaction. Never emit a note that overclaims exclusion.
      formatted = formatGit({ diff: '', changedPaths: nonSecret });
      formatted += `\n\nWorking-tree diff withheld: ${droppedCount} secret-classified file${droppedCount === 1 ? '' : 's'} present in the changes; showing changed-file list only (per-file diff redaction lands with commit-gen).`;
    } else {
      formatted = formatGit({ diff, changedPaths: nonSecret });
    }

    const { text, truncated } = clampText(formatted, CONTEXT_BUDGET.diffChars);
    return { ref, uri: 'git://working-tree', title: 'Git', text, truncated };
  }
}
