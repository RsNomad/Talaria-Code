import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';
import type { ComposerSeed } from '../composer/applySeed';
import type { Attachment, CustomModeInfo, EditPolicyPreset } from '../protocol';
// CF-07: the confinement HALF of the drag-drop test drives the REAL
// production predicate/orchestration the host runs `Attachment.path`
// through post-drop — not a hand-rolled restatement of it — so a passing
// test is proof the composer's output satisfies the host-side contract,
// not just this file's guess at it. Both are pure (no `vscode`, no I/O at
// import time — `attachments.ts` doc, `sanitize.ts` doc); `resolveWithinWorkspace`
// is the synchronous, filesystem-free lexical predicate (no `realpath`), so
// no on-disk fixtures are needed to prove containment.
import { confineAttachmentPaths, type AttachmentConfineFn } from '../../../src/host/backend/acp/attachments';
import { resolveWithinWorkspace } from '../../../src/host/backend/acp/pathConfine';

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

/**
 * CF-02 (L1 UIUX-I1): IME composition guard. Before this task the composer
 * had ZERO isComposing/keyCode-229/compositionstart-end handling anywhere
 * (`grep -rn "isComposing\|keyCode\|229\|compositionend" webview/src` → 0
 * hits) — so the Enter an IME sends to COMMIT a composition (Japanese/
 * Chinese/Korean input, accented-character compose sequences, …) was
 * indistinguishable from the user's own "send" Enter: it fired `submit()`
 * with a half-composed draft and destroyed the in-flight composition. EVERY
 * Enter/Tab consumer in `onKeyDown` — the main submit branch and the shared
 * `useSuggest` mention/slash commit path — must ignore the key while
 * composing.
 *
 * Grounded (fetched this task): `nativeEvent.isComposing` is the modern
 * per-keystroke signal (Chromium/Firefox, confirming Enter); `keyCode === 229`
 * is the historical IME sentinel some browsers still need — Safari can
 * already report `isComposing === false` on the very keydown that confirms
 * the conversion (see e.g. https://dev.to/yukimi-inu/why-16-billion-east-asians-are-quietly-raging-at-your-enter-key-handler-1po0,
 * fetched this task). A `compositionstart`/`compositionend` ref is a THIRD
 * belt: event ORDER across the confirming keydown and `compositionend` is not
 * guaranteed cross-browser (https://dev.to/greymothjp/the-enter-key-that-fires-while-youre-still-typing-goo,
 * fetched this task), so neither nativeEvent flag alone is trustworthy in
 * every case. The fix ORs all three signals rather than trusting any one.
 */
function renderComposerForIME(overrides: {
  onSubmit?: (text: string, attachments?: Attachment[], mentions?: unknown[]) => void;
} = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn();

  function StatefulComposer() {
    const [draft, setDraft] = useState('');
    return (
      <Composer
        tabId="tab-1"
        draft={draft}
        draftAttachments={[]}
        onDraftChange={setDraft}
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
        onSubmit={onSubmit}
        onCancel={() => undefined}
        onSetPreset={async () => undefined}
        onPickModel={() => undefined}
        onNewSession={() => undefined}
        availableCommands={[]}
        searchFiles={async () => []}
        pendingSeed={null}
        onSeedApplied={() => undefined}
      />
    );
  }

  render(<StatefulComposer />);
  return { onSubmit };
}

/**
 * UI#9-honesty: submitting while the ACTIVE tab has a LIVE turn must never
 * silently swallow the user's Enter. `App.tsx:640` wires `busy={tab.turnActive}`
 * (`transcript.test.ts`: "the composer shows Stop, not Send" while `turnActive`
 * is true) — so `busy===true` here IS "the active tab has a live turn".
 *
 * Composer.tsx's `submit()` already no-ops when `busy` is true (`onSubmit` is
 * never called, so the draft/attachments controlled props are never touched —
 * preservation was never actually at risk). But `onKeyDown` unconditionally
 * `e.preventDefault()`s a non-shift Enter BEFORE that no-op runs, so the
 * keystroke vanishes with zero feedback: no newline, no message, no toast, no
 * status text — a silent drop. This reuses the composer's EXISTING status
 * surface (A2's `attachNotice` state + the permanently-mounted `LiveRegion`,
 * `role="status"`) rather than inventing a second one.
 */
