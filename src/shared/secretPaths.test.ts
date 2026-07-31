import { describe, it, expect } from 'vitest';
import { classifyPath, isSecretForCompletion, isSecretForEditFloor } from './secretPaths';

/**
 * W6-FC (final-3way-arch.md I-6) — these suites MOVED here verbatim from
 * `host/backend/policy/editPolicy.test.ts` alongside the code they exercise
 * (pure relocation, see `secretPaths.ts`'s header). `editPolicy.test.ts`
 * keeps only the decision-table (`evaluateEditPolicy`) and mode-floor
 * (`violatesModeFloor`) suites, plus a thin pin proving its re-export of
 * these two functions is unaffected by the move.
 */

describe('classifyPath — secret (positives)', () => {
  for (const p of [
    '.ssh/id_rsa',
    '.git/config',
    'sub/.git/HEAD',
    '.env',
    '.env.local',
    'deep/path/.env.production',
    'id_rsa',
    'config/id_ed25519',
    'certs/server.pem',
    'home/user/.ssh/known_hosts',
  ]) {
    it(`marks ${p} secret`, () => {
      expect(classifyPath(p).secret).toBe(true);
    });
  }
});

describe('classifyPath — secret (near-miss negatives)', () => {
  for (const p of [
    'env.ts', // basename does not start with `.env.` nor equal `.env`
    'my.envelope', // `.env` prefix trap — `.envelope` ≠ `.env` and ≠ `.env.*`
    'src/environment.ts',
    'config/id_rsa.pub', // ≠ `id_rsa`, not `.pem`
    'readme.pem.md', // ends `.md`, not `.pem`
    'ssh/config', // segment is `ssh`, not `.ssh`
    'git/config', // segment is `git`, not `.git`
  ]) {
    it(`does NOT mark ${p} secret`, () => {
      expect(classifyPath(p).secret).toBe(false);
    });
  }
});

describe('classifyPath — protected (positives)', () => {
  for (const p of [
    '.hermes/policy.json',
    '.vscode/settings.json',
    'sub/.vscode/tasks.json',
    'AGENTS.md',
    'pkg/AGENTS.md',
    'hermes.code-workspace',
    'nested/dir/team.code-workspace',
  ]) {
    it(`marks ${p} protected`, () => {
      expect(classifyPath(p).protected).toBe(true);
    });
  }
});

describe('classifyPath — protected (near-miss negatives)', () => {
  for (const p of [
    'AGENTS.md.bak', // basename ≠ `AGENTS.md`
    'docs/AGENTS.mdx',
    'hermes/notes.md', // segment `hermes`, not `.hermes`
    'vscode/x.json', // segment `vscode`, not `.vscode`
    'foo.code-workspace.bak', // ends `.bak`, not `.code-workspace`
  ]) {
    it(`does NOT mark ${p} protected`, () => {
      expect(classifyPath(p).protected).toBe(false);
    });
  }
});

describe('classifyPath — classes are independent', () => {
  it('.env is secret but not protected', () => {
    expect(classifyPath('.env')).toEqual({ secret: true, protected: false });
  });
  it('.vscode/settings.json is protected but not secret', () => {
    expect(classifyPath('.vscode/settings.json')).toEqual({ secret: false, protected: true });
  });
  it('src/app.ts is neither', () => {
    expect(classifyPath('src/app.ts')).toEqual({ secret: false, protected: false });
  });
});

/**
 * W6-FC (final-3way-security.md IMPORTANT-1) — `classifyPath` is the FROZEN
 * edit-approval floor (locked user decision 2026-07-15: byte-for-byte parity
 * with Hermes core `edit_approval.py`). This pins that `credentials.json`
 * (the sharpest-vector filename from the finding) and its adjacent
 * egress-only additions do NOT newly become edit-approval-secret — proving
 * the W6-FC broaden touched ONLY `isSecretForCompletion`, never this
 * function. Paired with one already-secret and one already-clean control so
 * the pin isn't vacuous.
 */
