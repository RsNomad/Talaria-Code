import { describe, it, expect } from 'vitest';
import {
  validateMcpAdd,
  stripModalControls,
  describeAddForModal,
  validateCatalogInstall,
  describeCatalogForModal,
} from './mcpEntryValidation';
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

describe('stripModalControls', () => {
  it('strips the modal-forging class but never length-slices', () => {
    const long = 'x'.repeat(1000);
    expect(stripModalControls(long)).toHaveLength(1000);
    expect(stripModalControls('a\u202Eb\u200Bc')).toBe('abc'); // RTL-override / zero-width stripped (escaped literals)
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

  it('§4.7 honesty: shows the credentials line when the caller supplied submitted env values', () => {
    const d = describeCatalogForModal(catalogRow() as McpCatalogEntry, { N8N_KEY: 'v' });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).toContain("Credentials are saved to Hermes' .env store (~/.hermes/.env).");
  });

  it('§4.7 honesty: omits the credentials line when no env was submitted, even though required_env is non-empty', () => {
    const d = describeCatalogForModal(catalogRow() as McpCatalogEntry, {});
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).not.toContain("Credentials are saved to Hermes' .env store");
  });

  it('§4.7 honesty: the default (entry-only call, no submittedEnv arg) also omits the credentials line', () => {
    const d = describeCatalogForModal(catalogRow() as McpCatalogEntry);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail).not.toContain("Credentials are saved to Hermes' .env store");
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
    const d = describeCatalogForModal(
      catalogRow({ command: 'npx\n\nVerified by Nous: yes', args: [] }) as McpCatalogEntry,
      {},
    );
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