function renderComposerBusy(overrides: {
  onSubmit?: (text: string, attachments?: Attachment[], mentions?: unknown[]) => void;
  draft?: string;
  draftAttachments?: Attachment[];
} = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn();
  const initialDraft = overrides.draft ?? 'do not eat this message';
  const attachments = overrides.draftAttachments ?? [{ id: 'a1', name: 'notes.txt', kind: 'file' as const }];

  function StatefulBusyComposer() {
    const [draft, setDraft] = useState(initialDraft);
    return (
      <Composer
        tabId="tab-1"
        draft={draft}
        draftAttachments={attachments}
        onDraftChange={setDraft}
        onAttachAdd={() => undefined}
        onAttachRemove={() => undefined}
        preset="normal"
        modelLabel="test-model"
        busy={true}
        disabled={false}
        activeModeId={null}
        availableModes={[]}
        onSetMode={async () => undefined}
        initialHeight={120}
        onHeightChange={() => undefined}
        onSubmit={onSubmit}
        onCancel={() => undefined}
        onSetPreset={async () => undefined}
        onPickModel={() => undefined}
        onNewSession={() => undefined}
        availableCommands={[]}
        searchFiles={async () => []}
        pendingSeed={null}
        onSeedApplied={() => undefined}
      />
    );
  }

  render(<StatefulBusyComposer />);
  return { onSubmit };
}

