import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Composer } from './Composer';
import type { ComposerSeed } from '../composer/applySeed';
import type { Attachment, CustomModeInfo, EditPolicyPreset } from '../protocol';

/**
 * Audit C-3 (Critical). `pendingSeed` was never reset, and the Composer's
 * effect keys on the seed's OBJECT IDENTITY — so it also fires on MOUNT. The
 * Composer unmounts whenever the user leaves the chat panel, so returning to
 * chat re-applied the same seed; and `onDraftChange` is bound to the ACTIVE
 * tab, so a tab switch in between delivered the text to another conversation.
 */
function renderComposer(props: {
  tabId: string;
  draft: string;
  pendingSeed: ComposerSeed | null;
  onDraftChange: (text: string) => void;
  onSeedApplied: (seed: ComposerSeed) => void;
}) {
  return render(
    <Composer
      tabId={props.tabId}
      draft={props.draft}
      draftAttachments={[]}
      onDraftChange={props.onDraftChange}
      onAttachAdd={() => undefined}
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
      onSubmit={async () => undefined}
      onCancel={() => undefined}
      onSetPreset={async () => undefined}
      onPickModel={() => undefined}
      onNewSession={() => undefined}
      availableCommands={[]}
      searchFiles={async () => []}
      pendingSeed={props.pendingSeed}
      onSeedApplied={props.onSeedApplied}
    />,
  );
}

describe('C-3: a composer seed is applied exactly once, to the tab it was minted for', () => {
  it('applies the seed and reports it as consumed', () => {
    const drafts: string[] = [];
    const consumed: ComposerSeed[] = [];
    const seed: ComposerSeed = { tabId: 'tab-1', text: 'Explain this', mentions: [] };

    renderComposer({
      tabId: 'tab-1',
      draft: '',
      pendingSeed: seed,
      onDraftChange: (t) => drafts.push(t),
      onSeedApplied: (s) => consumed.push(s),
    });

    expect(drafts).toEqual(['Explain this']);
    expect(consumed).toEqual([seed]);
  });

  it('a REMOUNT with the same seed object does not apply it a second time', () => {
    const drafts: string[] = [];
    const seed: ComposerSeed = { tabId: 'tab-1', text: 'Explain this', mentions: [] };
    const noop = () => undefined;

    const first = renderComposer({
      tabId: 'tab-1',
      draft: '',
      pendingSeed: seed,
      onDraftChange: (t) => drafts.push(t),
      onSeedApplied: noop,
    });
    first.unmount();

    // Leaving the chat panel and returning unmounts and remounts the Composer
    // (App.tsx:515). The seed has already been applied; the draft now holds it.
    renderComposer({
      tabId: 'tab-1',
      draft: 'Explain this',
      pendingSeed: seed,
      onDraftChange: (t) => drafts.push(t),
      onSeedApplied: noop,
    });

    // Exactly one application, not two. `applySeed` APPENDS to a non-empty
    // draft, so a second application would produce 'Explain this\n\nExplain this'.
    expect(drafts).toEqual(['Explain this']);
  });

  it('a seed minted for ANOTHER tab is ignored entirely', () => {
    const drafts: string[] = [];
    const consumed: ComposerSeed[] = [];

    renderComposer({
      tabId: 'tab-2',
      draft: 'my other conversation',
      pendingSeed: { tabId: 'tab-1', text: 'Explain this', mentions: [] },
      onDraftChange: (t) => drafts.push(t),
      onSeedApplied: (s) => consumed.push(s),
    });

    expect(drafts).toEqual([]);
    expect(consumed).toEqual([]);
  });

  it('the composer still renders its textarea (the harness is really mounting it)', () => {
    renderComposer({
      tabId: 'tab-1',
      draft: '',
      pendingSeed: null,
      onDraftChange: () => undefined,
      onSeedApplied: () => undefined,
    });
    // B4 (UI M-2 + M-9): the textarea is an APG combobox (`role="combobox"`)
    // now, not the implicit `textbox` role — see `Composer.combobox.dom.test.tsx`.
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});

/**
 * A2 (path doc §2.1/§3): the oversize-attachment path and the FileReader
 * `onerror` path both fail *silently* today — oversize only logs via
 * `console.warn` (Composer.tsx's `addFiles`) and `reader.onerror` is never
 * assigned at all. Both must surface a user-visible, screen-reader-announced
 * notice through a POLITE `LiveRegion` (permanently mounted above the
 * toolbar — Finding-7 mounted-empty discipline), and neither failure may
 * call `onAttachAdd`.
 */
function renderComposerForAttachments(onAttachAdd: (a: Attachment) => void) {
  return render(
    <Composer
      tabId="tab-1"
      draft=""
      draftAttachments={[]}
      onDraftChange={() => undefined}
      onAttachAdd={onAttachAdd}
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
      onSubmit={async () => undefined}
      onCancel={() => undefined}
      onSetPreset={async () => undefined}
      onPickModel={() => undefined}
      onNewSession={() => undefined}
      availableCommands={[]}
      searchFiles={async () => []}
      pendingSeed={null}
      onSeedApplied={() => undefined}
    />,
  );
}

/** The hidden generic-file `<input type="file">` (`fileInputRef`, no `accept`
 * attribute) — distinct from the image-only input (`accept="image/*"`). */
function getGenericFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]:not([accept])');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('generic file <input> not found');
  }
  return input;
}

