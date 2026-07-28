# Where Hermes stores your API key (and what can go wrong on Linux)

Hermes stores the autocomplete API key in **VS Code's SecretStorage**, never in `settings.json`.

## How it actually works

Since VS Code 1.80 secrets are encrypted with Electron's `safeStorage`. **The secret values are not in your
keyring** — they are encrypted and written into VS Code's own SQLite state DB
(`~/.config/Code/User/globalStorage/state.vscdb`); only the *encryption key* lives in the OS keyring.
<https://code.visualstudio.com/docs/configure/settings-sync#_troubleshooting-keychain-issues>

**If no keyring is available, VS Code silently falls back to in-memory storage.** Saving appears to succeed
and the key works for the rest of the session — then it is gone when you quit. Hermes cannot detect this
directly (no API exposes the storage mode), so it protects you a different way: **it keeps your old plaintext
setting until it has seen the key survive a restart.**

## Fedora

- **Workstation, GNOME, password login — works out of the box.** GNOME is a recognised desktop environment,
  and gnome-keyring's login collection is unlocked by your login password.
- **Fingerprint login or automatic login — the keyring stays LOCKED.** No password is entered, so nothing
  unlocks it. You will see an *"unlock login keyring"* prompt the first time VS Code touches it. **Enter your
  password at that prompt.** Dismissing it leaves the session with no encryption available.
- **Window-manager-only spins (i3, sway) — the desktop environment is not recognised.** Install
  gnome-keyring and set `"password-store": "gnome-libsecret"` via **Preferences: Configure Runtime
  Arguments** (`argv.json`).
- **Flatpak VS Code** is unofficial and its sandbox has repeatedly broken keyring access. Fix with
  `flatpak override --user --talk-name=org.freedesktop.secrets com.visualstudio.code`, and/or the
  `password-store` setting above.
- **Remote-SSH: the remote host's keyring is irrelevant.** Secrets are always stored on the **client** —
  the machine running the VS Code UI. <https://code.visualstudio.com/api/advanced-topics/remote-extensions#_persisting-secrets>

## Two things worth knowing

- **`"password-store": "basic"` is obfuscation, not encryption.** It uses a key hardcoded in the Chromium
  source, so any process on your system could in theory decrypt your stored secrets. Use it only with that
  understanding.
- **A decryption failure deletes the secret.** If the encryption backend changes between sessions (keyring
  reset, switching `gnome-libsecret` ↔ `basic`, Flatpak permission changes), VS Code deletes the unreadable
  secret rather than returning it. Re-enter the key with **Hermes: Set Autocomplete API Key**.

## Hermes does not inspect your system

Hermes never reads `XDG_CURRENT_DESKTOP`, never runs `secret-tool` or `dbus-send`, never checks D-Bus, and
never edits `argv.json`. It only observes the outcomes of its own storage calls. Under Remote-SSH, probing
would examine the wrong machine anyway.
