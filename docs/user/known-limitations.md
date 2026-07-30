# Known limitations

A short, honest list of things Talaria Code doesn't do yet — worth knowing
before you file a bug, because these are expected for now rather than broken.

## The agent reads files from disk, so save before you ask

When you ask the agent about a file, it reads what's on disk — not what's in
your editor at that moment. If you have unsaved changes, the agent won't see
them. Save the file first (or turn on autosave) and the agent picks up your
latest edits. This is a limitation of the current agent backend, not of the
extension, and it's the first thing to check if the agent seems to be looking
at an older version of your code.

## Switching the model mid-session can drop search and language tools

If you change the model in the middle of a session, the agent may lose its
codebase-search and language-server (LSP) tools until you start a new session.
Symptom: the agent suddenly can't search your code or answer "where is this
defined?" the way it could a moment ago. The fix is to open a new session
after switching models. This too lives in the agent backend; a proper fix is
tracked upstream.

## Next Edit highlights aren't announced by screen readers

Next Edit Suggestions draw their inline preview using editor decorations, and
VS Code doesn't expose those to screen readers. If you rely on a screen
reader, the suggestion's highlighted text won't be read aloud — the jump and
accept commands still work, but the visual preview isn't accessible yet. The
rest of the panel (chat, approvals, the diff view) is built to be announced
normally; this gap is specific to the inline Next Edit decoration.
