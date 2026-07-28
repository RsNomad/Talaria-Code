/**
 * W2 T4 — F-D proposed-edit diff preview (§3.5): the host-only, ask-path-scoped
 * store the `talaria-diff:` virtual-document provider reads from.
 *
 * SECURITY (§7 B7 — the load-bearing invariant of this whole feature): this
 * registry is the ONLY content source `DiffPreviewProvider` may ever consult.
 * A miss (`getFile` returning `undefined`) must resolve to a placeholder at
 * the CALLER, never a file read — this class does not, and must never, touch
 * `fs`/`vscode.workspace.fs` itself (it doesn't even import `vscode` — see
 * below).
 *
 * SECURITY (§7 A6 — scope pinned to the ask path): entries are populated by
 * `AcpBackend.emitApprovalCard` (the ASK path) ONLY, from the RAW pending-edit
 * texts — never for post-apply auto-allowed `tool.diff` cards. `AcpBackend`
 * also CLEARS the entry at every point a pending approval is removed
 * (`respondApproval`, `finishApproval`, `cancelPendingApprovals`), so an entry
 * can never outlive its approval: `diff.open` can only ever open a preview for
 * a LIVE pending approval — there is no arbitrary-read primitive here, keyed
 * or otherwise.
 *
 * W4-T3b (T1b carry — Q-9/R7): keyed `(sessionId, toolCallId)`, not
 * `toolCallId` alone. Unlike the approval trio (`pendingApprovals`/
 * `hunkState`/`toolIdToApprovalId`), which T1a made per-session by giving
 * each `SessionController` its OWN Map instance (structurally collision-
 * proof — two sessions' maps are two different objects), THIS registry is
 * ONE instance shared across every session's port (`extension.ts` constructs
 * it once, `AcpBackend.buildSessionPort` threads the SAME instance into
 * every controller). A `toolCallId` collision across two DIFFERENT sessions
 * — plausible, since each session's own ACP-side id scheme is independent —
 * would otherwise cross-wire one session's pending diff preview into
 * another's `talaria-diff:` document. The compound key removes that
 * collision class unconditionally, without waiting on a probe.
 *
 * Deliberately `vscode`-FREE (no `vscode.EventEmitter`) so it's headless
 * unit-testable and reusable from a plain Node test — `DiffPreviewProvider`
 * (the thin vscode adapter) bridges {@link onChange} to its own
 * `vscode.EventEmitter<vscode.Uri>`.
 */

/** The RAW (pre-hunk-derivation) texts for one edited file, straight off the
 * ACP `AcpDiffContent` block — `oldText` is `null`/`undefined` for a
 * brand-new file, mirroring `diffHunks.ts`'s own convention. */
export interface PreviewFile {
  path: string;
  oldText?: string | null;
  newText: string;
}

interface PreviewEntry {
  approvalId: string;
  files: PreviewFile[];
}

/** A file's before/after texts, as served to the `talaria-diff:` provider. */
export interface PreviewFileTexts {
  oldText?: string | null;
  newText: string;
}

export type PreviewChangeListener = () => void;

export interface PreviewChangeSubscription {
  dispose(): void;
}

/** Space-joined compound key — `sessionId`/`toolCallId` are opaque,
 * server-issued, whitespace-free ids, so joining on a plain space cannot
 * ambiguously collide two DIFFERENT `(sessionId, toolId)` pairs onto the
 * same string. */
function compoundKey(sessionId: string, toolId: string): string {
  return `${sessionId} ${toolId}`;
}

export class EditPreviewRegistry {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly listeners = new Set<PreviewChangeListener>();

  /**
   * Populate (or replace) the entry for `(sessionId, toolId)`. Called ONLY
   * from the ask path (`SessionController.emitApprovalCard`) — see the class
   * doc's §7 A6 pin.
   */
  set(sessionId: string, toolId: string, approvalId: string, files: readonly PreviewFile[]): void {
    this.entries.set(compoundKey(sessionId, toolId), { approvalId, files: [...files] });
    this.notify();
  }

  /**
   * Look up a single file's before/after texts by `(sessionId, toolId, path)`.
   * `undefined` on ANY miss (unknown session/toolId pair, or a path that
   * pair's entry doesn't carry) — the caller (`DiffPreviewProvider`) must
   * treat a miss as "serve the placeholder", never fall back to a file read.
   */
  getFile(sessionId: string, toolId: string, path: string): PreviewFileTexts | undefined {
    const entry = this.entries.get(compoundKey(sessionId, toolId));
    if (!entry) return undefined;
    const file = entry.files.find((f) => f.path === path);
    if (!file) return undefined;
    return { oldText: file.oldText, newText: file.newText };
  }

  /** Remove the entry for `(sessionId, toolId)` (approval resolved/denied/
   * cancelled/torn down) — a no-op if it's already gone. */
  delete(sessionId: string, toolId: string): void {
    if (this.entries.delete(compoundKey(sessionId, toolId))) this.notify();
  }

  /** Remove every entry (full teardown). */
  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.notify();
  }

  /** Register a listener fired (synchronously, no payload) on any mutation
   * (`set`/`delete`/`clear`, when they actually change something). Returns a
   * disposable so `DiffPreviewProvider` can unsubscribe on its own disposal. */
  onChange(listener: PreviewChangeListener): PreviewChangeSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
