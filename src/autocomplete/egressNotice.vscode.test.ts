import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * CA-06-face + CA-06-path-face — the visible faces of FIM's two silent
 * egress protections. Recording vscode fake: items/toasts/commands are
 * pushed into plain arrays (repo convention — no vi.fn()). The surface
 * under test must (1) dedup to one kind-tagged badge per file + one
 * CONTENT-kind toast per file per epoch (the path kind never toasts),
 * (2) clear on allow/close/reset, (3) degrade silently when any vscode
 * API throws, (4) pin every user-facing string by EXACT equality —
 * constant strings are the no-leak proof.
 */
interface FakeStatusItem {
  id: string;
  selector: { scheme: string; pattern: string };
  name: string | undefined;
  text: string;
  detail: string | undefined;
  severity: number;
  command: { title: string; command: string } | undefined;
  accessibilityInformation: { label: string } | undefined;
  busy: boolean;
  disposed: boolean;
  dispose(): void;
}

const host = {
  items: [] as FakeStatusItem[],
  toasts: [] as Array<{ message: string; actions: string[] }>,
  infoMessages: [] as Array<{ message: string; actions: string[] }>,
  registeredCommands: [] as Array<{ id: string; handler: () => void }>,
  executedCommands: [] as Array<{ id: string; arg: unknown }>,
  closeListeners: [] as Array<(doc: { uri: { toString(): string } }) => void>,
  failCreateItem: false,
  failRegisterCommand: false,
};

