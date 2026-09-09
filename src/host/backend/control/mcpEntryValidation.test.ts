import { describe, it, expect } from 'vitest';
import {
  validateMcpAdd,
  stripModalControls,
  describeAddForModal,
  validateCatalogInstall,
  describeCatalogForModal,
  extractMcpEnabled,
  ENV_REFERENCE_PATTERN,
  secretEnvKeyFor,
  envReference,
  checkSecretValue,
  findSecretKeyCollision,
} from './mcpEntryValidation';
import { MODAL_UNSAFE_TEXT_PATTERN, redactForModal } from '../../setup/modalText';
import type { McpAddParams, McpCatalogEntry } from '../../../shared/protocol';

/**
 * Task A3 (features-add-mcp-skills-architecture.md :554-648) — the SECURITY
 * SPINE of T1: host-side re-validation of every MCP add/catalog-install
 * param BEFORE any network call, modal, or log line (§3 Layer 1), plus the
 * anti-modal-forgery consent-detail builders (§3 Layer 3, §4.4/§4.6/§4.7).
 * This is the heaviest TDD of the wave — written and watched RED before
 * `mcpEntryValidation.ts` exists.
 */

const stdio = (over: Record<string, unknown> = {}) => ({
  name: 'gh',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: {},
  secretEnvNames: [],
  ...over,
});

