/*
 * The `/`-command catalog (W2 T1, architecture doc §3.2 "Hybrid A+B, C
 * rejected"): one sectioned menu —
 *  - "Commands" (Approach A): client-templated prompt commands, data-only,
 *    expanded into the composer on pick (review-first — the user sees
 *    exactly what will be sent; never auto-submitted).
 *  - "Agent" (Approach B): the ACP `available_commands` catalog (agent-
 *    control verbs), inserted as a literal `/name ` token and sent as a
 *    normal prompt — Hermes' `_handle_slash_command` consumes it.
 *
 * Collision policy (§3.2): the two sections are separate namespaces; an
 * agent command whose name collides with a client template is HIDDEN (never
 * duplicated) — client templates win, since agent-supplied names/
 * descriptions are untrusted display text.
 *
 * Policy rule (§2b, applies to every entry here): a slash command maps to
 * PROMPT CONTENT only. It never flips the edit-policy preset, the wire mode,
 * or any control-plane state (the `/yolo`-backdoor class) — policy changes
 * go through the visible preset picker exclusively. Nothing below reaches
 * for that state.
 */
import type { SuggestItem, SuggestSection } from '../components/SuggestMenu';
import type { SlashCommandInfo } from '../protocol';

/** One client-side `/`-command template — a prompt with an open argument slot. */
export interface SlashTemplate extends SuggestItem {
  /** Expansion inserted into the composer in place of the leading `/query`. */
  expand: (arg: string) => string;
}

/** v1 client template set (§3.2). Each expands to a prompt ending in an open slot for the user's argument. */
export const SLASH_TEMPLATES: SlashTemplate[] = [
  {
    id: 'explain',
    label: '/explain',
    hint: 'explain the attached code',
    icon: 'question',
    expand: () => 'Explain ',
  },
  {
    id: 'test',
    label: '/test',
    hint: 'write tests',
    icon: 'beaker',
    expand: () => 'Write tests for ',
  },
  {
    id: 'review',
    label: '/review',
    hint: 'review for bugs and style',
    icon: 'checklist',
    expand: () => 'Review the following for bugs, edge cases, and style issues: ',
  },
  {
    id: 'doc',
    label: '/doc',
    hint: 'write documentation',
    icon: 'book',
    expand: () => 'Write documentation for ',
  },
];

/** One agent-control verb from the ACP `available_commands` catalog (§3.2 Approach B). */
export interface AgentSlashItem extends SuggestItem {
  /** The literal `/name ` token inserted verbatim; Hermes' `_handle_slash_command` consumes it. */
  name: string;
}

const TEMPLATE_IDS = new Set(SLASH_TEMPLATES.map((t) => t.id));

/** Case-insensitive match against a query — same predicate style as {@link filterMentions}. */
function matches(query: string, ...fields: string[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f.toLowerCase().includes(q));
}

/**
 * Build the sectioned `/` menu: "Commands" (client templates) filtered by
 * `query`, then "Agent" (the ACP catalog) filtered by `query`, with any
 * agent command colliding with a client template id dropped (client
 * templates win — §3.2 collision policy). A section with zero matching
 * items after filtering is omitted entirely (never rendered empty).
 * `availableCommands` may be `undefined`/empty — the catalog degrades
 * gracefully to the client section alone (B degrades to A, the documented
 * Fedora-probe fallback).
 */
export function buildSlashSections(
  availableCommands: SlashCommandInfo[] | undefined,
  query: string,
): SuggestSection<SlashTemplate | AgentSlashItem>[] {
  const commands = SLASH_TEMPLATES.filter((t) => matches(query, t.id, t.label));

  const agent: AgentSlashItem[] = [];
  for (const c of availableCommands ?? []) {
    if (TEMPLATE_IDS.has(c.name)) {
      // collision — client template wins, hidden not duplicated (§3.2 "hidden + logged")
      console.warn(`slash: hiding agent command "/${c.name}" — collides with a client template`);
      continue;
    }
    if (!matches(query, c.name, `/${c.name}`)) continue;
    agent.push({ id: c.name, name: c.name, label: `/${c.name}`, hint: c.description, icon: 'terminal' });
  }

  const sections: SuggestSection<SlashTemplate | AgentSlashItem>[] = [];
  if (commands.length > 0) sections.push({ heading: 'Commands', items: commands });
  if (agent.length > 0) sections.push({ heading: 'Agent', items: agent });
  return sections;
}
