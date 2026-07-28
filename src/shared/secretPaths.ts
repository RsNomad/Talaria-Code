/**
 * W6-FC · shared secret-path classifiers (final-3way-arch.md finding I-6).
 *
 * Pure, `vscode`-free, `fs`-free module housing the path-based secret
 * classifiers used across host, autocomplete, and RAG code:
 *
 *  - {@link classifyPath} — kept byte-for-byte parity with Hermes core
 *    `edit_approval.py` (locked user decision 2026-07-15: `credentials.json`
 *    is egress-ONLY — this classifier's own logic is FROZEN, do not change
 *    it; edit_approval.py-audit-diffability depends on that freeze).
 *    `editPolicy.ts` re-exports it so every existing importer is
 *    byte-identically unaffected by this move.
 *  - {@link isSecretForCompletion} — the deliberate egress SUPERSET (S4.1,
 *    CWE-200/312) gating what may leave the machine to the
 *    autocomplete/inference engine and the RAG index. Broader than
 *    `classifyPath` by design; see its own doc comment for the invariant
 *    (`isSecretForCompletion ⊇ classifyPath.secret`, enforced by a test).
 *  - {@link isSecretForEditFloor} — D4 (Decision 4, user sign-off
 *    2026-07-16, REVERSES the 2026-07-15 "egress-only" reading of Q2): the
 *    edit-approval FLOOR (`editPolicy.ts` F2 + N1) now consults this name,
 *    which is the egress SUPERSET (`isSecretForCompletion`), NOT
 *    `classifyPath`. `classifyPath` ITSELF remains byte-frozen and
 *    `edit_approval.py`-parity-locked as above — the divergence lives only
 *    at the policy layer, one level up. See {@link isSecretForEditFloor}'s
 *    own doc comment for the OWASP grounding.
 *
 * Extracted from `host/backend/policy/editPolicy.ts` (W4-frozen /
 * cross-cutting module) so routine egress-list edits (like W6-FC's) no
 * longer carry edit-approval review friction — see final-3way-arch.md I-6
 * and final-3way-security.md IMPORTANT-1. THIS COMMIT is a PURE relocation:
 * both functions' logic and doc comments are carried over byte-for-byte
 * unchanged from their prior home in `editPolicy.ts` — no behavior change.
 * `isSecretForCompletion`'s egress list is broadened in a SEPARATE, later
 * commit — never `classifyPath`.
 */

/**
 * Classify a POSIX path into the two protected classes.
 *
 * `secret`    ⇔ any segment is `.ssh` or `.git`; OR basename is `.env` or starts
 *               with `.env.`; OR basename is `id_rsa`/`id_ed25519`; OR basename
 *               ends with `.pem`. (Mirrors Hermes `edit_approval.py` + `.pem`.)
 * `protected` ⇔ any segment is `.hermes` or `.vscode`; OR basename is `AGENTS.md`;
 *               OR basename ends with `.code-workspace`. (Self-protection.)
 */
export function classifyPath(posixPath: string): { secret: boolean; protected: boolean } {
  const segments = posixPath.split('/');
  // `at(-1)` is `string | undefined` under noUncheckedIndexedAccess; `split`
  // never yields an empty array, so `?? ''` only satisfies the type checker.
  const basename = segments.at(-1) ?? '';

  const secret =
    segments.some((seg) => seg === '.ssh' || seg === '.git') ||
    basename === '.env' ||
    basename.startsWith('.env.') ||
    basename === 'id_rsa' ||
    basename === 'id_ed25519' ||
    basename.endsWith('.pem');

  const protectedClass =
    segments.some((seg) => seg === '.hermes' || seg === '.vscode') ||
    basename === 'AGENTS.md' ||
    basename.endsWith('.code-workspace');

  return { secret, protected: protectedClass };
}