describe('validateMcpAdd', () => {
  it('accepts a plain npx stdio entry', () => expect(validateMcpAdd(stdio()).ok).toBe(true));

  it.each(['bash', 'sh', '/usr/bin/zsh', 'powershell.exe', 'PWSH'])('S-4: refuses shell interpreter %s', (cmd) => {
    const r = validateMcpAdd(stdio({ command: cmd }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/shell/i);
  });

  it('S-1: refuses names outside the charset', () => {
    for (const bad of ['..', 'a/b', 'a b', 'Qwen/../evil', 'имя', 'a%2Fb', '']) {
      expect(validateMcpAdd(stdio({ name: bad })).ok).toBe(false);
    }
  });

  it('S-2: refuses bad env names, oversized values, NUL/newline smuggling', () => {
    expect(validateMcpAdd(stdio({ env: { 'lower-case': 'v' } })).ok).toBe(false);
    expect(validateMcpAdd(stdio({ env: { GOOD: 'x'.repeat(5000) } })).ok).toBe(false);
    expect(validateMcpAdd(stdio({ command: 'npx\n-e' })).ok).toBe(false);
    expect(validateMcpAdd(stdio({ args: ['ok', 'a\u0000b'] })).ok).toBe(false);
  });

  it('S-3: http refuses non-http schemes and userinfo; accepts a plain https URL', () => {
    for (const url of ['file:///etc/passwd', 'ftp://x', 'http://user:pw@host/', 'https://']) {
      expect(validateMcpAdd({ name: 'r', transport: 'http', url }).ok).toBe(false);
    }
    expect(validateMcpAdd({ name: 'r', transport: 'http', url: 'https://mcp.example.com/sse' }).ok).toBe(true);
  });
});

describe('describeAddForModal', () => {
  it('shows command+args verbatim, env KEYS only, and the F-7 plaintext line', () => {
    const d = describeAddForModal(stdio({ env: { GITHUB_TOKEN: 'ghp_secret' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain('npx -y @modelcontextprotocol/server-github');
    expect(d.detail).toContain('GITHUB_TOKEN');
    expect(d.detail).not.toContain('ghp_secret');
    expect(d.detail).toContain("stored in PLAIN TEXT in Hermes' ~/.hermes/config.yaml");
    expect(d.detail).toMatch(/will run on your machine/i);
  });

  it('BLOCKER regression: a LONG args list renders in FULL — no 200-char redactForModal slice', () => {
    const longArgs = Array.from({ length: 12 }, (_v, i) => `--flag-number-${i}=some-quite-long-value-${i}`);
    const d = describeAddForModal(stdio({ args: longArgs }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail.length).toBeGreaterThan(200); // would be impossible under redactForModal's slice
    for (const a of longArgs) expect(d.detail).toContain(a); // every argument visible, verbatim
  });

  it('regression: preserves the paragraph separators between disclosure lines (composeModal used to strip them)', () => {
    const d = describeAddForModal(stdio({ env: { GITHUB_TOKEN: 'ghp_secret' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // stdio+env composes exactly five lines (Runs / Env keys / plaintext / runs-on-machine /
    // reload); joined with '\n\n' they MUST stay five paragraphs. The old join-then-strip order
    // erased every separator and collapsed the whole disclosure into one run-on line.
    expect(d.detail.split('\n\n')).toHaveLength(5);
  });
});

/* AU-59 (D-lite): the modal now says PRECISELY what config.yaml will hold per
 * env key — a typed value (plain text) or a secret-free `${KEY}` reference
 * Hermes resolves from `.env` at load time — and WARNS (never refuses; env is
 * legitimately mixed) when a PLAINTEXT key looks like a credential, using
 * the same deny-list core the host->webview redaction belt uses. Keys only —
 * a value never appears in the modal. */
describe('describeAddForModal — AU-59 D-lite: plaintext vs ${KEY}-reference partition + credential warn', () => {
  it('lists plaintext keys and reference keys as SEPARATE categories, each only when non-empty', () => {
    const d = describeAddForModal(stdio({ env: { LOG_LEVEL: 'info', GITHUB_TOKEN: '${GITHUB_TOKEN}' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain('Env keys (plain text): LOG_LEVEL');
    expect(d.detail).toContain("Env keys resolved from Hermes' .env at runtime (${KEY} reference — config.yaml stores only the reference): GITHUB_TOKEN");
    expect(d.detail).not.toContain('${GITHUB_TOKEN}'); // keys only — the reference VALUE itself is never echoed
    expect(d.detail).not.toContain('Looks like a credential'); // GITHUB_TOKEN is a reference; LOG_LEVEL is not credential-shaped
  });

  it('a reference-only env emits NO plaintext line at all (no false "PLAIN TEXT" disclosure)', () => {
    const d = describeAddForModal(stdio({ env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).not.toContain('PLAIN TEXT');
    expect(d.detail).not.toContain('Env keys (plain text)');
    expect(d.detail.split('\n\n')).toHaveLength(4); // Runs / reference line / runs-on-machine / reload
  });

  it('WARNS (never refuses) when a PLAINTEXT key looks like a credential — keys only, the value never appears', () => {
    const d = describeAddForModal(stdio({ env: { GITHUB_TOKEN: 'ghp_secret', LOG_LEVEL: 'info' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const warnTail = d.detail.split('Looks like a credential and will be stored in plain text: ')[1] ?? '';
    expect(warnTail.startsWith('GITHUB_TOKEN —')).toBe(true); // ONLY the credential-shaped key is named in the warn
    expect(d.detail).toContain('reference a ~/.hermes/.env key as ${KEY} instead');
    expect(d.detail).not.toContain('ghp_secret');
  });

  it('does NOT over-warn on ENVIRONMENT/NODE_ENV-style keys (the hint core has no `env` breadth)', () => {
    const d = describeAddForModal(stdio({ env: { ENVIRONMENT: 'prod', NODE_ENV: 'production' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).not.toContain('Looks like a credential');
    expect(d.detail).toContain('Env keys (plain text): ENVIRONMENT, NODE_ENV');
  });

  it('a PARTIAL interpolation (`Bearer ${X}`) is classified plaintext — the modal describes what config.yaml literally holds', () => {
    const d = describeAddForModal(stdio({ env: { AUTH_HEADER: 'Bearer ${X}' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain('Env keys (plain text): AUTH_HEADER');
    expect(d.detail).not.toContain("resolved from Hermes' .env");
  });

  it('the warn is folded INTO the plaintext paragraph: a credential-shaped plaintext add still composes exactly 5 paragraphs (the standing pin holds)', () => {
    const d = describeAddForModal(stdio({ env: { GITHUB_TOKEN: 'ghp_secret' } }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail.split('\n\n')).toHaveLength(5);
  });

  it('ENV_REFERENCE_PATTERN: whole-value ${VAR} and ${env:VAR} only (mirrors tools/mcp_tool.py _ENV_VAR_PATTERN, anchored)', () => {
    expect(ENV_REFERENCE_PATTERN.test('${GITHUB_TOKEN}')).toBe(true);
    expect(ENV_REFERENCE_PATTERN.test('${env:GITHUB_TOKEN}')).toBe(true);
    for (const notWhole of ['Bearer ${X}', '${X} ', '${}', 'plain', '$X', '${A}${B}']) {
      expect(ENV_REFERENCE_PATTERN.test(notWhole)).toBe(false);
    }
  });
});

describe('stripModalControls', () => {
  it('strips the modal-forging class but never length-slices', () => {
    const long = 'x'.repeat(1000);
    expect(stripModalControls(long)).toHaveLength(1000);
    expect(stripModalControls('a\u202Eb\u200Bc')).toBe('abc'); // RTL-override / zero-width stripped (escaped literals)
  });
});

/**
 * R3-ARCH-01 (T5): `stripModalControls` now delegates to `modalText.ts`'s
 * `stripModalUnsafeText` (the leaf) instead of rebuilding its own module-init
 * `.source`-derived `/g` regex \u2014 behaviour-preserving. Every codepoint below
 * is built via `String.fromCharCode` (never a literal escape) so this test
 * file itself never carries a raw exotic byte.
 */
describe('R3-ARCH-01: stripModalControls delegates to the modalText leaf (behaviour-preserving)', () => {
  const BOUNDARY_CODEPOINTS: Array<[string, number]> = [
    ['U+0000', 0x0000],
    ['U+001F', 0x001f],
    ['U+007F', 0x007f],
    ['U+0080', 0x0080],
    ['U+009F', 0x009f],
    ['U+061C', 0x061c],
    ['U+200B', 0x200b],
    ['U+200F', 0x200f],
    ['U+2028', 0x2028],
    ['U+2029', 0x2029],
    ['U+202A', 0x202a],
    ['U+202E', 0x202e],
    ['U+2060', 0x2060],
    ['U+2066', 0x2066],
    ['U+2069', 0x2069],
    ['U+FEFF', 0xfeff],
  ];

  it.each(BOUNDARY_CODEPOINTS)('strips %s (one codepoint per sub-range of the unsafe class)', (_name, code) => {
    const ch = String.fromCharCode(code);
    const stripped = stripModalControls(`a${ch}b`);
    expect(MODAL_UNSAFE_TEXT_PATTERN.test(stripped)).toBe(false);
    expect(stripped).toBe('ab');
  });

  it('BLOCKER invariant: strip-only, never length-slices \u2014 a 300-char value keeps all 300 characters', () => {
    expect(stripModalControls('a'.repeat(300)).length).toBe(300);
  });

  it('agrees with redactForModal under its 200-char cap (behaviour-identical below the cap)', () => {
    const withUnsafe = `x${String.fromCharCode(0x202e)}y${String.fromCharCode(0x200b)}z`;
    expect(withUnsafe.length).toBeLessThan(200);
    expect(stripModalControls(withUnsafe)).toBe(redactForModal(withUnsafe));
  });
});

const catalogRow = (over: Record<string, unknown> = {}) => ({
  name: 'n8n',
  description: 'd',
  source: '',
  transport: 'stdio',
  auth_type: 'api_key',
  required_env: [{ name: 'N8N_KEY', prompt: 'key', required: true }],
  command: 'npx',
  args: ['-y', 'x'],
  url: null,
  install_url: null,
  install_ref: null,
  bootstrap: [],
  // R-a (controller reconciliation): the plan's :609-612 builder omitted the
  // now-required McpCatalogEntry.default_enabled field — added here (never
  // loosening the type) so these fixtures compile against the real shape.
  default_enabled: null,
  post_install: '',
  needs_install: false,
  installed: false,
  enabled: false,
  ...over,
});

describe('validateCatalogInstall', () => {
  it('name must match a listed row; env keys limited to the row required_env', () => {
    expect(validateCatalogInstall({ name: 'ghost', env: {} }, [catalogRow()]).ok).toBe(false);
    expect(validateCatalogInstall({ name: 'n8n', env: { OTHER: 'v' } }, [catalogRow()]).ok).toBe(false);
    expect(validateCatalogInstall({ name: 'n8n', env: { N8N_KEY: 'v' } }, [catalogRow()]).ok).toBe(true);
  });

  it('applies S-4 to the manifest command (a shell-command catalog row is refused)', () => {
    expect(validateCatalogInstall({ name: 'n8n', env: {} }, [catalogRow({ command: 'bash', args: ['-c', 'x'] })]).ok).toBe(false);
  });
});

describe('describeCatalogForModal', () => {
  it('BLOCKER regression: a build entry with MANY/LONG bootstrap lines renders EVERY line in full', () => {
    const bootstrap = [
      'npm ci --no-audit --no-fund',
      'npm run build -- --configuration=production --output-path=./dist/server',
      'python3 -m venv .venv && .venv/bin/pip install --requirement requirements.txt --no-cache-dir',
      'make install PREFIX=$HOME/.local/share/mcp-servers/this-entry',
    ];
    const d = describeCatalogForModal(catalogRow({
      needs_install: true,
      install_url: 'https://github.com/some-org/some-quite-long-repository-name',
      install_ref: 'v1.2.3',
      bootstrap,
    }) as McpCatalogEntry);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain('Clones: https://github.com/some-org/some-quite-long-repository-name @ v1.2.3 (pinned)');
    for (const cmd of bootstrap) expect(d.detail).toContain(`$ ${cmd}`); // FULL list, verbatim — the consent depends on it
    expect(d.detail.length).toBeGreaterThan(200); // proves the redactForModal slice is NOT in this path
    expect(d.detail).toMatch(/IN A SHELL on your machine/);
  });

  it('fail-closed ceiling: a detail past MODAL_DETAIL_MAX is REFUSED with terminal guidance, never truncated', () => {
    const huge = Array.from({ length: 100 }, (_v, i) => `step-${i}: ${'x'.repeat(80)}`);
    const d = describeCatalogForModal(catalogRow({
      needs_install: true,
      install_url: 'https://github.com/x/y',
      install_ref: 'v1',
      bootstrap: huge,
    }) as McpCatalogEntry);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toMatch(/too large to review/i);
    expect(d.reason).toContain('hermes mcp install');
  });

  // -------------------------------------------------------------------
  // Rev-1 B4 (CF-13 parity, TH-4) — SUPERSEDES the old A3-IMP2 binding
  // ("the credentials line must reflect what the user actually
  // submitted"): credentials are now collected HOST-side, masked, AFTER
  // this modal is confirmed — `describeCatalogForModal` no longer takes a
  // `submittedEnv` argument at all. The disclosure is FUTURE-TENSE and
  // driven entirely by the entry's OWN `required_env` schema.
  // -------------------------------------------------------------------
  it('Rev-1 B4: shows the future-tense credential line naming every required_env var + the .env destination, when required_env is non-empty', () => {
    const d = describeCatalogForModal(
      catalogRow({ required_env: [{ name: 'N8N_KEY', prompt: 'API key', required: true }] }) as McpCatalogEntry,
    );
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain("Will prompt for: N8N_KEY — saved to Hermes' .env store (~/.hermes/.env).");
  });

  it('Rev-1 B4: names EVERY required_env var, not just the first', () => {
    const d = describeCatalogForModal(
      catalogRow({
        required_env: [
          { name: 'OPENAI_API_KEY', prompt: 'OpenAI key', required: true },
          { name: 'N8N_KEY', prompt: 'n8n key', required: true },
        ],
      }) as McpCatalogEntry,
    );
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain("Will prompt for: OPENAI_API_KEY, N8N_KEY — saved to Hermes' .env store (~/.hermes/.env).");
  });

  it('Rev-1 B4 (no false disclosure): omits the credential line entirely when required_env is empty', () => {
    const d = describeCatalogForModal(catalogRow({ required_env: [] }) as McpCatalogEntry);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).not.toContain('Will prompt for');
    expect(d.detail).not.toContain("saved to Hermes' .env store");
  });

  it('MINOR-4 fail-closed: a malformed entry with no usable transport is refused, not silently rendered', () => {
    const d = describeCatalogForModal(catalogRow({ transport: 'http', command: null, url: null }) as McpCatalogEntry);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toMatch(/no usable transport/i);
    expect(d.reason).toContain('n8n');
  });

  it('regression + anti-forgery: real separators survive, but a break smuggled into a catalog field cannot forge a paragraph', () => {
    // A catalog row's own command is NOT charset-validated before the modal is built (only
    // shell-interpreter + env are), so a Hermes-supplied field could carry line separators.
    const d = describeCatalogForModal(catalogRow({ command: 'npx\n\nVerified by Nous: yes', args: [] }) as McpCatalogEntry);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const paragraphs = d.detail.split('\n\n');
    // structural separators survive: the source line and the Runs line are DISTINCT paragraphs
    // (under the old join-then-strip order this collapsed to a single paragraph).
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    // ...but every break inside the field was stripped, so the forged text is glued onto the Runs
    // line and never becomes its own paragraph — no field value can forge a modal line.
    expect(paragraphs.some((p) => p.startsWith('Verified by Nous'))).toBe(false);
    expect(d.detail).toContain('Runs: npxVerified by Nous: yes');
  });
});

describe('extractMcpEnabled — BHF-F1-2 (firm): literal boolean or honest refusal', () => {
  it('accepts literal true and literal false', () => {
    expect(extractMcpEnabled({ enabled: true })).toBe(true);
    expect(extractMcpEnabled({ enabled: false })).toBe(false);
  });

  it.each([
    ['missing enabled', {}],
    ['string "true"', { enabled: 'true' }],
    ['string "false"', { enabled: 'false' }],
    ['number 1', { enabled: 1 }],
    ['number 0', { enabled: 0 }],
    ['null enabled', { enabled: null }],
    ['undefined params', undefined],
    ['null params', null],
    ['array params', []],
    ['string params', 'enabled'],
  ])('throws an honest refusal for %s — NEVER a silent false', (_label, params) => {
    expect(() => extractMcpEnabled(params)).toThrow(/literal boolean/);
  });

  it('the refusal names only the offending TYPE, never the payload value', () => {
    let message = '';
    try {
      extractMcpEnabled({ enabled: 'sk-secret-value' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('a string value');
    expect(message).not.toContain('sk-secret-value');
  });
});

/* AU-59 (D-full): `secretEnvNames` carries NAMES ONLY. The gate is here, on
 * the host, before any modal/network/log line — the webview is untrusted. */
describe('validateMcpAdd — AU-59 secretEnvNames (names only, stdio only)', () => {
  it('absent → [] and the REST wire body is unchanged (older callers add no secrets)', () => {
    const { secretEnvNames: _dropped, ...withoutField } = stdio();
    const r = validateMcpAdd(withoutField);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secretEnvNames).toEqual([]);
    expect(r.body).toEqual({ name: 'gh', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: {} });
    expect('secretEnvNames' in r.body).toBe(false); // NEVER inside the body Hermes receives
  });

  it('accepts valid names, trims, drops blank lines; the body still carries no secretEnvNames', () => {
    const r = validateMcpAdd(stdio({ secretEnvNames: [' GITHUB_TOKEN ', '', 'OPENAI_API_KEY'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secretEnvNames).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    expect('secretEnvNames' in r.body).toBe(false);
  });

  it.each([
    ['a non-array', 'GITHUB_TOKEN', /array of strings/],
    ['a non-string item', [42], /must be a string/],
    ['a lowercase/hyphenated name', ['github-token'], /must match/],
    ['a duplicate', ['A_KEY', 'A_KEY'], /duplicate/],
    ['more than 8 names', Array.from({ length: 9 }, (_v, i) => `K${i}`), /more than 8/],
  ])('refuses %s', (_label, secretEnvNames, reason) => {
    const r = validateMcpAdd(stdio({ secretEnvNames }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('a bad name is refused WITHOUT echoing it (a VALUE pasted into the names box must not reach logs)', () => {
    const r = validateMcpAdd(stdio({ secretEnvNames: ['ghp_live_value'] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('entry 1');
    expect(r.reason).not.toContain('ghp_live_value');
  });

  it('refuses a secret name that is also a plaintext env key (the two sets are disjoint)', () => {
    const r = validateMcpAdd(stdio({ env: { GITHUB_TOKEN: 'x' }, secretEnvNames: ['GITHUB_TOKEN'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/both as a plain-text env key and as a secret env name/);
  });

  it('http: secretEnvNames is refused unless absent or empty (a remote server has no subprocess env)', () => {
    expect(validateMcpAdd({ name: 'r', transport: 'http', url: 'https://x.example/mcp', secretEnvNames: ['K'] }).ok).toBe(false);
    const ok = validateMcpAdd({ name: 'r', transport: 'http', url: 'https://x.example/mcp', secretEnvNames: [] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.secretEnvNames).toEqual([]);
  });
});

describe('AU-59: secretEnvKeyFor / envReference / checkSecretValue', () => {
  it.each([
    ['gh', 'GITHUB_TOKEN', 'MCP_GH_GITHUB_TOKEN'],
    ['my-server.v2', 'KEY', 'MCP_MY_SERVER_V2_KEY'],
    ['a-', 'K', 'MCP_A_K'],
    ['Mixed_Case', 'T', 'MCP_MIXED_CASE_T'],
  ])('secretEnvKeyFor(%s, %s) mirrors Hermes _env_key_for_server → %s', (server, secret, expected) => {
    expect(secretEnvKeyFor(server, secret)).toBe(expected);
  });

  it('every produced key satisfies Hermes _ENV_VAR_NAME_RE and starts with MCP_ — so it can never be a denylisted name', () => {
    const hermesNameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const server of ['gh', 'a.b-c_d', '0start', 'x'.repeat(64)]) {
      const key = secretEnvKeyFor(server, 'API_KEY');
      expect(hermesNameRe.test(key)).toBe(true);
      expect(key.startsWith('MCP_')).toBe(true);
      expect(['PATH', 'LD_PRELOAD', 'PYTHONPATH', 'HERMES_HOME', 'EDITOR', 'NODE_OPTIONS']).not.toContain(key);
    }
  });

  it('envReference round-trips through ENV_REFERENCE_PATTERN (the reference we write is the reference the modal classifies)', () => {
    const ref = envReference('MCP_GH_GITHUB_TOKEN');
    expect(ref).toBe('${MCP_GH_GITHUB_TOKEN}');
    expect(ENV_REFERENCE_PATTERN.test(ref)).toBe(true);
  });

  it('checkSecretValue: printable ASCII up to 4096 passes', () => {
    expect(checkSecretValue('ghp_abc123-XYZ.~!#=/+')).toEqual({ ok: true, value: 'ghp_abc123-XYZ.~!#=/+' });
    expect(checkSecretValue('x'.repeat(4096)).ok).toBe(true);
  });

  it('checkSecretValue: empty / non-ASCII / control bytes / oversize are refused, and the reason never carries the value', () => {
    expect(checkSecretValue('').ok).toBe(false);
    for (const bad of ['ghp_ábc', 'a\nb', 'a\tb', 'x'.repeat(4097)]) {
      const r = checkSecretValue(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toContain(bad.slice(0, 5));
    }
    const nonAscii = checkSecretValue('ghp_ábc');
    if (!nonAscii.ok) expect(nonAscii.reason).toMatch(/printable ASCII/);
  });
});

describe('L2-CA-22: findSecretKeyCollision — punctuation-only name collisions across listed servers', () => {
  it('finds a collision when a new name\'s secret key would match an existing listed server\'s (punctuation-only name difference)', () => {
    expect(findSecretKeyCollision('my-server', ['TOKEN'], new Set(['my.server']))).toEqual({
      key: 'MCP_MY_SERVER_TOKEN',
      otherServer: 'my.server',
    });
  });

  it('no collision when no listed name maps to the same key', () => {
    expect(findSecretKeyCollision('gh', ['TOKEN'], new Set(['gh2']))).toBeUndefined();
  });

  it('the new name itself already being listed is NOT our collision (Hermes\' own 409 handles a same-name re-add)', () => {
    expect(findSecretKeyCollision('gh', ['TOKEN'], new Set(['gh']))).toBeUndefined();
  });
});

describe('describeAddForModal — AU-59 "Will prompt for" line (future tense, names + namespaced .env keys)', () => {
  it('names each secret and its MCP_<NAME>_<KEY> destination; no PLAIN TEXT line when env is empty', () => {
    const d = describeAddForModal(stdio({ secretEnvNames: ['GITHUB_TOKEN', 'OPENAI_API_KEY'] }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain(
      "Will prompt for: GITHUB_TOKEN, OPENAI_API_KEY — saved to Hermes' .env store (~/.hermes/.env) as MCP_GH_GITHUB_TOKEN, MCP_GH_OPENAI_API_KEY; config.yaml gets only the ${KEY} reference, never the value.",
    );
    expect(d.detail).not.toContain('PLAIN TEXT');
    expect(d.detail.split('\n\n')).toHaveLength(4); // Runs / Will prompt for / runs-on-machine / reload
  });

  it('omits the line entirely when secretEnvNames is empty (no false disclosure); the standing 5-paragraph pin is untouched', () => {
    const d = describeAddForModal(stdio({ env: { GITHUB_TOKEN: 'ghp_secret' }, secretEnvNames: [] }) as McpAddParams);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).not.toContain('Will prompt for');
    expect(d.detail.split('\n\n')).toHaveLength(5);
  });

  it('a mixed add lists plaintext, reference AND prompt lines in that order', () => {
    const d = describeAddForModal(
      stdio({ env: { LOG_LEVEL: 'info', OTHER: '${OTHER}' }, secretEnvNames: ['GITHUB_TOKEN'] }) as McpAddParams,
    );
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const paragraphs = d.detail.split('\n\n');
    expect(paragraphs.findIndex((p) => p.startsWith('Env keys (plain text)'))).toBeLessThan(
      paragraphs.findIndex((p) => p.startsWith("Env keys resolved from Hermes' .env")),
    );
    expect(paragraphs.findIndex((p) => p.startsWith("Env keys resolved from Hermes' .env"))).toBeLessThan(
      paragraphs.findIndex((p) => p.startsWith('Will prompt for')),
    );
  });
});
