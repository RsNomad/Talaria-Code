import { describe, it, expect } from 'vitest';
import { collectNonTestTsSources, scanLines, VSCODE_IMPORT_BAN } from '../purityScan';
import { installCommand, pythonInstallPlan, type PackageKey } from './packageTable';
import type { DistroFamily, OsRelease } from './osDetect';

/**
 * packageTable.test.ts — Task T4 (beta5-setup-hardening-architecture.md
 * §1.1, §0.2, §5.3). Locks (a) the per-distro install-command table
 * verbatim, (b) the security flag posture (no auto-confirm, no
 * `add-apt-repository`, anywhere across EVERY composed command string), and
 * (c) the three-tier `pythonInstallPlan` decision, including the C-3
 * counterexample (Mint/Pop/Debian must never receive Ubuntu-specific
 * commands even though they resolve to the same `'debian'` family).
 *
 * The openSUSE python plan is pinned to a LIVE-VERIFIED finding (task
 * report, R-5): the openSUSE:Factory `python313` RPM spec shows the main
 * `python313` package `Requires: python313-base` unconditionally, and
 * `python313-base`'s `%files` carries `%{sitedir}/venv` +
 * `%{sitedir}/ensurepip` — so plain `sudo zypper install python313` already
 * pulls in venv/ensurepip transitively; no separate companion package (and
 * NOT `python313-pip`, which only carries the pip CLI) is needed.
 */

// ---------------------------------------------------------------------------
// installCommand — verbatim locks, every (family × key) combination.
// ---------------------------------------------------------------------------

