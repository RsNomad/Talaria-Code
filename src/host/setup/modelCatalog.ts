/**
 * modelCatalog — the beta.6 unified "Local Model" component's data + trust
 * boundary (beta6-unified-local-model-onboarding-architecture.md §1.2/§2.2).
 *
 * PURE DATA + a pure charset-boundary function. ZERO imports of ANY kind
 * (drift-locked by `modelCatalog.test.ts`'s zero-import scan, the same
 * discipline `registry.ts` already carries in this directory) — every
 * downstream task (T2–T18) consumes this module's exports as the ONLY path
 * to an HF URL or an Ollama library tag. Adding a row, a publisher, or an
 * exception-table entry is an OWNER decision, reviewed as a data diff.
 *
 * Every string here was resolved live against the Hugging Face API and
 * ollama.com/library on 2026-08-06 and re-verified byte-exact in the rev-3
 * session (architecture doc Part 0.2 / §A) — NOT from memory. Byte sizes,
 * repo names, filenames, and tags are copied VERBATIM; nothing here is
 * rounded or invented.
 */

// ---------------------------------------------------------------------------
// §1.2 types
// ---------------------------------------------------------------------------

/** THE trust boundary (variant 1). Adding a row is an OWNER decision. */
export interface TrustedPublisher {
  /** canonical HF org name (post-rename, as author-search reports it) */
  hfOwner: string;
  /** 'Qwen (Alibaba)' — rendered in the Tier-1 modal + §5 ledger */
  name: string;
  /** one honest sentence, rendered verbatim in the Tier-1 modal + ledger */
  trustBasis: string;
}

/** rev 3 FINAL — 7 publishers, owner-locked 2026-08-06. `openai` deliberately absent. */
export const TRUSTED_HF_PUBLISHERS: readonly TrustedPublisher[] = [
  { hfOwner: 'Qwen', name: 'Qwen (Alibaba)', trustBasis: 'Alibaba’s verified Hugging Face organization — the models’ own publisher.' },
  { hfOwner: 'ornith-ai', name: 'DeepReinforce (Ornith)', trustBasis: 'DeepReinforce’s Hugging Face organization (canonical name; MIT-licensed Ornith releases).' },
  { hfOwner: 'google', name: 'Google (Gemma)', trustBasis: 'Google’s verified Hugging Face organization.' },
  { hfOwner: 'mistralai', name: 'Mistral AI', trustBasis: 'Mistral’s verified Hugging Face organization — the models’ own publisher.' },
  { hfOwner: 'ggml-org', name: 'ggml.ai (llama.cpp)', trustBasis: 'The llama.cpp project’s own Hugging Face organization — first-party GGUF packaging of upstream models.' },
  { hfOwner: 'unsloth', name: 'Unsloth', trustBasis: 'Unsloth’s verified Hugging Face organization — a widely-used quantization publisher; provenance is weaker than a model’s own vendor (owner-accepted 2026-08-06).' },
  { hfOwner: 'SyntinalCo', name: 'Syntinal (us)', trustBasis: 'Our own publishing account; artifacts additionally self-pinned by code-committed SHA-256.' },
];

export type CatalogRole = 'agent' | 'fim' | 'embedding' | 'next';

export type VerifySpec =
  | { mode: 'live-oid' } // allowlist tier: verify received bytes against the publisher repo's live lfs.oid
  | { mode: 'pinned'; sha256: string }; // self-pinned tier: code-committed digest ('' ⇒ fail-closed everywhere)

export interface CatalogGguf {
  /** exactly `owner/repo`, both segments §2.2.1-charset; owner ∈ allowlist */
  hfRepo: string;
  /** exact filename, §2.2.1-charset, NO path separators */
  file: string;
  quant: string;
  /** from the live tree (Part 0) — size ceiling + button label */
  approxBytes: number;
}

