# Changelog

All notable, user-facing changes to **Talaria Code** are recorded here. This file
starts with the `v0.1.2-beta.5` drop; earlier pre-releases (`v0.1.0-beta.2/3`,
`v0.1.1-beta.4`) are captured in their GitHub Release notes.

Talaria Code is **local-first**, licensed **GPL-3.0-or-later**, targets
**Linux**, and requires **VS Code `^1.125`**.

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
