import * as vscode from 'vscode';
import type { EditPreviewRegistry } from './EditPreviewRegistry';
import { parseDiffUri } from './parseDiffUri';

/**
 * W2 T4 — F-D: the `talaria-diff:` `TextDocumentContentProvider`. Both diff
 * sides are virtual documents served entirely from {@link EditPreviewRegistry}
 * — the real file is NEVER a diff side and is NEVER read here.
 *
 * SECURITY (§7 B7, non-negotiable): the registry is the ONLY content source.
 * A registry miss (unknown/malformed URI, or a toolId/path the registry
 * doesn't currently carry — e.g. its approval already resolved) returns the
 * literal `"(resolved)"` placeholder. There is no `fs`/`vscode.workspace.fs`
 * call anywhere in this file — a read fallback here would turn the scheme
 * into an arbitrary-read oracle for anything named on the `talaria-diff:`
 * authority, independent of whether an approval was ever live for it.
 *
 * Build-blind (compile-checked + Fedora-verified) — deliberately thin: all
 * the parsing/lookup logic it calls (`parseDiffUri`, `registry.getFile`) is
 * pure and already headless-tested; this class is just the vscode wiring.
 */
export const TALARIA_DIFF_SCHEME = 'talaria-diff';

/** Served when the registry has nothing for the requested (toolId, path) —
 * NEVER a file read (see the class doc's §7 B7 pin). */
export const RESOLVED_PLACEHOLDER = '(resolved)';

export class DiffPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  /** Every URI this provider has ever been asked to serve, so a registry
   * change can re-fire `onDidChange` for the ones a diff editor might
   * currently have open (vscode re-fetches only the URIs it's told changed). */
  private readonly trackedUris = new Map<string, vscode.Uri>();
  private readonly registrySub: { dispose(): void };

  constructor(private readonly registry: EditPreviewRegistry) {
    this.registrySub = registry.onChange(() => this.refreshTracked());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    this.trackedUris.set(uri.toString(), uri);

    const parsed = parseDiffUri(uri);
    if (!parsed) return RESOLVED_PLACEHOLDER;

    const file = this.registry.getFile(parsed.sessionId, parsed.toolId, parsed.path);
    if (!file) return RESOLVED_PLACEHOLDER;

    return parsed.side === 'before' ? (file.oldText ?? '') : file.newText;
  }

  private refreshTracked(): void {
    for (const uri of this.trackedUris.values()) this.changeEmitter.fire(uri);
  }

  dispose(): void {
    this.registrySub.dispose();
    this.changeEmitter.dispose();
  }
}
