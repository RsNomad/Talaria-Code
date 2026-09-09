import { useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, RefObject } from 'react';
import type { Attachment } from '../protocol';

/**
 * WS-F5 F5-4 (FI-05, part 2/2 + CLOSE): the attachment-ingestion concern —
 * chip-notice/announce state, the two hidden `<input type=file>` refs, the
 * add/drag/paste handlers, and the file-shape module helpers below —
 * extracted verbatim out of `Composer.tsx`, alongside `useComposerResize`
 * (F5-3, the resize half of the same finding). A clean 2-input/12-output
 * seam: reads only `onAttachAdd` (hands off a fully-read attachment) and
 * `rootRef` (for `onDragLeave`'s containment check against the composer's
 * own root element) — owns none of the composer's other concerns (the
 * message text, the `@`/`/` suggest popups, or the resize state).
 */

export function uid(): string {
  return crypto.randomUUID?.() ?? `att-${Math.random().toString(36).slice(2)}`;
}

export function kindOf(file: File): Attachment['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'pdf';
  return 'file';
}

/** Extension → MIME fallback for the common text-ish kinds browsers report as `''`. */
export const EXT_MIME: Record<string, string> = {
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
export function resolveMime(file: File): string {
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
export const MAX_FILE_BYTES = 512 * 1024; // 512 KB — generic text/binary files
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB — images & pdfs
export function maxInlineBytes(kind: Attachment['kind']): number {
  return kind === 'image' || kind === 'pdf' ? MAX_MEDIA_BYTES : MAX_FILE_BYTES;
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
export function fileUriToFsPath(uri: string): string | undefined {
  if (!/^file:\/\//i.test(uri)) return undefined;
  try {
    const url = new URL(uri);
    if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return undefined;
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

export interface AttachmentIntake {
  dragging: boolean;
  attachNotice: string;
  /**
   * Exposed beyond this hook's own handlers on purpose — a deliberate BORROW,
   * not a leak: `Composer.tsx`'s send handler calls this directly for its
   * "still running" busy-notice, and the notice's own dismiss button calls it
   * to clear the text. `attachNotice`/`setAttachNotice` is the composer's ONE
   * shared status surface (A2, UI I-9) — never attachment-exclusive, even
   * though the failure/oversize notices below are its most frequent writer.
   */
  setAttachNotice: (text: string) => void;
  attachAnnounce: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  imageInputRef: RefObject<HTMLInputElement | null>;
  addFiles: (files: Iterable<File>) => void;
  onDragOver: (e: DragEvent<Element>) => void;
  onDragLeave: (e: DragEvent<Element>) => void;
  onDrop: (e: DragEvent<Element>) => void;
  onPaste: (e: ClipboardEvent<Element>) => void;
  /**
   * The ONLY new code this extraction introduces: resets the per-tab-scoped
   * drag/notice state on a tab switch — previously two inline lines
   * (`setDragging(false); setAttachNotice('');`) inside Composer's own tabId
   * reset effect, now this hook's own reset entry point so the orchestrating
   * effect no longer needs to reach into this hook's private setters.
   */
  resetForTab: () => void;
}

export function useAttachmentIntake({
  onAttachAdd,
  rootRef,
}: {
  onAttachAdd: (attachment: Attachment) => void;
  rootRef: RefObject<HTMLDivElement | null>;
}): AttachmentIntake {
  const [dragging, setDragging] = useState(false);
  /** A2 (UI I-9): oversize-attachment / FileReader-error notice — surfaced
   * through the permanently-mounted `LiveRegion` below (Finding-7 discipline:
   * the region itself is never conditionally mounted, only this text is
   * swapped). Empty string = no notice. */
  const [attachNotice, setAttachNotice] = useState('');
  /** Task 21 (WCAG 4.1.3): `attachNotice` above only ever announces FAILURE —
   * a successful attach was silent to assistive tech. Surfaced through its
   * own permanently-mounted `LiveRegion` (Finding-7 discipline: mounted
   * empty, text swaps per attach) so a screen-reader user gets the same
   * confirmation a sighted user gets from the new chip appearing. */
  const [attachAnnounce, setAttachAnnounce] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

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
        // P7-N1: appended at the REDUCER (onAttachAdd -> the tab's attachment-
        // add action), not via a whole-array controlled write here —
        // reader.onload resolves ASYNCHRONOUSLY, so two readers resolving
        // close together would race a stale attachments-array prop and drop a
        // sibling file. The reducer's append is atomic per dispatch instead.
        const raw = String(reader.result);
        const base64 = raw.slice(raw.indexOf(',') + 1);
        onAttachAdd({ ...meta, dataUri: `data:${mime};base64,${base64}` });
        // Task 21 (WCAG 4.1.3): announce the success too — until now only
        // the failure branches (oversize / reader.onerror, above) spoke.
        setAttachAnnounce(`Attached "${file.name}"`);
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

  const resetForTab = () => {
    setDragging(false);
    setAttachNotice('');
  };

  return {
    dragging,
    attachNotice,
    setAttachNotice,
    attachAnnounce,
    fileInputRef,
    imageInputRef,
    addFiles,
    onDragOver,
    onDragLeave,
    onDrop,
    onPaste,
    resetForTab,
  };
}
