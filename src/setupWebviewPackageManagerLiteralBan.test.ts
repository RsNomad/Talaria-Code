/**
 * T10 (beta5-setup-hardening-architecture.md §5.1 Global Constraint 1 /
 * §1.2): the webview must NEVER hardcode a distro-specific package-manager
 * command literal. Every pre-typed install line is composed HOST-side (the
 * osDetect/packageTable engine, `src/host/setup/`) and reaches the webview
 * only as wire data (`agent.bootstrap.command` / `agent.pythonInstall.
 * command`), rendered verbatim — never authored, guessed, or hardcoded in
 * `webview/src`. Fedora's package manager is the canonical example of
 * exactly the kind of distro-specific assumption this panel must stay free
 * of (the pre-T10 `pipx-missing` card hardcoded it; T10 replaced that with
 * the host-composed `agent.bootstrap` field).
 *
 * A blunt regex text scan (comments and strings included) — same posture as
 * `src/anyIntroductionBan.test.ts`, using the same shared file-walk
 * mechanism (`purityScan.ts`). This file lives under `src/`, outside the
 * scanned `webview/src` root, so it can never match itself.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectAllTsAndTsxSources, scanLines } from './host/purityScan';

const WEBVIEW_SRC_ROOT = join(__dirname, '..', 'webview', 'src');
const BANNED = /dnf/i;

describe('webview source carries no distro-specific package-manager literal (T10)', () => {
  it('reach: the walk discovers the Setup panel files (non-vacuous)', () => {
    const files = collectAllTsAndTsxSources(WEBVIEW_SRC_ROOT);
    expect(files.some((f) => f.file === 'panels/SetupPanel.tsx')).toBe(true);
    expect(files.some((f) => f.file === 'panels/setupCards.ts')).toBe(true);
  });

  it('no webview file hardcodes the Fedora package-manager literal (the real lock)', () => {
    expect(
      scanLines(collectAllTsAndTsxSources(WEBVIEW_SRC_ROOT), BANNED),
      'Found a distro-specific package-manager literal in webview source. Every pre-typed install ' +
        'command must come from host-composed wire data (agent.bootstrap / agent.pythonInstall) and be ' +
        'RENDERED verbatim — never authored or hardcoded in the webview.',
    ).toEqual([]);
  });
});
