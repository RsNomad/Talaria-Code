# Which model does what: three roles, two settings

Hermes has **three** model roles but only **two** model settings. Nothing detects, measures, or manages this
for you — the settings are yours, and this page is the map.

| Role | Model setting | Endpoint | What it sends |
|---|---|---|---|
| **Autocomplete (FIM)** | `hermes.autocomplete.model` | `hermes.autocomplete.endpoint` | Raw fill-in-the-middle tokens |
| **Next Edit — Generic via your FIM model** | **the same** `hermes.autocomplete.model` | **the same** `hermes.autocomplete.endpoint` | A ChatML instruction prompt |
| **Next Edit — dedicated model** | `hermes.nextEdit.model` | `hermes.nextEdit.endpoint` | The sweep-v2 format |

The two Next Edit role names above are the row labels you will see in the panel. They are **mutually
exclusive** — turning one on while the other is on is refused.

**There is no separate Generic model, by design.** Generic rides the FIM model on the FIM endpoint. The
`hermes.nextEdit.backend` setting says so in its own description: *"Generic always uses the FIM model on
`#hermes.autocomplete.endpoint#`, never this setting."* — and `hermes.nextEdit.endpoint`'s description says
the same about the endpoint half. Setting `hermes.nextEdit.model` has no effect whatsoever on Generic.

## Where each of these lives — and it is two different places

This trips people up, so it is worth being blunt about:

- **The model and endpoint settings above are `settings.json` data** — which model, which URL. Edit them
  the way you edit any VS Code setting.
- **The Next Edit on/off toggles are NOT `settings.json` settings and never will be.** They live in the
  extension's own **Settings panel**, under «Next Edit Suggestions». You will not find
  `hermes.nextEdit.enabled` or `hermes.nextEdit.generic` in your settings file, because no such keys exist.

So: `settings.json` carries the DATA, the Settings panel carries the STATE. Nothing on this page asks you to
turn a feature on by editing a settings file.

## The tension this creates

**FIM wants a base model. Generic wants an instruct model. One setting drives both.**

Autocomplete sends raw FIM tokens, which is a base-model interaction — Qwen's own model card for
`Qwen/Qwen2.5-Coder-1.5B` names fill-in-the-middle as an intended use of the *base* model and says *"We do
not recommend using base language models for conversations."* Generic sends an instruction prompt that opens
an assistant turn and pre-writes its first sentence, which is an instruct-model interaction. There is no
single model that is ideal for both.

**Our recommendation: use a `-base` model.** The shipped default, `qwen2.5-coder:1.5b-base`, already is one,
so if you have never touched the setting there is nothing to do. If you want the bigger model, set
`hermes.autocomplete.model` to `qwen2.5-coder:7b-base` — see the warning below about the bare `:7b` tag.

The reason is priority, not quality: autocomplete is **on by default** and runs while you type, while both
Next Edit sources are **off by default**. The default should serve the always-on route.

**The honest uncertainty.** Base is *probably* right, and there is a hint that supports it: the vendor's own
55.62% benchmark figure for the generic-instruct approach appears to have been measured on a **base** model,
which would help explain why it is so low for an instruction-shaped prompt.

But be clear about how weak that hint is, because it chains two uncertain findings:

1. **The vendor never states which variant it used.** That it was the base model is an inference from
   naming conventions in the vendor's own benchmark table — it lists models by their exact repository ids,
   and the word "Instruct" appears nowhere in the post. Strong, but circumstantial. There is no vendor
   statement to point at.
2. **Nobody has compared base against instruct on this specific setup.** No head-to-head exists, so "the
   figure was low because the model was base" is a plausible explanation, not a measured one.

An inference resting on a second inference is not an argument you should let decide your configuration.
**This one is settled by trying it on your own code, not by argument.** If you run Generic heavily and find
its output poor, an instruct model is a reasonable experiment — at a cost to your autocomplete quality that
nothing will warn you about.

The 55.62% figure itself stays what it always was: **vendor-reported and unreplicated**, and measured
against the model it was measured against, not against whatever you have configured. Roughly every second
suggestion is expected to be wrong. Review all of them.

> **Careful with the bare `:7b` tag.** On Ollama, `qwen2.5-coder:7b` is the **instruct** build — it resolves
> to the same digest (`dae161e27b0e`) as `:7b-instruct` and `:latest`, while `:7b-base` is a genuinely
> different artifact (`bd8755145f1c`). If you want the 7B base model you must write `qwen2.5-coder:7b-base`.
> Hermes cannot warn you: it recognises the model by the words "qwen" and "coder", so the bare tag looks
> recognised, works mechanically, and is quietly worse at infilling. There is no client-side check that can
> catch this — the model is present, recognised, and functional; it is only wrong in a way nothing local can
> see.

## Running FIM and Next Edit at the same time

If you enable the **dedicated** Next Edit model while autocomplete is on, **your machine loads two models at
once**. For a 7B pair that is roughly 4.7 GB of weights for the Qwen side and about 4.7–5.4 GB for a
4-bit-to-5-bit sweep-v2 GGUF, plus each model's context allocation on top — call it somewhere in the region
of 16 GB of VRAM in practice. Treat that as a rule of thumb, not a measurement: the real number depends on
your quantisation and the context length you configure, and it is yours to work out.

**Hermes does not check any of this.** It never measures VRAM, never detects your hardware, never counts
loaded models, and never decides whether a model fits. That is deliberate, and it is a rule the codebase
holds itself to rather than an oversight. If the two do not fit together, you will see it as slow responses
or as your server evicting one model to load the other — so pick sizes that fit, or run one feature at a
time.

**Generic mode exists partly for this reason:** it reuses the model autocomplete has already loaded, so it
costs no additional memory. That is the trade this whole page is about — Generic is free on memory and
constrained on model choice; the dedicated model is unconstrained on model choice and costs you a second
resident model.

## See also

- [`next-edit.md`](next-edit.md) — what Next Edit does, how to turn it on, and what accepting a proposal
  actually looks like.
