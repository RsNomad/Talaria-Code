/**
 * Per-distro install-command table + Python-install planner
 * (beta5-setup-hardening-architecture.md §1.1, §0.2, §5.3; Task T4).
 *
 * PURE — zero `vscode` imports (Global Constraint 5, purity-scanned by
 * `packageTable.test.ts`, same mechanism `osDetect.test.ts`/`registry.test.ts`
 * already use). This module is pure DATA + a resolver over it: every command
 * it can produce is a static, hand-verified string pulled from the distro's
 * OWN signed archive (§5.2 source ledger) — nothing here spawns a shell,
 * probes `command -v`, or accepts caller-supplied text. Unknown/unconfirmed
 * inputs resolve to `undefined` ({@link installCommand}) or a
 * {@link PythonGuidancePlan} ({@link pythonInstallPlan}) — composing a
 * guessed command is a defect (Global Constraint 1 / §5.1).
 *
 * Flag posture (§0.2, locked by test): no `-y`, no `--noconfirm`, anywhere —
 * the user reviews the pre-typed line and answers the manager's own prompt.
 * `pacman` keeps `--needed` (idempotence, not auto-confirm). No
 * `add-apt-repository` of any kind is ever composed (§5.3 rev 3 — the
 * owner removed the third-party-PPA tier entirely; own-archive-or-guidance
 * only, for pipx/llamacpp AND for Python).
 */

import type { DistroFamily, OsRelease } from './osDetect';

export type PackageKey = 'pipx' | 'llamacpp';

export interface InstallCommandSpec {
  /** The EXACT pre-typed line — never executed by us, no auto-confirm flags. */
  command: string;
  /** Named source + why trusted — surfaced in the Tier-1 modal (§5.1). */
  sourceNote: string;
  docsUrl: string;
}

export interface PythonInstallPlan {
  kind: 'command';
  command: string;
  sourceNote: string;
  docsUrl: string;
}

export interface PythonGuidancePlan {
  kind: 'guidance';
  text: string;
  docsUrl: string;
}

/**
 * §0.2 command table, as code. Keyed by family, then package key. A missing
 * entry — either the whole family (`'unknown'`) or one key within a present
 * family (`debian.llamacpp` — the binary package name in the Debian/Ubuntu
 * archives is unconfirmed, ggml-org/llama.cpp#20042) — means "guidance":
 * {@link installCommand} returns `undefined` for it and the caller renders
 * docs-link guidance instead of a pre-typed line.
 */
const INSTALL_COMMANDS: Readonly<
  Partial<Record<DistroFamily, Partial<Record<PackageKey, InstallCommandSpec>>>>
> = {
  fedora: {
    pipx: {
      command: 'sudo dnf install pipx',
      sourceNote:
        "Fedora's official repository via dnf — the distro's signed archive, the system's root of trust (packages.fedoraproject.org).",
      docsUrl: 'https://packages.fedoraproject.org/search?query=pipx',
    },
    llamacpp: {
      command: 'sudo dnf install llama-cpp',
      sourceNote:
        "Fedora's official repository via dnf — owner-live-verified on Fedora 44 (the `dnf install llama-cpp` transaction was watched to completion).",
      docsUrl: 'https://packages.fedoraproject.org/search?query=llama-cpp',
    },
  },
  debian: {
    pipx: {
      command: 'sudo apt-get update && sudo apt-get install pipx',
      sourceNote:
        "Debian/Ubuntu's own official archive via apt-get — the distro's signed repository (shared lineage across Debian, Ubuntu, Mint and Pop).",
      docsUrl: 'https://packages.debian.org/search?keywords=pipx',
    },
    // llamacpp intentionally absent: the Debian/Ubuntu archive binary
    // package name is unconfirmed (§0.2 row) -> guidance only, never a
    // guessed line.
  },
  arch: {
    pipx: {
      command: 'sudo pacman -S --needed python-pipx',
      sourceNote:
        "Arch Linux's official extra repository via pacman — the distro's signed archive, archlinux.org-verified.",
      docsUrl: 'https://archlinux.org/packages/?q=python-pipx',
    },
    llamacpp: {
      command: 'sudo pacman -S --needed llama-cpp',
      sourceNote:
        "Arch Linux's official extra repository via pacman — the distro's signed archive, archlinux.org-verified.",
      docsUrl: 'https://archlinux.org/packages/?q=llama-cpp',
    },
  },
  suse: {
    pipx: {
      command: 'sudo zypper install python3-pipx',
      sourceNote:
        "openSUSE's official repository via zypper — the distro's signed archive, software.opensuse.org-verified.",
      docsUrl: 'https://software.opensuse.org/package/python3-pipx',
    },
    llamacpp: {
      command: 'sudo zypper install llamacpp',
      sourceNote:
        "openSUSE Tumbleweed's official repository via zypper — software.opensuse.org-verified (no official Leap-16 build).",
      docsUrl: 'https://software.opensuse.org/package/llamacpp',
    },
  },
  // unknown intentionally absent -> every key resolves to undefined.
};

