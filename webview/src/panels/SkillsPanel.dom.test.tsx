/**
 * V-11 TOGGLE-HONESTY — DOM-level wiring proof for `SkillsPanel`.
 *
 * Scope discipline (`docs/testing/dom-tests.md`): these assert WIRING — that a
 * rejection reaches the screen through the `LiveRegion`, that a settled toggle
 * actually lets a later disagreeing `serverValue` push win. The DECISIONS
 * themselves (the `settledSeq`/`lastError`/`reconcileToggle` transitions) are
 * pure-tested in `useToggle.test.ts` and stay there.
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubInstallResult, HubPreview, HubScan, SkillsData } from '../protocol';
import { SkillsPanel } from './SkillsPanel';
import { must } from '../testing/must';

function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

/** Task B6: extended with a `provenance: 'hub'` row (§Task B6) — the row the
 *  hub-Remove-button tests exercise, alongside the pre-existing plain
 *  `web-search` row every earlier test in this file already keys off. */
function skillsData(enabled: boolean): SkillsData {
  return {
    skills: [
      {
        id: 'web-search',
        name: 'web-search',
        category: 'research',
        description: 'Search the web for current information.',
        enabled,
      },
      {
        id: 'pdf-tools',
        name: 'pdf-tools',
        category: 'official/pdf',
        description: 'PDF utilities installed from the skill hub.',
        enabled: true,
        provenance: 'hub',
        usage: 3,
      },
    ],
    categories: ['research', 'official/pdf'],
  };
}

const noop = () => undefined;

/** A request issued and never answered — the only honest model of "the user's
 *  toggle is STILL IN FLIGHT at the instant a host push lands". Resolving it
 *  would settle the row through confirm/rollback and destroy the race. */
const neverSettles = () => new Promise<unknown>(() => undefined);

/* Task B6: stub admin handlers for the pre-existing toggle-only tests below,
 * now that `SkillsPanelProps` carries the full Create/Install-from-hub/
 * hub-Remove surface — none of those tests exercise this new surface, so
 * trivial resolves are enough to satisfy the (required, non-optional — every
 * real caller always provides them) prop contract. Same posture as
 * `McpPanel.dom.test.tsx`'s `noopMcpAdminProps()`. */
function noopSkillsAdminProps() {
  return {
    onCreate: async () => ({ ok: true }),
    onHubPreview: async (identifier: string): Promise<HubPreview> => ({
      name: 'x',
      description: '',
      source: 'x',
      identifier,
      trust_level: 'trusted',
      skill_md: '',
      files: [],
    }),
    onHubScan: async (identifier: string): Promise<HubScan> => ({
      name: 'x',
      identifier,
      source: 'x',
      trust_level: 'trusted',
      verdict: 'safe' as const,
      summary: '',
      policy: 'allow' as const,
      policy_reason: '',
      findings: [],
      severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
    }),
    onHubInstall: async (identifier: string): Promise<HubInstallResult> => ({ ok: true as const, name: identifier }),
    onHubUninstall: async () => ({ ok: true }),
  };
}

