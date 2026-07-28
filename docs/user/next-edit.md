# Next Edit Suggestions

**Next Edit Suggestions** is an opt-in layer on top of Hermes autocomplete. Where
FIM (fill-in-the-middle) completes the current line, Next Edit looks at the
small region around your cursor — about ten lines above and ten lines below —
and proposes a rewrite of that region: fixing up a variable you renamed
elsewhere, finishing a change you started a few lines up, that kind of thing.
It does **not** jump to distant parts of the file; it only ever rewrites the
window right around where you're typing.

It is **off by default**, like every next-edit setting. Nothing about it runs
until you turn it on.

## The two sources, and the two models

Next Edit has two independent sources you can enable. They are mutually
exclusive — turning one on while the other is already on is refused (see
[Turning it on](#turning-it-on) below).

| Source | Model | Endpoint | Notes |
| --- | --- | --- | --- |
| **NEXT** | `sweep-next-edit-v2-7B` | its own endpoint (`talaria.nextEdit.endpoint`) | A dedicated next-edit model with its own request format. **This model has no published benchmark score** — the only number that ever circulated for a "sweep next-edit" model belongs to a different, unreleased model, not this one. Treat its quality as unmeasured. |
| **Generic** | whatever `talaria.autocomplete.model` is currently set to | your existing FIM endpoint (`talaria.autocomplete.endpoint`) | Reuses the same model and endpoint your FIM completions already use, with a different request shape (an instruction prompt) that asks the model to emulate a next-edit rewrite. See below for what model that actually is and what its quality figure does and doesn't cover. |

FIM's model is whatever `talaria.autocomplete.model` is set to in
`settings.json` — that setting is data (which model to use), not one of the
on/off toggles covered in [Turning it on](#turning-it-on). **The shipped
default is `qwen2.5-coder:1.5b-base`.** If you've never touched that setting,
that's what's serving your FIM completions today — and, if you turn Generic
on, your Generic next-edit suggestions too, since Generic rides the same
model. If you want a bigger model, set `talaria.autocomplete.model` to
`qwen2.5-coder:7b-base` — **not** `qwen2.5-coder:7b`. On Ollama the bare
`:7b` tag is the *instruct* build (same digest as `:7b-instruct` and
`:latest`), and instruction tuning costs infilling quality, which is exactly
what autocomplete does. Hermes cannot warn you about this: its known-model
check matches on "qwen" and "coder", so `:7b` looks recognised and the
degradation is silent. The measured gap between `1.5b-base` and `7b-base` on
infilling benchmarks is small (roughly 3 points), so the bigger model is a
modest gain for four times the weight.

Turning NEXT or Generic on or off never changes FIM itself: it keeps
completing the current line from `talaria.autocomplete.endpoint` exactly as it
does today, on whatever model that endpoint is configured for.

Generic's **vendor-reported quality figure — 55.62% (vendor-reported,
unreplicated), roughly every second suggestion expected to be wrong — was
measured specifically against `qwen2.5-coder:7b`.** It is not a measurement of
`qwen2.5-coder:1.5b-base` or of any other model you might have configured.
Review every Generic suggestion before accepting it regardless of which model
is behind it.

Nothing auto-applies, but be clear about what "reviewing" a proposal actually
means here: **there is no diff.** What you see is a tinted background over
the whole region under consideration (about ten lines above and ten lines
below your cursor — roughly twenty lines) and a small label at the end of
your current line reading `Tab to jump`. The proposed replacement text itself
is never shown before you accept it.

Pressing **Tab** the first time does not move your cursor or scroll
anything — the region already surrounds your cursor, so there is nowhere to
jump to. Its only visible effect is that the label flips to `Tab to accept`.
Pressing **Tab** again applies the edit: the entire tinted region is replaced
with the model's output in one go, which is the first time you actually see
what it wrote. Press **Esc** at any point before that second Tab to dismiss
the proposal with no change made.

Because you are accepting a rewrite you have not previewed, `Ctrl+Z` is your
real review step: if the result isn't what you wanted, undo it immediately,
the same as any other edit.

## Turning it on

**The NEXT and Generic switches live in Hermes's own Settings panel inside the
editor — they are not VS Code settings, and they are not something you edit in
`settings.json`.** `settings.json` only ever carries *data* for Next Edit
(which endpoint, which model, which backend) — never the on/off state. Open
the Hermes Settings panel and use the two rows under **"Next Edit
Suggestions"**:

- **Next Edit — dedicated model** (the NEXT source)
- **Next Edit — Generic via your FIM model** (the Generic source)

Two rules the panel enforces, both worth knowing before you rely on them:

1. **Turning on the second source while the first is already on is refused.**
   If NEXT is on and you flip Generic on, the request is rejected outright —
   the switch snaps back to off, nothing is saved, and you get a warning
   naming which source to turn off first. Turn it off explicitly, then turn
   the other one on.
2. **A conflicting saved state is never honored.** If Next Edit's internal
   state is ever found holding *both* sources on at startup — for example
   because of a bug, or because someone edited the extension's stored state by
   hand outside the Settings panel — Hermes does not try to reconcile it. It
   resets **both sources to off**, saves that reset, and shows a one-time
   notice. You'll need to re-enable whichever source you actually want from
   the Settings panel.

**NEXT needs `talaria.nextEdit.model` set by hand — nothing in the panel does
it for you.** The switch only turns the source on; it does not pick a model.
If you flip NEXT on without having set `talaria.nextEdit.model`, the first
time Next Edit would otherwise try to build a suggestion, Hermes shows a
one-time warning telling you to set `talaria.nextEdit.model` (for example to
`sweep-next-edit-v2-7B`), together with `talaria.nextEdit.endpoint` if your
model isn't on the default port. Until you set it, NEXT stays on but never
produces a suggestion.

### `settings.json` reference (data only — never the on/off state)

| Setting | Purpose | Default |
| --- | --- | --- |
| `talaria.nextEdit.endpoint` | The NEXT source's server URL. Leave empty to use the backend's default (`http://127.0.0.1:11434` for Ollama, `http://127.0.0.1:8000` for an OpenAI-compatible server). | `''` |
| `talaria.nextEdit.model` | The NEXT source's model — `sweep-next-edit-v2-7B` for the officially supported setup. | `''` |
| `talaria.nextEdit.backend` | The NEXT source's transport: `ollama` or `openai-compat`. | `ollama` |

The Generic source has no settings of its own — by design, it rides whatever
`talaria.autocomplete.*` is already configured for FIM (see Scenario 3 below).

## The three supported scenarios

### Scenario 1 — FIM + NEXT (two endpoints, two backends, no conflict)

Turn NEXT on, leave Generic off. FIM keeps completing the current line from
`talaria.autocomplete.endpoint`; NEXT proposes rewrites of the region around
your cursor from its own `talaria.nextEdit.endpoint`, on its own model
(`sweep-next-edit-v2-7B`). The two never compete for the same request: only
one of them is ever building a request at a time (Next Edit steps aside
whenever FIM's ghost text is on screen or in flight), so there's no scenario
where they interfere with each other — just two endpoints, on two backends
if you want, doing two different jobs.

This is the setup to use if you're able to run the dedicated NEXT model. Keep
in mind it has no published benchmark score, so judge it on how it performs
for you.

### Scenario 2 — FIM only (both Next Edit sources off)

The default. Leave both NEXT and Generic off and you get plain FIM
autocomplete, unchanged — no next-edit requests are ever built, no next-edit
endpoint is ever contacted.

### Scenario 3 — FIM + Generic (everything rides the main FIM endpoint)

Turn Generic on, leave NEXT off. There is no second endpoint and no second
model here: Generic sends its requests to your existing
`talaria.autocomplete.endpoint`, using your existing `talaria.autocomplete.model`
— it just asks that same model a differently-shaped question (an instruction
prompt) to emulate a next-edit rewrite. The moment you accept the Generic
toggle, Hermes shows a one-time setup note explaining the recipe below — it
does not appear again after that.

**Check which model that actually is before you judge the results.** Open
`settings.json` and look at `talaria.autocomplete.model` (it can never be
empty — an unset value silently falls back to the shipped default, it never
serves an empty string). If it's still `qwen2.5-coder:1.5b-base` (the shipped
default), that's the model Generic will use too, and the 55.62% quality
figure above doesn't apply to it — that number was measured on
`qwen2.5-coder:7b`. If you want to move to a 7B model, use
`qwen2.5-coder:7b-base` rather than the bare `:7b` tag — see the note above
on why. Note also that the vendor did not state which 7B variant the 55.62%
was measured on, so treat it as an order of magnitude, not a promise about
your setup.

#### The recipe: set `OLLAMA_CONTEXT_LENGTH=16384` on your Ollama server

If your FIM backend is Ollama, do this before relying on Generic:

```
Environment="OLLAMA_CONTEXT_LENGTH=16384"
```

Concretely, on a systemd-managed Ollama service (the normal case on Fedora):

```bash
sudo systemctl edit ollama.service
```

add the two lines

```ini
[Service]
Environment="OLLAMA_CONTEXT_LENGTH=16384"
```

then

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

(Running Ollama by hand instead of as a service? The equivalent is
`OLLAMA_CONTEXT_LENGTH=16384 ollama serve`.)

**Why this matters.** Ollama auto-sizes a model's context window based on your
GPU's VRAM, and below 23 GiB of VRAM that auto-sized default is **4096
tokens**. Generic's prompt — the whole recent-changes history plus the file
content it sends — measures roughly **6,000 tokens** (vendor-reported,
±2,500). That doesn't fit in a 4096-token window. Hermes has no way to detect
this from the client side, so nothing stops the request from going out — it
just gets silently truncated on the server before the model ever sees the
whole thing, and you get a plausible-looking but quietly-wrong suggestion,
built from a truncated prompt. Setting `OLLAMA_CONTEXT_LENGTH=16384` raises
the server's default so both your FIM requests and Generic's requests fit
comfortably.

**Why raising the shared default is safe, and doesn't cause reload churn.**
Hermes never sends a per-request context size on any next-edit or FIM
request — there is no code path anywhere in the extension that sends a
context-window override. Both your FIM requests and Generic's requests are
always "auto" as far as Ollama is concerned. Ollama only has to reload a
model when two callers ask for genuinely *different* context configurations —
which does not happen here, because both callers are auto and therefore
resolve to the *same* value. (The case that WOULD cause repeated reloads is
one caller sending an explicit context size while another sends auto — Hermes
never does that itself, so switching between FIM and Generic on the same
model doesn't thrash the server.) Raising `OLLAMA_CONTEXT_LENGTH` just raises
the one shared number both sides land on.

**If your FIM backend is llama.cpp or vLLM instead:** neither needs this
environment variable. Both runners fix their context size once, at server
startup (llama.cpp's `--ctx-size`, vLLM's `max_model_len`) — there is no
per-request auto-sizing to trip over, so there is no truncation trap to guard
against here. Just make sure whatever startup context size you already chose
is large enough for Generic's ~6k-token prompt.

**Keep-alive.** Every next-edit request to Ollama (from either NEXT or
Generic) asks it to keep the model loaded for 30 minutes after that request.
Since Generic's requests land on the exact same model your FIM requests
already use, the two keep each other's model warm — you shouldn't see the
model repeatedly evicted and reloaded just from switching between typing
(FIM) and a next-edit suggestion (Generic) on the same file.

#### Remote endpoints: the two-box rule

If `talaria.nextEdit.endpoint` or `talaria.autocomplete.endpoint` points at a
machine other than your own (a GPU box on your LAN, say) **and** you've
configured an API key for it, Hermes refuses to send that key over plain
`http://` to a non-local host — sending a credential in cleartext across a
real network is exactly the mistake this check exists to stop. You have two
ways around it: terminate TLS on the remote box so the endpoint is `https://`,
or put it behind a tunnel (SSH port-forward, WireGuard, etc.) so that from
your machine's point of view the endpoint is still `http://127.0.0.1:<port>`.
A local, loopback endpoint with no API key is never affected by this check.

## What Next Edit deliberately does not do

Hermes never measures your GPU's VRAM, never detects what hardware you're
running, and never checks whether a model actually fits before sending a
request. Sizing your setup — which model, which context length, whether NEXT
and Generic can coexist on the same card as your FIM model — is entirely on
you. The `OLLAMA_CONTEXT_LENGTH` recipe above and the one-time setup note are
the only help Hermes offers here; nothing in the extension inspects your
server or your hardware to do this automatically.
