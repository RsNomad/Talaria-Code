/**
 * SecretStorage handling for the autocomplete API key (security-review.md H1).
 *
 * The key must live in the OS keychain via `context.secrets`, NOT in plaintext
 * settings where Settings Sync, other extensions, or a committed
 * `settings.json` could leak it. The legacy `talaria.autocomplete.apiKey`
 * setting is kept only (machine-scoped) as a migration source and is never
 * logged.
 *
 * The pure helpers below are `vscode`-free so they can be unit-tested.
 */

/** SecretStorage key under which the autocomplete API key is persisted. */
export const AUTOCOMPLETE_API_KEY_SECRET = 'talaria.autocomplete.apiKey';

/**
 * The effective API key: prefer the keychain-backed SecretStorage value over
 * the legacy plaintext setting. Whitespace-only is treated as absent.
 */
export function pickApiKey(
  secretValue: string | undefined,
  settingValue: string | undefined,
): string | undefined {
  const secret = secretValue?.trim();
  if (secret) return secret;
  const setting = settingValue?.trim();
  return setting || undefined;
}

/**
 * True when a plaintext setting exists but SecretStorage has no value yet — the
 * one-time signal to migrate the legacy key into SecretStorage.
 */
export function shouldMigrateApiKey(
  secretValue: string | undefined,
  settingValue: string | undefined,
): boolean {
  return !secretValue?.trim() && !!settingValue?.trim();
}

/**
 * Whether it is SAFE to delete the legacy plaintext setting.
 *
 * The migration used to store into SecretStorage and clear the plaintext
 * setting in the SAME session. That destroys the key on any machine where
 * VS Code silently fell back to in-memory secret storage: `store()` resolves
 * (there is nothing to encrypt, so no error surfaces), `get()` works for the
 * rest of the session, and the value is gone on quit — leaving no copy
 * anywhere.
 *
 * So the durable copy is kept until a LATER activation reads the secret back
 * WITHOUT migration having run. That read is the only evidence available
 * without probing the environment — and probing would be both forbidden (no
 * orchestration) and wrong (under Remote-SSH the secret lives on the client,
 * not on the machine the extension host runs on).
 *
 * Requires all three: the secret read back, a setting still present to clear,
 * and the two agreeing — a setting holding a DIFFERENT value was never the
 * thing we migrated.
 *
 * F-3 (fix wave): that last requirement means this AUTOMATIC path can never
 * clear a plaintext value that disagrees with the secret, so one would
 * otherwise linger forever. It is not stranded: the `Talaria: Set Autocomplete
 * API Key` command's clear branch removes the setting unconditionally, which
 * is sound precisely because it is the user explicitly asking to hold no key
 * — none of the durability reasoning above applies to a deletion that was
 * requested. Automatic deletion still needs all three conditions.
 */
export function shouldClearLegacyApiKeySetting(
  secretValue: string | undefined,
  settingValue: string | undefined,
  migratedThisSession: boolean,
): boolean {
  if (migratedThisSession) return false;
  const secret = secretValue?.trim();
  const setting = settingValue?.trim();
  // F-6 (fix wave): NOT redundant, despite an earlier report claiming so. With
  // BOTH values absent, `undefined === undefined` below is `true` — this line
  // is the only thing between that and a "safe to clear" verdict in the state
  // where nothing has been proven at all. Deleting it turns the suite red.
  if (!secret || !setting) return false;
  return secret === setting;
}
