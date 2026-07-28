/*
 * B4 (UI M-2 + M-9) / path doc §4 B4 — the composer textarea drives the APG
 * combobox contract for whichever of the THREE SuggestMenu popups (mention
 * `@`, filePick `@file:`/`@folder:`, slash `/`) is currently open. Grounding
 * (fetched this task, W3C APG): "DOM focus is maintained on the combobox and
 * the assistive technology focus is moved within the listbox using
 * aria-activedescendant" — the textarea itself never loses DOM focus; role,
 * aria-expanded, aria-controls, aria-activedescendant, aria-autocomplete
 * live on it (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
 *
 * Before this task none of role/aria-expanded/aria-controls/
 * aria-activedescendant/aria-autocomplete existed on the textarea at all —
 * every assertion below is RED against the pre-B4 component.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';
import type { Attachment, ContextRef, SlashCommandInfo } from '../protocol';
import type { ComposerSeed } from '../composer/applySeed';

/** Narrows a possibly-absent attribute, failing the test with a clear message
 * instead of silently comparing against `null` (or spraying `!`). */
function requireAttr(el: Element, name: string): string {
  const value = el.getAttribute(name);
  if (value === null) throw new Error(`expected attribute "${name}" to be present on ${el.outerHTML}`);
  return value;
}

/** A real, stateful draft (matches how `App.tsx` actually drives Composer) —
 * required so typing `@`/`/` in the textarea genuinely opens a popup;
 * `Composer`'s `draft` is a controlled prop, not internal state. */
function StatefulComposer(props: {
  searchFiles?: (query: string, maxResults?: number) => Promise<string[]>;
  availableCommands?: SlashCommandInfo[];
}) {
  const [draft, setDraft] = useState('');
  return (
    <Composer
      tabId="tab-1"
      draft={draft}
      draftAttachments={[]}
      onDraftChange={setDraft}
      onAttachAdd={(_a: Attachment) => undefined}
      onAttachRemove={() => undefined}
      preset="normal"
      modelLabel="test-model"
      busy={false}
      disabled={false}
      activeModeId={null}
      availableModes={[]}
      onSetMode={async () => undefined}
      initialHeight={120}
      onHeightChange={() => undefined}
      onSubmit={(_text: string, _attachments?: Attachment[], _mentions?: ContextRef[]) => undefined}
      onCancel={() => undefined}
      onSetPreset={async () => undefined}
      onPickModel={() => undefined}
      onNewSession={() => undefined}
      availableCommands={props.availableCommands ?? []}
      searchFiles={props.searchFiles ?? (async () => [])}
      pendingSeed={null as ComposerSeed | null}
      onSeedApplied={() => undefined}
    />
  );
}

function getTextarea(): HTMLElement {
  return screen.getByPlaceholderText(/Ask Talaria/);
}

describe('B4: composer textarea is an APG combobox — collapsed state', () => {
  it('is role=combobox, aria-autocomplete=list, collapsed, with no controls/activedescendant', () => {
    render(<StatefulComposer />);
    const textarea = getTextarea();

    expect(textarea).toHaveAttribute('role', 'combobox');
    expect(textarea).toHaveAttribute('aria-autocomplete', 'list');
    expect(textarea).toHaveAttribute('aria-expanded', 'false');
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
  });
});

describe('B4: @ mention popup', () => {
  it('expands the combobox, controls the mention listbox, and activedescendant follows ArrowDown to a real option', async () => {
    const user = userEvent.setup();
    render(<StatefulComposer />);
    const textarea = getTextarea();

    await user.type(textarea, '@');

    expect(textarea).toHaveAttribute('aria-expanded', 'true');
    expect(textarea).toHaveAttribute('aria-controls', 'mention');
    const firstId = requireAttr(textarea, 'aria-activedescendant');
    expect(firstId).toBe('mention-opt-0');
    expect(document.getElementById(firstId)).not.toBeNull();

    await user.keyboard('{ArrowDown}');

    const secondId = requireAttr(textarea, 'aria-activedescendant');
    expect(secondId).toBe('mention-opt-1');
    const optionEl = document.getElementById(secondId);
    expect(optionEl).not.toBeNull();
    expect(optionEl).toHaveAttribute('role', 'option');

    // Escape closes the popup — the combobox collapses back to its resting state.
    await user.keyboard('{Escape}');
    expect(textarea).toHaveAttribute('aria-expanded', 'false');
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
  });
});

describe('B4: / slash popup', () => {
  it('controls the slash listbox and activedescendant follows ArrowDown to a real option', async () => {
    const user = userEvent.setup();
    render(<StatefulComposer />);
    const textarea = getTextarea();

    await user.type(textarea, '/');

    expect(textarea).toHaveAttribute('aria-expanded', 'true');
    expect(textarea).toHaveAttribute('aria-controls', 'slash');
    expect(requireAttr(textarea, 'aria-activedescendant')).toBe('slash-opt-0');

    await user.keyboard('{ArrowDown}');

    const id = requireAttr(textarea, 'aria-activedescendant');
    expect(id).toBe('slash-opt-1');
    const optionEl = document.getElementById(id);
    expect(optionEl).not.toBeNull();
    expect(optionEl).toHaveAttribute('role', 'option');
    expect(optionEl).toHaveTextContent('/test');
  });
});

describe('B4: @file: filePick popup — the third popup the draft missed', () => {
  it('is expanded with aria-controls=filepick but NO activedescendant while zero options are rendered (loading), then activedescendant names the real resolved option', async () => {
    const user = userEvent.setup();
    const searchFiles = vi.fn(async () => ['src/foo.ts', 'src/bar.ts']);
    render(<StatefulComposer searchFiles={searchFiles} />);
    const textarea = getTextarea();

    await user.type(textarea, '@file:');

    // The submenu is open (aria-controls wired to its listbox) before the
    // debounced search resolves, but it renders ZERO `role="option"` rows
    // ("Searching…"). An aria-activedescendant naming a nonexistent id is
    // itself an a11y bug, so it must be ABSENT here — not a phantom
    // 'filepick-opt-0'.
    await waitFor(() => expect(textarea).toHaveAttribute('aria-expanded', 'true'));
    expect(textarea).toHaveAttribute('aria-controls', 'filepick');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(textarea).not.toHaveAttribute('aria-activedescendant');

    // Once the debounced search resolves, the option exists and
    // activedescendant names it.
    await waitFor(() => expect(searchFiles).toHaveBeenCalled());
    await waitFor(() => expect(requireAttr(textarea, 'aria-activedescendant')).toBe('filepick-opt-0'));

    const id = requireAttr(textarea, 'aria-activedescendant');
    const optionEl = document.getElementById(id);
    expect(optionEl).not.toBeNull();
    expect(optionEl).toHaveAttribute('role', 'option');
    expect(optionEl).toHaveTextContent('foo.ts');
  });
});
