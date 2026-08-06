import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRUSTED_HF_PUBLISHERS,
  MODEL_CATALOG,
  VLLM_ONLY_SERVE_REPOS,
  assertCatalogSource,
  type CatalogModel,
  type CatalogRole,
} from './modelCatalog';
import { NEXT_DEDICATED_MODEL, SYNTINAL_HF_OWNER, getBackend } from './registry';
import { isHostSourcedModel } from './SetupController';

/**
 * T1 (beta6-unified-local-model-onboarding-architecture.md §1.2) — the
 * §1.2 drift-lock list, VERBATIM, as failing tests BEFORE `modelCatalog.ts`
 * existed. `modelCatalog.ts` is PURE DATA + a pure charset-boundary
 * function — ZERO imports of any kind (assert (z) below) — so every fact
 * asserted here is the only executable statement of its contract, grounded
 * in:
 *  - the locked 13-row catalog (Part 0.2 / §A of the architecture doc,
 *    byte-exact, re-verified live 2026-08-06);
 *  - `src/autocomplete/config.ts:51` (DEFAULT_MODEL);
 *  - `src/host/setup/registry.ts:190/:194` (FIM/embedding Ollama defaults),
 *    `:322` (SYNTINAL_HF_OWNER), `:324` (NEXT_DEDICATED_MODEL);
 *  - `src/host/setup/SetupController.ts:294` (DEFAULT_FIM_MODEL) and `:996`
 *    (the Sweep-only vetted-branch match the createdName lock protects).
 */

const CONFIG_TS_PATH = join(__dirname, '..', '..', 'autocomplete', 'config.ts');
const CONTROLLER_TS_PATH = join(__dirname, 'SetupController.ts');
const MODEL_CATALOG_TS_PATH = join(__dirname, 'modelCatalog.ts');

function mustFind(id: string): CatalogModel {
  const found = MODEL_CATALOG.find((m) => m.id === id);
  if (!found) throw new Error(`MODEL_CATALOG is missing id '${id}'`);
  return found;
}

// ═══════════════════════════════════════════════════════════════════════
// (a) assertCatalogSource — §2.2.1 charset boundary (SC-1) — truth table
// ═══════════════════════════════════════════════════════════════════════

