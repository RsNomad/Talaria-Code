/**
 * OS-release parsing + distro-family/package-manager resolution
 * (beta5-setup-hardening-architecture.md §1.1, Task T3).
 *
 * PURE — zero `vscode`, zero `fs` imports (Global Constraint 5, as sharpened
 * for this module by the T3 task brief: "osDetect.ts has ZERO vscode
 * imports and no fs"). `parseOsRelease` takes the os-release file's TEXT as
 * a plain string parameter rather than reading `/etc/os-release` itself —
 * the caller (a later task's host seam) is responsible for the actual file
 * read, keeping this module deterministic and unit-testable with zero
 * mocking. `osDetect.test.ts`'s "purity" describe block mechanizes this ban
 * via the shared `purityScan` directory-scan walker, the same mechanism
 * `registry.test.ts` (h) already uses for the vscode-only ban across this
 * directory.
 */

export interface OsRelease {
  id?: string;
  idLike: string[];
  versionId?: string;
  prettyName?: string;
}

export type DistroFamily = 'fedora' | 'debian' | 'arch' | 'suse' | 'unknown';
export type PackageManager = 'dnf' | 'apt-get' | 'pacman' | 'zypper' | 'unknown';

/**
 * `KEY=value` line matcher — captures the key and the (possibly quoted) raw
 * value. Anchored to a leading identifier-shaped key (letters/digits/
 * underscore, not starting with a digit) per the systemd os-release shell
 * grammar; anything not shaped like that (comments, blank lines, garbage) is
 * simply not a match and is skipped by the caller.
 */
const KEY_VALUE_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Strips one layer of matching surrounding quotes (double OR single, per
 * the os-release shell-style grammar) and trims incidental whitespace.
 * Deliberately no backslash-escape processing beyond that: every fixture
 * this module is contracted against (T3 brief Step 1) uses plain quoted
 * text, and the real-world distros this ships against (§1.1's family map)
 * never need escapes in `ID`/`ID_LIKE`/`VERSION_ID`/`PRETTY_NAME`.
 */
function unquote(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parses `/etc/os-release`-shaped text into an {@link OsRelease}. Handles
 * both unquoted (`KEY=value`) and quoted (`KEY="quoted value"` /
 * `KEY='quoted value'`) lines, ignores comment lines (`#...`, optionally
 * indented) and blank lines, and tolerates lines it doesn't recognize
 * (never throws on empty or garbage input — an unparseable file simply
 * yields an `OsRelease` with every field absent, which
 * {@link resolveDistroFamily} maps to `'unknown'`).
 */
export function parseOsRelease(text: string): OsRelease {
  const release: OsRelease = { id: undefined, idLike: [], versionId: undefined, prettyName: undefined };

  for (const rawLine of text.split(/\r\n|\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = KEY_VALUE_LINE.exec(line);
    if (!match) continue;
    // `noUncheckedIndexedAccess`: capture-group indices type as
    // `string | undefined` even though this regex has no optional groups
    // and a successful `exec` always populates both. Guard rather than
    // assert non-null (typescript-anti-patterns: no `!`).
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    const value = unquote(rawValue);

    switch (key) {
      case 'ID':
        release.id = value;
        break;
      case 'ID_LIKE':
        release.idLike = value.split(/\s+/).filter((token) => token.length > 0);
        break;
      case 'VERSION_ID':
        release.versionId = value;
        break;
      case 'PRETTY_NAME':
        release.prettyName = value;
        break;
      default:
        break;
    }
  }

  return release;
}

/**
 * Family map (locked by test — §1.1 line ~97): every `ID`/`ID_LIKE` token on
 * the left resolves to the {@link DistroFamily} on the right. Used both as
 * the direct `ID` lookup and, in order, for each `ID_LIKE` token.
 */
const FAMILY_MAP: Readonly<Record<string, DistroFamily>> = {
  fedora: 'fedora',
  rhel: 'fedora',
  centos: 'fedora',
  rocky: 'fedora',
  almalinux: 'fedora',

  debian: 'debian',
  ubuntu: 'debian',
  linuxmint: 'debian',
  pop: 'debian',

  arch: 'arch',
  manjaro: 'arch',
  endeavouros: 'arch',

  opensuse: 'suse',
  'opensuse-tumbleweed': 'suse',
  'opensuse-leap': 'suse',
  sles: 'suse',
  suse: 'suse',
};

/**
 * Resolves an {@link OsRelease} to a {@link DistroFamily}: `ID` is checked
 * first; if absent or unmapped, each `ID_LIKE` token is checked in order and
 * the first match wins. Never mutates `release` (in particular, `release.id`
 * is left exactly as parsed — e.g. Linux Mint keeps `id: 'linuxmint'` even
 * though it resolves to the `'debian'` family). Returns `'unknown'` when
 * neither `ID` nor any `ID_LIKE` token is in the map (including when
 * `release` came from empty or garbage input).
 */
export function resolveDistroFamily(release: OsRelease): DistroFamily {
  if (release.id !== undefined) {
    const direct = FAMILY_MAP[release.id];
    if (direct !== undefined) return direct;
  }

  for (const token of release.idLike) {
    const mapped = FAMILY_MAP[token];
    if (mapped !== undefined) return mapped;
  }

  return 'unknown';
}

/** Maps a resolved {@link DistroFamily} to its native package manager. */
export function managerFor(family: DistroFamily): PackageManager {
  switch (family) {
    case 'fedora':
      return 'dnf';
    case 'debian':
      return 'apt-get';
    case 'arch':
      return 'pacman';
    case 'suse':
      return 'zypper';
    case 'unknown':
      return 'unknown';
  }
}