/**
 * S4.1 (CWE-200/312): the secret surface for the AUTOCOMPLETE exfiltration gate,
 * a deliberate SUPERSET of `classifyPath().secret` (the edit-approval floor). A
 * file whose contents must never be POSTed to a remote inference endpoint is a
 * broader class than one whose EDIT needs approval — private keys of every
 * common name/extension, cloud/package-manager credential files, keystores.
 * Case-INSENSITIVE (fail-closed: `cert.PEM` on a case-sensitive FS is still a
 * key) — classification runs against the LOWERCASED path throughout, including
 * the `classifyPath` base call, so case-variants of `.env`/`id_rsa`/`*.pem`/
 * `.ssh`/`.git` are caught too, not just the patterns added here. Kept separate
 * from `classifyPath` so edit-approval behavior is unchanged.
 *
 * W6-FC (final-3way-security.md IMPORTANT-1 / arch I-6): broadened to also
 * catch `credentials.json`, `application_default_credentials.json` (the GCP
 * ADC well-known filename — `$HOME/.config/gcloud/application_default_credentials.json`),
 * `.git-credentials` (the plaintext file `git credential store` writes,
 * `https://user:token@host` lines), `secrets.*` (any extension —
 * `secrets.json`/`.yaml`/`.yml`/…), and `*.tfvars` (Terraform variable files,
 * which commonly carry provider credentials). Confirmed via web research
 * (gitleaks/trufflehog config, OWASP secure-agent-playbook, Google Cloud ADC
 * docs) as the standard set of filenames flagged by real secret scanners /
 * `.gitignore` templates for this exact class. This closes the sharpest
 * vector identified in review: the active-file autocomplete egress path
 * (`autocomplete/provider.ts`) gates SOLELY on this function, with no
 * content-scan backstop for the file currently being edited.
 *
 * P7-N9 (2nd-3way security Minor-1 + backlog C3): further broadened to catch
 * `*.p8` (Apple APNs/DeviceCheck/MusicKit/WeatherKit private-key download
 * extension — confirmed via Apple's own developer docs), `*.ppk` (PuTTY
 * private key — a named GitGuardian detector), `wallet.dat` (Bitcoin
 * Core / crypto wallet — a named deepfence/SecretScanner rule), `*.kubeconfig`
 * (the extension form; bare `kubeconfig` was already caught — both confirmed
 * as "High-Risk File Patterns" in OWASP's secure-agent-playbook alongside
 * `terraform.tfstate`/`*.tfvars`/`credentials`/`credentials.json`), `*.tfstate`
 * (Terraform state — commonly carries plaintext secrets per Terraform's own
 * docs and its official .gitignore template's `*.tfstate`/`*.tfstate.*`),
 * the `credentials.*` generalization (previously only the exact
 * `credentials.json` was caught; now ANY extension — `credentials.yaml`,
 * `.ini`, `.toml`, …), and files under a `secrets.d/` or `credentials.d/`
 * directory (POSIX path-segment match — the Unix "*.d drop-in directory"
 * convention, e.g. `cron.d`/`sudoers.d`, applied to credential storage; not
 * itself a named rule in gitleaks/trufflehog default configs, so this is a
 * defensive addition specific to this finding rather than an externally
 * pinned scanner convention). Same egress-only shape as W6-FC — `classifyPath`
 * (the edit-approval floor) is untouched.
 *
 * H7 (P7-N9 further-candidate carry, ledger + this file's prior "further-
 * candidate carry" note): five more residuals. `*.tfstate.*` — Terraform
 * state BACKUP files (`terraform.tfstate.backup`, numbered
 * `terraform.tfstate.1.backup`, …), carrying the same plaintext secrets as
 * the live state; confirmed via Terraform's own `.gitignore` template
 * (github/gitignore's `Terraform.gitignore`), which lists BOTH `*.tfstate`
 * and `*.tfstate.*`. `id_ed448` / `id_xmss` — SSH private-key filenames for
 * the Ed448 (RFC 8709 "Ed25519 and Ed448 Public Key Algorithms for SSH") and
 * XMSS (post-quantum, OpenSSH `ssh-keygen.c`'s `_PATH_SSH_CLIENT_ID_XMSS`,
 * experimental since OpenSSH 7.7) key types; exact-match, mirroring the
 * existing `id_ecdsa`/`id_dsa` style (deliberately NOT a broad `id_*`
 * prefix, which would also catch `id_*.pub` PUBLIC keys — a scope change
 * that style avoids). `*.jceks` — the Java Cryptography Extension KeyStore
 * format (Oracle's own JCE Reference Guide names "JCEKS" as the keystore
 * type), a sibling of the already-caught `.jks`/`.keystore`/`.p12`/`.pfx`/
 * `.pkcs12`. `.azure` — the Azure CLI's config/token-cache directory
 * (`~/.azure/accessTokens.json`, `azureProfile.json`, `msal_token_cache.*`;
 * Microsoft Learn's `azure-cli-configuration` docs confirm `$HOME/.azure` as
 * the default `AZURE_CONFIG_DIR` on Linux/macOS), matching the `.aws`/
 * `.gnupg`/`.kube` directory convention above. Same egress-only shape as
 * W6-FC/P7-N9 — `classifyPath` (the edit-approval floor) is untouched.
 */