vi.mock('vscode', () => ({
  LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
  languages: {
    createLanguageStatusItem: (id: string, selector: { scheme: string; pattern: string }) => {
      if (host.failCreateItem) throw new Error('injected: no language status surface');
      const item: FakeStatusItem = {
        id,
        selector,
        name: undefined,
        text: '',
        detail: undefined,
        severity: 0,
        command: undefined,
        accessibilityInformation: undefined,
        busy: false,
        disposed: false,
        dispose(): void {
          item.disposed = true;
        },
      };
      host.items.push(item);
      return item;
    },
  },
  window: {
    showWarningMessage: (message: string, ...actions: string[]) => {
      host.toasts.push({ message, actions });
      return Promise.resolve(undefined);
    },
    showInformationMessage: (message: string, ...actions: string[]) => {
      host.infoMessages.push({ message, actions });
      return Promise.resolve(undefined);
    },
  },
  commands: {
    registerCommand: (id: string, handler: () => void) => {
      if (host.failRegisterCommand) throw new Error('injected: command registry down');
      host.registeredCommands.push({ id, handler });
      return { dispose(): void {} };
    },
    executeCommand: (id: string, arg?: unknown) => {
      host.executedCommands.push({ id, arg: arg ?? undefined });
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    onDidCloseTextDocument: (cb: (doc: { uri: { toString(): string } }) => void) => {
      host.closeListeners.push(cb);
      return { dispose(): void {} };
    },
  },
  Uri: {
    parse: (value: string) => ({
      scheme: value.slice(0, Math.max(0, value.indexOf(':'))),
      fsPath: value.startsWith('file://') ? value.slice('file://'.length) : value,
    }),
  },
}));

import { must } from '../testing/must';
import { createEgressNoticeSurface, EXPLAIN_EGRESS_PAUSE_COMMAND } from './egressNotice.vscode';

const FILE_A = 'file:///home/dev/app.ts';
const FILE_B = 'file:///home/dev/.env';

describe('CA-06-face + CA-06-path-face — egress notice surface (two-kind)', () => {
  beforeEach(() => {
    host.items.length = 0;
    host.toasts.length = 0;
    host.infoMessages.length = 0;
    host.registeredCommands.length = 0;
    host.executedCommands.length = 0;
    host.closeListeners.length = 0;
    host.failCreateItem = false;
    host.failRegisterCommand = false;
  });

  it('ten rapid content-blocks for one file: exactly ONE badge and ONE toast (the anti-spam pin)', () => {
    const surface = createEgressNoticeSurface();
    for (let i = 0; i < 10; i += 1) surface.onEgressVerdict(FILE_A, 'content-block');
    expect(host.items).toHaveLength(1);
    expect(host.toasts).toHaveLength(1);
    surface.dispose();
  });

  it('pins the CONTENT badge fields and copy EXACTLY (constants = the no-leak proof)', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    const item = must(host.items[0]);
    expect(item.id).toBe('talaria.autocomplete.egressPaused:' + FILE_A);
    expect(item.selector).toEqual({ scheme: 'file', pattern: '/home/dev/app.ts' });
    expect(item.name).toBe('Talaria Autocomplete');
    expect(item.severity).toBe(1); // LanguageStatusSeverity.Warning
    expect(item.text).toBe('$(shield) Completions paused');
    expect(item.detail).toBe(
      'This file may contain a secret, so nothing is sent to the remote completion endpoint',
    );
    expect(item.command).toEqual({ title: 'Learn More', command: EXPLAIN_EGRESS_PAUSE_COMMAND });
    expect(must(item.accessibilityInformation).label).toBe(
      'Talaria completions paused: this file may contain a secret, so nothing is sent to the remote completion endpoint',
    );
    expect(item.busy).toBe(false); // no spinner, ever
    surface.dispose();
  });

  it('pins the PATH badge: Information severity, off-for-this-file copy, and NO toast (CA-06-path-face)', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_B, 'path-block');
    const item = must(host.items[0]);
    expect(item.id).toBe('talaria.autocomplete.egressPaused:' + FILE_B);
    expect(item.selector).toEqual({ scheme: 'file', pattern: '/home/dev/.env' });
    expect(item.name).toBe('Talaria Autocomplete');
    expect(item.severity).toBe(0); // LanguageStatusSeverity.Information — by-design state, not a warning
    expect(item.text).toBe('$(shield) Completions off for this file');
    expect(item.detail).toBe(
      'This looks like a secrets file (such as .env or a key file), so inline completions stay off here',
    );
    expect(item.command).toEqual({ title: 'Learn More', command: EXPLAIN_EGRESS_PAUSE_COMMAND });
    expect(must(item.accessibilityInformation).label).toBe(
      'Talaria completions are off for this file: it looks like a secrets file, so nothing from it is ever sent',
    );
    expect(item.busy).toBe(false);
    expect(host.toasts).toHaveLength(0); // path kind NEVER toasts (nothing to recover — no alarm)
    surface.onEgressVerdict(FILE_B, 'path-block');
    expect(host.items).toHaveLength(1); // deduped per keystroke
    surface.dispose();
  });

  it('pins the toast copy EXACTLY (no secret, no rule, no host, no path)', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    const toast = must(host.toasts[0]);
    expect(toast.message).toBe(
      'Talaria: Inline completions are paused for this file — it may contain a secret, ' +
        'and your completion endpoint is not local. Nothing was sent.',
    );
    expect(toast.actions).toEqual(['Learn More']);
    surface.dispose();
  });

  it('allow clears the badge; a later re-block recreates it WITHOUT a second toast', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    surface.onEgressVerdict(FILE_A, 'allow');
    expect(must(host.items[0]).disposed).toBe(true);
    surface.onEgressVerdict(FILE_A, 'content-block');
    expect(host.items).toHaveLength(2); // a genuine condition edge recreates
    expect(host.toasts).toHaveLength(1); // toast stays once-per-file-per-epoch
    surface.dispose();
  });

  it('an allow for a file with no badge is a no-op', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'allow');
    expect(host.items).toHaveLength(0);
    expect(host.toasts).toHaveLength(0);
    surface.dispose();
  });

  it('a kind change replaces the badge (defensive — path copy must never stand for a content block)', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'path-block');
    surface.onEgressVerdict(FILE_A, 'content-block');
    expect(must(host.items[0]).disposed).toBe(true);
    expect(host.items).toHaveLength(2);
    expect(must(host.items[1]).severity).toBe(1);
    expect(host.toasts).toHaveLength(1); // the content arrival still toasts once
    surface.dispose();
  });

  it('two files get independent badges; toasts stay content-kind-only per file', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    surface.onEgressVerdict(FILE_B, 'path-block');
    expect(host.items).toHaveLength(2);
    expect(host.toasts).toHaveLength(1);
    surface.dispose();
  });

  it('reset() disposes all badges (path included) and RE-ARMS the toast (the rebuild epoch boundary)', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    surface.onEgressVerdict(FILE_B, 'path-block');
    surface.reset();
    expect(host.items.every((i) => i.disposed)).toBe(true);
    surface.onEgressVerdict(FILE_A, 'content-block');
    expect(host.toasts).toHaveLength(2); // re-armed — a config change is a new epoch
    surface.onEgressVerdict(FILE_B, 'path-block');
    expect(host.toasts).toHaveLength(2); // path kind still never toasts, epoch or not
    surface.dispose();
  });

  it('closing the document clears its badge and re-arms its toast (per-file epoch boundary)', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    const fireClose = must(host.closeListeners[0]);
    fireClose({ uri: { toString: () => FILE_A } });
    expect(must(host.items[0]).disposed).toBe(true);
    surface.onEgressVerdict(FILE_A, 'content-block');
    expect(host.items).toHaveLength(2);
    expect(host.toasts).toHaveLength(2);
    surface.dispose();
  });

  it('a throwing createLanguageStatusItem degrades: content → toast-only, path → SILENT; NEVER throws', () => {
    host.failCreateItem = true;
    const surface = createEgressNoticeSurface();
    expect(() => surface.onEgressVerdict(FILE_A, 'content-block')).not.toThrow();
    expect(host.items).toHaveLength(0);
    expect(host.toasts).toHaveLength(1); // the badge failing must not kill the toast
    expect(() => surface.onEgressVerdict(FILE_B, 'path-block')).not.toThrow();
    expect(host.toasts).toHaveLength(1); // path kind has no toast fallback by design — silent, still no throw
    surface.dispose();
  });

  it('a failed command registration drops the links instead of shipping dead ones (both kinds)', () => {
    host.failRegisterCommand = true;
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    surface.onEgressVerdict(FILE_B, 'path-block');
    expect(must(host.items[0]).command).toBeUndefined();
    expect(must(host.items[1]).command).toBeUndefined();
    expect(must(host.toasts[0]).actions).toEqual([]);
    surface.dispose();
  });

  it('the Learn More command shows the explanation (now covering BOTH kinds) and the settings deep-link', async () => {
    const surface = createEgressNoticeSurface();
    const registered = must(
      host.registeredCommands.find((c) => c.id === EXPLAIN_EGRESS_PAUSE_COMMAND),
    );
    registered.handler();
    await Promise.resolve();
    const info = must(host.infoMessages[0]);
    expect(info.message).toBe(
      'Talaria pauses inline completions when a file looks like it contains a secret ' +
        '(an API key, a token, a private key) and the autocomplete endpoint is not on this ' +
        'machine. The file content is never sent while paused. Completions resume when the ' +
        'text near the cursor no longer looks like a secret, or when you use a local endpoint. ' +
        'Files that are secrets by nature (like .env or a private key file) always stay off — ' +
        'nothing from them is ever sent, no matter where your endpoint runs.',
    );
    expect(info.actions).toEqual(['Open Endpoint Setting']);
    surface.dispose();
  });

  it('dispose() disposes every live badge (both kinds)', () => {
    const surface = createEgressNoticeSurface();
    surface.onEgressVerdict(FILE_A, 'content-block');
    surface.onEgressVerdict(FILE_B, 'path-block');
    surface.dispose();
    expect(host.items.every((i) => i.disposed)).toBe(true);
  });
});