describe('packageTable: installCommand — verbatim command locks (§0.2/§1.1 table)', () => {
  it('fedora pipx -> sudo dnf install pipx', () => {
    const spec = installCommand('fedora', 'pipx');
    expect(spec?.command).toBe('sudo dnf install pipx');
    expect(spec?.sourceNote.length).toBeGreaterThan(0);
    expect(spec?.docsUrl).toMatch(/^https:\/\//);
  });

  it('fedora llamacpp -> sudo dnf install llama-cpp', () => {
    const spec = installCommand('fedora', 'llamacpp');
    expect(spec?.command).toBe('sudo dnf install llama-cpp');
    expect(spec?.sourceNote.length).toBeGreaterThan(0);
    expect(spec?.docsUrl).toMatch(/^https:\/\//);
  });

  it('debian pipx -> sudo apt-get update && sudo apt-get install pipx', () => {
    const spec = installCommand('debian', 'pipx');
    expect(spec?.command).toBe('sudo apt-get update && sudo apt-get install pipx');
    expect(spec?.sourceNote.length).toBeGreaterThan(0);
    expect(spec?.docsUrl).toMatch(/^https:\/\//);
  });

  it('debian llamacpp -> undefined (guidance only — unconfirmed archive package name)', () => {
    expect(installCommand('debian', 'llamacpp')).toBeUndefined();
  });

  it('arch pipx -> sudo pacman -S --needed python-pipx', () => {
    const spec = installCommand('arch', 'pipx');
    expect(spec?.command).toBe('sudo pacman -S --needed python-pipx');
    expect(spec?.sourceNote.length).toBeGreaterThan(0);
    expect(spec?.docsUrl).toMatch(/^https:\/\//);
  });

  it('arch llamacpp -> sudo pacman -S --needed llama-cpp', () => {
    const spec = installCommand('arch', 'llamacpp');
    expect(spec?.command).toBe('sudo pacman -S --needed llama-cpp');
    expect(spec?.sourceNote.length).toBeGreaterThan(0);
    expect(spec?.docsUrl).toMatch(/^https:\/\//);
  });

  it('suse pipx -> sudo zypper install python3-pipx', () => {
    const spec = installCommand('suse', 'pipx');
    expect(spec?.command).toBe('sudo zypper install python3-pipx');
    expect(spec?.sourceNote.length).toBeGreaterThan(0);
    expect(spec?.docsUrl).toMatch(/^https:\/\//);
  });

  it('suse llamacpp -> sudo zypper install llamacpp', () => {
    const spec = installCommand('suse', 'llamacpp');
    expect(spec?.command).toBe('sudo zypper install llamacpp');
    expect(spec?.sourceNote.length).toBeGreaterThan(0);
    expect(spec?.docsUrl).toMatch(/^https:\/\//);
  });

  it('unknown family -> undefined for every key (fail-closed, never a guessed command)', () => {
    expect(installCommand('unknown', 'pipx')).toBeUndefined();
    expect(installCommand('unknown', 'llamacpp')).toBeUndefined();
  });

  it('every returned spec carries a non-empty sourceNote naming a trusted source and an https docsUrl', () => {
    const families: DistroFamily[] = ['fedora', 'debian', 'arch', 'suse', 'unknown'];
    const keys: PackageKey[] = ['pipx', 'llamacpp'];
    for (const family of families) {
      for (const key of keys) {
        const spec = installCommand(family, key);
        if (spec === undefined) continue;
        expect(spec.sourceNote.trim().length, `${family}/${key} sourceNote`).toBeGreaterThan(10);
        expect(spec.docsUrl, `${family}/${key} docsUrl`).toMatch(/^https:\/\//);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Security posture — regex over every composed command string, from BOTH
// installCommand and pythonInstallPlan. No auto-confirm flags, ever. No
// `add-apt-repository`, ever (§5.3 rev 3 — the third-party-PPA tier does
// not exist).
// ---------------------------------------------------------------------------

describe('packageTable: security posture — no auto-confirm flags, no add-apt-repository, anywhere', () => {
  const AUTO_CONFIRM_OR_PPA = /(^|\s)-y(\s|$)|--noconfirm|add-apt-repository/;

  function allInstallCommandStrings(): string[] {
    const families: DistroFamily[] = ['fedora', 'debian', 'arch', 'suse', 'unknown'];
    const keys: PackageKey[] = ['pipx', 'llamacpp'];
    const out: string[] = [];
    for (const family of families) {
      for (const key of keys) {
        const spec = installCommand(family, key);
        if (spec !== undefined) out.push(spec.command);
      }
    }
    return out;
  }

  function allPythonPlanCommandStrings(): string[] {
    const fixtures: Array<{ release: OsRelease; family: DistroFamily }> = [
      { release: { id: 'fedora', idLike: [], versionId: '44' }, family: 'fedora' },
      { release: { id: 'ubuntu', idLike: ['debian'], versionId: '22.04' }, family: 'debian' },
      { release: { id: 'ubuntu', idLike: ['debian'], versionId: '26.04' }, family: 'debian' },
      { release: { id: 'debian', idLike: [], versionId: '13' }, family: 'debian' },
      { release: { id: 'linuxmint', idLike: ['ubuntu', 'debian'], versionId: '21.3' }, family: 'debian' },
      { release: { id: 'pop', idLike: ['ubuntu', 'debian'], versionId: '22.04' }, family: 'debian' },
      { release: { id: 'arch', idLike: [] }, family: 'arch' },
      { release: { id: 'opensuse-tumbleweed', idLike: ['opensuse', 'suse'], versionId: '20260803' }, family: 'suse' },
      { release: { idLike: [] }, family: 'unknown' },
    ];
    const out: string[] = [];
    for (const { release, family } of fixtures) {
      const plan = pythonInstallPlan(release, family);
      if (plan.kind === 'command') out.push(plan.command);
    }
    return out;
  }

  it('no composed installCommand string contains -y, --noconfirm, or add-apt-repository', () => {
    for (const command of allInstallCommandStrings()) {
      expect(command, command).not.toMatch(AUTO_CONFIRM_OR_PPA);
    }
    expect(allInstallCommandStrings().length).toBeGreaterThan(0); // non-vacuous
  });

  it('no composed pythonInstallPlan command string contains -y, --noconfirm, or add-apt-repository', () => {
    for (const command of allPythonPlanCommandStrings()) {
      expect(command, command).not.toMatch(AUTO_CONFIRM_OR_PPA);
    }
    expect(allPythonPlanCommandStrings().length).toBeGreaterThan(0); // non-vacuous: at least one command-kind fixture
  });

  it('pacman commands keep --needed (idempotence, not auto-confirm)', () => {
    expect(installCommand('arch', 'pipx')?.command).toContain('--needed');
    expect(installCommand('arch', 'llamacpp')?.command).toContain('--needed');
  });
});

// ---------------------------------------------------------------------------
// pythonInstallPlan — the §5.3 three-tier decision.
// ---------------------------------------------------------------------------

const PYTHON_GUIDANCE_TEXT =
  "Hermes needs Python 3.11–3.13, and your system's own package archive doesn't carry one in range. Install a supported Python yourself (see your distro's documentation or python.org), then press Re-check — Talaria will find it automatically.";

describe('packageTable: pythonInstallPlan — command-kind branches', () => {
  it('fedora -> command sudo dnf install python3.13 (no version gating — always offered)', () => {
    const plan = pythonInstallPlan({ id: 'fedora', idLike: [], versionId: '44' }, 'fedora');
    expect(plan.kind).toBe('command');
    if (plan.kind === 'command') {
      expect(plan.command).toBe('sudo dnf install python3.13');
      expect(plan.sourceNote.length).toBeGreaterThan(0);
      expect(plan.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("ubuntu 22.04 -> command with the load-bearing -venv companion", () => {
    const plan = pythonInstallPlan({ id: 'ubuntu', idLike: ['debian'], versionId: '22.04' }, 'debian');
    expect(plan.kind).toBe('command');
    if (plan.kind === 'command') {
      expect(plan.command).toBe('sudo apt-get update && sudo apt-get install python3.11 python3.11-venv');
      expect(plan.command).toContain('python3.11-venv');
      expect(plan.sourceNote.length).toBeGreaterThan(0);
    }
  });

  it('ubuntu 22.04.5 point release -> versionId startsWith match still fires', () => {
    const plan = pythonInstallPlan({ id: 'ubuntu', idLike: ['debian'], versionId: '22.04.5' }, 'debian');
    expect(plan.kind).toBe('command');
  });

  it('suse -> command sudo zypper install python313 (live-verified, R-5 — see test-file header)', () => {
    const plan = pythonInstallPlan(
      { id: 'opensuse-tumbleweed', idLike: ['opensuse', 'suse'], versionId: '20260803' },
      'suse',
    );
    expect(plan.kind).toBe('command');
    if (plan.kind === 'command') {
      expect(plan.command).toBe('sudo zypper install python313');
      expect(plan.command).not.toContain('python313-pip');
      expect(plan.sourceNote.toLowerCase()).toContain('venv');
      expect(plan.docsUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('packageTable: pythonInstallPlan — guidance-kind branches (§5.3 tier 3, §6 verbatim text)', () => {
  function expectGuidance(release: OsRelease, family: DistroFamily, label: string) {
    const plan = pythonInstallPlan(release, family);
    expect(plan.kind, label).toBe('guidance');
    if (plan.kind === 'guidance') {
      expect(plan.text, label).toBe(PYTHON_GUIDANCE_TEXT);
      expect(plan.docsUrl, label).toMatch(/^https:\/\//);
    }
  }

  it('ubuntu 26.04 -> guidance (whole archive out of range, no PPA tier)', () => {
    expectGuidance({ id: 'ubuntu', idLike: ['debian'], versionId: '26.04' }, 'debian', 'ubuntu 26.04');
  });

  it('ubuntu with unknown/missing versionId -> guidance (fail-closed, never guessed)', () => {
    expectGuidance({ id: 'ubuntu', idLike: ['debian'] }, 'debian', 'ubuntu unknown versionId');
  });

  it('ubuntu 22.10 (not the 22.04 LTS) -> guidance — startsWith gate must not over-match', () => {
    expectGuidance({ id: 'ubuntu', idLike: ['debian'], versionId: '22.10' }, 'debian', 'ubuntu 22.10');
  });

  it('debian (plain) -> guidance, never the ubuntu command (C-3: gated on release.id, not family)', () => {
    expectGuidance({ id: 'debian', idLike: [], versionId: '13' }, 'debian', 'debian 13');
  });

  it('linux mint -> guidance, NOT the ubuntu command, even though ID_LIKE contains ubuntu (C-3 counterexample)', () => {
    expectGuidance(
      { id: 'linuxmint', idLike: ['ubuntu', 'debian'], versionId: '21.3' },
      'debian',
      'linux mint',
    );
  });

  it('pop!_os -> guidance, NOT the ubuntu command (C-3 counterexample)', () => {
    expectGuidance({ id: 'pop', idLike: ['ubuntu', 'debian'], versionId: '22.04' }, 'debian', 'pop!_os');
  });

  it('arch -> guidance (no official versioned pythons; AUR never offered)', () => {
    expectGuidance({ id: 'arch', idLike: [] }, 'arch', 'arch');
  });

  it('unknown family / unreadable os-release -> guidance', () => {
    expectGuidance({ idLike: [] }, 'unknown', 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Purity — zero vscode (Global Constraint 5).
// ---------------------------------------------------------------------------

describe('packageTable: purity — zero vscode (Global Constraint 5)', () => {
  it('packageTable.ts imports no vscode', () => {
    const files = collectNonTestTsSources(__dirname).filter((f) => f.file === 'packageTable.ts');
    expect(files).toHaveLength(1); // non-vacuous
    expect(scanLines(files, VSCODE_IMPORT_BAN)).toEqual([]);
  });
});
