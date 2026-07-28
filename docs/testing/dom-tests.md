# DOM tests — what they prove, and what they do not

**One-line version:** *the DOM suite proves the panel's internal wiring; it proves nothing about whether the
panel appears, looks right, or is announced.*

## When a DOM test earns its cost

A DOM test earns its cost only when the thing being asserted is **wiring** — that a decision reaches the
screen, that an interaction reaches a handler, that an attribute reaches an element.

If the assertion is about a **decision**, it belongs in a pure test and it is already there. Do not convert
the pure extractions. In particular `webview/src/panels/SettingsPanel.test.ts` holds
character-for-character copy locks on exported data, and rendered text goes through whitespace
normalisation — converting it would be a **downgrade**, not an upgrade.

## What a green DOM suite still does not prove

1. **Nothing about the real VS Code webview.** It runs in an Electron `<iframe>` under a Content-Security
   Policy, loading the built bundle via `asWebviewUri`. jsdom has no CSP, no `acquireVsCodeApi`, no
   `postMessage` boundary. **A CSP violation that blanks the panel in production is invisible to every test
   here.**
2. **Nothing about theming.** Tailwind classes are strings to jsdom. No stylesheet is applied and no VS Code
   theme variable is resolved, so nothing here says whether text is legible or even visible.
3. **Nothing about layout, visibility, or overflow.** jsdom has no layout engine; every element has zero
   dimensions. "Present" means *in the accessibility tree*, not *on the screen* — an element hidden by CSS
   still passes `toBeInTheDocument()`.
4. **Nothing about screen-reader announcement.** `role="status"` being in the DOM is not NVDA or Orca
   announcing it. These tests prove the contract we chose; they do not prove the user heard it. On the
   Fedora ship target that means Orca, untested.
5. **Nothing about the build.** These import TypeScript source through Vite's transform, not the Rollup
   bundle that ships. A bundling failure passes every DOM test.
6. **Nothing about the host↔webview RPC in situ.** The bridge is mocked or bypassed. Message-shape drift
   remains the job of the pure protocol tests.

## Layout

- `vitest.config.ts` (repo root) — three disjoint projects: `host`, `webview-pure`, `webview-dom`.
- `webview/test/dom-setup.ts` — jest-dom matchers + manual `cleanup()` (globals are off, so RTL's
  auto-cleanup does not install itself).
- DOM tests are named `*.dom.test.tsx` and live beside the component they render.

## The suffix is load-bearing

A DOM test **must** be named `*.dom.test.tsx`. That suffix is the only thing that routes a file into the
jsdom project.

- Name it `*.test.tsx` (no `.dom`) and **it matches no project at all** — it will not run, and the suite
  stays green while silently ignoring it.
- Name it `*.dom.test.ts` (no `x`) and the same thing happens.

There is no glob in `vitest.config.ts` that catches a mis-suffixed file, by construction: the projects are
disjoint so that `host` can never pick up a webview file. The cost of that disjointness is that a typo in a
filename is silent. When adding a DOM test, confirm it actually ran:

```bash
npx vitest run --project=webview-dom --reporter=dot   # the file count must go up
```

## Environment cost — read before adding the third DOM file

Each jsdom file costs roughly **1.1 s** of the `environment` figure. Measured on this repo at the time
`vitest.config.ts` was added, full-suite `npx vitest run`:

| DOM files | `environment` | wall-clock |
| --------: | ------------: | ---------: |
|         0 |          13ms |     25.6 s |
|         2 |        2.13 s |     26.5 s |
|         3 |    **3.28 s** |     26.0 s |
|         5 |    **5.74 s** |     26.9 s |

The wave's ceiling is **`environment` ≤ 3000 ms** (and wall-clock ≤ 35 s). Wall-clock has plenty of headroom
— jsdom construction parallelises across workers — but **the `environment` ceiling is crossed at the third
DOM file.**

So the jsdom-vs-happy-dom question is not settled by the config landing green; it becomes live the moment a
third DOM test exists. ADR-015 chose jsdom on **fidelity** (a false green on an a11y assertion is worse than
no test), and that argument does not weaken under load. If the ceiling has to give, the options are, in
order: (a) re-examine whether the ceiling is measuring anything that matters, since wall-clock — the figure
a developer actually waits on — barely moves; (b) swap the one `webview-dom` project to `happy-dom`, a
one-line change, and re-validate the a11y assertions that motivated jsdom.

Do not swap silently. The choice is recorded in ADR-015 with reasons.