describe('classifyPath — W6-FC: UNCHANGED by the isSecretForCompletion broaden', () => {
  it('credentials.json remains NOT secret under classifyPath (edit-approval parity preserved)', () => {
    expect(classifyPath('credentials.json').secret).toBe(false);
  });
  it('application_default_credentials.json remains NOT secret under classifyPath', () => {
    expect(classifyPath('application_default_credentials.json').secret).toBe(false);
  });
  it('.git-credentials remains NOT secret under classifyPath', () => {
    expect(classifyPath('.git-credentials').secret).toBe(false);
  });
  it('secrets.yaml remains NOT secret under classifyPath', () => {
    expect(classifyPath('secrets.yaml').secret).toBe(false);
  });
  it('prod.tfvars remains NOT secret under classifyPath', () => {
    expect(classifyPath('prod.tfvars').secret).toBe(false);
  });
  it('control: an already-secret path (.env) is still secret', () => {
    expect(classifyPath('.env').secret).toBe(true);
  });
  it('control: an already-clean path (src/app.ts) is still clean', () => {
    expect(classifyPath('src/app.ts').secret).toBe(false);
  });
});

/**
 * S4.1 (CWE-200/312) fix — SEC-AC MEDIUM: `isSecretForCompletion` is a
 * deliberate SUPERSET of `classifyPath().secret` for the autocomplete
 * exfiltration gate. Each positive below is a file `classifyPath` alone does
 * NOT catch (proven by the "is a strict superset" describe below), so this
 * suite exercises exactly the newly-covered surface, plus a negative control
 * so the whole thing isn't vacuously true-everywhere.
 */
describe('isSecretForCompletion — newly-covered positives (beyond classifyPath)', () => {
  for (const p of [
    '/repo/certs/server.key', // *.key
    '/repo/tls.pfx', // *.pfx
    '/home/u/.aws/credentials', // .aws/ dir (also basename `credentials`)
    '/repo/.npmrc', // package-manager credential file
    '/home/u/deploy_key.p12', // *.p12
    '/repo/CERT.PEM', // case-variant of classifyPath's *.pem — must still be caught
    '/repo/keys/backup.pkcs12', // *.pkcs12
    '/repo/keystore.jks', // *.jks
    '/repo/release.keystore', // *.keystore
    '/home/u/.ssh/id_ecdsa', // id_ecdsa (any location)
    '/home/u/.ssh/id_dsa', // id_dsa (any location)
    '/repo/kubeconfig', // basename `kubeconfig`
    '/home/u/.kube/config', // .kube/ dir
    '/repo/serviceaccount.json', // GCP service-account key
    '/home/u/.netrc', // netrc
    '/home/u/.pgpass', // pgpass
    '/home/u/.pypirc', // pypirc
    '/repo/.envrc', // direnv
    '/home/u/.gnupg/secring.gpg', // .gnupg/ dir
  ]) {
    it(`marks ${p} secret-for-completion`, () => {
      expect(isSecretForCompletion(p)).toBe(true);
    });
  }
});

describe('isSecretForCompletion — negative control (not vacuously true)', () => {
  for (const p of ['/repo/src/index.ts', '/repo/README.md']) {
    it(`does NOT mark ${p} secret-for-completion`, () => {
      expect(isSecretForCompletion(p)).toBe(false);
    });
  }
});

/**
 * D4 (Decision 4, user sign-off 2026-07-16, reverses locked decision Q2 of
 * 2026-07-15): `isSecretForEditFloor` is a NAMED delegation — deliberately
 * the SAME function reference as `isSecretForCompletion`, not a third
 * classifier. This is a `toBe` (reference equality) pin, mirroring
 * `editPolicy.test.ts`'s existing re-export identity pins, so a future edit
 * cannot silently fork it into a re-implementation that could drift from the
 * egress superset's maintained `⊇ classifyPath.secret` invariant.
 */
describe('isSecretForEditFloor — D4: identity with isSecretForCompletion (not a re-implementation)', () => {
  it('is the exact same function reference as isSecretForCompletion', () => {
    expect(isSecretForEditFloor).toBe(isSecretForCompletion);
  });
  it('behaves identically on the credentials.json case that motivated D4', () => {
    expect(isSecretForEditFloor('credentials.json')).toBe(true);
    expect(isSecretForEditFloor('credentials.json')).toBe(isSecretForCompletion('credentials.json'));
  });
});

/**
 * H7 (P7-N9 further-candidate carry, ledger + secretPaths.ts doc comment):
 * five more residuals — `*.tfstate.*` (Terraform state BACKUP files, per
 * Terraform's own `.gitignore` template which lists both `*.tfstate` and
 * `*.tfstate.*`), `id_ed448` / `id_xmss` (SSH Ed448 / XMSS private-key
 * filenames, exact-match mirroring the existing `id_ecdsa`/`id_dsa` style),
 * `*.jceks` (Java Cryptography Extension KeyStore, sibling of `.jks`/
 * `.keystore`/`.p12`/`.pfx`/`.pkcs12`), and `.azure` (Azure CLI's
 * token-cache directory, sibling of `.aws`/`.gnupg`/`.kube`). Same
 * egress-only shape as W6-FC/P7-N9 — RED before the broaden, GREEN after —
 * fixture filenames only, never a real secret value.
 */
