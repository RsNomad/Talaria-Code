/*
 * Prompt composer — the action hub at the bottom of the chat.
 * ------------------------------------------------------------------
 * - Attachment chips sit ABOVE the textarea; each shows a kind icon, its name,
 *   and a remove ✕. Attachments arrive via the 📎 menu, drag-drop, or paste.
 * - Enter sends, Shift+Enter inserts a newline. Send toggles to Stop while a
 *   turn is active.
 * - The toolbar carries: attach • preset picker • model chip • spacer •
 *   + New Session • Send/Stop. Below ~360px the preset/model/new-session labels
 *   collapse to icons.
 * - The input is drag-resizable (a grabber on the top edge); the committed
 *   height is persisted by the parent via bridge.setState.
 * - Typing `@` opens the reference menu to drop a mention token; typing `/`
 *   at the start of a line opens the sectioned slash-command menu (client
 *   "Commands" templates + the agent's "Agent" catalog). Both share ONE
 *   suggest primitive (`composer/useSuggest.ts` + `components/SuggestMenu.tsx`,
 *   W2 T1, architecture doc §2b) — see `onComposerTextChange`/`onKeyDown` below.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, ContextRef, CustomModeInfo, EditPolicyPreset, SlashCommandInfo } from '../protocol';
import { Icon } from './Icon';
import { AttachMenu } from './AttachMenu';
import { LiveRegion } from './LiveRegion';
import { useMenuFocus } from '../hooks/useMenuFocus';
import { Pill } from './Pill';
import { SuggestMenu, flattenSuggestSections, activeOptionId, type SuggestItem } from './SuggestMenu';
import { filterMentions, type MentionItem } from '../composer/mentionCatalog';
import { buildSlashSections, type AgentSlashItem, type SlashTemplate } from '../composer/slashCatalog';
import { useSuggest, pathPickEmptyKey } from '../composer/useSuggest';
import { parseMentions, formatMentionToken } from '../composer/parseMentions';
import { describeMention, basename } from '../composer/mentionChip';
import { parsePathPick, filesToFolders } from '../composer/fileSearch';
import { useFileSearch } from '../composer/useFileSearch';
import { applySeed, type ComposerSeed } from '../composer/applySeed';

// W2-F1: the picker replaced the wire AgentMode picker — every preset pins the
// ACP mode at 'default' and differs only in the client-side edit-policy engine.
// The active value is authoritative from the host (`policy.state`/bootstrap);
// selecting merely fires `onSetPreset` and waits for the echo.
//
// F3 consent-surface honesty: the gate only sees main-loop file edits
// (`write_file`/`patch`). Ordinary commands auto-run Hermes-side, and
// subagent/`execute_code`/MCP writes bypass the gate entirely — the post-turn
// checkpoint snapshot is what recovers those. Hints must never promise more
// than that (no "everything", no "no edits") — locked by `Composer.test.ts`.
export const PRESETS: { id: EditPolicyPreset; label: string; icon: string; hint: string }[] = [
  { id: 'manual', label: 'Manual', icon: 'question', hint: 'ask before file edits' },
  { id: 'normal', label: 'Normal', icon: 'shield', hint: 'auto-allow safe in-workspace edits' },
  { id: 'strict', label: 'Strict', icon: 'lock', hint: 'deny risky edits; commands still auto-run' },
  { id: 'plan', label: 'Plan', icon: 'checklist', hint: 'discourage edits (not filesystem-enforced)' },
];

/** Narrow a fixed, non-empty literal's first element once, with a return
 * type (`T`, not `T | undefined`) that TypeScript can carry into closures
 * defined anywhere later — unlike narrowing a bare module-level `const` via
 * an `if`, which control-flow analysis does not reliably propagate across a
 * later function boundary (verified: it did not, here). Throws (an honest
 * runtime check, not a `!` lie) only if the literal is ever emptied. */
function nonEmptyFirst<T>(arr: readonly T[]): T {
  const first = arr[0];
  if (first === undefined) throw new Error('expected a non-empty array');
  return first;
}

const FIRST_PRESET = nonEmptyFirst(PRESETS);

const MIN_H = 64;
const NARROW = 360;

