# Architecture

Talaria Code is a VS Code extension that puts a coding agent and local model
completions into the editor. This document explains how the pieces fit together,
so you can find your way around the source without reading all of it first.

## Two halves

The extension is split into a **host** and a **webview**, and they don't share a
runtime.

The host is plain TypeScript running in VS Code's extension process. It can touch
the filesystem, the network, child processes — everything a Node program can do.
esbuild bundles it to `dist/extension.js`; the source is under `src/`.

The webview is a React app (`webview/`, built with Vite to `dist/webview/`). It
draws the panel in the sidebar and nothing else. It can't read a file, spawn a
process, or open a socket. When it needs something done, it asks the host.

The two talk over one typed message channel in `src/shared/protocol.ts`. Every
message the host sends the webview, and every message back, is a variant in that
file — if it isn't in the protocol, it doesn't cross the boundary. This is the
one rule worth internalizing before you change anything: **the webview is a view,
the host is the authority.** Keeping that line sharp is why file access, model
endpoints, and approvals stay unreachable from the UI layer even when a bug
tries to reach them.

## What the host does

Three subsystems live in the host, and they're more independent than they look.

**The agent.** Talaria drives the [Hermes](https://github.com/nousresearch/hermes-agent) agent over the
Agent Client Protocol (ACP): the chat you talk to, the edits it proposes, the
tools it calls, the MCP servers it connects. The ACP client and session
machinery sit under `src/host/backend/`. Edits never land silently — every write
is proposed back to you and waits for an explicit yes or no, gated on the
approval path in `src/host/backend/acp/`.

**Completions.** Inline completion (fill-in-the-middle) and next-edit
suggestions are a separate engine under `src/autocomplete/`. It does not go
through Hermes. It talks straight to whatever model runtime you point it at —
Ollama, vLLM, or llama.cpp — because a path that runs on every keystroke can't
afford the extra hop. The two suggestion formats live in
`src/autocomplete/nextedit/formats/`.

**Codebase search.** The index under `src/rag/` chunks your code with
tree-sitter, embeds the chunks, and keeps the vectors in LanceDB on disk. It's
handed to the agent as an MCP tool, so an answer can be grounded in your actual
code instead of guessed.

## Where the guardrails are

The point of Talaria is that your code stays on hardware you control. A few
boundaries enforce that, and each one fails toward doing less rather than more.

Whatever the completion engine is about to send gets scanned first
(`src/autocomplete/context/`), and a build-time check (`assertAllScanned`) fails
the build if any send path could skip the scan. Secrets and credential-shaped
files are stripped before the request leaves.

Permission prompts have a deadline. Miss it and the answer is **no** — a prompt
that times out is never read as consent.

The agent is boxed into the workspace. Paths that try to climb out (`..`,
absolute system paths) are refused, not resolved.

And the settings that decide which model and backend you talk to are
machine-scoped on purpose, so a repository you open can't quietly repoint the
agent at some other endpoint.

## The build

One `npm install` sets up both bundles — they're npm workspaces. `npm run build`
produces the two `dist/` outputs; `npm run package` wraps them into a `.vsix`.
Press F5 in VS Code to launch everything in a development host against a scripted
mock backend: no Hermes process, no models, runs on any OS. That mock is also how
most of the test suite runs, which is why the suite is fast and needs no GPU.

## Reading order

New to the code? Start with `src/shared/protocol.ts` — the message types are the
contract everything else obeys. Then `src/extension.ts`, the entry point that
wires the subsystems together. From there, pick the subsystem you care about and
follow it down.
