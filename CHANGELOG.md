# Changelog

All notable, user-facing changes to **Talaria Code** are recorded here. This file
starts with the `v0.1.2-beta.5` drop; earlier pre-releases (`v0.1.0-beta.2/3`,
`v0.1.1-beta.4`) are captured in their GitHub Release notes.

Talaria Code is **local-first**, licensed **GPL-3.0-or-later**, targets
**Linux**, and requires **VS Code `^1.125`**.

---

## v0.1.3-beta.6 — 2026-08-08

Local-model onboarding drop. beta.5 fixed setup one surface at a time; beta.6
replaces those point-fixes with **one coherent way to configure a local model**
across every role the extension uses — the agent, autocomplete, next-edit, and
the codebase index — backed by a fixed catalog of curated models and a
verified-download tier from a small, named publisher allowlist. It also closes
the panel gap where downloading a model didn't actually let you *select* it, and
tightens honesty throughout — all under the same verified-sources-only rule as
beta.5.

### Unified "Configure local model"

- **One setup component, four surfaces.** Agent, Autocomplete (FIM), Next-Edit,
  and Codebase index (RAG) now share the same flow: pick a backend
  (**Ollama** / **llama.cpp** / **vLLM**), see whether it's installed, see which
  model is present, download and verify it, and test the endpoint — the same
  affordances everywhere, and idempotent (a model already present shows a green
  line, not a download button).
- **New: a local agent model.** The Agent card gains a **"Configure Local Agent
  Model"** picker — six agent models to choose from, with **Devstral-24B (2507)**
  as the recommended default. You can prepare the model before Hermes is even
  installed; once it is, the card points you to the exact provider settings to
  finish wiring it up.
- **Start-screen recommendations.** The setup walkthrough and panel now suggest a
  model stack sized to your hardware — what fits your GPU (from ~8 GB up to
  32 GB+), the verified 24 GB working stack, and an honest note that a
  mixture-of-experts model isn't smaller on disk just because fewer parameters
  are active per token.
- **A fixed, curated catalog.** Thirteen models across the four roles, each with
  its size, context window, and a plain VRAM-fit line. The catalog is the *only*
  source of an automated download; an unknown model is refused rather than
  fetched.

### Verified downloads, trusted publishers

- **Downloads come only from a named, seven-publisher allowlist** — Qwen,
  Mistral AI, Google, DeepReinforce (Ornith), ggml.ai (llama.cpp), Unsloth, and
  our own Syntinal account — never an unaudited community re-upload. Each
  publisher carries an honest one-line trust basis, shown in the confirmation
  dialog before anything downloads.
- **Every download is integrity-checked before it is used.** Talaria hashes the
  received bytes and checks them against the publisher's own published checksum
  (SHA-256); llama.cpp files are written to a temporary file in the destination
  folder and renamed into place atomically, with a small attestation recorded
  next to them; Ollama verifies the digest again as it ingests the file.
- **Presence is reported honestly.** A model reads *present* only when it is
  genuinely on the server or in the folder Talaria actually probed — never
  inferred from a default it might not match.
- **Devstral-24B (2507) is the default agent model on both Ollama and
  llama.cpp**, installed through the verified download so it's the same 2507 build
  everywhere. Talaria deliberately does **not** use Ollama's plain `devstral`
  library tag — that tag is still the older 2505 build — so the version can't
  quietly drift between backends.
- **vLLM is treated honestly.** For a vLLM target Talaria composes the
  `vllm serve` command but downloads nothing itself — vLLM fetches the weights —
  so its integrity basis is the publisher's repo identity over TLS, and that
  weaker basis is stated plainly. Two named repositories (the official upstream
  Sweep model and gpt-oss) are the *only* serve targets allowed from outside the
  download allowlist, recorded as explicit exceptions.
- **llama.cpp autocomplete uses base-model builds** — Q8 packages from ggml.ai,
  the llama.cpp project's own packaging of the base model. An instruct-tuned GGUF
  remains a documented manual fallback if you prefer one.

### Select and apply a model in the panel

- **Picking or downloading a model now actually selects it.** On Autocomplete and
  Codebase index, choosing a model row — or finishing a download — marks it as
  your pending choice with a *"not saved yet"* line; pressing **Apply** then saves
  the endpoint **and** the model together, and the confirmation names both.
  Previously a download changed nothing about which model was used.
- **Autocomplete and the codebase index keep separate models — by design.** They
  are different jobs, so they never share a model; nothing lets one card
  overwrite the other's setting. (Typed free-text model names still work; the one
  honest exception is the llama.cpp completion server, which serves whatever you
  launched it with and says so instead of showing a model box.)
- **Each embedding backend remembers its own endpoint.** Switching the
  Codebase-index tab to llama.cpp no longer risks saving Ollama's port as a
  llama.cpp endpoint — every tab shows the right default for its backend.
- **The "it's working" lines are honest.** *"Autocomplete is active"* and
  *"Codebase index is ready"* now appear only when the model is genuinely present
  on the configured server, not merely because a setting is filled in.
- **Clearer copy.** The "no vetted build yet" message now names what to do by
  function — the vLLM backend in the dedicated Next-Edit setup, or Generic mode —
  instead of pointing "below" at instructions that no longer exist; there's one
  check-mark per line (no doubled ✓); commands carry a **"Start the server:"**
  caption; every Test button names the address it tests; and internal names like
  `llamacpp` display as **llama.cpp**.
- **Confirmation dialogs can't be forged.** Every free-text or saved value shown
  in a confirmation popup is sanitized so it can't smuggle in extra lines.

### Known residuals (honest limits of this build)