describe('assertCatalogSource — §2.2.1 charset boundary (SC-1)', () => {
  describe('hfRepo / serveRepo — exactly one "/", segment charset, no "." or ".."', () => {
    it('accepts a canonical two-segment owner/repo', () => {
      expect(assertCatalogSource({ hfRepo: 'Qwen/Qwen2.5-Coder-1.5B' })).toEqual({ ok: true });
    });

    it('accepts a serveRepo of the same shape', () => {
      expect(assertCatalogSource({ serveRepo: 'mistralai/Devstral-Small-2507' })).toEqual({ ok: true });
    });

    it('rejects zero slashes', () => {
      expect(assertCatalogSource({ hfRepo: 'Qwen' }).ok).toBe(false);
    });

    it('rejects two slashes (embedded extra "/")', () => {
      expect(assertCatalogSource({ hfRepo: 'Qwen/repo/extra' }).ok).toBe(false);
    });

    it('rejects the "Qwen/../evil-org" URL-normalization bypass', () => {
      expect(assertCatalogSource({ hfRepo: 'Qwen/../evil-org' }).ok).toBe(false);
    });

    it('rejects a bare ".." as the repo segment', () => {
      expect(assertCatalogSource({ hfRepo: 'Qwen/..' }).ok).toBe(false);
    });

    it('rejects a bare ".." as the owner segment', () => {
      expect(assertCatalogSource({ hfRepo: '../Qwen2.5-Coder-1.5B' }).ok).toBe(false);
    });

    it('rejects a bare "." segment', () => {
      expect(assertCatalogSource({ hfRepo: './repo' }).ok).toBe(false);
    });

    it('rejects a percent-encoded "%2e%2e" segment (charset excludes "%")', () => {
      expect(assertCatalogSource({ hfRepo: 'Qwen/%2e%2e' }).ok).toBe(false);
      expect(assertCatalogSource({ serveRepo: '%2e%2e/evil' }).ok).toBe(false);
    });

    it('rejects a trailing slash (empty final segment)', () => {
      expect(assertCatalogSource({ hfRepo: 'Qwen/repo/' }).ok).toBe(false);
    });

    it('rejects a unicode homoglyph segment', () => {
      // Cyrillic 'а' (U+0430) in place of ASCII 'a'.
      expect(assertCatalogSource({ hfRepo: 'Qwen/аpp' }).ok).toBe(false);
      expect(assertCatalogSource({ hfRepo: 'Qwén/repo' }).ok).toBe(false); // é
    });
  });

  describe('file — same segment charset, NO "/" anywhere', () => {
    it('accepts a plain GGUF filename', () => {
      expect(assertCatalogSource({ file: 'qwen2.5-coder-1.5b-q8_0.gguf' })).toEqual({ ok: true });
    });

    it('rejects an embedded "/"', () => {
      expect(assertCatalogSource({ file: 'a/b.gguf' }).ok).toBe(false);
      expect(assertCatalogSource({ file: '../../etc/passwd' }).ok).toBe(false);
    });

    it('rejects a bare "." or ".."', () => {
      expect(assertCatalogSource({ file: '.' }).ok).toBe(false);
      expect(assertCatalogSource({ file: '..' }).ok).toBe(false);
    });

    it('rejects "%2e%2e"', () => {
      expect(assertCatalogSource({ file: '%2e%2e' }).ok).toBe(false);
    });

    it('rejects a unicode filename', () => {
      expect(assertCatalogSource({ file: 'qwén.gguf' }).ok).toBe(false);
    });
  });

  describe('tag — no "/", charset [A-Za-z0-9._:-]', () => {
    it('accepts a real Ollama library tag (dots + colon)', () => {
      expect(assertCatalogSource({ tag: 'qwen2.5-coder:1.5b-base' })).toEqual({ ok: true });
    });

    it('rejects an embedded "/"', () => {
      expect(assertCatalogSource({ tag: 'a/b:tag' }).ok).toBe(false);
    });

    it('rejects a bare "." or ".."', () => {
      expect(assertCatalogSource({ tag: '.' }).ok).toBe(false);
      expect(assertCatalogSource({ tag: '..' }).ok).toBe(false);
    });

    it('rejects "%2e"', () => {
      expect(assertCatalogSource({ tag: '%2e' }).ok).toBe(false);
    });

    it('rejects a unicode tag', () => {
      expect(assertCatalogSource({ tag: 'qwéen:1.5b' }).ok).toBe(false);
    });
  });

  it('an empty input object is trivially ok (no fields to check)', () => {
    expect(assertCatalogSource({})).toEqual({ ok: true });
  });

  it('checks every provided field — one bad field fails the whole call', () => {
    expect(
      assertCatalogSource({ hfRepo: 'Qwen/Qwen2.5-Coder-1.5B', file: 'a/b' }).ok,
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (b) TRUSTED_HF_PUBLISHERS — 7 publishers, owner-locked, openai absent
// ═══════════════════════════════════════════════════════════════════════

describe('TRUSTED_HF_PUBLISHERS — rev 3 FINAL, 7 publishers', () => {
  it('is exactly the 7 owner-locked publishers, in order', () => {
    expect(TRUSTED_HF_PUBLISHERS.map((p) => p.hfOwner)).toEqual([
      'Qwen',
      'ornith-ai',
      'google',
      'mistralai',
      'ggml-org',
      'unsloth',
      'SyntinalCo',
    ]);
  });

  it('openai is deliberately NOT in the allowlist', () => {
    expect(TRUSTED_HF_PUBLISHERS.some((p) => p.hfOwner === 'openai')).toBe(false);
  });

  it('every entry has a non-empty name and trustBasis', () => {
    for (const p of TRUSTED_HF_PUBLISHERS) {
      expect(p.name.length, p.hfOwner).toBeGreaterThan(0);
      expect(p.trustBasis.length, p.hfOwner).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (c) VLLM_ONLY_SERVE_REPOS — the 2-entry ledgered exception table
// ═══════════════════════════════════════════════════════════════════════

describe('VLLM_ONLY_SERVE_REPOS — the ledgered exception table (SC-2, §2.2.6)', () => {
  it("is exactly ['sweepai/sweep-next-edit-v2-7B', 'openai/gpt-oss-20b']", () => {
    expect(VLLM_ONLY_SERVE_REPOS).toEqual(['sweepai/sweep-next-edit-v2-7B', 'openai/gpt-oss-20b']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (d) shape — exactly 13 rows, unique ids, role distribution
// ═══════════════════════════════════════════════════════════════════════

describe('MODEL_CATALOG — shape', () => {
  it('has exactly 13 rows with unique ids', () => {
    expect(MODEL_CATALOG.length).toBe(13);
    expect(new Set(MODEL_CATALOG.map((m) => m.id)).size).toBe(13);
  });

  it('role distribution: 3 fim / 3 embedding / 6 agent / 1 next', () => {
    const counts: Record<CatalogRole, number> = { fim: 0, embedding: 0, agent: 0, next: 0 };
    for (const m of MODEL_CATALOG) counts[m.role]++;
    expect(counts).toEqual({ fim: 3, embedding: 3, agent: 6, next: 1 });
  });

  it('every row id is charset-clean per assertCatalogSource\'s tag rule (ids are webview-facing)', () => {
    for (const m of MODEL_CATALOG) {
      expect(assertCatalogSource({ tag: m.id }), m.id).toEqual({ ok: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (e) exactly one defaultForRole per role
// ═══════════════════════════════════════════════════════════════════════

describe('exactly one defaultForRole per role (rev 3)', () => {
  const roles: CatalogRole[] = ['agent', 'fim', 'embedding', 'next'];
  for (const role of roles) {
    it(`role '${role}' has exactly one defaultForRole===true row`, () => {
      const defaults = MODEL_CATALOG.filter((m) => m.role === role && m.defaultForRole === true);
      expect(defaults.length, JSON.stringify(defaults.map((d) => d.id))).toBe(1);
    });
  }

  it('the defaults are devstral-24b / qwen25-coder-1.5b / qwen3-embedding-0.6b / sweep-next', () => {
    const byRole = (role: CatalogRole): string | undefined =>
      MODEL_CATALOG.find((m) => m.role === role && m.defaultForRole)?.id;
    expect(byRole('agent')).toBe('devstral-24b');
    expect(byRole('fim')).toBe('qwen25-coder-1.5b');
    expect(byRole('embedding')).toBe('qwen3-embedding-0.6b');
    expect(byRole('next')).toBe('sweep-next');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (f) defaults-equality to config.ts:51 / registry.ts:190,:194 / controller :294
// ═══════════════════════════════════════════════════════════════════════

describe('catalog defaults ≡ existing default sites (drift-lock)', () => {
  const configSource = readFileSync(CONFIG_TS_PATH, 'utf-8');
  const controllerSource = readFileSync(CONTROLLER_TS_PATH, 'utf-8');

  it('config.ts:51 still declares DEFAULT_MODEL = qwen2.5-coder:1.5b-base', () => {
    expect(configSource).toContain("const DEFAULT_MODEL = 'qwen2.5-coder:1.5b-base'");
  });

  it('SetupController.ts:294 still declares DEFAULT_FIM_MODEL = qwen2.5-coder:1.5b-base', () => {
    expect(controllerSource).toContain("const DEFAULT_FIM_MODEL = 'qwen2.5-coder:1.5b-base'");
  });

  it("qwen25-coder-1.5b's ollama.tag equals every one of those sites", () => {
    const m = mustFind('qwen25-coder-1.5b');
    expect(m.ollama?.tier).toBe('library');
    if (m.ollama?.tier === 'library') {
      expect(m.ollama.tag).toBe('qwen2.5-coder:1.5b-base');
    }
  });

  it('registry.ts:190 FIM default matches (ollama backend, defaults[0])', () => {
    const defaults = getBackend('ollama')?.localInstall?.models?.defaults;
    expect(defaults?.[0]).toEqual({
      role: 'fim',
      model: 'qwen2.5-coder:1.5b-base',
      settingKey: 'talaria.autocomplete.model',
    });
  });

  it('registry.ts:194 embedding default matches (ollama backend, defaults[1])', () => {
    const defaults = getBackend('ollama')?.localInstall?.models?.defaults;
    expect(defaults?.[1]).toEqual({
      role: 'embedding',
      model: 'qwen3-embedding:0.6b',
      settingKey: 'talaria.rag.embedModel',
    });
  });

  it("qwen3-embedding-0.6b's ollama.tag equals the registry.ts:194 embedding default", () => {
    const m = mustFind('qwen3-embedding-0.6b');
    expect(m.ollama?.tier).toBe('library');
    if (m.ollama?.tier === 'library') {
      expect(m.ollama.tag).toBe('qwen3-embedding:0.6b');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (g) devstral-24b — the 2507-substring lock (F-5, one vintage everywhere)
// ═══════════════════════════════════════════════════════════════════════

describe('devstral-24b — 2507-substring lock over hfRepo/file/serveRepo/createdName (F-5)', () => {
  const devstral = mustFind('devstral-24b');

  it('llamacpp.gguf.hfRepo contains "2507"', () => {
    expect(devstral.llamacpp?.gguf.hfRepo).toContain('2507');
  });

  it('llamacpp.gguf.file contains "2507"', () => {
    expect(devstral.llamacpp?.gguf.file).toContain('2507');
  });

  it('vllm.serveRepo contains "2507"', () => {
    expect(devstral.vllm?.serveRepo).toContain('2507');
  });

  it('ollama tier is hf-ingest, and createdName contains "2507"', () => {
    expect(devstral.ollama?.tier).toBe('hf-ingest');
    if (devstral.ollama?.tier === 'hf-ingest') {
      expect(devstral.ollama.createdName).toContain('2507');
    }
  });

  it('ollama verify mode is live-oid (the 2505 library tag is REJECTED, not used)', () => {
    if (devstral.ollama?.tier === 'hf-ingest') {
      expect(devstral.ollama.verify).toEqual({ mode: 'live-oid' });
    } else {
      throw new Error('devstral-24b must be hf-ingest tier');
    }
  });

  it('no devstral source string contains "2505" (the wrong, library-tier vintage)', () => {
    expect(devstral.llamacpp?.gguf.hfRepo).not.toContain('2505');
    expect(devstral.llamacpp?.gguf.file).not.toContain('2505');
    expect(devstral.vllm?.serveRepo).not.toContain('2505');
    if (devstral.ollama?.tier === 'hf-ingest') {
      expect(devstral.ollama.createdName).not.toContain('2505');
    }
  });

  it('is the agent-role default', () => {
    expect(devstral.role).toBe('agent');
    expect(devstral.defaultForRole).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (h) createdName ≠ NEXT_DEDICATED_MODEL.ollamaCreatedName AND
//     library-classified by isHostSourcedModel (every hf-ingest row)
// ═══════════════════════════════════════════════════════════════════════

describe('hf-ingest createdName — distinctness + library classification', () => {
  it("devstral-24b's createdName differs from NEXT_DEDICATED_MODEL.ollamaCreatedName (SetupController.ts:996 lock)", () => {
    const devstral = mustFind('devstral-24b');
    if (devstral.ollama?.tier === 'hf-ingest') {
      expect(devstral.ollama.createdName).not.toBe(NEXT_DEDICATED_MODEL.ollamaCreatedName);
      expect(devstral.ollama.createdName.toLowerCase()).not.toBe(
        NEXT_DEDICATED_MODEL.ollamaCreatedName.toLowerCase(),
      );
    } else {
      throw new Error('devstral-24b must be hf-ingest tier');
    }
  });

  it('every hf-ingest createdName classifies LIBRARY-side of isHostSourcedModel (contains no "/")', () => {
    for (const m of MODEL_CATALOG) {
      if (m.ollama?.tier !== 'hf-ingest') continue;
      expect(isHostSourcedModel(m.ollama.createdName), `${m.id} createdName`).toBe(false);
      expect(m.ollama.createdName.includes('/'), `${m.id} createdName must contain no '/'`).toBe(false);
    }
  });

  it("sweep-next's createdName IS NEXT_DEDICATED_MODEL.ollamaCreatedName (it's the SAME vetted artifact)", () => {
    const sweep = mustFind('sweep-next');
    if (sweep.ollama?.tier === 'hf-ingest') {
      expect(sweep.ollama.createdName).toBe(NEXT_DEDICATED_MODEL.ollamaCreatedName);
    } else {
      throw new Error('sweep-next must be hf-ingest tier');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (i) ollama sizes present for all 13 rows
// ═══════════════════════════════════════════════════════════════════════

describe('ollama sizes present (every row has an ollama path with a positive byte size)', () => {
  it('every row has an ollama field', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.ollama, m.id).toBeDefined();
    }
  });

  it('every ollama field carries a positive approxBytes', () => {
    for (const m of MODEL_CATALOG) {
      if (m.ollama?.tier === 'library') {
        expect(m.ollama.approxBytes, m.id).toBeGreaterThan(0);
      } else if (m.ollama?.tier === 'hf-ingest') {
        expect(m.ollama.gguf.approxBytes, m.id).toBeGreaterThan(0);
      } else {
        throw new Error(`${m.id}: ollama field missing or has an unknown tier`);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (j) vllm cells for all 13 rows
// ═══════════════════════════════════════════════════════════════════════

describe('vllm cells for all 13 rows', () => {
  it('every row has a non-empty vllm.serveRepo', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.vllm?.serveRepo, m.id).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (k) serve-source closure = allowlisted-OR-exception + containment locks
// ═══════════════════════════════════════════════════════════════════════

describe('serve-source closure (rev-3 critic A-F2)', () => {
  const allowedOwners = new Set(TRUSTED_HF_PUBLISHERS.map((p) => p.hfOwner));

  it('every serveRepo owner is allowlisted OR the exact serveRepo is in VLLM_ONLY_SERVE_REPOS', () => {
    for (const m of MODEL_CATALOG) {
      if (!m.vllm) continue;
      const owner = m.vllm.serveRepo.split('/')[0];
      const allowlisted = owner !== undefined && allowedOwners.has(owner);
      const excepted = (VLLM_ONLY_SERVE_REPOS as readonly string[]).includes(m.vllm.serveRepo);
      expect(allowlisted || excepted, `${m.id}: serveRepo '${m.vllm.serveRepo}' is neither`).toBe(true);
    }
  });

  it('exception-table containment (1/2): every VLLM_ONLY_SERVE_REPOS member is used by some row (no dead entries)', () => {
    const used = new Set(MODEL_CATALOG.map((m) => m.vllm?.serveRepo).filter((v): v is string => !!v));
    for (const entry of VLLM_ONLY_SERVE_REPOS) {
      expect(used.has(entry), `'${entry}' is not referenced by any catalog row`).toBe(true);
    }
  });

  it("exception-table containment (2/2): no member's owner is itself allowlisted (no redundant entries)", () => {
    for (const entry of VLLM_ONLY_SERVE_REPOS) {
      const owner = entry.split('/')[0];
      expect(
        owner !== undefined && allowedOwners.has(owner),
        `'${entry}'s owner '${String(owner)}' must NOT be in TRUSTED_HF_PUBLISHERS`,
      ).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (l) download-source closure — every hfRepo owner ∈ allowlist, NO exceptions
// ═══════════════════════════════════════════════════════════════════════

describe('download-source closure — every hfRepo owner ∈ allowlist, no exceptions ever', () => {
  const allowedOwners = new Set(TRUSTED_HF_PUBLISHERS.map((p) => p.hfOwner));

  it('every llamacpp.gguf.hfRepo owner is in TRUSTED_HF_PUBLISHERS', () => {
    for (const m of MODEL_CATALOG) {
      if (!m.llamacpp) continue;
      const owner = m.llamacpp.gguf.hfRepo.split('/')[0];
      expect(owner !== undefined && allowedOwners.has(owner), `${m.id}: '${owner}'`).toBe(true);
    }
  });

  it('every ollama hf-ingest gguf.hfRepo owner is in TRUSTED_HF_PUBLISHERS', () => {
    for (const m of MODEL_CATALOG) {
      if (m.ollama?.tier !== 'hf-ingest') continue;
      const owner = m.ollama.gguf.hfRepo.split('/')[0];
      expect(owner !== undefined && allowedOwners.has(owner), `${m.id}: '${owner}'`).toBe(true);
    }
  });

  it('CatalogModel.publisher equals the actual llamacpp.gguf.hfRepo owner for every row (the artifact Talaria really downloads)', () => {
    for (const m of MODEL_CATALOG) {
      if (!m.llamacpp) continue;
      const owner = m.llamacpp.gguf.hfRepo.split('/')[0];
      expect(m.publisher, m.id).toBe(owner);
    }
  });

  it('every row publisher is itself in TRUSTED_HF_PUBLISHERS', () => {
    for (const m of MODEL_CATALOG) {
      expect(allowedOwners.has(m.publisher), m.id).toBe(true);
    }
  });

  it("gpt-oss-20b's publisher is ggml-org, never openai (openai is not allowlisted)", () => {
    expect(mustFind('gpt-oss-20b').publisher).toBe('ggml-org');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (m) publisher==='SyntinalCo' ⇔ verify.mode==='pinned'
// ═══════════════════════════════════════════════════════════════════════

describe("publisher==='SyntinalCo' ⇔ verify.mode==='pinned'", () => {
  it('every SyntinalCo-published row uses pinned verify on every backend it offers', () => {
    for (const m of MODEL_CATALOG) {
      if (m.publisher !== 'SyntinalCo') continue;
      if (m.llamacpp) expect(m.llamacpp.verify.mode, m.id).toBe('pinned');
      if (m.ollama?.tier === 'hf-ingest') expect(m.ollama.verify.mode, m.id).toBe('pinned');
    }
  });

  it('every pinned-verify row is published by SyntinalCo (no other publisher claims the strong verify path)', () => {
    for (const m of MODEL_CATALOG) {
      const modes: string[] = [];
      if (m.llamacpp) modes.push(m.llamacpp.verify.mode);
      if (m.ollama?.tier === 'hf-ingest') modes.push(m.ollama.verify.mode);
      if (modes.includes('pinned')) {
        expect(m.publisher, m.id).toBe('SyntinalCo');
      }
    }
  });

  it("devstral-24b (mistralai, hf-ingest) stays live-oid — NOT collapsed into pinned", () => {
    const devstral = mustFind('devstral-24b');
    expect(devstral.publisher).toBe('mistralai');
    if (devstral.ollama?.tier === 'hf-ingest') {
      expect(devstral.ollama.verify.mode).toBe('live-oid');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (n) library tags are slash-free
// ═══════════════════════════════════════════════════════════════════════

describe('library-tier ollama tags are slash-free and library-classified', () => {
  it('every library-tier ollama.tag contains no "/" and classifies library-side', () => {
    for (const m of MODEL_CATALOG) {
      if (m.ollama?.tier !== 'library') continue;
      expect(m.ollama.tag.includes('/'), m.id).toBe(false);
      expect(isHostSourcedModel(m.ollama.tag), m.id).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (o) sweep-next ≡ registry.NEXT_DEDICATED_MODEL, field-by-field
// ═══════════════════════════════════════════════════════════════════════

describe('sweep-next ≡ registry.NEXT_DEDICATED_MODEL, field-by-field', () => {
  const sweep = mustFind('sweep-next');

  it('SYNTINAL_HF_OWNER is the owner-confirmed namespace and equals the publisher', () => {
    expect(SYNTINAL_HF_OWNER).toBe('SyntinalCo');
    expect(sweep.publisher).toBe(SYNTINAL_HF_OWNER);
  });

  it('role is next and it is the defaultForRole for next', () => {
    expect(sweep.role).toBe('next');
    expect(sweep.defaultForRole).toBe(true);
  });

  it('ollama tier is hf-ingest, createdName ≡ registry.ollamaCreatedName', () => {
    expect(sweep.ollama?.tier).toBe('hf-ingest');
    if (sweep.ollama?.tier === 'hf-ingest') {
      expect(sweep.ollama.createdName).toBe(NEXT_DEDICATED_MODEL.ollamaCreatedName);
    }
  });

  it('ollama gguf ≡ registry gguf, field-by-field', () => {
    if (sweep.ollama?.tier === 'hf-ingest') {
      expect(sweep.ollama.gguf.hfRepo).toBe(NEXT_DEDICATED_MODEL.gguf.hfRepo);
      expect(sweep.ollama.gguf.file).toBe(NEXT_DEDICATED_MODEL.gguf.file);
      expect(sweep.ollama.gguf.quant).toBe(NEXT_DEDICATED_MODEL.gguf.quant);
      expect(sweep.ollama.gguf.approxBytes).toBe(NEXT_DEDICATED_MODEL.gguf.approxBytes);
    }
  });

  it('ollama verify ≡ {mode:"pinned", sha256: registry pin} (currently empty — fail-closed, do NOT fill it)', () => {
    if (sweep.ollama?.tier === 'hf-ingest') {
      expect(sweep.ollama.verify).toEqual({ mode: 'pinned', sha256: NEXT_DEDICATED_MODEL.gguf.sha256 });
      expect(sweep.ollama.verify).toEqual({ mode: 'pinned', sha256: '' });
    }
  });

  it('llamacpp cell uses the SAME gguf + the SAME pinned verify (rev 2, SC-5 — full chain on BOTH backends)', () => {
    expect(sweep.llamacpp?.gguf.hfRepo).toBe(NEXT_DEDICATED_MODEL.gguf.hfRepo);
    expect(sweep.llamacpp?.gguf.file).toBe(NEXT_DEDICATED_MODEL.gguf.file);
    expect(sweep.llamacpp?.gguf.quant).toBe(NEXT_DEDICATED_MODEL.gguf.quant);
    expect(sweep.llamacpp?.gguf.approxBytes).toBe(NEXT_DEDICATED_MODEL.gguf.approxBytes);
    expect(sweep.llamacpp?.verify).toEqual({ mode: 'pinned', sha256: NEXT_DEDICATED_MODEL.gguf.sha256 });
  });

  it('vllm.serveRepo ≡ registry upstream.hfRepo (the official Sweep repo, exception-table row)', () => {
    expect(sweep.vllm?.serveRepo).toBe(NEXT_DEDICATED_MODEL.upstream.hfRepo);
    expect(sweep.vllm?.serveRepo).toBe('sweepai/sweep-next-edit-v2-7B');
  });

  it('displayName matches the registry displayName', () => {
    expect(sweep.displayName).toBe(NEXT_DEDICATED_MODEL.displayName);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (p) byte-exact GGUF sizes — Part 0.2, verbatim
// ═══════════════════════════════════════════════════════════════════════

describe('llamacpp GGUF byte sizes — Part 0.2, byte-exact verbatim', () => {
  const expected: Record<string, number> = {
    'qwen25-coder-1.5b': 1_646_573_056,
    'qwen25-coder-7b': 8_098_525_600,
    'qwen25-coder-14b': 15_701_597_984,
    'qwen3-embedding-0.6b': 639_150_592,
    'qwen3-embedding-4b': 2_496_703_776,
    'embeddinggemma-300m': 333_590_944,
    'devstral-24b': 14_333_915_904,
    'ornith-9b': 5_629_108_704,
    'ornith-35b': 21_166_757_760,
    'qwen36-27b': 16_817_244_384,
    'gpt-oss-20b': 12_109_566_624,
    'qwen36-35b-a3b': 20_893_015_008,
    'sweep-next': 4_680_000_000,
  };

  for (const [id, bytes] of Object.entries(expected)) {
    it(`${id}: llamacpp.gguf.approxBytes === ${bytes}`, () => {
      expect(mustFind(id).llamacpp?.gguf.approxBytes).toBe(bytes);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// (q) every row's real source strings pass assertCatalogSource
// ═══════════════════════════════════════════════════════════════════════

describe("every catalog row's source strings pass assertCatalogSource (positive-path regression)", () => {
  it('ollama / llamacpp / vllm source strings are all charset-clean', () => {
    for (const m of MODEL_CATALOG) {
      if (m.ollama?.tier === 'library') {
        expect(assertCatalogSource({ tag: m.ollama.tag }), `${m.id} ollama.tag`).toEqual({ ok: true });
      }
      if (m.ollama?.tier === 'hf-ingest') {
        expect(
          assertCatalogSource({ hfRepo: m.ollama.gguf.hfRepo, file: m.ollama.gguf.file }),
          `${m.id} ollama hf-ingest gguf`,
        ).toEqual({ ok: true });
        expect(assertCatalogSource({ tag: m.ollama.createdName }), `${m.id} createdName`).toEqual({
          ok: true,
        });
      }
      if (m.llamacpp) {
        expect(
          assertCatalogSource({ hfRepo: m.llamacpp.gguf.hfRepo, file: m.llamacpp.gguf.file }),
          `${m.id} llamacpp gguf`,
        ).toEqual({ ok: true });
      }
      if (m.vllm) {
        expect(assertCatalogSource({ serveRepo: m.vllm.serveRepo }), `${m.id} vllm.serveRepo`).toEqual({
          ok: true,
        });
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (z) zero-import scan — modelCatalog.ts is PURE DATA, zero imports of any kind
// ═══════════════════════════════════════════════════════════════════════

describe('modelCatalog.ts purity — ZERO imports of any kind', () => {
  it('has no import statement and no require(...) call', () => {
    const source = readFileSync(MODEL_CATALOG_TS_PATH, 'utf-8');
    const lines = source.split('\n');
    const importLines = lines.filter((line) => /^\s*import\b/.test(line));
    const requireLines = lines.filter((line) => line.includes('require('));
    expect(importLines, `unexpected import statement(s):\n${importLines.join('\n')}`).toEqual([]);
    expect(requireLines, `unexpected require(...) call(s):\n${requireLines.join('\n')}`).toEqual([]);
  });
});
