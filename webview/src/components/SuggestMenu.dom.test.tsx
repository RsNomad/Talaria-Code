/*
 * B4 (UI M-2 + M-9) / path doc §4 B4 — SuggestMenu's popup markup gains
 * stable option `id`s so the composer textarea's `aria-activedescendant` can
 * point assistive tech at the visually-focused option while DOM focus stays
 * on the textarea (APG combobox — DOM focus stays on the input,
 * aria-activedescendant names the visually-focused option, options carry ids:
 * https://www.w3.org/WAI/ARIA/apg/patterns/combobox/, fetched this task).
 * `idBase` is per-instance ('mention' | 'filepick' | 'slash' — Composer.tsx
 * has THREE independent popups sharing this one component) so the three
 * popups never collide on ids. `activeOptionId` is the pure id formula the
 * composer's `aria-activedescendant` is built from — it MUST match what this
 * component actually renders for a given index, proven below for both the
 * flat `items` shape (mention/filePick) and the sectioned `sections` shape
 * (slash), where the running index must NOT reset per section.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SuggestMenu, activeOptionId, type SuggestItem, type SuggestSection } from './SuggestMenu';

const ALPHA: SuggestItem = { id: 'a', label: 'Alpha', hint: 'first', icon: 'file' };
const BRAVO: SuggestItem = { id: 'b', label: 'Bravo', hint: 'second', icon: 'file' };
const CHARLIE: SuggestItem = { id: 'c', label: 'Charlie', hint: 'third', icon: 'file' };
const ITEMS: SuggestItem[] = [ALPHA, BRAVO, CHARLIE];

describe('B4: SuggestMenu option ids', () => {
  it('gives the listbox id={idBase} and each option a stable, sequential, role=option id', () => {
    render(
      <SuggestMenu
        idBase="mention"
        ariaLabel="Insert a reference"
        heading="Reference"
        items={ITEMS}
        activeIndex={1}
        onPick={() => undefined}
      />,
    );
    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveAttribute('id', 'mention');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.id)).toEqual(['mention-opt-0', 'mention-opt-1', 'mention-opt-2']);
  });

  it('activeOptionId(idBase, index) resolves to the id of a REAL rendered option element', () => {
    render(
      <SuggestMenu
        idBase="mention"
        ariaLabel="Insert a reference"
        heading="Reference"
        items={ITEMS}
        activeIndex={1}
        onPick={() => undefined}
      />,
    );
    const id = activeOptionId('mention', 1);
    expect(id).toBe('mention-opt-1');
    const el = document.getElementById(id);
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute('role', 'option');
    expect(el).toHaveTextContent('Bravo');
  });

  it('sectioned popups (the slash shape) keep ONE running index across sections, not per-section', () => {
    const sections: SuggestSection<SuggestItem>[] = [
      { heading: 'Commands', items: [ALPHA, BRAVO] },
      { heading: 'Agent', items: [CHARLIE] },
    ];
    render(
      <SuggestMenu
        idBase="slash"
        ariaLabel="Slash commands"
        sections={sections}
        activeIndex={2}
        onPick={() => undefined}
      />,
    );
    // Charlie is the 3rd item overall (flat index 2) despite being the 1st
    // item of the 2nd section — the id numbering must follow the FLAT order
    // `activeIndex` is expressed in (useSuggest's reducer), not a per-section
    // restart.
    const id = activeOptionId('slash', 2);
    expect(id).toBe('slash-opt-2');
    const el = document.getElementById(id);
    expect(el).not.toBeNull();
    expect(el).toHaveTextContent('Charlie');
  });

  it('a different idBase never collides with another popup’s ids', () => {
    render(
      <SuggestMenu
        idBase="filepick"
        ariaLabel="File search"
        items={ITEMS}
        activeIndex={0}
        onPick={() => undefined}
      />,
    );
    expect(document.getElementById('mention-opt-0')).toBeNull();
    expect(document.getElementById('filepick-opt-0')).not.toBeNull();
  });
});

/**
 * B5 (audit-3 UI/UX M-2): options are never real Tab stops in the APG
 * combobox pattern — DOM focus stays on the owning textarea the whole time,
 * and the visually-"focused" option is only ever communicated via
 * `aria-activedescendant` ("DOM focus is maintained on the combobox... the
 * assistive technology focus is moved within the listbox using
 * aria-activedescendant", https://www.w3.org/WAI/ARIA/apg/patterns/combobox/,
 * fetched this task). Without `tabIndex={-1}` every `role="option"` button is
 * an ordinary Tab stop, so a sighted keyboard user tabbing through the page
 * lands on menu rows the combobox contract says should be unreachable by Tab.
 */
describe('B5: SuggestMenu options are not Tab stops (APG combobox)', () => {
  it('every role="option" element has tabIndex={-1}', () => {
    render(
      <SuggestMenu
        idBase="mention"
        ariaLabel="Insert a reference"
        heading="Reference"
        items={ITEMS}
        activeIndex={1}
        onPick={() => undefined}
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    for (const option of options) {
      expect(option).toHaveAttribute('tabindex', '-1');
    }
  });
});
