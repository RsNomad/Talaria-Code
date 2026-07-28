# Packaging (per-platform `.vsix`)

**P0 constraint (architecture-review.md GZ1):** Hermes ships a native module,
`@lancedb/lancedb` (napi-rs / N-API). LanceDB distributes one prebuilt binary
package *per OS+arch+libc* as an `optionalDependency`:

- `@lancedb/lancedb-linux-x64-gnu` (Fedora/most desktop Linux, glibc)
- `@lancedb/lancedb-linux-arm64-gnu`
- `@lancedb/lancedb-linux-x64-musl` / `-linux-arm64-musl` (Alpine-style, musl libc)
- `@lancedb/lancedb-win32-x64-msvc` / `-win32-arm64-msvc`
- `@lancedb/lancedb-darwin-arm64`

`npm install` only fetches the ONE binary package that matches the machine you
run it on. **The `.vsix` you build only ever contains the binary that was
present in `node_modules` at packaging time** — there is no "universal"
LanceDB binary.

## The rule

> **A `.vsix` built on this Windows dev box ships the `win32-x64-msvc`
> binary and will NOT run on Fedora.** The real release artifact must be
> built *for* the target platform, not on whatever box happens to run the
> build.

Fedora (the actual deployment target for this extension) is glibc-based x86_64
(or aarch64), so the artifact that matters is `linux-x64` (and `linux-arm64`
for ARM hosts).

## How to build the Fedora artifact

### Option A — build on Fedora (or a Fedora/glibc-matching CI runner)

On the target OS/arch, a plain install already resolves the right optional
binary:

```bash
npm ci
npm run build
npx vsce package --target linux-x64   # or linux-arm64
```

### Option B — cross-install from the Windows/macOS dev box

npm (≥ 8.something with the `--os`/`--cpu`/`--libc` flags) can fetch a
*different* platform's optional dependencies without actually running on that
platform:

```bash
npm install --os=linux --cpu=x64 --libc=glibc
npm run build
npx vsce package --target linux-x64
```

This forces npm to resolve `@lancedb/lancedb-linux-x64-gnu` (and skip the
`win32-x64-msvc` one) even though the host machine is Windows. Re-run a plain
`npm install` afterwards to restore the normal Windows dev-box `node_modules`
before continuing local development.

### npm scripts

Two convenience scripts wrap `vsce package --target`:

```jsonc
"package:linux-x64": "vsce package --target linux-x64",
"package:linux-arm64": "vsce package --target linux-arm64",
```

`--target` does two things: (1) it tags the produced `.vsix`'s manifest so
the Marketplace/`code --install-extension` picks it for matching machines,
and (2) `vsce` only includes the platform-specific `optionalDependencies`
that are actually resolved in the local `node_modules` for that target — so
the platform binaries **must already be installed** (via Option A or B above)
before running the script; `vsce` does not fetch them for you.

### CI (recommended, not yet wired)

Run a build matrix with one job per target (`linux-x64`, `linux-arm64`, and
optionally `win32-x64`/`darwin-arm64` if those platforms are ever supported),
each either running natively on that OS/arch or cross-installing via
`--os`/`--cpu`/`--libc` as in Option B, then uploading the resulting `.vsix`
as a release artifact. A guard step should fail the build if `npx vsce ls`
for that target is missing any of: the matching
`@lancedb/lancedb-<os>-<arch>-*` binary, `apache-arrow`, `reflect-metadata`,
`flatbuffers`, `tslib`, `web-tree-sitter`, `tree-sitter-wasms`, or
`@vscode/codicons` (see `.vscodeignore` for the full annotated allow-list and
why each package is required at runtime).

## Verifying the dependency closure (any platform, including this Windows box)

`npx vsce ls` prints the exact file manifest of what the `.vsix` would
contain, without needing a matching-platform binary present — it is safe to
run on Windows to confirm the *closure* is correct, even though the LanceDB
binary it lists will be `win32-x64-msvc` here. Look for:

- `node_modules/@lancedb/lancedb/**` and the platform binary package
  (`@lancedb/lancedb-<os>-<arch>-*`)
- `node_modules/apache-arrow/**`, `node_modules/reflect-metadata/**`
- `node_modules/flatbuffers/**`, `node_modules/tslib/**` (apache-arrow's own
  runtime dependencies — hoisted to root `node_modules`, easy to miss)
- `node_modules/web-tree-sitter/**`, `node_modules/tree-sitter-wasms/**`
- `node_modules/@vscode/codicons/**` (webview icon font: `codicon.css` +
  `codicon.ttf`)

A **Fedora-runnable** `.vsix` additionally requires that the LanceDB binary
in that manifest be `linux-x64-gnu` (or `linux-arm64-gnu`), which only happens
when packaging was done per Option A or B above — not on a plain Windows
`npm install`.
