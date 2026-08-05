import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectNonTestTsSources, scanLines, VSCODE_IMPORT_BAN, FS_IMPORT_BAN } from '../purityScan';
import {
  parseOsRelease,
  resolveDistroFamily,
  managerFor,
  type OsRelease,
  type DistroFamily,
} from './osDetect';

/**
 * osDetect.test.ts — Task T3 (beta5-setup-hardening-architecture.md §1.1).
 * Fixture table copied verbatim from the task brief
 * (`.superpowers/sdd/task-T3-brief.md` Step 1): Fedora 44, Ubuntu 24.04,
 * Debian 13, Arch, openSUSE Tumbleweed, Linux Mint 21.3 (the ID_LIKE-preserved
 * case), CentOS Stream, a dedicated quoted-values/VERSION_ID fixture, and
 * empty/garbage input.
 *
 * `osDetect.ts` is PURE (§1.1 header, Global Constraint 5 as sharpened by the
 * task brief): zero `vscode`, zero `fs` — it takes the os-release TEXT as a
 * parameter rather than reading `/etc/os-release` itself. The "purity" describe
 * block below is that ban, mechanized via the shared `purityScan` walker
 * (same mechanism `registry.test.ts` (h) already uses for the vscode-only
 * ban across this directory).
 */

// ---------------------------------------------------------------------------
// Fixtures — realistic /etc/os-release content per distro.
// ---------------------------------------------------------------------------

const FEDORA_44 = `NAME="Fedora Linux"
VERSION="44 (Workstation Edition)"
ID=fedora
VERSION_ID=44
VERSION_CODENAME=""
PLATFORM_ID="platform:f44"
PRETTY_NAME="Fedora Linux 44 (Workstation Edition)"
ANSI_COLOR="0;38;2;60;110;180"
LOGO=fedora-logo-icon
CPE_NAME="cpe:/o:fedoraproject:fedora:44"
DEFAULT_HOSTNAME="fedora"
HOME_URL="https://fedoraproject.org/"
DOCUMENTATION_URL="https://docs.fedoraproject.org/en-US/fedora/f44/system-administrators-guide/"
SUPPORT_URL="https://ask.fedoraproject.org/"
BUG_REPORT_URL="https://bugzilla.redhat.com/"
REDHAT_BUGZILLA_PRODUCT="Fedora"
REDHAT_BUGZILLA_PRODUCT_VERSION=44
REDHAT_SUPPORT_PRODUCT="Fedora"
REDHAT_SUPPORT_PRODUCT_VERSION=44
SUPPORT_END=2026-05-13
VARIANT="Workstation Edition"
VARIANT_ID=workstation
`;

const UBUNTU_2404 = `PRETTY_NAME="Ubuntu 24.04 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo
`;

const DEBIAN_13 = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"
`;

const ARCH = `NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
BUILD_ID=rolling
ANSI_COLOR="38;2;23;147;209"
HOME_URL="https://archlinux.org/"
DOCUMENTATION_URL="https://wiki.archlinux.org/"
SUPPORT_URL="https://bbs.archlinux.org/"
BUG_REPORT_URL="https://gitlab.archlinux.org/groups/archlinux/-/issues"
LOGO=archlinux
`;

const OPENSUSE_TUMBLEWEED = `NAME="openSUSE Tumbleweed"
# VERSION="20260803"
ID="opensuse-tumbleweed"
ID_LIKE="opensuse suse"
VERSION_ID="20260803"
PRETTY_NAME="openSUSE Tumbleweed"
ANSI_COLOR="0;32"
CPE_NAME="cpe:/o:opensuse:tumbleweed:20260803"
BUG_REPORT_URL="https://bugzilla.opensuse.org"
SUPPORT_URL="https://bugs.opensuse.org"
HOME_URL="https://www.opensuse.org"
DOCUMENTATION_URL="https://en.opensuse.org/Portal:Tumbleweed"
LOGO=distributor-logo-Tumbleweed
`;

// Brief line 6: `ID=linuxmint ID_LIKE="ubuntu debian" → family debian, id
// preserved as 'linuxmint'` (the family resolver must not overwrite `id`).
const LINUX_MINT_213 = `NAME="Linux Mint"
VERSION="21.3 (Virginia)"
ID=linuxmint
ID_LIKE="ubuntu debian"
PRETTY_NAME="Linux Mint 21.3"
VERSION_ID="21.3"
VERSION_CODENAME=virginia
UBUNTU_CODENAME=jammy
`;

const CENTOS_STREAM = `NAME="CentOS Stream"
VERSION="9"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="9"
PLATFORM_ID="platform:el9"
PRETTY_NAME="CentOS Stream 9"
ANSI_COLOR="0;31"
LOGO=fedora-logo-icon
CPE_NAME="cpe:/o:centos:centos:9"
HOME_URL="https://centos.org/"
BUG_REPORT_URL="https://issues.redhat.com/"
REDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux 9"
REDHAT_SUPPORT_PRODUCT_VERSION="CentOS Stream"
`;

