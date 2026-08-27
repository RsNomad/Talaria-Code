/**
 * CA-06-face + CA-06-path-face — the visible faces of FIM's two silent
 * egress protections (design: docs_claude/lens-dorabotok/
 * CA-06-notice-feature-design.md + CA-06-path-face-design.md).
 *
 * Both gates stay silent and fail-closed — this module is a detached
 * observer on the notice seam that renders a per-file `LanguageStatusItem`
 * badge with TWO copy kinds:
 *  - 'content-block' (Warning + one-shot toast): the engine's CA-06 content
 *    gate blocked a would-be remote egress; recoverable (remove the secret,
 *    or use a local endpoint);
 *  - 'path-block' (Information, NO toast): the provider's S4.1 secret-path
 *    skip — a secrets-by-nature file, off by design, permanently; it must
 *    inform, never alarm.
 * One badge per file per feature; edges only, never per keystroke; toast at
 * most once per file per epoch, content kind only (an epoch ends on engine
 * rebuild → `reset()`, or on that file's close).
 *
 * Invariants (R5′-R11): `onEgressVerdict` NEVER throws to its caller; every
 * vscode touch is individually guarded and degrades silently; every
 * user-facing string is a compile-time constant (no secret, rule, host,
 * content, or path can appear). Wiring conditionality lives in index.ts and
 * mirrors each gate: the engine (content) thread is non-loopback-only, the
 * provider (path) thread is unconditional.
 */
import * as vscode from 'vscode';
import type { EgressVerdictObserver, FimEgressNoticeVerdict } from './engine';

/** Runtime-registered only (not palette-facing) — deliberately NOT contributed in package.json. */
export const EXPLAIN_EGRESS_PAUSE_COMMAND = 'talaria.autocomplete.explainEgressPause';

const BADGE_NAME = 'Talaria Autocomplete';
const CONTENT_BADGE_TEXT = '$(shield) Completions paused';
const CONTENT_BADGE_DETAIL =
  'This file may contain a secret, so nothing is sent to the remote completion endpoint';
const CONTENT_BADGE_A11Y =
  'Talaria completions paused: this file may contain a secret, so nothing is sent to the remote completion endpoint';
const PATH_BADGE_TEXT = '$(shield) Completions off for this file';
const PATH_BADGE_DETAIL =
  'This looks like a secrets file (such as .env or a key file), so inline completions stay off here';
const PATH_BADGE_A11Y =
  'Talaria completions are off for this file: it looks like a secrets file, so nothing from it is ever sent';
const TOAST_MESSAGE =
  'Talaria: Inline completions are paused for this file — it may contain a secret, ' +
  'and your completion endpoint is not local. Nothing was sent.';
const LEARN_MORE = 'Learn More';
const EXPLAIN_MESSAGE =
  'Talaria pauses inline completions when a file looks like it contains a secret ' +
  '(an API key, a token, a private key) and the autocomplete endpoint is not on this ' +
  'machine. The file content is never sent while paused. Completions resume when the ' +
  'text near the cursor no longer looks like a secret, or when you use a local endpoint. ' +
  'Files that are secrets by nature (like .env or a private key file) always stay off — ' +
  'nothing from them is ever sent, no matter where your endpoint runs.';
const OPEN_ENDPOINT_SETTING = 'Open Endpoint Setting';

type BlockKind = Exclude<FimEgressNoticeVerdict, 'allow'>;

export interface EgressNoticeSurface {
  /** The seam-facing observer (engine content thread + provider path thread). Never throws. */
  onEgressVerdict: EgressVerdictObserver;
  /** Clear every badge and re-arm the one-shot toasts. Call on every engine
   *  rebuild. (A showing PATH badge is recreated on that file's next
   *  completion attempt — the path condition is config-independent; the
   *  transient gap is the documented CA-06-path-face residual.) */
  reset: () => void;
  dispose: () => void;
}

