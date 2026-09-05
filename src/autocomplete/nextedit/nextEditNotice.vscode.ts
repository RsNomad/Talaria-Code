/**
 * CA-06-NE-face — the visible face of the silent next-edit egress refusals
 * (design: docs_claude/lens-dorabotok/CA-06-nextedit-face-design.md).
 *
 * The shell's gates stay silent and fail-closed — this module is a detached
 * observer on `NextEditShellDeps.onEgressVerdict` that renders:
 *  - a per-file `LanguageStatusItem` badge with TWO copy kinds:
 *    'content-block' (Warning — a possible secret near the edit; resumes
 *    when it is gone) and 'path-block' (Information — a secrets-by-nature
 *    file; off by design, permanently, so it must not alarm);
 *  - at most ONE `showWarningMessage` toast per file per epoch, for the
 *    content kind ONLY (an epoch ends on `reset()`/teardown, or on that
 *    file's close).
 *
 * Invariants (CA-06-NE-face R5-R8):
 *  - `onEgressVerdict` NEVER throws to its caller; every vscode touch is
 *    individually guarded and degrades silently (fail-safe surface).
 *  - Every user-facing string is a compile-time constant: no secret
 *    content, no rule id, no endpoint host, no file path can appear.
 *  - Wired UNCONDITIONALLY (contrast CA-06-face's loopback omission): the
 *    next-edit gates scan regardless of endpoint locality, so the notice
 *    mirrors the gate it observes. Inert via the feature's own default —
 *    `talaria.nextEdit.source = 'off'` means GATE 1 never lets a verdict
 *    reach this module.
 */
import * as vscode from 'vscode';
import type { NextEditEgressObserver, NextEditEgressVerdict } from './shell.vscode';

/** Runtime-registered only (not palette-facing) — deliberately NOT contributed in package.json. */
export const EXPLAIN_NEXT_EDIT_PAUSE_COMMAND = 'talaria.nextEdit.explainEgressPause';

const BADGE_NAME = 'Talaria Next Edit';
const CONTENT_BADGE_TEXT = '$(shield) Next Edit paused';
const CONTENT_BADGE_DETAIL =
  'This file may contain a secret near your edit, so nothing is sent to the suggestion endpoint';
const CONTENT_BADGE_A11Y =
  'Talaria Next Edit paused: this file may contain a secret near your edit, so nothing is sent to the suggestion endpoint';
const PATH_BADGE_TEXT = '$(shield) Next Edit off for this file';
const PATH_BADGE_DETAIL =
  'This looks like a secrets file (such as .env or a key file), so next-edit suggestions stay off here';
const PATH_BADGE_A11Y =
  'Talaria Next Edit is off for this file: it looks like a secrets file, so nothing from it is ever sent';
const TOAST_MESSAGE =
  'Talaria: Next-edit suggestions are paused for this file — it may contain a secret near your edit. ' +
  'Nothing was sent.';
const LEARN_MORE = 'Learn More';
const EXPLAIN_MESSAGE =
  'Talaria pauses next-edit suggestions when the text it would send — your recent edits and the ' +
  'lines around them — looks like it contains a secret (an API key, a token, a private key). ' +
  'Nothing is sent while paused, no matter where your endpoint runs. Suggestions resume when ' +
  'the text near your edit no longer looks like a secret. Files that are secrets by nature ' +
  '(like .env or a private key file) always stay off.';
const OPEN_NEXT_EDIT_SETTINGS = 'Open Next Edit Settings';

type BlockKind = Exclude<NextEditEgressVerdict, 'allow'>;

export interface NextEditNoticeSurface {
  /** The shell-facing observer (`NextEditShellDeps.onEgressVerdict`). Never throws. */
  onEgressVerdict: NextEditEgressObserver;
  /** Clear every badge and re-arm the one-shot toasts. No production caller
   *  today (the next-edit gates are config-independent — no rebuild seam);
   *  exposed for teardown reuse and any future re-registration path. */
  reset: () => void;
  dispose: () => void;
}

export function createNextEditNoticeSurface(): NextEditNoticeSurface {
  /** filepath (`document.uri.toString()`) → live badge + the kind it renders. */
  const badges = new Map<string, { kind: BlockKind; item: vscode.LanguageStatusItem }>();
  /** Files toasted this epoch (content kind only). */
  const toasted = new Set<string>();
  const ownedDisposables: { dispose(): void }[] = [];

  // ── construction (each acquisition individually guarded — R6) ────────────
  let explainCommandRegistered = false;
  try {
    ownedDisposables.push(
      vscode.commands.registerCommand(EXPLAIN_NEXT_EDIT_PAUSE_COMMAND, () => {
        void vscode.window.showInformationMessage(EXPLAIN_MESSAGE, OPEN_NEXT_EDIT_SETTINGS).then(
          (choice) => {
            if (choice === OPEN_NEXT_EDIT_SETTINGS) {
              void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'talaria.nextEdit',
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
    // Degrade: badge and toast render WITHOUT their Learn More links —
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
    // Degrade: badges for closed files linger until dispose() (the
    // per-document selector already keeps them invisible elsewhere).
  }

  // ── internals ────────────────────────────────────────────────────────────
  function showBadge(filepath: string, kind: BlockKind): void {
    const existing = badges.get(filepath);
    if (existing !== undefined) {
      if (existing.kind === kind) return; // per-keystroke no-op while the condition holds
      clearBadge(filepath); // kind edge (defensive): never let path copy stand for a content block
    }
    const uri = vscode.Uri.parse(filepath);
    const item = vscode.languages.createLanguageStatusItem(
      'talaria.nextEdit.egressPaused:' + filepath,
      // Per-document scope: shows ONLY while this file is active. Glob
      // forbids backslashes (Context7 pin) — normalized for dev-on-Windows;
      // glob metacharacters in a path may defeat the match: the badge then
      // silently does not show (accepted residual — toast/log still fired).
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
      item.command = { title: LEARN_MORE, command: EXPLAIN_NEXT_EDIT_PAUSE_COMMAND };
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
          void vscode.commands.executeCommand(EXPLAIN_NEXT_EDIT_PAUSE_COMMAND);
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
  const onEgressVerdict: NextEditEgressObserver = (filepath, verdict) => {
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
        // Degrade silently — never into the trigger path.
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