describe('A2 (UI I-9): oversized/unreadable attachments surface a live-region notice', () => {
  it('the notice region is mounted (empty) from the start — Finding-7 discipline', () => {
    const { getByRole } = renderComposerForAttachments(() => undefined);

    expect(getByRole('status')).toHaveTextContent('');
  });

  it('an oversized file is skipped AND the notice names it (was console.warn-only)', () => {
    const added: Attachment[] = [];
    const { container, getByRole } = renderComposerForAttachments((a) => added.push(a));

    // Composer.tsx: MAX_FILE_BYTES (generic-file cap) is 512 * 1024.
    const oversizedBytes = 512 * 1024 + 1;
    const bigFile = new File([new Uint8Array(oversizedBytes)], 'huge.txt', { type: 'text/plain' });

    fireEvent.change(getGenericFileInput(container), { target: { files: [bigFile] } });

    expect(getByRole('status')).toHaveTextContent(/huge\.txt/);
    expect(added).toEqual([]);
  });

  it("a FileReader error is skipped AND the notice names it (today's failure is fully silent)", async () => {
    const added: Attachment[] = [];
    const originalFileReader = globalThis.FileReader;

    /** Minimal FileReader double that always fails — the production code
     * assigns both `onload` and (after this task) `onerror`; this double
     * only ever drives the error path. */
    class FailingFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: string | ArrayBuffer | null = null;
      readAsDataURL(): void {
        queueMicrotask(() => this.onerror?.());
      }
    }
    globalThis.FileReader = FailingFileReader as unknown as typeof FileReader;

    try {
      const { container, getByRole } = renderComposerForAttachments((a) => added.push(a));
      const smallFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });

      fireEvent.change(getGenericFileInput(container), { target: { files: [smallFile] } });

      await waitFor(() => expect(getByRole('status')).toHaveTextContent(/notes\.txt/));
      expect(added).toEqual([]);
    } finally {
      globalThis.FileReader = originalFileReader;
    }
  });

  it('a dismissible "x" clears the notice and is announced by an accessible name', () => {
    const { container, getByRole, queryByRole } = renderComposerForAttachments(() => undefined);
    const oversizedBytes = 512 * 1024 + 1;
    const bigFile = new File([new Uint8Array(oversizedBytes)], 'huge.txt', { type: 'text/plain' });

    fireEvent.change(getGenericFileInput(container), { target: { files: [bigFile] } });
    expect(getByRole('status')).toHaveTextContent(/huge\.txt/);

    fireEvent.click(getByRole('button', { name: 'Dismiss attachment notice' }));

    // The region stays mounted (Finding-7) — only its text clears.
    expect(getByRole('status')).toHaveTextContent('');
    expect(queryByRole('button', { name: 'Dismiss attachment notice' })).not.toBeInTheDocument();
  });

  it('a subsequent successful attach clears a stale oversize notice', () => {
    const added: Attachment[] = [];
    const { container, getByRole } = renderComposerForAttachments((a) => added.push(a));
    const oversizedBytes = 512 * 1024 + 1;
    const bigFile = new File([new Uint8Array(oversizedBytes)], 'huge.txt', { type: 'text/plain' });
    fireEvent.change(getGenericFileInput(container), { target: { files: [bigFile] } });
    expect(getByRole('status')).toHaveTextContent(/huge\.txt/);

    const okFile = new File(['ok'], 'small.txt', { type: 'text/plain' });
    fireEvent.change(getGenericFileInput(container), { target: { files: [okFile] } });

    expect(getByRole('status')).toHaveTextContent('');
  });
});

/**
 * B5 (path doc §4 B5, item 1 of 3 remaining): the preset/mode/model chips only
 * name their current value via `title` — MDN: "Use of the title attribute is
 * highly problematic for … people navigating with keyboards … assistive
 * technology such as screen readers … [and] touch-only devices"
 * (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/title,
 * fetched this task). Each chip's icon is `aria-hidden` (`Icon.tsx`) and its
 * text label is hidden below `NARROW` (360px) — `Composer.tsx`'s
 * `useLayoutEffect` seeds `narrow` from `getBoundingClientRect().width`,
 * which jsdom always reports as 0, so every `webview-dom` render of this
 * component is already in the "labels collapsed" state these tests target.
 * Fix: an explicit, DYNAMIC `aria-label` ("Edit policy: <preset>" / "Mode:
 * <mode>" / "Model: <model>") on each trigger button; `title` stays as the
 * (secondary) visual tooltip, unchanged.
 */