- **The dedicated Sweep Next-Edit download is still disabled.** Our vetted build
  of that model isn't published yet, so its integrity pin is empty and the
  fail-closed gate keeps **both** the download button **and** the guided
  `llama.cpp` line off. The card says so and offers the **vLLM** path (official
  Sweep release) instead; it lights up in a later drop once the build ships and
  its checksum is filled. (Carried forward from beta.5.)
- **The model catalog is final for this release.** Its download sources,
  publishers, and per-role defaults are locked; adding a model or a publisher is
  a deliberate, reviewed change in a future drop.

### Requirements (unchanged)

Linux (developed on Fedora) · VS Code `^1.125` · Python **3.11–3.13** + `pipx` ·
a local model runtime (Ollama / vLLM / llama.cpp). License: **GPL-3.0-or-later**.

---

## v0.1.2-beta.5 — 2026-08-06

Setup-hardening drop. The beta.4 Fedora live test exposed a batch of setup-flow
gaps — silent installs, a false 30-second timeout, an unreadable session error,
and a Fedora-only install path. This release closes them, extends dependency
install to more Linux distributions, and brings the dedicated Next-Edit model to
parity with FIM — all under a verified-sources-only rule.

### Multi-distro dependency install

- **Backend Setup now works beyond Fedora.** The panel reads your
  `/etc/os-release`, recognizes your distribution, and pre-types the correct
  install command for its native package manager:
  **Fedora/RHEL** (`dnf`) · **Debian** (`apt-get`) · **Ubuntu** (`apt-get`) ·
  **Arch** (`pacman`) · **openSUSE** (`zypper`).
- **Every command comes from the distribution's own signed archive** — nothing
  is guessed. You still review the pre-typed line and answer your package
  manager's own prompt; Talaria never auto-confirms and never `sudo`s for you.
- **Unrecognized distro → honest guidance, not a wrong command.** If your distro
  isn't in the list (or `os-release` can't be read), the panel shows guided
  instructions and a docs link instead of a command you shouldn't run.

### Honest panel feedback

- **Installs are no longer silent.** The card flips to *Installing…* right after
  you confirm, shows progress, and reports success **or** failure — a controller
  refusal now surfaces as a real error box instead of vanishing.
- **The false "timed out after 30000ms" during a long install is gone.** The
  install step no longer races a 30-second timer, so a large download completes
  without a spurious timeout banner.
- **The cryptic `Failed to start a Hermes session: [object Object]` is
  replaced** with a readable message. When the real cause is that no chat
  provider is configured, you get a specific pointer to **Setup → Provider**
  rather than an opaque object.
- **Test and Apply now confirm on success**, not only on failure —
  `✓ Endpoint reachable` / `✓ Applied`. Cancelling an Apply shows **nothing**
  (no false `✓`, no false `✗`).
- **Each card ends with a plain "done / what's next" line** so you always know
  the next step.

### Login-shell probe robustness

- **The one-time shell probe that locates `pipx` tolerates a slow profile.** A
  slow login shell (nvm, conda, a network home directory) no longer fails the
  whole lookup, a probe timeout is reported honestly (not mislabeled as
  "pipx missing"), and **Cancel can reach the probe while it is still running**.

### Dedicated Next-Edit (Sweep) parity

- **The Dedicated Next-Edit card reaches parity with FIM.** For
  **Sweep Next-Edit v2 (7B)** the card checks whether the model is already
  present on your local Ollama, and carries a verified, checksum-enforced
  download path: Talaria downloads our own build, verifies the received bytes
  against a **pinned SHA-256**, and Ollama verifies the digest **again** as it
  ingests the file (loopback only).
- A **vLLM path against Sweep's official release** is available regardless of the
  above.

### Verified sources, everywhere

Every install and download **names its exact source and how its integrity is
checked, or it does not run**:

- Package installs come from **your distribution's own signed archive** (its
  package manager's GPG/repo chain).
- **Hermes** from **PyPI** at a pinned version (`hermes-agent[acp]==0.18.2`).
- **Models** from **Ollama's content-addressed registry**, or from a
  **checksum-pinned** artifact verified after download and again at ingest.
- **Community / third-party model conversions are banned from every automated
  path.** A pin proves a file hasn't changed since we looked — not that someone
  else's conversion is faithful — so Talaria only automates its own vetted
  build.

### Known residuals (read these — they are honest limits of this build)

- **The dedicated Sweep download is disabled in this build.** Our vetted GGUF has
  not been published yet, so its pinned checksum is empty and the fail-closed
  gate keeps **both** the Download button **and** the guided `llama.cpp` line
  off. The card honestly says *"No vetted build of this model is published
  yet"* and offers the **vLLM** path (official Sweep release) instead. This
  lights up in a later drop once the build is published and its checksum is
  filled.
- **llama.cpp on Debian/Ubuntu is guidance-only.** The binary package name in
  those archives isn't confirmed, so Talaria links the docs rather than guess a
  command. (Fedora `llama-cpp`, Arch `llama-cpp`, and openSUSE Tumbleweed
  `llamacpp` are pre-typed; Fedora's was live-verified.)
- **vLLM install is docs-guided.** Its install depends on your GPU/CUDA setup, so
  Talaria opens the official guide and tests your endpoint — it does not run a
  `pip install` for you.
- **Containers / Flatpak degrade honestly.** If Talaria can't tell which host
  system your terminal acts on (VS Code appears to run in a sandbox/container),
  it falls back to the host's identity or an honest note asking you to run the
  install commands on your host — never an install command for the wrong system.

### Requirements (unchanged)

Linux (developed on Fedora) · VS Code `^1.125` · Python **3.11–3.13** + `pipx` ·
a local model runtime (Ollama / vLLM / llama.cpp). License: **GPL-3.0-or-later**.
