/**
 * §2a `terminalCapture.ts` — passive shell-integration ring-buffer capture
 * for the `terminal` mention kind (§3.1's decided source: VS Code has no
 * scrollback-read API; the clipboard-hijack workaround other extensions use
 * is BANNED). Subscribes to `window.onDidStartTerminalShellExecution` at
 * construction and drains each OBSERVED execution's raw output
 * (`TerminalShellExecution.read()`) into a per-terminal {@link RingBuffer} —
 * captures only executions started AFTER this subscription is live, which
 * is VS Code's own hard constraint (Context7-grounded, cross-checked against
 * the installed `@types/vscode@1.125.0` at write-time): `read()`'s doc
 * comment reads "This will only include data that was written after `read`
 * was called for the first time, ie. you must call `read` immediately after
 * the command is executed via … {@link window.onDidStartTerminalShellExecution}
 * to not miss any data" (`node_modules/@types/vscode/index.d.ts`, mirrors
 * `microsoft/vscode` `src/vscode-dts/vscode.d.ts`). No shell integration
 * available on a given terminal/shell ⇒ the event never fires for it ⇒
 * nothing captured — `capturedTail` returns `undefined`, and the resolver
 * (`resolver.ts`) already renders the honest-empty note for that case.
 *
 * The PURE ring-buffer logic lives in {@link RingBuffer} (`./ringBuffer.ts`,
 * zero `vscode` import, headlessly tested) — this file is the thin vscode
 * shell around it; it is build-blind (Fedora-verified per the ship gate,
 * probe P4 — shell-integration availability on Fedora bash).
 *
 * Grounded via Context7 (`/microsoft/vscode-docs`, session) +
 * `node_modules/@types/vscode/index.d.ts` (installed `1.125.0`, matching
 * `microsoft/vscode` `src/vscode-dts/vscode.d.ts` fetched raw at write-time):
 * `window.onDidStartTerminalShellExecution: Event<TerminalShellExecutionStartEvent>`
 * (`{terminal, shellIntegration, execution}`),
 * `TerminalShellExecution.read(): AsyncIterable<string>`,
 * `window.activeTerminal: Terminal | undefined`, `Terminal.name: string`.
 */
import * as vscode from 'vscode';

import { RingBuffer } from './ringBuffer';
import type { TerminalPort } from './types';

/**
 * Completed lines retained per terminal — generous headroom over the
 * `@terminal` PROMPT budget (`sanitize.ts` `CONTEXT_BUDGET.terminalLines` =
 * 200; the resolver clamps to that budget separately at resolve-time). This
 * is purely "don't let one terminal's capture grow without bound over a
 * long session" — a ring, not a policy cap.
 */
const RING_BUFFER_CAP_LINES = 1000;

export class TerminalCapture implements TerminalPort, vscode.Disposable {
  private readonly buffers = new Map<vscode.Terminal, RingBuffer>();
  private readonly subscription: vscode.Disposable;
  private readonly closeSubscription: vscode.Disposable;

  /** Optional — matches the `logger`-taking convention every other
   * vscode-shell adapter in this codebase follows (`CheckpointTracker`,
   * `HermesDashboardManager`): a passive, long-lived background subscription
   * has no other visibility channel, so a drain error is worth a line even
   * though it is always best-effort-recovered, never re-thrown. */
  constructor(private readonly logger?: vscode.OutputChannel) {
    this.subscription = vscode.window.onDidStartTerminalShellExecution((event) => {
      void this.drain(event.terminal, event.execution);
    });
    // Evict a closed terminal's buffer immediately rather than only at
    // `dispose()` — otherwise a long session that opens/closes many
    // terminals grows `buffers` unbounded (dead entries never freed).
    this.closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      this.buffers.delete(terminal);
    });
  }

  /** The active terminal's captured tail, or `undefined` when there is no
   * active terminal, or nothing has been captured for it yet. */
  capturedTail(maxLines: number): { name: string; text: string } | undefined {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) return undefined;
    const ring = this.buffers.get(terminal);
    if (!ring) return undefined;
    const text = ring.tail(maxLines);
    if (!text) return undefined;
    return { name: terminal.name, text };
  }

  dispose(): void {
    this.subscription.dispose();
    this.closeSubscription.dispose();
    this.buffers.clear();
  }

  private async drain(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): Promise<void> {
    let ring = this.buffers.get(terminal);
    if (!ring) {
      ring = new RingBuffer(RING_BUFFER_CAP_LINES);
      this.buffers.set(terminal, ring);
    }
    try {
      for await (const chunk of execution.read()) {
        ring.push(chunk);
      }
    } catch (err) {
      // Best-effort capture (§3.1 "degrades gracefully"): a stream error
      // just stops draining THIS execution — already-captured lines are
      // kept, and the next execution on this terminal starts a fresh drain.
      // Logged (not silently swallowed) since this is the only visibility
      // this background subscription has.
      this.logger?.appendLine(`[terminalCapture] read() stream error: ${String(err)}`);
    }
  }
}