export function isSecretForCompletion(posixPath: string): boolean {
  const lower = posixPath.toLowerCase();
  if (classifyPath(lower).secret) return true; // .ssh/.git, .env*, id_rsa/id_ed25519, *.pem
  const segments = lower.split('/');
  const basename = segments.at(-1) ?? '';
  const inDir = (name: string): boolean => segments.some((seg) => seg === name);
  return (
    // credential-bearing directories (H7 adds `.azure`, the Azure CLI
    // token-cache dir — see doc comment)
    inDir('.aws') || inDir('.gnupg') || inDir('.kube') || inDir('.azure') ||
    // other private-key names/extensions (any location) (H7 adds
    // `id_ed448`/`id_xmss` — see doc comment)
    basename === 'id_ecdsa' || basename === 'id_dsa' ||
    basename === 'id_ed448' || basename === 'id_xmss' ||
    basename.endsWith('.key') || basename.endsWith('.p12') ||
    basename.endsWith('.pfx') || basename.endsWith('.pkcs12') ||
    basename.endsWith('.jks') || basename.endsWith('.keystore') ||
    // H7 adds `.jceks`, a sibling keystore extension — see doc comment
    basename.endsWith('.jceks') ||
    // credential files
    basename === 'credentials' || basename === 'kubeconfig' ||
    basename === 'serviceaccount.json' ||
    basename === '.netrc' || basename === '.npmrc' ||
    basename === '.pgpass' || basename === '.pypirc' || basename === '.envrc' ||
    // W6-FC (IMPORTANT-1): credentials.json + 4 adjacent credential filenames.
    // `secrets.*` matches ANY non-empty extension after the `secrets.` stem
    // (`secrets.json`/`.yaml`/`.yml`/`.txt`/…) but not the bare basename
    // `secrets` (no extension) — matching the brief's `secrets.*` glob shape.
    // `credentials.*` below (P7-N9) subsumes the exact `credentials.json`
    // match, so it is not repeated here.
    basename === 'application_default_credentials.json' ||
    basename === '.git-credentials' ||
    (basename.startsWith('secrets.') && basename.length > 'secrets.'.length) ||
    basename.endsWith('.tfvars') ||
    // P7-N9 (2nd-3way security Minor-1 + backlog C3): private-key extensions,
    // a crypto-wallet filename, the *.kubeconfig extension form, Terraform
    // state, the credentials.* generalization, and credential-bearing
    // directory conventions. See doc comment above for source confirmation.
    basename.endsWith('.p8') ||
    basename.endsWith('.ppk') ||
    basename === 'wallet.dat' ||
    basename.endsWith('.kubeconfig') ||
    basename.endsWith('.tfstate') ||
    // H7 adds the `*.tfstate.*` family (state backups) alongside the bare
    // `*.tfstate` match above — see doc comment
    basename.includes('.tfstate.') ||
    (basename.startsWith('credentials.') && basename.length > 'credentials.'.length) ||
    inDir('secrets.d') ||
    inDir('credentials.d')
  );
}

/** D4/Q2-revised (user sign-off 2026-07-16): the EDIT-APPROVAL floor's secret
 * classifier. Deliberately the egress SUPERSET (`isSecretForCompletion`), NOT
 * the byte-frozen `classifyPath` — an agent WRITE to a credential-class file
 * (credentials.json, .aws/, keystores, tfstate, …) must be gated behind
 * approval (OWASP secure-agent-playbook High-Risk File Patterns / AISVS
 * AC.4.4), which `classifyPath`'s edit_approval.py-parity set does not cover.
 * `classifyPath` STAYS byte-frozen (audit-diffability vs Hermes core); the
 * divergence lives ONLY here, at the policy layer — same "broaden the superset,
 * never classifyPath" precedent this file already establishes (:26-27). */
export const isSecretForEditFloor = isSecretForCompletion;