export function createEgressNoticeSurface(): EgressNoticeSurface {
  /** filepath (`document.uri.toString()`) → live badge + the kind it renders. */
  const badges = new Map<string, { kind: BlockKind; item: vscode.LanguageStatusItem }>();
  /** Files toasted this epoch (content kind only). */
  const toasted = new Set<string>();
  const ownedDisposables: { dispose(): void }[] = [];

  // ── construction (each acquisition individually guarded — R6) ────────────
  let explainCommandRegistered = false;
  try {
    ownedDisposables.push(
      vscode.commands.registerCommand(EXPLAIN_EGRESS_PAUSE_COMMAND, () => {
        void vscode.window.showInformationMessage(EXPLAIN_MESSAGE, OPEN_ENDPOINT_SETTING).then(
          (choice) => {
            if (choice === OPEN_ENDPOINT_SETTING) {
              void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'talaria.autocomplete.endpoint',
              );
            }
          },
          () => {
            // Surface unavailable — degrade silently.
          },
        );
      }),
    );
    explainCommandRegistered = true;
  } catch {
    // Degrade: badges and toast render WITHOUT their Learn More links —
    // never a dead link to an unregistered command.
  }
  try {
    ownedDisposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        clearBadge(key);
        toasted.delete(key); // fresh file lifecycle = fresh epoch for it
      }),
    );
  } catch {
    // Degrade: badges for closed files linger until reset()/dispose() (the
    // per-document selector already keeps them invisible elsewhere).
  }

  // ── internals ────────────────────────────────────────────────────────────
  function showBadge(filepath: string, kind: BlockKind): void {
    const existing = badges.get(filepath);
    if (existing !== undefined) {
      if (existing.kind === kind) return; // per-keystroke no-op while the condition holds
      clearBadge(filepath); // kind edge (defensive): path copy must never stand for a content block
    }
    const uri = vscode.Uri.parse(filepath);
    const item = vscode.languages.createLanguageStatusItem(
      'talaria.autocomplete.egressPaused:' + filepath,
      // Per-document scope: shows ONLY while this file is active. Glob
      // forbids backslashes (Context7 pin) — normalized for dev-on-Windows;
      // glob metacharacters in a path may defeat the match: the badge then
      // silently does not show (accepted residual — the content toast, where
      // one exists, still fired; the path kind stays silent by design).
      { scheme: uri.scheme, pattern: uri.fsPath.replace(/\\/g, '/') },
    );
    item.name = BADGE_NAME;
    if (kind === 'content-block') {
      item.severity = vscode.LanguageStatusSeverity.Warning;
      item.text = CONTENT_BADGE_TEXT; // codicon + words — meaning never by color alone
      item.detail = CONTENT_BADGE_DETAIL;
      item.accessibilityInformation = { label: CONTENT_BADGE_A11Y };
    } else {
      // A secrets-by-nature file is a BY-DESIGN state: Information, not
      // Warning — informative, never alarming (there is nothing to fix).
      item.severity = vscode.LanguageStatusSeverity.Information;
      item.text = PATH_BADGE_TEXT;
      item.detail = PATH_BADGE_DETAIL;
      item.accessibilityInformation = { label: PATH_BADGE_A11Y };
    }
    if (explainCommandRegistered) {
      item.command = { title: LEARN_MORE, command: EXPLAIN_EGRESS_PAUSE_COMMAND };
    }
    // `busy` is left false forever: no spinner, no motion.
    badges.set(filepath, { kind, item });
  }

  function maybeToast(filepath: string): void {
    if (toasted.has(filepath)) return;
    toasted.add(filepath); // marked BEFORE the async call — re-entry cannot double-toast
    const actions = explainCommandRegistered ? [LEARN_MORE] : [];
    void vscode.window.showWarningMessage(TOAST_MESSAGE, ...actions).then(
      (choice) => {
        if (choice === LEARN_MORE) {
          void vscode.commands.executeCommand(EXPLAIN_EGRESS_PAUSE_COMMAND);
        }
      },
      () => {
        // Surface unavailable — degrade silently.
      },
    );
  }

  function clearBadge(filepath: string): void {
    const entry = badges.get(filepath);
    if (entry === undefined) return;
    badges.delete(filepath);
    try {
      entry.item.dispose();
    } catch {
      // Already gone — nothing to do.
    }
  }

  // ── the seam face (never throws — R6) ────────────────────────────────────
  const onEgressVerdict: EgressVerdictObserver = (filepath, verdict) => {
    if (verdict === 'allow') {
      try {
        clearBadge(filepath);
      } catch {
        // Degrade silently.
      }
      return;
    }
    try {
      showBadge(filepath, verdict);
    } catch {
      // A dead badge surface must not kill the toast below.
    }
    if (verdict === 'content-block') {
      try {
        maybeToast(filepath);
      } catch {
        // Degrade silently — never into the completion path.
      }
    }
  };

  const reset = (): void => {
    for (const filepath of [...badges.keys()]) clearBadge(filepath);
    toasted.clear();
  };

  const dispose = (): void => {
    reset();
    for (const d of ownedDisposables) {
      try {
        d.dispose();
      } catch {
        // Best-effort teardown.
      }
    }
    ownedDisposables.length = 0;
  };

  return { onEgressVerdict, reset, dispose };
}