export interface CatalogModel {
  /** stable, §2.2.1-charset — the ONLY thing the webview may send */
  id: string;
  role: CatalogRole;
  /** rev 3: EXACTLY ONE per role — picker preselect + §3.5 recs + "Default" chip */
  defaultForRole?: true;
  displayName: string;
  /** must equal a TRUSTED_HF_PUBLISHERS.hfOwner — the actual artifact Talaria downloads from */
  publisher: string;
  license: string;
  /** projected onto the wire (rev 2) */
  contextWindow?: number;
  /** §6 honesty line */
  vramLine: string;
  /** rev 3: base-build note, mmproj note, MoE note, embeddinggemma ctx note… */
  note?: string;
  ollama?:
    | { tier: 'library'; tag: string; approxBytes: number } // rev 2 (CC-3): size on the wire
    | { tier: 'hf-ingest'; gguf: CatalogGguf; createdName: string; verify: VerifySpec };
  llamacpp?: { gguf: CatalogGguf; verify: VerifySpec };
  /** §2.2.1-charset + gated AT COMPOSE TIME (SC-2) */
  vllm?: { serveRepo: string };
}

// ---------------------------------------------------------------------------
// §2.2.6 — the ledgered vLLM-only serve-repo exception table
// ---------------------------------------------------------------------------

/**
 * The ONLY two `vllm.serveRepo` values allowed to come from a NON-allowlisted
 * owner. Talaria never downloads from `sweepai/` or `openai/` — vLLM fetches
 * those weights itself; this table exists solely so the serve-source-closure
 * invariant (§2.2.1 drift-lock, `modelCatalog.test.ts`) has a named,
 * containment-checked home for the two exceptions instead of a silent
 * allowlist bypass. Every member MUST be used by some `MODEL_CATALOG` row's
 * `vllm.serveRepo` (no dead entries); no member's owner may itself be in
 * {@link TRUSTED_HF_PUBLISHERS} (it would then be a redundant entry — the
 * table stays an exception list, never a second allowlist).
 */
export const VLLM_ONLY_SERVE_REPOS: readonly string[] = [
  'sweepai/sweep-next-edit-v2-7B',
  'openai/gpt-oss-20b',
];

// ---------------------------------------------------------------------------
// §2.2.1 — assertCatalogSource: the charset boundary (SC-1)
// ---------------------------------------------------------------------------

/**
 * Segment charset: `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` — first character MUST be
 * alphanumeric (this alone already rejects a leading '.', so '.'/'..'  never
 * matches), every character ASCII-only (kills unicode homoglyphs and any
 * percent-encoded byte, since '%' is not in the charset).
 */
const SEGMENT_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Ollama tag charset: no '/', otherwise [A-Za-z0-9._:-] (colons for `name:tag`). */
const TAG_CHARSET = /^[A-Za-z0-9._:-]+$/;

function isDotOrDotDot(value: string): boolean {
  return value === '.' || value === '..';
}

function checkSegment(value: string, label: string): { ok: true } | { ok: false; reason: string } {
  if (isDotOrDotDot(value)) {
    return { ok: false, reason: `${label} must not be '.' or '..'` };
  }
  if (!SEGMENT_CHARSET.test(value)) {
    return { ok: false, reason: `${label} contains characters outside the allowed charset` };
  }
  return { ok: true };
}

function checkOwnerRepo(value: string, label: string): { ok: true } | { ok: false; reason: string } {
  const segments = value.split('/');
  if (segments.length !== 2) {
    return { ok: false, reason: `${label} must be exactly "owner/repo" (one '/')` };
  }
  const [owner, repo] = segments;
  const ownerCheck = checkSegment(owner ?? '', `${label} owner segment`);
  if (!ownerCheck.ok) return ownerCheck;
  const repoCheck = checkSegment(repo ?? '', `${label} repo segment`);
  if (!repoCheck.ok) return repoCheck;
  return { ok: true };
}