/**
 * Resolves the exact pre-typed install line for `key` on `family`, or
 * `undefined` when there is no verified source to compose one from (an
 * unrecognized family, or a family whose archive doesn't carry a confirmed
 * package name for that key). `undefined` always means "render guidance",
 * never "retry" or "assume a name".
 */
export function installCommand(family: DistroFamily, key: PackageKey): InstallCommandSpec | undefined {
  return INSTALL_COMMANDS[family]?.[key];
}

/**
 * §6 verbatim guidance copy — the ONLY path for Ubuntu 26.04+/Debian/Mint/
 * Pop/Arch/unknown-versionId/unknown-distro (§5.3 tier 3). Implementers
 * elsewhere (UI tasks) must use this string verbatim; it is duplicated here,
 * not imported from a UI copy module, because this module must stay
 * `vscode`-free and dependency-free of anything the webview owns.
 */
const PYTHON_GUIDANCE_TEXT =
  "Hermes needs Python 3.11–3.13, and your system's own package archive doesn't carry one in range. Install a supported Python yourself (see your distro's documentation or python.org), then press Re-check — Talaria will find it automatically.";

const PYTHON_GUIDANCE_DOCS_URL = 'https://www.python.org/downloads/';

function pythonGuidance(): PythonGuidancePlan {
  return { kind: 'guidance', text: PYTHON_GUIDANCE_TEXT, docsUrl: PYTHON_GUIDANCE_DOCS_URL };
}

/**
 * §5.3 three-tier decision, own-archive-or-guidance only (rev 3, owner-
 * resolved — no third-party tier of any kind, no `add-apt-repository` ever):
 *  1. Already-in-range defaults need no plan at all — not this function's
 *     concern; the caller only invokes this once a locator has confirmed
 *     the current Python is unsuitable.
 *  2. An in-range versioned Python exists in the distro's OWN archive ->
 *     a plain install command, including the load-bearing venv/ensurepip
 *     companion package where the distro splits it out of the interpreter
 *     package (Ubuntu's `python3.11-venv`).
 *  3. Everything else -> honest guidance, never a guessed command.
 *
 * Critic C-3 (binding): the Ubuntu-22.04 branch is gated on
 * `release.id === 'ubuntu'` + `release.versionId`, NEVER on the collapsed
 * `family` — Mint/Pop/Debian resolve to the same `'debian'` family but must
 * NOT receive Ubuntu-specific commands.
 *
 * The openSUSE branch is pinned to a live-verified finding (T4 brief, R-5):
 * the openSUSE:Factory `python313` RPM spec's main `python313` package
 * carries an unconditional `Requires: python313-base`, and
 * `python313-base`'s `%files` list includes `%{sitedir}/venv` and
 * `%{sitedir}/ensurepip` (source: `python313.spec` inside
 * `https://api.opensuse.org/public/source/openSUSE:Factory/python313`,
 * human-browsable at `https://build.opensuse.org/package/show/openSUSE:Factory/python313`).
 * So `sudo zypper install python313` already pulls in venv/ensurepip
 * transitively — no separate companion package is needed, and in particular
 * `python313-pip` (the pip CLI only) is NOT the load-bearing package.
 */
export function pythonInstallPlan(release: OsRelease, family: DistroFamily): PythonInstallPlan | PythonGuidancePlan {
  switch (family) {
    case 'fedora':
      return {
        kind: 'command',
        command: 'sudo dnf install python3.13',
        sourceNote:
          "Fedora's official repository via dnf — the distro's signed archive; Fedora does not split venv/ensurepip out of the interpreter package.",
        docsUrl: 'https://packages.fedoraproject.org/search?query=python3.13',
      };

    case 'debian':
      if (release.id === 'ubuntu' && release.versionId !== undefined && release.versionId.startsWith('22.04')) {
        return {
          kind: 'command',
          command: 'sudo apt-get update && sudo apt-get install python3.11 python3.11-venv',
          sourceNote:
            "Ubuntu's own official archive (universe) via apt-get — the distro's signed repository, packages.ubuntu.com-verified; python3.11-venv is the load-bearing companion carrying venv/ensurepip (Debian-family distros split it out of the interpreter package).",
          docsUrl: 'https://packages.ubuntu.com/jammy/python3.11-venv',
        };
      }
      return pythonGuidance();

    case 'suse':
      return {
        kind: 'command',
        command: 'sudo zypper install python313',
        sourceNote:
          "openSUSE's official Factory/Tumbleweed archive via zypper. Live-verified against the python313 RPM spec (openSUSE:Factory): venv and ensurepip ship inside python313-base, an unconditional Requires of python313 — no separate companion package is needed (python313-pip is unrelated: it carries only the pip CLI, not venv/ensurepip).",
        docsUrl: 'https://build.opensuse.org/package/show/openSUSE:Factory/python313',
      };

    case 'arch':
    case 'unknown':
      return pythonGuidance();
  }
}
