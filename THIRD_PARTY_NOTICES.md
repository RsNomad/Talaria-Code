# Third-Party Notices

Talaria Code is licensed under **GPL-3.0-or-later** (see [`LICENSE`](./LICENSE)).
Copyright © 2026 Syntinal.

This product bundles and/or redistributes the third-party components listed
below. Each remains under its own license; those licenses are reproduced or
referenced here to satisfy their attribution and notice requirements. Nothing
in this file alters the license of Talaria Code itself.

> Build-only tooling (esbuild, TypeScript, Vite, Vitest, Tailwind, PostCSS,
> `lightningcss`, etc.) is **not** distributed inside the packaged extension and
> is therefore not listed here. In particular `lightningcss` (MPL-2.0) is a
> build-time dependency only.

---

## Bundled runtime dependencies (shipped in the `.vsix`)

### @agentclientprotocol/sdk — Apache-2.0
Copyright © Zed Industries, Inc. and the Agent Client Protocol authors.
<https://github.com/agentclientprotocol/typescript-sdk>
Licensed under the Apache License, Version 2.0. A copy of the Apache-2.0
license is available at <https://www.apache.org/licenses/LICENSE-2.0>.

### @lancedb/lancedb — Apache-2.0
Copyright © The LanceDB Authors.
<https://github.com/lancedb/lancedb>
Licensed under the Apache License, Version 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>). This package additionally
redistributes its own third-party components; their notices ship inside the
package as `NODEJS_THIRD_PARTY_LICENSES.md` and `RUST_THIRD_PARTY_LICENSES.html`.

### @modelcontextprotocol/sdk — MIT
Copyright © 2024 Anthropic, PBC.
<https://github.com/modelcontextprotocol/typescript-sdk>

### ignore — MIT
Copyright © 2013 Kael Zhang and contributors.
<https://github.com/kaelzhang/node-ignore>

### web-tree-sitter — MIT
Copyright © 2018 Max Brunsfeld.
<https://github.com/tree-sitter/tree-sitter>

### tree-sitter-wasms — The Unlicense (public domain)
By Gregor and Menci.
<https://github.com/Gregoor/tree-sitter-wasms>
Released into the public domain under the Unlicense; attribution is provided
here as a courtesy and is not required.

### zod — MIT
Copyright © 2025 Colin McDonnell.
<https://github.com/colinhacks/zod>

### react, react-dom — MIT
Copyright © Meta Platforms, Inc. and affiliates (Facebook, Inc. and its affiliates).
<https://github.com/facebook/react>

### @vscode/codicons — icons: CC-BY-4.0, code: MIT
Copyright © Microsoft Corporation.
<https://github.com/microsoft/vscode-codicons>
The Codicon **icons** are licensed under Creative Commons Attribution 4.0
International (CC-BY-4.0, <https://creativecommons.org/licenses/by/4.0/>); the
accompanying font-generation code is licensed under MIT. This attribution
satisfies the CC-BY-4.0 credit requirement.

---

## The MIT License (full text, applicable to the MIT components above)

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime services (not bundled)

Talaria Code operates as a client of the **Hermes** agent (MIT) and connects to
model runtimes you host yourself (Ollama, vLLM, llama.cpp). These are separate
programs that you install and run; they are not distributed as part of this
extension and retain their own respective licenses.
