import type { SlashCommandInfo } from '../../../shared/protocol';

/**
 * ACP `available_commands_update.availableCommands` -> {@link SlashCommandInfo}[]
 * (W2 F-S).
 *
 * The exact Hermes payload shape is UNPINNED until verified live (Fedora probe
 * P3 — see {@link AcpAvailableCommand}'s own doc), so `raw` is read as
 * `unknown` and every entry is validated DEFENSIVELY: an entry failing the
 * shape guard (missing/blank `name`, missing/non-string `description`, or not
 * an object at all) is DROPPED rather than thrown — one malformed entry must
 * never take down the whole catalog push. `raw` itself not being an array
 * (payload shape drift, or simply absent) degrades to `[]`, never a throw.
 */
export function mapAvailableCommands(raw: unknown): SlashCommandInfo[] {
  if (!Array.isArray(raw)) return [];

  const out: SlashCommandInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    const name = e.name;
    if (typeof name !== 'string' || name.trim() === '') continue;

    const description = e.description;
    if (typeof description !== 'string') continue;

    const info: SlashCommandInfo = { name: name.trim(), description };

    const input = e.input;
    if (input && typeof input === 'object') {
      const hint = (input as Record<string, unknown>).hint;
      if (typeof hint === 'string') info.inputHint = hint;
    }

    out.push(info);
  }
  return out;
}