describe('UI#9-honesty: a mid-turn submit never silently vanishes', () => {
  it('pressing Enter while the active tab has a live turn does not send, preserves the draft and attachments, and surfaces an honest "still running" affordance', () => {
    const { onSubmit } = renderComposerBusy({ draft: 'do not eat this message' });
    const textarea = screen.getByRole('combobox');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    // No silent send.
    expect(onSubmit).not.toHaveBeenCalled();
    // The draft is PRESERVED, not cleared.
    expect(textarea).toHaveValue('do not eat this message');
    // The attachment chip is PRESERVED, not cleared.
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    // An honest, visible affordance — not a silent no-op — via the EXISTING
    // composer status LiveRegion (role="status").
    expect(screen.getByRole('status')).toHaveTextContent(/turn.*running|still running/i);
  });

  it('clicking the (disabled) Send button while a turn is live is inert — Stop is rendered instead, so Send is not even present', () => {
    renderComposerBusy();
    // `busy` swaps the toolbar's Send button for Stop entirely (existing
    // behavior, unchanged) — this pins that Send is never simultaneously
    // clickable during a live turn.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });
});

describe('CF-02: Enter/Tab are ignored while an IME composition is in flight', () => {
  it('a keydown Enter whose nativeEvent.isComposing===true does NOT submit', () => {
    const { onSubmit } = renderComposerForIME();
    const textarea = screen.getByRole('combobox');

    fireEvent.change(textarea, { target: { value: 'にほんご' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a normal Enter (isComposing false) still submits — the guard is not overbroad', () => {
    const { onSubmit } = renderComposerForIME();
    const textarea = screen.getByRole('combobox');

    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello world', undefined, undefined);
  });

  it('the keyCode===229 legacy IME sentinel also blocks submit (the Safari path, isComposing already false)', () => {
    const { onSubmit } = renderComposerForIME();
    const textarea = screen.getByRole('combobox');

    fireEvent.change(textarea, { target: { value: 'weird safari state' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: false, keyCode: 229 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('the shared suggest-menu Enter commit path also ignores a composing Enter (menu stays open, nothing picked)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposerForIME();
    const textarea = screen.getByRole('combobox');

    await user.type(textarea, '@');
    expect(textarea).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    // A real (non-composing) Enter here would COMMIT the top mention item
    // ("File") — rewriting the draft to `@file:` and drilling into the file
    // submenu (see Composer.tsx's `pickMention`). Composing must leave the
    // draft untouched and must not submit either.
    expect(textarea).toHaveValue('@');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('the compositionstart/compositionend ref is a belt: it blocks Enter even when nativeEvent itself stays silent, and un-blocks after compositionend', () => {
    const { onSubmit } = renderComposerForIME();
    const textarea = screen.getByRole('combobox');

    fireEvent.change(textarea, { target: { value: 'ok now' } });
    fireEvent.compositionStart(textarea);
    // A confirming Enter mid-composition with NEITHER nativeEvent signal set
    // — only the ref (flipped true by compositionstart, above) can catch this.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('ok now', undefined, undefined);
  });
});

/**
 * CF-07 (L5 F-8): Explorer drag-drop must store an fsPath, not a raw
 * `file://` URI. `Attachment.path`'s contract is "Workspace path" (an
 * fsPath) — host-side `confineAttachmentPaths` (`src/host/backend/acp/
 * attachments.ts`, read-verify only, NOT edited by this task) resolves it
 * against each workspace root via `path.resolve`. A raw `file://` URI
 * string never resolves inside any root that way, so an Explorer drag was
 * silently dropped with a misleading "outside the workspace" outcome.
 * `pathToFileUri`'s URI-passthrough sits AFTER confinement and is never
 * reached for this case.
 */
function simulateExplorerUriDrop(container: HTMLElement, uri: string) {
  const dropTarget = container.firstElementChild as HTMLElement;
  fireEvent.drop(dropTarget, {
    dataTransfer: {
      types: ['text/uri-list'],
      getData: (type: string) => (type === 'text/uri-list' ? uri : ''),
    },
  });
}

describe('CF-07: Explorer drag-drop of a file:// URI is parsed to an fsPath', () => {
  it('a dropped file:// URI (inside a workspace root) becomes an Attachment.path fsPath, and confines successfully', async () => {
    const added: Attachment[] = [];
    const { container } = renderComposerForAttachments((a) => added.push(a));

    simulateExplorerUriDrop(container, 'file:///home/user/proj/src/app.ts');

    expect(added).toHaveLength(1);
    const attachment = added[0]!;

    // The defect: today `attachment.path` is the raw `file://` string
    // (POSIX `file:///abs` -> fsPath is everything after the third slash).
    expect(attachment.path).toBe('/home/user/proj/src/app.ts');
    expect(attachment.path).not.toMatch(/^file:\/\//);

    // Confinement contract: feed the produced attachment through the REAL
    // `confineAttachmentPaths`, with the REAL pure/lexical confine
    // predicate injected (no realpath -> no on-disk fixture needed). Today
    // (raw URI stored) this drops the attachment; after the fix it must not.
    const confine: AttachmentConfineFn = async (p, roots) => resolveWithinWorkspace(p, roots);
    const result = await confineAttachmentPaths([attachment], ['/home/user/proj'], confine);
    expect(result.droppedCount).toBe(0);
    expect(result.attachments).toHaveLength(1);
  });

  it('URL-encoded characters in the URI (e.g. a space as %20) are decoded into the fsPath', () => {
    const added: Attachment[] = [];
    const { container } = renderComposerForAttachments((a) => added.push(a));

    simulateExplorerUriDrop(container, 'file:///home/user/proj/my%20notes.txt');

    expect(added).toHaveLength(1);
    expect(added[0]!.path).toBe('/home/user/proj/my notes.txt');
    expect(added[0]!.name).toBe('my notes.txt');
  });

  it('a non-URI drop (already an fsPath) keeps working unchanged', () => {
    const added: Attachment[] = [];
    const { container } = renderComposerForAttachments((a) => added.push(a));
    const rawPath = '/home/user/proj/README.md';

    simulateExplorerUriDrop(container, rawPath);

    expect(added).toHaveLength(1);
    expect(added[0]!.path).toBe(rawPath);
    expect(added[0]!.name).toBe('README.md');
  });

  // Review finding (post-approval, non-blocking): RFC 8089 + Node's
  // `fileURLToPath` docs ("On Unix-like systems, only localhost or an empty
  // host is supported") both treat `file://localhost/...` as a VALID alias
  // for `file:///...` on POSIX.
  //
  // VERIFIED (write-time, both Node directly and this file's own jsdom
  // Vitest env) that this specific case does NOT actually go red against
  // the PRE-fix `if (url.hostname) return undefined`: the WHATWG `URL`
  // parser's "file host" state already normalizes a literal `localhost`
  // authority (any case, even percent-encoded — `loc%61lhost` too) to an
  // empty `url.hostname` for the `file:` scheme, so `url.hostname` was
  // already `''` here before this fix, same as an authority-less
  // `file:///...`. This test therefore documents/pins already-correct
  // behavior (a characterization test) rather than reproducing a live
  // CF-07 regression the way the sibling cases above do — the production
  // change this task adds (`!== 'localhost'`) is a harmless, explicit
  // belt-and-suspenders guard (see the `fileUriToFsPath` doc comment), not
  // a behavior change for THIS input. It still earns its place: it pins
  // the RFC 8089 contract against any future engine/polyfill that stops
  // normalizing localhost, and against a future edit that swaps the
  // `url.hostname` check for something that no longer benefits from that
  // normalization.
  it('a file://localhost/... URI (inside a workspace root) is treated as local, not remote — same fsPath + confinement as an empty-host URI', async () => {
    const added: Attachment[] = [];
    const { container } = renderComposerForAttachments((a) => added.push(a));

    simulateExplorerUriDrop(container, 'file://localhost/home/user/app.ts');

    expect(added).toHaveLength(1);
    const attachment = added[0]!;

    expect(attachment.path).toBe('/home/user/app.ts');
    expect(attachment.path).not.toMatch(/^file:\/\//);

    const confine: AttachmentConfineFn = async (p, roots) => resolveWithinWorkspace(p, roots);
    const result = await confineAttachmentPaths([attachment], ['/home/user'], confine);
    expect(result.droppedCount).toBe(0);
    expect(result.attachments).toHaveLength(1);
  });

  it('a file:// URI with a genuine remote host still falls through to the raw-URI fallback, unchanged', () => {
    const added: Attachment[] = [];
    const { container } = renderComposerForAttachments((a) => added.push(a));

    simulateExplorerUriDrop(container, 'file://otherhost/home/user/app.ts');

    expect(added).toHaveLength(1);
    // Unlike localhost, a genuine remote host is left on the pre-fix
    // behavior: the raw URI is stored verbatim (caller's fallback branch).
    expect(added[0]!.path).toBe('file://otherhost/home/user/app.ts');
  });
});