interface ComposerProps {
  /** P7-N1: which tab this composer is editing — used ONLY for the ephemeral
   * reset effect below (suggest sessions / popovers / drag state are
   * per-composer-EDIT, meaningless across a tab switch since their offsets
   * index the OLD tab's draft). The draft itself is NOT keyed by this —
   * it's the `draft`/`draftAttachments` props below, controlled from
   * `TabState`. */
  tabId: string;
  /** P7-N1 controlled draft (from `TabState.draft`) — replaces the old
   * component-local `useState` that let a tab switch carry a stale draft
   * into the wrong session (the wrong-session-send Critical). */
  draft: string;
  draftAttachments: Attachment[];
  onDraftChange: (text: string) => void;
  onAttachAdd: (attachment: Attachment) => void;
  onAttachRemove: (attachmentId: string) => void;
  /** W2-F1: the active edit-policy preset (host-authoritative). */
  preset: EditPolicyPreset;
  modelLabel: string;
  busy: boolean;
  /**
   * W4 §2e: the per-tab composer latch — the multi-tab generalization of the
   * old `backendStarted` latch. Disabled (textarea + send both inert) until
   * the ACTIVE tab's `binding === 'bound'`; a fresh unbound/pending tab
   * renders this true.
   */
  disabled?: boolean;
  /**
   * ARCH-1 (final review, UI I-3): overrides the generic `'Connecting…'`
   * placeholder shown while `disabled`. `App.tsx` passes an honest
   * session-lost message for a tab whose session died — "Connecting…" would
   * be a lie there (nothing is connecting; the route back is History/New
   * Chat, never a passive wait). `undefined` (every other disabled reason —
   * a fresh/pending tab) keeps the original copy.
   */
  disabledPlaceholder?: string;
  /**
   * SF-2 (T4 populates `availableModes`/owns the engine — T3b wires only
   * this picker UI SHELL, reading `mode.state`). `null` = no custom mode
   * active. The picker renders only when `availableModes` is non-empty —
   * today that's always (no host code sends `mode.state` yet), so this is
   * honestly inert until T4 lands, by design.
   */
  activeModeId?: string | null;
  availableModes?: CustomModeInfo[];
  onSetMode?: (modeId: string | null) => void;
  /** Persisted textarea height (px) to restore on mount. */
  initialHeight: number;
  onHeightChange: (height: number) => void;
  /**
   * `mentions` (W2 T2e, §2b) is the PURE `parseMentions(trimmed)` derivation
   * of the FINAL submitted text — never a tracked side-array (§7 A7).
   * Omitted/undefined when the draft carried no recognizable `@`-token.
   */
  onSubmit: (text: string, attachments?: Attachment[], mentions?: ContextRef[]) => void;
  onCancel: () => void;
  onSetPreset: (preset: EditPolicyPreset) => void;
  onPickModel: () => void;
  onNewSession: () => void;
  /** W2 T1: the ACP `available_commands` catalog for the `/` palette's "Agent" section (§3.2). */
  availableCommands?: SlashCommandInfo[];
  /**
   * W2 T2e (§3.1): the `@file`/`@folder` submenu's file source —
   * `context.searchFiles` threaded down from `App.tsx` (`bridge.request`),
   * injected rather than imported directly so this component never reaches
   * for the bridge singleton itself.
   */
  searchFiles: (query: string, maxResults?: number) => Promise<string[]>;
  /**
   * W2 T3 (F-A code actions, §2e/§3.3): the most recent `composer.seed` push
   * from an editor action ("Add/Explain/Improve/Fix with Hermes"), or `null`
   * before the first one arrives / after the pending one has been consumed
   * (audit C-3: App clears this to `null` via `onSeedApplied`, below). A NEW
   * object identity (App.tsx only ever sets this via a fresh `{tabId, text,
   * mentions}` literal per incoming message) is what drives the apply-effect
   * below — REFERENCE equality, not content — so a genuinely new push still
   * applies even with byte-identical text. `tabId` scopes the seed to the
   * conversation it was minted for (see the effect's guards). Applying a seed
   * only ever edits the draft (`applySeed`, pure) and refocuses the textarea;
   * it NEVER calls `submit()` (review-first — a seeded prompt is never
   * auto-sent).
   */
  pendingSeed?: ComposerSeed | null;
  /**
   * Audit C-3: reports a seed as CONSUMED so App can clear `pendingSeed`.
   * Without this the seed is never cleared, and because the apply-effect
   * below keys on `pendingSeed`'s object identity — which also fires on
   * MOUNT — a Composer remount (leaving and returning to the chat panel,
   * `App.tsx:516`) re-applies the same seed a second time.
   */
  onSeedApplied: (seed: ComposerSeed) => void;
}

function uid(): string {
  return crypto.randomUUID?.() ?? `att-${Math.random().toString(36).slice(2)}`;
}

function kindOf(file: File): Attachment['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'pdf';
  return 'file';
}

/** Extension → MIME fallback for the common text-ish kinds browsers report as `''`. */
const EXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  ts: 'application/typescript',
  tsx: 'application/typescript',
  js: 'application/javascript',
  jsx: 'application/javascript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  yml: 'application/x-yaml',
  yaml: 'application/x-yaml',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
};