// Dedicated quoted-values/VERSION_ID stress fixture (brief line 6, listed as
// its own bullet, separate from the named distros): single-quoted ID,
// double-quoted ID_LIKE with two tokens, double-quoted VERSION_ID, and a
// double-quoted PRETTY_NAME containing spaces + parens. Its `id` ('rhelish')
// is deliberately NOT in the direct ID map, so the family only resolves via
// the ID_LIKE fallback ('rhel' -> fedora) — exercising the "ID first, then
// ID_LIKE tokens" fallback path the interface comment documents.
const QUOTED_VALUES_FIXTURE = `ID='rhelish'
ID_LIKE="rhel fedora"
VERSION_ID="7.9"
PRETTY_NAME="Test Distro 7.9 (Special Edition)"
NAME=TestDistro
`;

describe('osDetect: parseOsRelease + resolveDistroFamily fixture table (T3 brief Step 1)', () => {
  it('Fedora 44 -> id=fedora, family fedora, versionId 44', () => {
    const release = parseOsRelease(FEDORA_44);
    expect(release.id).toBe('fedora');
    expect(release.idLike).toEqual([]);
    expect(release.versionId).toBe('44');
    expect(release.prettyName).toBe('Fedora Linux 44 (Workstation Edition)');
    expect(resolveDistroFamily(release)).toBe('fedora');
  });

  it('Ubuntu 24.04 -> id=ubuntu, idLike=[debian], family debian', () => {
    const release = parseOsRelease(UBUNTU_2404);
    expect(release.id).toBe('ubuntu');
    expect(release.idLike).toEqual(['debian']);
    expect(release.versionId).toBe('24.04');
    expect(resolveDistroFamily(release)).toBe('debian');
  });

  it('Debian 13 -> id=debian, family debian, no ID_LIKE needed', () => {
    const release = parseOsRelease(DEBIAN_13);
    expect(release.id).toBe('debian');
    expect(release.idLike).toEqual([]);
    expect(release.versionId).toBe('13');
    expect(resolveDistroFamily(release)).toBe('debian');
  });

  it('Arch -> id=arch, family arch, no VERSION_ID present', () => {
    const release = parseOsRelease(ARCH);
    expect(release.id).toBe('arch');
    expect(release.idLike).toEqual([]);
    expect(release.versionId).toBeUndefined();
    expect(resolveDistroFamily(release)).toBe('arch');
  });

  it('openSUSE Tumbleweed -> id=opensuse-tumbleweed, family suse, comment line ignored', () => {
    const release = parseOsRelease(OPENSUSE_TUMBLEWEED);
    expect(release.id).toBe('opensuse-tumbleweed');
    expect(release.idLike).toEqual(['opensuse', 'suse']);
    expect(release.versionId).toBe('20260803');
    expect(resolveDistroFamily(release)).toBe('suse');
  });

  it('Linux Mint 21.3 -> family debian, id PRESERVED as linuxmint (not overwritten)', () => {
    const release = parseOsRelease(LINUX_MINT_213);
    expect(release.id).toBe('linuxmint');
    expect(release.idLike).toEqual(['ubuntu', 'debian']);
    expect(resolveDistroFamily(release)).toBe('debian');
    // The family resolver must be a pure function of the release; the
    // original `id` field itself is untouched by resolution.
    expect(release.id).toBe('linuxmint');
  });

  it('CentOS Stream -> id=centos, family fedora', () => {
    const release = parseOsRelease(CENTOS_STREAM);
    expect(release.id).toBe('centos');
    expect(release.idLike).toEqual(['rhel', 'fedora']);
    expect(resolveDistroFamily(release)).toBe('fedora');
  });

  it('quoted values + VERSION_ID fixture -> mixed quote styles parsed, ID_LIKE fallback resolves family', () => {
    const release = parseOsRelease(QUOTED_VALUES_FIXTURE);
    expect(release.id).toBe('rhelish'); // single-quoted, quotes stripped
    expect(release.idLike).toEqual(['rhel', 'fedora']); // double-quoted, split on spaces
    expect(release.versionId).toBe('7.9'); // double-quoted VERSION_ID
    expect(release.prettyName).toBe('Test Distro 7.9 (Special Edition)');
    // 'rhelish' is not itself in the family map: family only resolves via
    // the ID_LIKE fallback, first token 'rhel' -> fedora.
    expect(resolveDistroFamily(release)).toBe('fedora');
  });

  it('empty text -> OsRelease resolving to family unknown', () => {
    const release = parseOsRelease('');
    expect(release.id).toBeUndefined();
    expect(release.idLike).toEqual([]);
    expect(release.versionId).toBeUndefined();
    expect(release.prettyName).toBeUndefined();
    expect(resolveDistroFamily(release)).toBe('unknown');
  });

  it('garbage text (no recognizable KEY=value lines) -> family unknown, no throw', () => {
    const garbage = `this is not an os-release file
*** random noise ***
=== nothing to see here ===
\t  \n\n#####\n`;
    const release = parseOsRelease(garbage);
    expect(release.id).toBeUndefined();
    expect(resolveDistroFamily(release)).toBe('unknown');
  });

  it('blank lines and comment-only lines are ignored, not mis-parsed', () => {
    const withNoise = `# leading comment\n\n  \nID=fedora\n# trailing comment\n\nVERSION_ID=44\n`;
    const release = parseOsRelease(withNoise);
    expect(release.id).toBe('fedora');
    expect(release.versionId).toBe('44');
  });

  it('an id with no family-map entry and no ID_LIKE resolves to unknown', () => {
    const release = parseOsRelease('ID=someweirddistro\n');
    expect(release.id).toBe('someweirddistro');
    expect(resolveDistroFamily(release)).toBe('unknown');
  });
});