describe('isSecretForCompletion — H7: tfstate.* family / id_ed448 / id_xmss / *.jceks / .azure', () => {
  for (const p of [
    'main.tfstate.backup', // *.tfstate.* family (state backup)
    'terraform.tfstate.1.backup', // *.tfstate.* family (numbered backup)
    '~/.ssh/id_ed448', // brief fixture — also already caught by the frozen
    // .ssh-directory rule in classifyPath (superset), so this alone does not
    // isolate the new id_ed448 pattern; see the bare `id_ed448` case below
    // for that.
    'id_xmss', // bare — isolates the new pattern (no .ssh dir confound)
    'release.jceks', // *.jceks
    '/home/u/.azure/accessTokens.json', // .azure/ dir (Azure CLI token cache)
  ]) {
    it(`marks ${p} secret-for-completion`, () => {
      expect(isSecretForCompletion(p)).toBe(true);
    });
  }

  // Bare `id_ed448` (no directory), isolating the new exact-match pattern
  // from the frozen classifyPath `.ssh`-segment rule that already covers the
  // brief's `~/.ssh/id_ed448` fixture above.
  it('marks bare id_ed448 secret-for-completion', () => {
    expect(isSecretForCompletion('id_ed448')).toBe(true);
  });
  it('marks a nested, non-.ssh id_ed448 secret-for-completion', () => {
    expect(isSecretForCompletion('config/id_ed448')).toBe(true);
  });

  it('case-insensitivity applies to the new patterns too (RELEASE.JCEKS, ID_XMSS)', () => {
    expect(isSecretForCompletion('RELEASE.JCEKS')).toBe(true);
    expect(isSecretForCompletion('ID_XMSS')).toBe(true);
    expect(isSecretForCompletion('/home/u/.AZURE/accessTokens.json')).toBe(true);
  });

  // Near-misses: prove the new patterns are exact-basename / exact-extension
  // / exact-path-segment matches, not accidental substring/source-code
  // matches (over-block is acceptable for an egress guard; under-block is
  // not — but these pin that we are NOT over-blocking obvious source/docs).
  for (const p of [
    'main.tf', // Terraform config source, not state — not *.tfstate nor *.tfstate.*
    'notes.md', // plain doc, unrelated
    'id_ed448.pub', // PUBLIC key — exact-match excludes it, like id_rsa.pub today
    'azure.ts', // a source file named "azure", NOT under a `.azure/` dir
    'keystore.md', // contains "keystore" but is not *.jceks/*.jks/*.keystore
  ]) {
    it(`does NOT mark ${p} secret-for-completion (near-miss)`, () => {
      expect(isSecretForCompletion(p)).toBe(false);
    });
  }
});

/**
 * H7: `classifyPath` is the FROZEN edit-approval floor (locked user decision
 * 2026-07-15, byte-for-byte parity with Hermes core `edit_approval.py`).
 * This pins that every new H7 shape does NOT newly become edit-approval-
 * secret, proving the broaden touched ONLY `isSecretForCompletion` — and
 * doubles as the superset-invariant check for this batch (each fixture is
 * `classifyPath`-negative but `isSecretForCompletion`-positive). The brief's
 * `~/.ssh/id_ed448` fixture is deliberately excluded here since it IS
 * classifyPath-secret (via the frozen `.ssh` segment rule, not via this
 * batch's additions) — see the suite above for that distinction.
 */
describe('classifyPath — H7: UNCHANGED by the isSecretForCompletion broaden', () => {
  for (const p of [
    'main.tfstate.backup',
    'terraform.tfstate.1.backup',
    'id_xmss',
    'config/id_ed448',
    'release.jceks',
    '/home/u/.azure/accessTokens.json',
  ]) {
    it(`${p} remains NOT secret under classifyPath, but IS secret-for-completion (superset invariant)`, () => {
      expect(classifyPath(p).secret).toBe(false);
      expect(isSecretForCompletion(p)).toBe(true);
    });
  }
});