/** A non-empty MIME for a file: its own `type`, else an extension-based guess, else a binary default. */
function resolveMime(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/**
 * Per-kind cap on inline-read attachment bytes — above the cap we skip inlining
 * rather than send a dead chip. Generic files (the newly-supported inline path)
 * get a tight 512 KB cap; images/pdf keep their prior "read unconditionally"
 * behavior with only a loose 20 MB sanity bound so a routine screenshot never
 * falls through.
 */
const MAX_FILE_BYTES = 512 * 1024; // 512 KB — generic text/binary files
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB — images & pdfs
function maxInlineBytes(kind: Attachment['kind']): number {
  return kind === 'image' || kind === 'pdf' ? MAX_MEDIA_BYTES : MAX_FILE_BYTES;
}

function chipIcon(kind: Attachment['kind']): string {
  return kind === 'image' ? 'file-media' : kind === 'pdf' ? 'file-pdf' : 'file';
}

/**
 * CF-07 (L5 F-8): an Explorer drag delivers its `text/uri-list` entry as a
 * `file://` URI (e.g. `file:///home/user/proj/src/app.ts`), but
 * `Attachment.path`'s contract is a workspace fsPath — host-side
 * `confineAttachmentPaths` (`src/host/backend/acp/attachments.ts`)
 * `path.resolve()`s it against each workspace root. A raw URI string never
 * resolves inside any root that way, so storing it verbatim gets the
 * attachment silently dropped with a misleading "outside the workspace or
 * secret-classified" outcome — fixed HERE, at the composer boundary, so
 * confinement itself stays a pure fsPath-only contract (smaller blast
 * radius than teaching it to accept URIs too).
 *
 * Grounded via Context7 (`/nodejs/node`, `url.fileURLToPath` doc, write-time):
 * `new URL(uri).pathname` alone is NOT the fsPath — it stays
 * percent-encoded (`file:///hello world` -> pathname `/hello%20world`,
 * `file:///你好.txt` -> `/%E4%BD%A0%E5%A5%BD.txt`) — `decodeURIComponent`
 * on top is required to get the real path back, exactly what
 * `fileURLToPath` does internally. `url.fileURLToPath` itself is Node-only
 * and unavailable here (this module runs in the webview's browser
 * context), so this reimplements its POSIX case against the WHATWG `URL`
 * global instead, which the webview host and jsdom both provide.
 *
 * POSIX-only (Fedora is the target platform): `file:///abs/path` has an
 * empty authority, and per RFC 8089 + Node's own `fileURLToPath` docs
 * ("On Unix-like systems, only localhost or an empty host is supported"),
 * `file://localhost/abs/path` is an equally valid LOCAL alias for it —
 * only a genuinely different, non-empty, non-localhost host (e.g.
 * `file://otherhost/...`) is a REMOTE/UNC form. The WHATWG `URL` parser
 * used here already normalizes a literal `localhost` authority (any case,
 * even percent-encoded) to an empty `url.hostname` for the `file:` scheme
 * as part of its own "file host" state, so the `!== 'localhost'` check
 * below is belt-and-suspenders — it makes the RFC 8089 exemption explicit
 * in this function's own logic instead of leaning on that engine-internal
 * normalization implicitly. A genuinely different host is deliberately
 * left unhandled (returns `undefined`, falling through to the non-URI
 * branch below) rather than guessed at.
 *
 * @returns the decoded fsPath, or `undefined` when `uri` is not a
 *          recognizable local `file://` URI (caller falls back to storing
 *          it verbatim, unchanged from before this fix).
 */
function fileUriToFsPath(uri: string): string | undefined {
  if (!/^file:\/\//i.test(uri)) return undefined;
  try {
    const url = new URL(uri);
    if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return undefined;
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

/**
 * Audit C-3 (Critical): every `ComposerSeed` object ever applied, by
 * reference. MODULE-scoped (not component-instance `useState`/`useRef`) on
 * purpose — this component unmounts whenever the user leaves the chat panel
 * and `<StrictMode>` (`main.tsx`) additionally double-invokes effects
 * (mount → run → simulated unmount → remount with UNCHANGED props → run
 * again) precisely to surface bugs like this one. A component-instance-scoped
 * guard cannot survive either case: a fresh instance has fresh state, so it
 * would see the same not-yet-cleared `pendingSeed` as brand new and re-apply
 * it (verified — `Composer.dom.test.tsx`'s remount case reproduces
 * `'text\n\ntext'` with only the tabId + `onSeedApplied` guards). A `WeakSet`
 * costs nothing at rest: App.tsx mints a FRESH seed object per incoming
 * message, so once `pendingSeed` moves on the old object is unreferenced and
 * this entry is GC'd along with it — there is no unbounded growth.
 */
const consumedSeeds = new WeakSet<ComposerSeed>();

export function Composer({
  tabId,
  draft,
  draftAttachments,
  onDraftChange,
  onAttachAdd,
  onAttachRemove,
  preset,
  modelLabel,
  busy,
  disabled = false,
  disabledPlaceholder,
  activeModeId = null,
  availableModes = [],
  onSetMode,
  initialHeight,
  onHeightChange,
  onSubmit,
  onCancel,
  onSetPreset,
  onPickModel,
  onNewSession,
  availableCommands,
  searchFiles,
  pendingSeed,
  onSeedApplied,
}: ComposerProps) {
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [height, setHeight] = useState(initialHeight);
  /** A2 (UI I-9): oversize-attachment / FileReader-error notice — surfaced
   * through the permanently-mounted `LiveRegion` below (Finding-7 discipline:
   * the region itself is never conditionally mounted, only this text is
   * swapped). Empty string = no notice. */
  const [attachNotice, setAttachNotice] = useState('');

  // W2 T1 (§2b): the ONE shared suggest primitive drives both `@` (mentions,
  // any word boundary — unchanged pre-T1 behavior) and `/` (slash commands,
  // input/line start only — Continue's startOfLine, avoids "see /etc/hosts"
  // mid-sentence false-hits). Two independent hook instances, same engine.
  const mentionSuggest = useSuggest({ trigger: '@' });
  const slashSuggest = useSuggest({ trigger: '/', requireStart: true });

  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /**
   * CF-02: belt for the compositionstart/compositionend event-order gap
   * (`onKeyDown` below). `nativeEvent.isComposing`/`keyCode === 229` are the
   * primary per-keystroke IME signals, but the confirming keydown and
   * `compositionend` are not guaranteed to fire in the same order across
   * browsers — this ref is set true on `compositionstart` and flips false
   * ONLY once `compositionend` actually fires, so it stays a reliable third
   * signal even on a keydown where both nativeEvent flags are silent.
   */
  const composingRef = useRef(false);
  const presetWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // B3 (UI M-1) / path doc §2.3: the preset and mode pickers adopt the same
  // APG menu keyboard contract as AttachMenu, via the shared `useMenuFocus`
  // hook — see `webview/src/hooks/useMenuFocus.ts`. Each trigger ref is
  // separate from its wrapper ref (`presetWrapRef`/`modeWrapRef`, still used
  // for outside-mousedown dismissal below) because the hook needs the
  // FOCUSABLE trigger element to return focus to on Escape, not the layout
  // wrapper div.
  const presetTriggerRef = useRef<HTMLButtonElement>(null);
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const presetMenu = useMenuFocus(PRESETS.length, presetTriggerRef);
  const modeMenu = useMenuFocus(availableModes.length + 1, modeTriggerRef);

  // Collapse control labels to icons on a narrow panel.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setNarrow(w < NARROW);
    });
    ro.observe(el);
    setNarrow(el.getBoundingClientRect().width < NARROW);
    return () => ro.disconnect();
  }, []);

  // Dismiss the preset picker on an outside press.
  useEffect(() => {
    if (!presetMenu.open) return;
    const onDown = (e: MouseEvent) => {
      if (!presetWrapRef.current?.contains(e.target as Node)) presetMenu.closeMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `closeMenu` is a
    // fresh function identity every render (useMenuFocus doesn't memoize it);
    // `open` is the only dependency that should re-run this effect (mirrors
    // the pre-extraction effect's own deps).
  }, [presetMenu.open]);

  // SF-2 mode picker: same outside-press dismissal as the preset picker.
  useEffect(() => {
    if (!modeMenu.open) return;
    const onDown = (e: MouseEvent) => {
      if (!modeWrapRef.current?.contains(e.target as Node)) modeMenu.closeMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above.
  }, [modeMenu.open]);

  // W2 T3 (F-A code actions, §2e/§3.3): apply an editor-action seed to the
  // draft as soon as one arrives.
  //
  // Audit C-3 (Critical): this effect keys on `pendingSeed`'s object identity,
  // which means it ALSO fires on MOUNT — and this component unmounts whenever
  // the user leaves the chat panel (`App.tsx:516`). Three guards, all
  // required (verified: a build with any one removed reproduces the bug —
  // see `Composer.dom.test.tsx`):
  //  1. `seed.tabId !== tabId` — the seed belongs to the conversation it was
  //     minted for. `onDraftChange` is bound to the ACTIVE tab, so without
  //     this a tab switch delivers the text to someone else's draft.
  //  2. `consumedSeeds.has(seed)` — a seed object is applied at MOST ONCE,
  //     EVER, by object identity, tracked below the component instance (see
  //     `consumedSeeds`' doc comment for why: a callback-only one-shot only
  //     protects re-renders of the SAME instance, not a fresh remount that
  //     still sees the same not-yet-cleared seed prop).
  //  3. `onSeedApplied(seed)` — consumption is also reported upward so App
  //     can clear `pendingSeed`, keeping stale seeds out of state generally
  //     (belt-and-suspenders with guard 2, not a substitute for it).
  useEffect(() => {
    if (!pendingSeed) return;
    if (pendingSeed.tabId !== tabId) return;
    if (consumedSeeds.has(pendingSeed)) return;
    consumedSeeds.add(pendingSeed);
    onDraftChange(applySeed(draft, pendingSeed));
    onSeedApplied(pendingSeed);
    requestAnimationFrame(() => taRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity-keyed on
    // pendingSeed only; including `draft`/`onDraftChange` would re-fire this on
    // every keystroke.
  }, [pendingSeed]);

  // P7-N1: suggest sessions + popovers are per-composer-EDIT state, meaningless
  // across a tab switch (their offsets index the OLD tab's draft) — reset them.
  // This is what `key={tabId}` would have bought, WITHOUT its fault of
  // discarding the draft and re-firing the `pendingSeed` effect onto the
  // newly-active tab (see the design doc's "Why not key" section).
  useEffect(() => {
    mentionSuggest.close();
    slashSuggest.close();
    presetMenu.closeMenu(false);
    modeMenu.closeMenu(false);
    setDragging(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // keyed on tabId ONLY; mentionSuggest/slashSuggest/presetMenu/modeMenu
    // are stable-enough per render — their imperative methods' identity
    // isn't what should re-fire this.
  }, [tabId]);

  // ---- attachments ----

  const addFiles = (files: Iterable<File>) => {
    // A2 (UI I-9): a fresh attach attempt clears any stale notice from a
    // PRIOR call — each failure below (over)writes it again (last-wins).
    setAttachNotice('');
    for (const file of files) {
      const kind = kindOf(file);
      const id = uid();
      const mime = resolveMime(file);
      // Above the per-kind inline cap we can't embed bytes and there's no path to
      // fall back to (that's the Explorer-drag branch in onDrop) — a chip that
      // sends nothing is worse than no chip, so skip it outright. Images/pdf keep
      // their prior always-read behavior under a loose 20 MB sanity bound; only
      // generic files get the tight 512 KB cap.
      const cap = maxInlineBytes(kind);
      if (file.size > cap) {
        console.warn(`Talaria: "${file.name}" is ${file.size} bytes, over the ${cap}-byte inline cap — skipping attachment`);
        // A2 (UI I-9): the console.warn above is invisible to the user —
        // this is the user-visible, screen-reader-announced counterpart.
        setAttachNotice(`"${file.name}" is too large to attach — skipped.`);
        continue;
      }
      const meta: Attachment = { id, name: file.name, kind, mime };
      const reader = new FileReader();
      reader.onload = () => {
        // Rebuild the data URI with our resolved MIME: the browser's own
        // readAsDataURL output uses file.type verbatim, which is `''` for many
        // text-ish extensions (.csv/.md/.log) and would otherwise produce an
        // unparseable `data:;base64,...` URI downstream.
        // P7-N1: appended at the REDUCER (onAttachAdd -> local.draft.attach.add),
        // not via a whole-array controlled write here — reader.onload resolves
        // ASYNCHRONOUSLY, so two readers resolving close together would race a
        // stale `draftAttachments` prop and drop a sibling file. The reducer's
        // append is atomic per dispatch instead.
        const raw = String(reader.result);
        const base64 = raw.slice(raw.indexOf(',') + 1);
        onAttachAdd({ ...meta, dataUri: `data:${mime};base64,${base64}` });
      };
      // A2 (UI I-9): previously unassigned — a FileReader failure (permission
      // denial, an unreadable/vanished file, an OS-level read error) was
      // fully silent: no attachment, no chip, no console output, no notice.
      reader.onerror = () => {
        setAttachNotice(`"${file.name}" couldn't be read — skipped.`);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeAttachment = (id: string) => onAttachRemove(id);

  // ---- drag-drop ----

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files') || e.dataTransfer?.types?.includes('text/uri-list')) {
      e.preventDefault();
      setDragging(true);
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node)) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      addFiles(Array.from(files));
      return;
    }
    // Explorer drag: fall back to the uri-list as path references.
    const uris = e.dataTransfer?.getData('text/uri-list');
    if (uris) {
      uris
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
        .forEach((u) => {
          // CF-07: a `file://` URI is parsed to its fsPath before it's
          // stored — `path` is already decoded in that case, so the name is
          // taken from IT (not re-decoded, which would corrupt a filename
          // that happens to contain a literal `%`). A non-URI drop is
          // already an fsPath — unchanged prior behavior.
          const fsPath = fileUriToFsPath(u);
          if (fsPath !== undefined) {
            const name = fsPath.split('/').pop() || fsPath;
            onAttachAdd({ id: uid(), name, kind: 'file', path: fsPath });
            return;
          }
          const name = decodeURIComponent(u.split('/').pop() || u);
          onAttachAdd({ id: uid(), name, kind: 'file', path: u });
        });
    }
  };

  // ---- paste image ----

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images = Array.from(items).filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    );
    if (!images.length) return;
    e.preventDefault();
    for (const it of images) {
      const file = it.getAsFile();
      if (file) addFiles([file]);
    }
  };

  // ---- @ mention / / slash suggest — one shared primitive, two instances ----

  // W2 T2e (§3.1): once the open `@`-query looks like `file:<partial>` /
  // `folder:<partial>` — either typed by hand or entered via `pickMention`
  // below picking "File"/"Folder" — the SAME suggest session drills into the
  // async `context.searchFiles` submenu instead of the static top catalog.
  // Purely derived from `mentionSuggest.state.query`, so backspacing past
  // the colon falls straight back to the top catalog with no extra state.
  const pathPick = mentionSuggest.state.open ? parsePathPick(mentionSuggest.state.query) : null;
  const fileSearch = useFileSearch(pathPick ? pathPick.search : null, searchFiles);
  const filePickPaths = pathPick?.kind === 'folder' ? filesToFolders(fileSearch.results) : fileSearch.results;
  const filePickItems: SuggestItem[] = filePickPaths.map((p) => ({
    id: p,
    label: basename(p),
    hint: p,
    icon: pathPick?.kind === 'folder' ? 'folder' : 'file',
  }));
  const filePickHeading =
    fileSearch.status === 'loading'
      ? 'Searching…'
      : fileSearch.status === 'error'
        ? 'Search failed'
        : filePickItems.length === 0
          ? 'No matches'
          : pathPick?.kind === 'folder'
            ? 'Folders'
            : 'Files';
  const showFilePick = pathPick !== null;

  const filteredMentions: MentionItem[] = mentionSuggest.state.open && !pathPick
    ? filterMentions(mentionSuggest.state.query)
    : [];
  const showMention = mentionSuggest.state.open && !pathPick && filteredMentions.length > 0;
  const mentionItemCount = pathPick ? filePickItems.length : filteredMentions.length;
  const mentionActiveIndex = Math.min(mentionSuggest.activeIndex, Math.max(0, mentionItemCount - 1));

  const slashSections = slashSuggest.state.open ? buildSlashSections(availableCommands, slashSuggest.state.query) : [];
  const slashItems = flattenSuggestSections(slashSections);
  const showSlash = slashSuggest.state.open && slashItems.length > 0;
  const slashActiveIndex = Math.min(slashSuggest.activeIndex, Math.max(0, slashItems.length - 1));

  // B4 (UI M-2 + M-9) / path doc §4 B4: the composer textarea is an APG
  // combobox for whichever of the three popups above is open — DOM focus
  // stays on the textarea; `aria-activedescendant` points assistive tech at
  // the visually-focused option (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/,
  // fetched this task). `showMention`/`showFilePick` are mutually exclusive
  // by construction (the mention popup is gated `!pathPick`, filePick is
  // `pathPick !== null`); `onKeyDown` below documents why mention and slash
  // can't legitimately both be open at one caret position either — so this
  // first-match order is never ambiguous in practice.
  const openPopupId: 'mention' | 'filepick' | 'slash' | undefined = showMention
    ? 'mention'
    : showFilePick
      ? 'filepick'
      : showSlash
        ? 'slash'
        : undefined;
  // filePick can be OPEN with ZERO rendered options (the "Searching…"/
  // "No matches" states — `showFilePick` doesn't gate on item count, unlike
  // mention/slash which already require length > 0 to show at all). An
  // aria-activedescendant naming an id with no matching element would itself
  // be an a11y bug, so this only ever names an id that is on an actually
  // rendered `role="option"` element.
  const activeOptId: string | undefined =
    openPopupId === 'mention' && filteredMentions.length > 0
      ? activeOptionId('mention', mentionActiveIndex)
      : openPopupId === 'filepick' && filePickItems.length > 0
        ? activeOptionId('filepick', mentionActiveIndex)
        : openPopupId === 'slash' && slashItems.length > 0
          ? activeOptionId('slash', slashActiveIndex)
          : undefined;

  const onComposerTextChange = (value: string, caret: number) => {
    mentionSuggest.onTextChange(value, caret);
    slashSuggest.onTextChange(value, caret);
  };

  /**
   * Insert `token` at the open `@` trigger, replacing `@<query>` with it —
   * the ONE place `@`-insertion touches `text` (§2b: an `@` pick always
   * inserts a canonical TEXT token; chips/refs are re-derived from `text`,
   * never tracked here). `reopen: true` re-derives the suggest state from
   * the new text/caret so the SAME session continues (the file/folder
   * drill-in); `false` closes the menu (a terminal pick).
   */
  const insertMentionToken = (token: string, reopen: boolean) => {
    const caret = taRef.current?.selectionStart ?? draft.length;
    const next = draft.slice(0, mentionSuggest.state.start) + token + draft.slice(caret);
    onDraftChange(next);
    const pos = mentionSuggest.state.start + token.length;
    if (reopen) mentionSuggest.onTextChange(next, pos);
    else mentionSuggest.close();
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  /**
   * `@` pick from the top catalog. File/folder are special: instead of
   * closing, they insert `@file:`/`@folder:` and keep the menu open so it
   * drills into the async submenu above (Roo's `dynamicSearchResults`
   * model, §3.1) — every other kind is a complete, terminal token.
   */
  const pickMention = (item: MentionItem) => {
    if (item.id === 'file' || item.id === 'folder') {
      insertMentionToken(`@${item.token}:`, true);
      return;
    }
    insertMentionToken(`@${item.token} `, false);
  };

  /**
   * Picking a drill-in result inserts the completed `@file:<path>`/
   * `@folder:<path>` token — via the pure `formatMentionToken` (I2), which
   * quotes the path when it contains whitespace so it round-trips through
   * `parseMentions`'s quoted-path grammar instead of truncating at the
   * first space.
   */
  const pickFilePath = (kind: 'file' | 'folder', path: string) => {
    insertMentionToken(formatMentionToken(kind, path), false);
  };

  /**
   * `/` pick: insertion semantics deliberately differ from `@` (§2b) — a
   * client template REPLACES the leading `/query` with its expansion (the
   * user sees exactly what will be sent, review-first); an agent command
   * leaves the literal `/name ` token for Hermes' `_handle_slash_command` to
   * consume from the prompt text. Neither ever touches policy/mode state
   * (the `/yolo`-backdoor rule, §2b) — both only ever edit `text`.
   */
  const pickSlash = (item: SlashTemplate | AgentSlashItem) => {
    const caret = taRef.current?.selectionStart ?? draft.length;
    const replacement = 'expand' in item ? item.expand('') : `/${item.name} `;
    const next = draft.slice(0, slashSuggest.state.start) + replacement + draft.slice(caret);
    onDraftChange(next);
    slashSuggest.close();
    const pos = slashSuggest.state.start + replacement.length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  // ---- send ----

  const submit = () => {
    const trimmed = draft.trim();
    if ((!trimmed && draftAttachments.length === 0) || busy || disabled) return;
    // W2 T2e (§2b/§7 A7): `mentions` is a PURE re-derivation of the FINAL
    // submitted text at the moment of send — never a side-array accumulated
    // across edits, so it can never desync from what the user actually typed.
    const mentions = parseMentions(trimmed);
    // CF-03 (was P7-N1, now stale): no local clear here, but NOT because
    // `sendDraft` clears it — ARCH-1 removed that optimistic dispatch (see
    // `useHostActions.sendDraft`). The draft clears only once the HOST's
    // `user` admission echo arrives, folded in `transcript.ts`'s `user` case
    // against this TRIMMED text (`tab.draft.trim() === msg.text`). Composer
    // only closes its own transient suggest popovers here.
    onSubmit(trimmed, draftAttachments.length ? draftAttachments : undefined, mentions.length ? mentions : undefined);
    mentionSuggest.close();
    slashSuggest.close();
  };

  const newSession = () => {
    // P7-N1: no local clear — App's `newSession` dispatches `local.draft.clear`
    // for this tab (parity with the send-path clear).
    mentionSuggest.close();
    slashSuggest.close();
    onNewSession();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // CF-02: an IME (CJK input, accented-character compose sequences, …)
    // sends its OWN Enter to COMMIT the in-flight composition — that keydown
    // must never reach either Enter/Tab consumer below (the suggest-menu
    // pick dispatch just below, or the submit branch at the bottom), or a
    // half-composed draft gets sent / a suggestion gets committed out from
    // under the user. Three ORed signals, per the grounding in
    // `Composer.dom.test.tsx`: `nativeEvent.isComposing` (the modern,
    // per-keystroke check), `nativeEvent.keyCode === 229` (some browsers,
    // e.g. Safari, can already report `isComposing === false` on the
    // confirming keydown), and `composingRef` (belt for the compositionend/
    // confirming-keydown event-order gap — set on `onCompositionStart`/
    // `onCompositionEnd` on the textarea below). Deliberately scoped to
    // Enter/Tab only — Arrow/Escape navigation is unaffected. No
    // `preventDefault()` here: while composing, the browser/IME owns Enter.
    const composing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || composingRef.current;
    if (composing && (e.key === 'Enter' || e.key === 'Tab')) return;
    // The ONE shared reducer (useSuggest.onKeyDown) handles Arrow/Enter/Tab/
    // Esc for whichever trigger is open — `@` and `/` can never both be open
    // at once (one caret position can't sit inside two different open
    // tokens), so trying both in sequence is safe and keeps this a single
    // dispatch site rather than a duplicated key-handling branch per trigger.
    // The `@` session's item list/pick target switches to the file/folder
    // drill-in while `pathPick` is active — same single dispatch site either way.
    const mentionPick = (i: number) => {
      if (pathPick) {
        const path = filePickPaths[i];
        if (path !== undefined) pickFilePath(pathPick.kind, path);
        return;
      }
      const mention = filteredMentions[i];
      if (mention !== undefined) pickMention(mention);
    };
    if (mentionSuggest.onKeyDown(e, mentionItemCount, mentionPick)) return;
    // H2 M3: `mentionSuggest.onKeyDown` above only consumes when
    // `mentionItemCount > 0` (`reduceSuggestKey`'s 0-item branch intentionally
    // no-ops — correct for a top-level `@foo` with no matches). While the
    // async `@file:`/`@folder:` submenu is open, though, 0 items just means
    // "still searching" — falling through to Enter→submit would send the
    // draft with a dangling, incomplete `@file:` token. `showFilePick` scopes
    // this strictly to the submenu window; the top-level mention/slash paths
    // below are unreached whenever this guard fires.
    if (showFilePick) {
      const decision = pathPickEmptyKey(e.key, e.shiftKey);
      if (decision === 'close') {
        e.preventDefault();
        mentionSuggest.close();
        return;
      }
      if (decision === 'swallow') {
        e.preventDefault();
        return;
      }
    }
    if (
      slashSuggest.onKeyDown(e, slashItems.length, (i) => {
        const item = slashItems[i];
        if (item !== undefined) pickSlash(item);
      })
    )
      return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // ---- drag-resize ----

  const clampH = (h: number) => Math.max(MIN_H, Math.min(h, Math.round(window.innerHeight * 0.6)));

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let latest = startH;
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => {
      latest = clampH(startH + (startY - ev.clientY));
      setHeight(latest);
    };
    const up = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onHeightChange(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const resizeByKey = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = clampH(height + 16);
    else if (e.key === 'ArrowDown') next = clampH(height - 16);
    if (next === null) return;
    e.preventDefault();
    setHeight(next);
    onHeightChange(next);
  };

  const activePreset = PRESETS.find((p) => p.id === preset) ?? FIRST_PRESET;
  const maxH = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.6);

  // W2 T2e (§2b/§7 A7): the chip row is a pure VIEW recomputed from `draft` on
  // every render — never a tracked side-array that could desync from what's
  // actually typed. Editing/deleting the token in the text is how a mention
  // is "removed" (no separate remove-affordance in v1, per the brief).
  const draftMentions = parseMentions(draft);

  return (
    <div
      ref={rootRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative flex flex-none flex-col border-t border-border bg-raised"
    >
      {/* drag-resize grabber */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        aria-valuenow={height}
        aria-valuemin={MIN_H}
        aria-valuemax={maxH}
        tabIndex={0}
        title="Drag to resize"
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
        className="group flex h-2 w-full flex-none cursor-ns-resize items-center justify-center"
        style={{ touchAction: 'none' }}
      >
        <span className="h-0.5 w-8 rounded-full bg-border group-hover:bg-accent" />
      </div>

      <div className="flex flex-col px-3 pb-2.5">
        {/* mention chips — derived from `text`, not tracked (§2b/§7 A7) */}
        {draftMentions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-2">
            {draftMentions.map((m) => {
              const view = describeMention(m);
              return (
                <Pill key={m.id} tone="accent" icon={view.icon}>
                  <span title={view.title} className="max-w-[160px] truncate normal-case tracking-normal">
                    {view.text}
                  </span>
                </Pill>
              );
            })}
          </div>
        )}

        {/* attachment chips */}
        {draftAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-2">
            {draftAttachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex max-w-[180px] items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 text-2xs text-muted"
              >
                <Icon name={chipIcon(a.kind)} size={12} className="flex-none text-accent" />
                <span className="truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  title={`Remove ${a.name}`}
                  aria-label={`Remove ${a.name}`}
                  className="flex-none rounded p-0.5 text-faint hover:text-del"
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* input box */}
        <div
          className={`relative rounded-card border bg-surface transition-colors ${
            dragging ? 'border-accent ring-2 ring-accent/40' : 'border-border focus-within:border-accent'
          }`}
        >
          {showMention && (
            <SuggestMenu
              idBase="mention"
              ariaLabel="Insert a reference"
              heading="Reference"
              items={filteredMentions}
              activeIndex={mentionActiveIndex}
              onPick={pickMention}
            />
          )}
          {showFilePick && pathPick && (
            <SuggestMenu
              idBase="filepick"
              ariaLabel={pathPick.kind === 'file' ? 'File search' : 'Folder search'}
              heading={filePickHeading}
              items={filePickItems}
              activeIndex={mentionActiveIndex}
              onPick={(item) => pickFilePath(pathPick.kind, item.id)}
            />
          )}
          {showSlash && (
            <SuggestMenu
              idBase="slash"
              ariaLabel="Slash commands"
              sections={slashSections}
              activeIndex={slashActiveIndex}
              onPick={pickSlash}
            />
          )}
          <textarea
            ref={taRef}
            role="combobox"
            aria-expanded={openPopupId !== undefined}
            aria-controls={openPopupId}
            aria-activedescendant={activeOptId}
            aria-autocomplete="list"
            value={draft}
            disabled={disabled}
            placeholder={
              disabled
                ? (disabledPlaceholder ?? 'Connecting…')
                : 'Ask Talaria…  (@ to reference, Enter to send)'
            }
            style={{ height }}
            onChange={(e) => {
              // P7-N1: write `e.target.value` SYNCHRONOUSLY to the controlled
              // value path — never debounced (react.dev <input> reference: a
              // controlled input's value must update synchronously or the
              // caret jumps). The fold itself is O(1) (one TabState spread).
              onDraftChange(e.target.value);
              onComposerTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            // CF-02: the composingRef belt onKeyDown consults above — set
            // true for the whole span an IME composition is open, false only
            // once it actually ends.
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            className="w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        {/* A2 (UI I-9): attachment failure notice — permanently-mounted
         * LiveRegion (Finding-7 discipline: never conditionally mounted, only
         * `attachNotice` swaps). The dismiss button is a SIBLING outside the
         * live element (interactive content inside a status region pollutes
         * the announcement) and renders only while there is text to dismiss. */}
        <div className={`flex items-center gap-1.5 ${attachNotice ? 'pt-2' : ''}`}>
          <LiveRegion
            text={attachNotice}
            className="min-w-0 flex-1 truncate text-2xs text-del"
            title={attachNotice || undefined}
          />
          {attachNotice && (
            <button
              type="button"
              onClick={() => setAttachNotice('')}
              aria-label="Dismiss attachment notice"
              className="flex-none rounded p-0.5 text-faint hover:text-del"
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </div>

        {/* toolbar */}
        <div className="mt-2 flex items-center gap-1.5">
          <AttachMenu
            onAttachFile={() => fileInputRef.current?.click()}
            onAddImage={() => imageInputRef.current?.click()}
          />

          {/* preset picker */}
          <div className="relative" ref={presetWrapRef}>
            <button
              ref={presetTriggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={presetMenu.open}
              aria-label={`Edit policy: ${activePreset.label}`}
              title={`Edit policy: ${activePreset.label} · ${activePreset.hint}`}
              onClick={presetMenu.toggleMenu}
              onKeyDown={presetMenu.onTriggerKey}
              className="flex items-center gap-1 rounded-full border border-accent px-2 py-1 font-mono text-2xs text-accent transition-colors hover:bg-accent-soft"
            >
              <Icon name={activePreset.icon} size={11} />
              {!narrow && activePreset.label}
              <Icon name="chevron-down" size={10} />
            </button>
            {presetMenu.open && (
              <div
                role="menu"
                onKeyDown={presetMenu.onMenuKey}
                className="absolute bottom-full left-0 z-30 mb-1 min-w-[184px] overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg"
              >
                {PRESETS.map((p, i) => {
                  const selected = p.id === preset;
                  return (
                    <button
                      key={p.id}
                      ref={presetMenu.itemRef(i)}
                      role="menuitemradio"
                      aria-checked={selected}
                      type="button"
                      tabIndex={i === presetMenu.focusIdx ? 0 : -1}
                      onClick={() => {
                        onSetPreset(p.id);
                        presetMenu.closeMenu(false);
                      }}
                      className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left font-mono text-2xs transition-colors hover:bg-accent-soft ${
                        selected ? 'text-accent' : 'text-muted'
                      }`}
                    >
                      <Icon name={p.icon} size={11} className="mt-0.5 flex-none" />
                      <span className="flex min-w-0 flex-col">
                        <span>{p.label}</span>
                        <span className="text-faint">{p.hint}</span>
                      </span>
                      {/* T-16 F8 / WCAG 1.4.1 (Use of Color): the selected
                          preset is ALSO conveyed by this check glyph, not
                          color alone — additive to the existing
                          `text-accent` cue above, never a replacement. */}
                      {selected && (
                        <Icon name="check" size={11} className="ml-auto mt-0.5 flex-none" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* SF-2 mode picker (T4b: real mode.state data + §4.4 honesty copy).
              The tooltip and the dropdown caption both state the NOT-a-
              sandbox scope: a mode floors the main edit path (write_file/
              patch) only — terminal/code/subagent/MCP writes bypass it, and
              the post-turn checkpoint is the recovery for those. Never
              describe the mode as sandboxing or fully preventing edits. */}
          {availableModes.length > 0 && (
            <div className="relative" ref={modeWrapRef}>
              <button
                ref={modeTriggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={modeMenu.open}
                aria-label={`Mode: ${availableModes.find((m) => m.id === activeModeId)?.name ?? 'None'}`}
                title={`Custom mode: ${
                  availableModes.find((m) => m.id === activeModeId)?.name ?? 'None'
                }. Restricts the main edit path only — not a sandbox; terminal, code execution, subagent, and MCP-tool writes bypass it (the checkpoint is the recovery for those).`}
                onClick={modeMenu.toggleMenu}
                onKeyDown={modeMenu.onTriggerKey}
                className="flex items-center gap-1 rounded-full border border-border px-2 py-1 font-mono text-2xs text-muted transition-colors hover:bg-overlay"
              >
                <Icon name="filter" size={11} />
                {!narrow && (availableModes.find((m) => m.id === activeModeId)?.name ?? 'Mode')}
                <Icon name="chevron-down" size={10} />
              </button>
              {modeMenu.open && (
                <div
                  role="menu"
                  onKeyDown={modeMenu.onMenuKey}
                  className="absolute bottom-full left-0 z-30 mb-1 min-w-[160px] overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg"
                >
                  <div className="border-b border-border px-2.5 py-1.5 font-mono text-2xs text-faint">
                    Restricts edits only, not a sandbox — terminal/code/subagent/MCP writes bypass it
                  </div>
                  <button
                    ref={modeMenu.itemRef(0)}
                    role="menuitemradio"
                    aria-checked={activeModeId === null}
                    type="button"
                    tabIndex={modeMenu.focusIdx === 0 ? 0 : -1}
                    onClick={() => {
                      onSetMode?.(null);
                      modeMenu.closeMenu(false);
                    }}
                    className={`flex w-full items-center px-2.5 py-1.5 text-left font-mono text-2xs transition-colors hover:bg-accent-soft ${
                      activeModeId === null ? 'text-accent' : 'text-muted'
                    }`}
                  >
                    None
                    {/* T-16 F8 / WCAG 1.4.1: non-color selected indicator,
                        additive to the existing color cue (see preset picker
                        above). */}
                    {activeModeId === null && (
                      <Icon name="check" size={11} className="ml-auto flex-none" />
                    )}
                  </button>
                  {availableModes.map((m, i) => {
                    const selected = m.id === activeModeId;
                    return (
                      <button
                        key={m.id}
                        ref={modeMenu.itemRef(i + 1)}
                        role="menuitemradio"
                        aria-checked={selected}
                        type="button"
                        tabIndex={modeMenu.focusIdx === i + 1 ? 0 : -1}
                        onClick={() => {
                          onSetMode?.(m.id);
                          modeMenu.closeMenu(false);
                        }}
                        className={`flex w-full items-center px-2.5 py-1.5 text-left font-mono text-2xs transition-colors hover:bg-accent-soft ${
                          selected ? 'text-accent' : 'text-muted'
                        }`}
                      >
                        {m.name}
                        {selected && <Icon name="check" size={11} className="ml-auto flex-none" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* model chip */}
          <button
            type="button"
            onClick={onPickModel}
            aria-label={`Model: ${modelLabel}`}
            title={`Model: ${modelLabel}`}
            className="flex min-w-0 items-center gap-1 rounded-full border border-border px-2 py-1 font-mono text-2xs text-muted transition-colors hover:bg-overlay"
          >
            <Icon name="chip" size={11} className="flex-none" />
            {!narrow && <span className="max-w-[120px] truncate">{modelLabel}</span>}
          </button>

          <div className="ml-auto flex items-center gap-1.5">
            {/* new session */}
            <button
              type="button"
              onClick={newSession}
              title="New Session"
              aria-label="New Session"
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-2xs text-muted transition-colors hover:border-accent hover:text-fg"
            >
              <Icon name="add" size={13} />
              {!narrow && <span>New Session</span>}
            </button>

            {/* send / stop */}
            {busy ? (
              <button
                type="button"
                onClick={onCancel}
                title="Stop"
                aria-label="Stop"
                className="flex h-7 w-7 flex-none items-center justify-center rounded-lg border border-del text-del transition-colors hover:bg-del-soft"
              >
                <Icon name="debug-stop" size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={disabled || (!draft.trim() && draftAttachments.length === 0)}
                title="Send"
                aria-label="Send"
                className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <Icon name="send" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* drag overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-none bg-accent-soft text-2xs uppercase tracking-wide text-accent">
          <Icon name="file-add" size={16} />
          Drop to attach
        </div>
      )}

      {/* hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
    </div>
  );
}