/**
 * The §2.2.1 charset boundary (SC-1, the load-bearing fix). Called BOTH at
 * build time (this module's own drift-lock tests) and at runtime before ANY
 * network/fs use of a catalog string — `startsWith(publisher + '/')` alone is
 * theater against a `Qwen/../evil-org` URL-normalization bypass or a
 * `file: '../../…'` store escape; this is the actual gate.
 *
 * - `hfRepo`/`serveRepo`: EXACTLY one '/', each segment matches the segment
 *   charset and is not '.' or '..'.
 * - `file`: same segment charset, NO '/' anywhere, not '.' or '..'.
 * - `tag`: no '/', charset `[A-Za-z0-9._:-]`, not '.' or '..' (defense in
 *   depth — the tag charset alone would otherwise accept a bare '..').
 *
 * Every provided field is checked; the first failure short-circuits the call.
 * An input with no fields set is trivially `{ ok: true }`.
 */
export function assertCatalogSource(s: {
  hfRepo?: string;
  file?: string;
  tag?: string;
  serveRepo?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (s.hfRepo !== undefined) {
    const r = checkOwnerRepo(s.hfRepo, 'hfRepo');
    if (!r.ok) return r;
  }
  if (s.serveRepo !== undefined) {
    const r = checkOwnerRepo(s.serveRepo, 'serveRepo');
    if (!r.ok) return r;
  }
  if (s.file !== undefined) {
    if (s.file.includes('/')) {
      return { ok: false, reason: 'file must not contain "/"' };
    }
    const r = checkSegment(s.file, 'file');
    if (!r.ok) return r;
  }
  if (s.tag !== undefined) {
    if (s.tag.includes('/')) {
      return { ok: false, reason: 'tag must not contain "/"' };
    }
    if (isDotOrDotDot(s.tag)) {
      return { ok: false, reason: 'tag must not be "." or ".."' };
    }
    if (!TAG_CHARSET.test(s.tag)) {
      return { ok: false, reason: 'tag contains characters outside the allowed charset' };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §A — the locked catalog: 13 FINAL rows, 7 publishers (rev 3, owner-closed)
// ---------------------------------------------------------------------------

const FIM_BASE_BUILD_NOTE =
  "Base build (Q8) from ggml-org — the llama.cpp project's own packaging of Qwen's base model.";
const MOE_HONESTY_NOTE =
  'MoE ≠ smaller: a 35B MoE still needs ~20 GiB for weights — only compute is light (~3B active per token).';

export const MODEL_CATALOG: readonly CatalogModel[] = [
  // --- FIM (3 rows; qwen25-coder-1.5b is the role default) -----------------
  {
    id: 'qwen25-coder-1.5b',
    role: 'fim',
    defaultForRole: true,
    displayName: 'Qwen2.5-Coder 1.5B (base)',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    contextWindow: 32768,
    vramLine: 'any modern GPU (~1–2 GB)',
    note: FIM_BASE_BUILD_NOTE,
    ollama: { tier: 'library', tag: 'qwen2.5-coder:1.5b-base', approxBytes: 986_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF',
        file: 'qwen2.5-coder-1.5b-q8_0.gguf',
        quant: 'Q8_0',
        approxBytes: 1_646_573_056,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'Qwen/Qwen2.5-Coder-1.5B' },
  },
  {
    id: 'qwen25-coder-7b',
    role: 'fim',
    displayName: 'Qwen2.5-Coder 7B (base)',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    vramLine: 'Ollama Q4 ≈ 6 GB · llama.cpp Q8 ≈ 9–10 GB',
    note: FIM_BASE_BUILD_NOTE,
    ollama: { tier: 'library', tag: 'qwen2.5-coder:7b-base', approxBytes: 4_700_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF',
        file: 'qwen2.5-coder-7b-q8_0.gguf',
        quant: 'Q8_0',
        approxBytes: 8_098_525_600,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'Qwen/Qwen2.5-Coder-7B' },
  },
  {
    id: 'qwen25-coder-14b',
    role: 'fim',
    displayName: 'Qwen2.5-Coder 14B (base)',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    vramLine: 'Ollama Q4 ≈ 11 GB · llama.cpp Q8 wants a 24 GB card',
    note: FIM_BASE_BUILD_NOTE,
    ollama: { tier: 'library', tag: 'qwen2.5-coder:14b-base', approxBytes: 9_000_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'ggml-org/Qwen2.5-Coder-14B-Q8_0-GGUF',
        file: 'qwen2.5-coder-14b-q8_0.gguf',
        quant: 'Q8_0',
        approxBytes: 15_701_597_984,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'Qwen/Qwen2.5-Coder-14B' },
  },

  // --- Embedding (3 rows; qwen3-embedding-0.6b is the role default) --------
  {
    id: 'qwen3-embedding-0.6b',
    role: 'embedding',
    defaultForRole: true,
    displayName: 'Qwen3-Embedding 0.6B',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    vramLine: '< 1.5 GB',
    ollama: { tier: 'library', tag: 'qwen3-embedding:0.6b', approxBytes: 639_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
        file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
        quant: 'Q8_0',
        approxBytes: 639_150_592,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'Qwen/Qwen3-Embedding-0.6B' },
  },
  {
    id: 'qwen3-embedding-4b',
    role: 'embedding',
    displayName: 'Qwen3-Embedding 4B',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    contextWindow: 40960,
    vramLine: '≈ 3 GB',
    ollama: { tier: 'library', tag: 'qwen3-embedding:4b', approxBytes: 2_500_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'Qwen/Qwen3-Embedding-4B-GGUF',
        file: 'Qwen3-Embedding-4B-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 2_496_703_776,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'Qwen/Qwen3-Embedding-4B' },
  },
  {
    id: 'embeddinggemma-300m',
    role: 'embedding',
    displayName: 'EmbeddingGemma 300M',
    publisher: 'ggml-org',
    license: 'Gemma',
    contextWindow: 2048,
    vramLine: '< 1 GB',
    note: '2K context on the Ollama build — fine for Talaria’s chunk sizes (≤512 tokens).',
    ollama: { tier: 'library', tag: 'embeddinggemma:300m', approxBytes: 622_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'ggml-org/embeddinggemma-300M-GGUF',
        file: 'embeddinggemma-300M-Q8_0.gguf',
        quant: 'Q8_0',
        approxBytes: 333_590_944,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'google/embeddinggemma-300m' },
  },

  // --- Agent (6 rows; devstral-24b is the role default) --------------------
  {
    id: 'devstral-24b',
    role: 'agent',
    defaultForRole: true,
    displayName: 'Devstral-24B (2507)',
    publisher: 'mistralai',
    license: 'Apache-2.0',
    contextWindow: 131072,
    vramLine: '24GB-comfortable — the sweet spot: ~55K ctx fp16-KV / ~110K Q8-KV; 128K window',
    ollama: {
      tier: 'hf-ingest',
      gguf: {
        hfRepo: 'mistralai/Devstral-Small-2507_gguf',
        file: 'Devstral-Small-2507-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 14_333_915_904,
      },
      createdName: 'devstral-small-2507:24b',
      verify: { mode: 'live-oid' },
    },
    llamacpp: {
      gguf: {
        hfRepo: 'mistralai/Devstral-Small-2507_gguf',
        file: 'Devstral-Small-2507-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 14_333_915_904,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'mistralai/Devstral-Small-2507' },
  },
  {
    id: 'ornith-9b',
    role: 'agent',
    displayName: 'Ornith-1.0 9B',
    publisher: 'ornith-ai',
    license: 'MIT',
    vramLine: '24GB-easy (128K+ ctx headroom)',
    ollama: { tier: 'library', tag: 'ornith:9b', approxBytes: 5_600_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'ornith-ai/Ornith-1.0-9B-GGUF',
        file: 'ornith-1.0-9b-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 5_629_108_704,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'ornith-ai/Ornith-1.0-9B' },
  },
  {
    id: 'ornith-35b',
    role: 'agent',
    displayName: 'Ornith-1.0 35B (MoE)',
    publisher: 'ornith-ai',
    license: 'MIT',
    vramLine: '24GB-stretch (CPU-offload) / 32GB-comfortable',
    note: MOE_HONESTY_NOTE,
    ollama: { tier: 'library', tag: 'ornith:35b', approxBytes: 21_000_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'ornith-ai/Ornith-1.0-35B-GGUF',
        file: 'ornith-1.0-35b-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 21_166_757_760,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'ornith-ai/Ornith-1.0-35B' },
  },
  {
    id: 'qwen36-27b',
    role: 'agent',
    displayName: 'Qwen3.6-27B',
    publisher: 'unsloth',
    license: 'Apache-2.0',
    contextWindow: 262144,
    vramLine: '24GB-comfortable, tighter ctx (~24–40K)',
    note: 'Vision input is optional — llama-server needs the separate mmproj file (not downloaded here); text works without it.',
    ollama: { tier: 'library', tag: 'qwen3.6:27b', approxBytes: 17_000_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'unsloth/Qwen3.6-27B-GGUF',
        file: 'Qwen3.6-27B-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 16_817_244_384,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'Qwen/Qwen3.6-27B' },
  },
  {
    id: 'gpt-oss-20b',
    role: 'agent',
    displayName: 'gpt-oss-20b',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    contextWindow: 131072,
    vramLine: '24GB-easy (100K+ ctx)',
    ollama: { tier: 'library', tag: 'gpt-oss:20b', approxBytes: 14_000_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'ggml-org/gpt-oss-20b-GGUF',
        file: 'gpt-oss-20b-MXFP4.gguf',
        quant: 'MXFP4',
        approxBytes: 12_109_566_624,
      },
      verify: { mode: 'live-oid' },
    },
    // exception row (SC-2): openai is deliberately NOT allowlisted — nothing
    // ever downloads from openai/, vLLM fetches the weights itself.
    vllm: { serveRepo: 'openai/gpt-oss-20b' },
  },
  {
    id: 'qwen36-35b-a3b',
    role: 'agent',
    displayName: 'Qwen3.6-35B-A3B',
    publisher: 'unsloth',
    license: 'Apache-2.0',
    vramLine: '24GB-stretch (offload) / 32GB-comfortable',
    note: MOE_HONESTY_NOTE,
    ollama: { tier: 'library', tag: 'qwen3.6:35b', approxBytes: 24_000_000_000 },
    llamacpp: {
      gguf: {
        hfRepo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        file: 'Qwen3.6-35B-A3B-UD-Q4_K_S.gguf',
        quant: 'UD-Q4_K_S',
        approxBytes: 20_893_015_008,
      },
      verify: { mode: 'live-oid' },
    },
    vllm: { serveRepo: 'Qwen/Qwen3.6-35B-A3B' },
  },

  // --- NEXT (pinned; the only next-role row, and its role default) ---------
  {
    id: 'sweep-next',
    role: 'next',
    defaultForRole: true,
    displayName: 'Sweep Next-Edit v2 (7B)',
    publisher: 'SyntinalCo',
    license: 'Apache-2.0',
    contextWindow: 32768,
    vramLine: 'Q4 ≈ 5 GB',
    ollama: {
      tier: 'hf-ingest',
      gguf: {
        hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
        file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 4_680_000_000,
      },
      createdName: 'sweep-next-edit-v2-7b:q4_k_m',
      verify: { mode: 'pinned', sha256: '' },
    },
    llamacpp: {
      gguf: {
        hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
        file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        approxBytes: 4_680_000_000,
      },
      verify: { mode: 'pinned', sha256: '' },
    },
    // exception row (SC-2): sweepai is deliberately NOT allowlisted — the
    // OFFICIAL upstream Sweep repo, carried forward from beta.5.
    vllm: { serveRepo: 'sweepai/sweep-next-edit-v2-7B' },
  },
];