/**
 * P7-N9 (2nd-3way security Minor-1 + backlog C3): the first pass's own
 * Minor-1 named `*.p8` (Apple/APNs auth key), `*.ppk` (PuTTY private key),
 * and `wallet.dat` (crypto wallet) as active-file gaps that W6-FC did not
 * fold in; plus the already-backlogged `*.kubeconfig` extension form (only
 * bare `kubeconfig` was caught), `*.tfstate` (Terraform state — commonly
 * carries plaintext secrets, confirmed by Terraform's own docs and the
 * official Terraform .gitignore template), the `credentials.*` generalization
 * (previously only the exact `credentials.json` was caught, not
 * `credentials.yaml`/`.ini`/other extensions), and files under a `secrets.d/`
 * or `credentials.d/` directory (POSIX path-segment, Unix "*.d drop-in
 * directory" convention). Best-practice-confirmed via web research: GitGuardian's
 * "Putty Private Key" detector (.ppk), deepfence/SecretScanner's named
 * `wallet.dat` → "Bitcoin Core wallet" rule, Apple's own developer docs (.p8
 * is the literal extension APNs/DeviceCheck/MusicKit/WeatherKit keys download
 * as), and OWASP secure-agent-playbook's "High-Risk File Patterns" list
 * (`kubeconfig`, `*.kubeconfig`, `*.tfvars`, `terraform.tfstate`,
 * `credentials`, `credentials.json`). RED before the broaden, GREEN after —
 * fixture filenames only, never a real secret value.
 */
describe('isSecretForCompletion — P7-N9: p8/ppk/wallet.dat/*.kubeconfig/*.tfstate/credentials.*/secrets.d//credentials.d/', () => {
  for (const p of [
    'key.p8', // *.p8 (Apple APNs/DeviceCheck/MusicKit/WeatherKit auth key)
    'certs/id.ppk', // *.ppk (PuTTY private key)
    'wallet.dat', // exact basename (Bitcoin Core / crypto wallet)
    'home/user/wallet.dat',
    'prod.kubeconfig', // *.kubeconfig extension form (bare `kubeconfig` already covered)
    '/repo/clusters/staging.kubeconfig',
    'terraform.tfstate', // *.tfstate
    'infra/terraform.tfstate',
    'app/state/main.tfstate', // generic *.tfstate, non-`terraform` stem
    'credentials.yaml', // credentials.* generalization (any extension)
    'credentials.ini',
    '/home/u/credentials.toml',
    'x/secrets.d/token', // secrets.d/ credential-directory convention
    'x/credentials.d/key', // credentials.d/ credential-directory convention
    '/etc/credentials.d/db.conf',
  ]) {
    it(`marks ${p} secret-for-completion`, () => {
      expect(isSecretForCompletion(p)).toBe(true);
    });
  }

  it('case-insensitivity applies to the new patterns too (KEY.P8)', () => {
    expect(isSecretForCompletion('KEY.P8')).toBe(true);
  });

  // Near-misses: prove the new patterns are exact-basename / exact-extension /
  // exact-path-segment matches, not accidental substring matches.
  for (const p of [
    'sample.p8x', // extension continues past `.p8` — not `*.p8`
    'notwallet.dat', // different basename — not exactly `wallet.dat`
    'wallet.dat.bak', // basename is `wallet.dat.bak`, not `wallet.dat`
    'notkubeconfig', // no literal `.` before `kubeconfig` — not `*.kubeconfig` nor bare `kubeconfig`
    'terraform.state', // missing the `tf` — not `*.tfstate`
    'x/mycredentials.d/file', // segment is `mycredentials.d`, not `credentials.d`
    'x/secrets.directory/file', // segment is `secrets.directory`, not `secrets.d`
  ]) {
    it(`does NOT mark ${p} secret-for-completion (near-miss)`, () => {
      expect(isSecretForCompletion(p)).toBe(false);
    });
  }
});

/**
 * P7-N9: `classifyPath` is the FROZEN edit-approval floor (locked user
 * decision Q2, byte-for-byte parity with Hermes core `edit_approval.py`).
 * This pins that every new P7-N9 shape does NOT newly become edit-approval-
 * secret, proving the broaden touched ONLY `isSecretForCompletion` — and
 * doubles as the superset-invariant check for this batch (each fixture is
 * `classifyPath`-negative but `isSecretForCompletion`-positive).
 */