function renderComposerChips(overrides: {
  preset?: EditPolicyPreset;
  modelLabel?: string;
  activeModeId?: string | null;
  availableModes?: CustomModeInfo[];
}) {
  return render(
    <Composer
      tabId="tab-1"
      draft=""
      draftAttachments={[]}
      onDraftChange={() => undefined}
      onAttachAdd={() => undefined}
      onAttachRemove={() => undefined}
      preset={overrides.preset ?? 'normal'}
      modelLabel={overrides.modelLabel ?? 'test-model'}
      busy={false}
      disabled={false}
      activeModeId={overrides.activeModeId ?? null}
      availableModes={overrides.availableModes ?? []}
      onSetMode={async () => undefined}
      initialHeight={120}
      onHeightChange={() => undefined}
      onSubmit={async () => undefined}
      onCancel={() => undefined}
      onSetPreset={async () => undefined}
      onPickModel={() => undefined}
      onNewSession={() => undefined}
      availableCommands={[]}
      searchFiles={async () => []}
      pendingSeed={null}
      onSeedApplied={() => undefined}
    />,
  );
}

describe('B5: state-bearing chips carry a dynamic aria-label (title alone is unreliable)', () => {
  it('the preset chip names the control AND its current value', () => {
    renderComposerChips({ preset: 'manual' });
    const button = screen.getByRole('button', { name: 'Edit policy: Manual' });
    expect(button).toHaveAttribute('aria-label', 'Edit policy: Manual');
    // title stays as the (richer) visual tooltip — unchanged, not removed.
    expect(button).toHaveAttribute('title', expect.stringContaining('Manual'));
  });

  it('the preset chip aria-label is DYNAMIC, not a static string — it tracks the current preset', () => {
    renderComposerChips({ preset: 'strict' });
    expect(screen.getByRole('button', { name: 'Edit policy: Strict' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit policy: Manual' })).not.toBeInTheDocument();
  });

  it('the mode chip names the control and reports "None" when no custom mode is active', () => {
    renderComposerChips({ availableModes: [{ id: 'm1', name: 'Reviewer' }], activeModeId: null });
    const button = screen.getByRole('button', { name: 'Mode: None' });
    expect(button).toHaveAttribute('aria-label', 'Mode: None');
  });

  it('the mode chip aria-label is DYNAMIC — it names the active custom mode when one is set', () => {
    renderComposerChips({ availableModes: [{ id: 'm1', name: 'Reviewer' }], activeModeId: 'm1' });
    expect(screen.getByRole('button', { name: 'Mode: Reviewer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mode: None' })).not.toBeInTheDocument();
  });

  it('the model chip names the control and its current model label, and updates when the label changes', () => {
    // RED today: even though this chip's `title` text happens to read
    // "Model: <label>" too (unlike preset/mode, which append a hint), there
    // is NO `aria-label` attribute at all — assert the attribute directly so
    // this doesn't pass by accident via the title-as-accessible-name
    // fallback some AT/UA combinations apply (the exact unreliability MDN
    // warns about — this test must not depend on it).
    const { rerender } = renderComposerChips({ modelLabel: 'gpt-5-mini' });
    const button = screen.getByRole('button', { name: 'Model: gpt-5-mini' });
    expect(button).toHaveAttribute('aria-label', 'Model: gpt-5-mini');

    rerender(
      <Composer
        tabId="tab-1"
        draft=""
        draftAttachments={[]}
        onDraftChange={() => undefined}
        onAttachAdd={() => undefined}
        onAttachRemove={() => undefined}
        preset="normal"
        modelLabel="claude-sonnet"
        busy={false}
        disabled={false}
        activeModeId={null}
        availableModes={[]}
        onSetMode={async () => undefined}
        initialHeight={120}
        onHeightChange={() => undefined}
        onSubmit={async () => undefined}
        onCancel={() => undefined}
        onSetPreset={async () => undefined}
        onPickModel={() => undefined}
        onNewSession={() => undefined}
        availableCommands={[]}
        searchFiles={async () => []}
        pendingSeed={null}
        onSeedApplied={() => undefined}
      />,
    );
    const updated = screen.getByRole('button', { name: 'Model: claude-sonnet' });
    expect(updated).toHaveAttribute('aria-label', 'Model: claude-sonnet');
    expect(screen.queryByRole('button', { name: 'Model: gpt-5-mini' })).not.toBeInTheDocument();
  });
});