describe('SkillsPanel V-11 TOGGLE-HONESTY', () => {
  it('a rejected toggle rolls the switch back AND announces the reason through a live region', async () => {
    const onToggle = () => Promise.reject(new Error('dashboard unreachable'));
    const { user } = setup(
      <SkillsPanel data={skillsData(true)} onToggle={onToggle} onRefresh={noop} {...noopSkillsAdminProps()} />,
    );

    const toggle = screen.getByRole('switch', { name: 'Enable web-search' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);

    // Today (pre-fix) this text never appears anywhere — the rollback is silent.
    expect(await screen.findByText('Not saved: dashboard unreachable')).toBeInTheDocument();
    expect(toggle, 'the switch rolls back to the live server value on rejection').toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('an IN-FLIGHT toggle stands against a disagreeing serverValue push (never clobbered while pending)', async () => {
    const { user, rerender } = setup(
      <SkillsPanel data={skillsData(false)} onToggle={neverSettles} onRefresh={noop} {...noopSkillsAdminProps()} />,
    );
    const toggle = () => screen.getByRole('switch', { name: 'Enable web-search' });

    await user.click(toggle()); // optimistic ON; the request never answers
    expect(toggle()).toHaveAttribute('aria-checked', 'true');

    // A host push lands while our own toggle is still in flight — the server
    // side still disagrees (still reports false).
    rerender(
      <SkillsPanel data={skillsData(false)} onToggle={neverSettles} onRefresh={noop} {...noopSkillsAdminProps()} />,
    );

    expect(
      toggle(),
      'an in-flight optimistic value must never be clobbered by a push — only a SETTLED op may reconcile',
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('once a toggle has SETTLED, a later disagreeing serverValue push wins — the mask is gone', async () => {
    let resolveToggle: (() => void) | undefined;
    const onToggle = () => new Promise<void>((res) => { resolveToggle = res; });
    const { user, rerender } = setup(
      <SkillsPanel data={skillsData(false)} onToggle={onToggle} onRefresh={noop} {...noopSkillsAdminProps()} />,
    );
    const toggle = () => screen.getByRole('switch', { name: 'Enable web-search' });

    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-checked', 'true'); // optimistic, still in flight

    resolveToggle?.(); // the persist actually succeeds — the toggle SETTLES

    // Another editor then turned it back off — server truth is false again.
    // Today (pre-fix) `overrides[id]` never expires once confirmed, so this
    // push would be masked forever and the switch would stay stuck ON.
    await waitFor(() => {
      rerender(
        <SkillsPanel data={skillsData(false)} onToggle={onToggle} onRefresh={noop} {...noopSkillsAdminProps()} />,
      );
      expect(
        toggle(),
        'once settled, a later disagreeing serverValue push must win over a confirmed optimistic value',
      ).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('TG-4 (AU-54), was beta.7 C3: the persist note renders ABOVE every skill row — a panel-level note, not the last group’s caption', () => {
    const data: SkillsData = {
      skills: [
        {
          id: 'web-search',
          name: 'web-search',
          category: 'research',
          description: 'Search the web for current information.',
          enabled: true,
        },
        {
          id: 'code-review',
          name: 'code-review',
          category: 'engineering',
          description: 'Review code for issues.',
          enabled: true,
        },
      ],
      categories: ['research', 'engineering'],
    };
    setup(
      <SkillsPanel data={data} onToggle={async () => undefined} onRefresh={noop} {...noopSkillsAdminProps()} />,
    );
    // TG-4 (AU-54, INV-18, Rev-1 B6): adopts the ONE canonical effect-latency
    // sentence shared with the MCP admin notices — an intentional, announced
    // copy change from the shipped C3 wording ("...apply to new sessions; a
    // chat already running may keep its current skills until its next
    // session."), not accidental drift. Generic "setup" replaces the
    // skills-specific "skills" tail deliberately — one string everywhere.
    const note = screen.getByText(
      'Toggles persist immediately. Takes effect in new chats; chats already open keep their current setup.',
    );
    const firstToggle = screen.getByRole('switch', { name: 'Enable web-search' });
    const lastToggle = screen.getByRole('switch', { name: 'Enable code-review' });
    expect(note.compareDocumentPosition(firstToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(lastToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/*
 * Task B6 (§5.6): the Create-skill disclosure, the Install-from-hub
 * disclosure (Check -> preview+scan card -> Install), and the hub-row
 * Remove button. Same harness as the V-11 tests above (`render`/`screen`/
 * `waitFor` + `userEvent`), `skillsData()`'s extended fixture (a plain
 * `web-search` row + a `provenance: 'hub'` `pdf-tools` row).
 */
describe('B6: SkillsPanel Create + Install-from-hub + hub-row Remove', () => {
  it('the Check flow fires BOTH onHubPreview and onHubScan and renders the trust + verdict pills from the resolved result', async () => {
    const user = userEvent.setup();
    const previewed: string[] = [];
    const scanned: string[] = [];
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onHubPreview={async (identifier) => {
          previewed.push(identifier);
          return {
            name: 'pdf',
            description: 'PDF utilities.',
            source: 'github',
            identifier,
            trust_level: 'trusted',
            skill_md: '# PDF skill\n\ndoes pdf things',
            files: ['SKILL.md'],
          };
        }}
        onHubScan={async (identifier) => {
          scanned.push(identifier);
          return {
            name: 'pdf',
            identifier,
            source: 'github',
            trust_level: 'trusted',
            verdict: 'caution',
            summary: 'One low finding.',
            policy: 'allow',
            policy_reason: '',
            findings: [{ severity: 'low', category: 'network', file: 'a.py', line: 3, description: 'net call' }],
            severity_counts: { critical: 0, high: 0, medium: 0, low: 1 },
          };
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Install from hub/i }));
    await user.type(screen.getByLabelText(/Identifier/i), 'anthropics/skills/pdf');
    await user.click(screen.getByRole('button', { name: /^Check$/i }));

    await screen.findByText('pdf');
    await waitFor(() => expect(previewed).toEqual(['anthropics/skills/pdf']));
    await waitFor(() => expect(scanned).toEqual(['anthropics/skills/pdf']));
    expect(screen.getByText('trusted')).toBeInTheDocument();
    expect(screen.getByText('caution')).toBeInTheDocument();
  });

  it('Install stays disabled while onHubInstall is pending (neverSettles)', async () => {
    const user = userEvent.setup();
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onHubInstall={() => new Promise<HubInstallResult>(() => undefined)}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Install from hub/i }));
    await user.type(screen.getByLabelText(/Identifier/i), 'anthropics/skills/pdf');
    await user.click(screen.getByRole('button', { name: /^Check$/i }));
    await screen.findByText('x'); // the noop preview/scan fixture's name

    const install = screen.getByRole('button', { name: /^Install$/i });
    expect(install).not.toBeDisabled();
    await user.click(install);

    expect(await screen.findByText('Installing…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Installing…/i })).toBeDisabled();
  });

  it('AU-58 (INV-18): a successful hub-install notice states the effect-latency copy — installing a skill affects only future sessions, not chats already open', async () => {
    const user = userEvent.setup();
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onHubInstall={async (identifier) => ({ ok: true as const, name: identifier })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Install from hub/i }));
    await user.type(screen.getByLabelText(/Identifier/i), 'anthropics/skills/pdf');
    await user.click(screen.getByRole('button', { name: /^Check$/i }));
    await screen.findByText('x'); // the noop preview/scan fixture's name
    await user.click(screen.getByRole('button', { name: /^Install$/i }));

    // RED today: the notice reads only `Installed "anthropics/skills/pdf".` —
    // nothing tells the user the skill only takes effect in a NEW chat, same
    // gap TG-2 closed for the MCP catalog-install notice. Two matches is the
    // expected, correct outcome — the sr-only LiveRegion announcement and the
    // sighted-user card both carry the same text (`HubNoticeCard`).
    await waitFor(() =>
      expect(
        screen.getAllByText(
          'Installed "anthropics/skills/pdf". Takes effect in new chats; chats already open keep their current setup.',
        ),
      ).toHaveLength(2),
    );
  });

  it('TH-1 (AU-37): editing the identifier after Check makes Install stale — it must not install against a mismatched result, and the allowlist hint returns', async () => {
    const user = userEvent.setup();
    const installed: string[] = [];
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onHubPreview={async (identifier) => ({
          name: identifier,
          description: '',
          source: 'github',
          identifier,
          trust_level: 'trusted',
          skill_md: '',
          files: [],
        })}
        onHubScan={async (identifier) => ({
          name: identifier,
          identifier,
          source: 'github',
          trust_level: 'trusted',
          verdict: 'safe',
          summary: '',
          policy: 'allow',
          policy_reason: '',
          findings: [],
          severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
        })}
        onHubInstall={async (identifier) => {
          installed.push(identifier);
          return { ok: true as const, name: identifier };
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Install from hub/i }));
    const input = screen.getByLabelText(/Identifier/i);
    // an untrusted-prefix identifier so the allowlist hint is in play.
    await user.type(input, 'myorg/tools/a');
    await user.click(screen.getByRole('button', { name: /^Check$/i }));

    await screen.findByText('myorg/tools/a'); // the resolved preview name === identifier A
    // Check succeeded against a trusted-looking result — the hint is gone.
    expect(screen.queryByText(/Only official or trusted publishers/i)).not.toBeInTheDocument();

    // Edit the field to a DIFFERENT identifier WITHOUT re-running Check —
    // the card still shows A's verdict.
    await user.clear(input);
    await user.type(input, 'myorg/tools/b');

    const install = screen.getByRole('button', { name: /^Install$/i });
    expect(install, 'a stale result must disable Install natively (indefinite, not in-flight)').toBeDisabled();
    expect(install).toHaveAttribute('title', expect.stringMatching(/run Check again/i));

    // Belt-and-suspenders: clicking the (disabled) button must not fire onHubInstall with B.
    await user.click(install);
    expect(installed, "must NOT install against B while the shown verdict was computed for A").toEqual([]);

    expect(screen.getByText(/Identifier changed.*Run Check again/i)).toBeInTheDocument();
    // the allowlist hint returns once the shown result no longer matches the typed identifier.
    expect(screen.getByText(/Only official or trusted publishers/i)).toBeInTheDocument();

    // Companion (not over-broad): editing BACK to the identifier Check ran for
    // makes the result fresh again — Install fires normally with A.
    await user.clear(input);
    await user.type(input, 'myorg/tools/a');
    expect(screen.getByRole('button', { name: /^Install$/i })).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^Install$/i }));
    await waitFor(() => expect(installed).toEqual(['myorg/tools/a']));
  });

  it('TH-2 (AU-38): a fresh scan result surfaces summary, policy verdict + reason, and severity counts — not just a bare finding count', async () => {
    const user = userEvent.setup();
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onHubScan={async (identifier) => ({
          name: identifier,
          identifier,
          source: 'github',
          trust_level: 'trusted',
          verdict: 'caution',
          summary: 'Two findings need review before install.',
          policy: 'ask',
          policy_reason: 'Requests outbound network access from an unverified publisher.',
          findings: [
            {
              severity: 'high',
              category: 'network',
              file: 'src/fetch.py',
              line: 12,
              description: 'Makes an outbound HTTP call.',
            },
            {
              severity: 'low',
              category: 'filesystem',
              file: 'src/util.py',
              line: 3,
              description: 'Reads a local config file.',
            },
          ],
          severity_counts: { critical: 0, high: 1, medium: 0, low: 1 },
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Install from hub/i }));
    await user.type(screen.getByLabelText(/Identifier/i), 'anthropics/skills/pdf');
    await user.click(screen.getByRole('button', { name: /^Check$/i }));

    // RED today: only a Pill + "2 finding(s)" render — the summary/policy
    // reason/per-bucket counts are dropped entirely.
    await screen.findByText('Two findings need review before install.');
    expect(screen.getByText('ask')).toBeInTheDocument();
    expect(
      screen.getByText('Requests outbound network access from an unverified publisher.'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 high · 1 low')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ findings?$/)).not.toBeInTheDocument();

    // The findings themselves stay collapsed until the chevron is opened —
    // same disclosure grammar as the SKILL.md preview in this same card.
    expect(screen.queryByText('Makes an outbound HTTP call.')).not.toBeInTheDocument();
    const findingsToggle = screen.getByRole('button', { name: /Findings \(2\)/i });
    expect(findingsToggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(findingsToggle);
    expect(findingsToggle).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getByText('network')).toBeInTheDocument();
    expect(screen.getByText('src/fetch.py:12')).toBeInTheDocument();
    expect(screen.getByText('Makes an outbound HTTP call.')).toBeInTheDocument();
    expect(screen.getByText('filesystem')).toBeInTheDocument();
    expect(screen.getByText('src/util.py:3')).toBeInTheDocument();
    expect(screen.getByText('Reads a local config file.')).toBeInTheDocument();
  });

  it('TH-2 (AU-38): an all-clear scan (zero severity_counts) renders an honest "No findings" line, not a blank', async () => {
    const user = userEvent.setup();
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onHubScan={async (identifier) => ({
          name: identifier,
          identifier,
          source: 'github',
          trust_level: 'trusted',
          verdict: 'safe',
          summary: 'No issues detected.',
          policy: 'allow',
          policy_reason: '',
          findings: [],
          severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Install from hub/i }));
    await user.type(screen.getByLabelText(/Identifier/i), 'anthropics/skills/pdf');
    await user.click(screen.getByRole('button', { name: /^Check$/i }));

    await screen.findByText('No issues detected.');
    expect(screen.getByText('No findings')).toBeInTheDocument();
  });

  it('a provenance:"hub" row shows Remove and firing it calls onHubUninstall(name); the non-hub row never gets one', async () => {
    const user = userEvent.setup();
    const uninstalled: string[] = [];
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onHubUninstall={async (name) => {
          uninstalled.push(name);
          return { ok: true };
        }}
      />,
    );

    // Exactly one Remove button — only the hub-provenance 'pdf-tools' row.
    const removeButtons = screen.getAllByRole('button', { name: /^Remove$/i });
    expect(removeButtons).toHaveLength(1);

    await user.click(must(removeButtons[0]));
    await waitFor(() => expect(uninstalled).toEqual(['pdf-tools']));
  });

  it('the Create-skill form fires onCreate with {name, content, category?}, seeded content, and a submitting state', async () => {
    const user = userEvent.setup();
    const created: Array<{ name: string; content: string; category?: string }> = [];
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onCreate={async (params) => {
          created.push(params);
          return { ok: true };
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Create skill/i }));
    await user.type(screen.getByLabelText(/^Name$/i), 'my-skill');
    await user.type(screen.getByLabelText(/Category/i), 'research');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => expect(created).toHaveLength(1));
    const params = must(created[0]);
    expect(params.name).toBe('my-skill');
    expect(params.category).toBe('research');
    expect(params.content.startsWith('---\nname: my-skill\n')).toBe(true);
  });

  it('a declined/rejected create surfaces a neutral notice instead of crashing', async () => {
    const user = userEvent.setup();
    render(
      <SkillsPanel
        data={skillsData(true)}
        onToggle={async () => undefined}
        onRefresh={noop}
        {...noopSkillsAdminProps()}
        onCreate={async () => {
          throw new Error('Creating skill "my-skill" was declined or cancelled.');
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Create skill/i }));
    await user.type(screen.getByLabelText(/^Name$/i), 'my-skill');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    // The notice renders through BOTH the sr-only LiveRegion and the
    // sighted-user card (same by-design duplication `McpPanel.dom.test.tsx`
    // already documents for its own row notices) — two matches is correct.
    await waitFor(() =>
      expect(screen.getAllByText('Creating skill "my-skill" was declined or cancelled.')).toHaveLength(2),
    );
  });
});