describe('classifyPath — P7-N9: UNCHANGED by the isSecretForCompletion broaden', () => {
  for (const p of [
    'key.p8',
    'certs/id.ppk',
    'wallet.dat',
    'prod.kubeconfig',
    'terraform.tfstate',
    'credentials.yaml',
    'credentials.ini',
    'x/secrets.d/token',
    'x/credentials.d/key',
  ]) {
    it(`${p} remains NOT secret under classifyPath, but IS secret-for-completion (superset invariant)`, () => {
      expect(classifyPath(p).secret).toBe(false);
      expect(isSecretForCompletion(p)).toBe(true);
    });
  }
});

describe('isSecretForCompletion — is a strict superset of classifyPath().secret', () => {
  it('every classifyPath secret-positive is also isSecretForCompletion-positive', () => {
    for (const p of [
      '.ssh/id_rsa',
      '.git/config',
      '.env',
      '.env.local',
      'id_rsa',
      'config/id_ed25519',
      'certs/server.pem',
    ]) {
      expect(classifyPath(p).secret).toBe(true); // sanity: base fixture is really covered by classifyPath
      expect(isSecretForCompletion(p)).toBe(true);
    }
  });

  it('the newly-covered positives above are NOT caught by classifyPath alone (proves this is genuinely new coverage)', () => {
    for (const p of [
      '/repo/certs/server.key',
      '/repo/tls.pfx',
      '/home/u/.aws/credentials',
      '/repo/.npmrc',
      '/home/u/deploy_key.p12',
      '/repo/CERT.PEM',
    ]) {
      expect(classifyPath(p).secret).toBe(false);
    }
  });
});

/**
 * W6-FC (final-3way-security.md IMPORTANT-1) — `credentials.json` and four
 * adjacent credential filenames escaped `isSecretForCompletion`, and the
 * sharpest vector (the active-file autocomplete egress path,
 * `autocomplete/provider.ts`) gates SOLELY on this function with no
 * content-scan backstop. RED before the broaden, GREEN after — fixture
 * filenames only, never a real secret value.
 */
describe('isSecretForCompletion — W6-FC: credentials.json + 4 adjacent filenames (egress superset broaden)', () => {
  for (const p of [
    '/repo/credentials.json', // the sharpest-vector filename from the finding
    'credentials.json', // relative, no leading dir
    '/home/u/.config/gcloud/application_default_credentials.json', // GCP ADC well-known path
    'application_default_credentials.json',
    '/home/u/.git-credentials', // plaintext `git credential store` file
    '.git-credentials',
    '/repo/secrets.json', // secrets.* — any extension
    '/repo/secrets.yaml',
    '/repo/secrets.yml',
    '/repo/config/secrets.txt',
    '/repo/prod.tfvars', // *.tfvars
    '/repo/env/staging.auto.tfvars',
  ]) {
    it(`marks ${p} secret-for-completion`, () => {
      expect(isSecretForCompletion(p)).toBe(true);
    });
  }

  // Near-miss: bare `secrets` (no extension) is NOT `secrets.*` — proves the
  // glob-shape match isn't accidentally matching every basename starting
  // with "secrets".
  it('does NOT mark a bare "secrets" (no extension) as secret-for-completion via the new secrets.* rule', () => {
    expect(isSecretForCompletion('/repo/secrets')).toBe(false);
  });

  it('case-insensitivity applies to the new patterns too (CREDENTIALS.JSON)', () => {
    expect(isSecretForCompletion('/repo/CREDENTIALS.JSON')).toBe(true);
  });
});

describe('AUDIT-5 SEC M-1: the *.env SUFFIX convention (production.env / staging.env / config.env)', () => {
  it.each(['production.env', 'config/staging.env', 'deploy/config.env', 'local.env', 'PRODUCTION.ENV'])(
    'isSecretForCompletion(%j) is true — the systemd EnvironmentFile= / Docker naming the standard *.env scanner glob covers',
    (p) => {
      expect(isSecretForCompletion(p)).toBe(true);
    },
  );

  it('isSecretForEditFloor inherits the arm (it IS the alias — one classifier, three surfaces)', () => {
    expect(isSecretForEditFloor('production.env')).toBe(true);
  });

  it('classifyPath stays frozen: the suffix form is deliberately NOT added at the edit_approval.py-parity floor', () => {
    expect(classifyPath('production.env').secret).toBe(false);
  });

  it('lookalikes stay allowed — no over-blocking', () => {
    expect(isSecretForCompletion('src/environment.ts')).toBe(false);
    expect(isSecretForCompletion('notes/agenda.envy')).toBe(false);
  });
});