describe('osDetect: resolveDistroFamily precedence (ID first, then ID_LIKE tokens, first match wins)', () => {
  it('ID match wins even when ID_LIKE would resolve to a different family', () => {
    const release: OsRelease = { id: 'fedora', idLike: ['debian'] };
    expect(resolveDistroFamily(release)).toBe('fedora');
  });

  it('ID_LIKE is consulted only when ID itself is absent or unmapped', () => {
    const release: OsRelease = { id: 'not-a-known-id', idLike: ['arch'] };
    expect(resolveDistroFamily(release)).toBe('arch');
  });

  it('within ID_LIKE, the FIRST matching token wins over a later one', () => {
    const release: OsRelease = { idLike: ['unknown-token', 'debian', 'arch'] };
    expect(resolveDistroFamily(release)).toBe('debian');
  });

  it('no id and no matching ID_LIKE token -> unknown', () => {
    const release: OsRelease = { idLike: ['also-unknown', 'still-unknown'] };
    expect(resolveDistroFamily(release)).toBe('unknown');
  });
});

describe('osDetect: family map is locked exactly as specified (§1.1 line ~97)', () => {
  const FEDORA_IDS = ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'];
  const DEBIAN_IDS = ['debian', 'ubuntu', 'linuxmint', 'pop'];
  const ARCH_IDS = ['arch', 'manjaro', 'endeavouros'];
  const SUSE_IDS = ['opensuse', 'opensuse-tumbleweed', 'opensuse-leap', 'sles', 'suse'];

  it.each(FEDORA_IDS)('id=%s -> fedora', (id) => {
    expect(resolveDistroFamily({ id, idLike: [] })).toBe('fedora');
  });

  it.each(DEBIAN_IDS)('id=%s -> debian', (id) => {
    expect(resolveDistroFamily({ id, idLike: [] })).toBe('debian');
  });

  it.each(ARCH_IDS)('id=%s -> arch', (id) => {
    expect(resolveDistroFamily({ id, idLike: [] })).toBe('arch');
  });

  it.each(SUSE_IDS)('id=%s -> suse', (id) => {
    expect(resolveDistroFamily({ id, idLike: [] })).toBe('suse');
  });

  it('the same ids also resolve correctly when seen only via ID_LIKE', () => {
    for (const id of [...FEDORA_IDS, ...DEBIAN_IDS, ...ARCH_IDS, ...SUSE_IDS]) {
      const viaId = resolveDistroFamily({ id, idLike: [] });
      const viaIdLike = resolveDistroFamily({ idLike: [id] });
      expect(viaIdLike, `ID_LIKE=[${id}] should resolve the same as ID=${id}`).toBe(viaId);
    }
  });
});

describe('osDetect: managerFor', () => {
  const CASES: Array<[DistroFamily, string]> = [
    ['fedora', 'dnf'],
    ['debian', 'apt-get'],
    ['arch', 'pacman'],
    ['suse', 'zypper'],
    ['unknown', 'unknown'],
  ];

  it.each(CASES)('family %s -> package manager %s', (family, expected) => {
    expect(managerFor(family)).toBe(expected);
  });
});

describe('osDetect: purity — zero vscode, zero fs (Global Constraint 5, sharpened by T3 brief)', () => {
  it('osDetect.ts imports neither vscode nor node:fs', () => {
    const files = collectNonTestTsSources(__dirname).filter((f) => f.file === 'osDetect.ts');
    expect(files).toHaveLength(1); // non-vacuous: the scan must actually see osDetect.ts
    expect(scanLines(files, VSCODE_IMPORT_BAN)).toEqual([]);
    expect(scanLines(files, FS_IMPORT_BAN)).toEqual([]);
  });

  it('osDetect.ts has no vscode import textually anywhere in the raw file (belt + suspenders)', () => {
    const source = readFileSync(join(__dirname, 'osDetect.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"]vscode['"]/);
    expect(source).not.toMatch(/from\s+['"](?:node:)?fs(?:\/promises)?['"]/);
  });
});
