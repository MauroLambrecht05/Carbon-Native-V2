# Bun toolchain for Bazel

Bazel has no first-party Bun support and there is no `rules_bun` in the Bazel
Central Registry, so carbon-native declares its own. It is small on purpose:
download a pinned Bun, register it as a toolchain, and give `bun_binary` /
`bun_test` to the rest of the workspace.

```starlark
load("//.tools/orchestration/bazel/bun:defs.bzl", "bun_binary", "bun_test")

bun_binary(
    name = "carbon",
    entry = "src/main.ts",
    srcs = [":srcs"],
    data = ["//solutions/internal/ts/shared:srcs"],
)
```

```sh
bazel run  //products/carbon-cli:carbon -- dev ./my-app
bazel test //solutions/internal/ts/updater:rollout_test
```

## Why not rules_js

`MODULE.bazel` used to declare `rules_js` and `rules_ts`. Neither ever
resolved — in the registry those modules are named `aspect_rules_js` /
`aspect_rules_ts`, so `bazel query //...` failed at module resolution before
reaching a single BUILD file.

They were removed rather than corrected, because `rules_js` supplies a **Node**
toolchain and this CLI is a Bun program:

| Site | Bun API |
|---|---|
| `pipeline/index.ts` | `Bun.build`, `Bun.file`, `Bun.BunPlugin` + a Vite-plugin→Bun.build adapter |
| `commands/doctor.ts` | `import { spawnSync } from "bun"` |
| `shared/src/paths.ts` | detects Bun's compiled-binary VFS (`$bunfs`, `~BUN`) |
| `build-cli.ts` | `bun build --compile --bytecode` |

Under Node the entrypoint loads and then dies on the first `bun` import
(verified: `--help` and `signer` run, `doctor` does not). Rewriting the
pipeline onto esbuild would regress the 95 ms warm rebundle that is the point
of the project.

## What this does not do

**It is not hermetic.** The launcher chdirs to `BUILD_WORKSPACE_DIRECTORY` and
runs bun against the real source tree. Bun resolves `node_modules` by walking
*up* from each importing file and resolves the `@carbon/*` aliases from the
`tsconfig.json` nearest that file; both need the real directory layout.
Reproducing them inside runfiles means making `node_modules` a Bazel input,
which needs npm rules this workspace does not have.

So Bazel is the **entrypoint** — one command, one dependency graph, targets
other rules can depend on — while Bun stays the runtime. `bazel run
//products/carbon-cli:carbon -- dev` and `bun products/carbon-cli/src/main.ts
dev` do the same work.

This is also why `package.json` and `bun.lock` still sit at the workspace root.
They cannot move until `node_modules` becomes a Bazel input; see "Making it
hermetic" below.

## Three platform quirks worth knowing

These each cost a debugging cycle and are commented at their call sites:

1. **`short_path` is not an rlocation.** For external repositories it comes
   back as `../<repo>/<path>`, expressed relative to the main workspace's
   directory inside runfiles. The runfiles root holds one directory per
   repository, so the `../` must be stripped, not followed. Following it gives
   "The system cannot find the path specified".

2. **Windows never materialises the runfiles tree.** Without `--enable_runfiles`
   (which itself needs Developer Mode or admin for symlinks) the runfiles
   directory contains only `_main/`, and even that is empty — everything is
   reachable only through `MANIFEST`. Both launchers fall back to parsing it.

3. **`.bat` files need CRLF.** With LF-only endings `cmd.exe` mis-parses
   multi-line `if (...)` blocks; the symptom is nonsense like
   `'tlocal' is not recognized as an internal or external command`.

And one Bun quirk: `bun test <path>` treats a bare path as a name *filter*, not
a path. It needs a `./` prefix — but only in the workspace-relative form, since
the `MANIFEST` fallback yields an absolute path.

## Pinning

`MODULE.bazel` pins the Bun release:

```starlark
bun.toolchain(version = "1.3.10")
```

**The downloads are not integrity-checked yet.** `repositories.bzl` calls
`download_and_extract` without a `sha256`, so Bazel warns on first fetch and
verifies nothing. Pin the hashes before this is used for release builds — an
unpinned toolchain download is exactly the supply-chain hole `@carbon/signer`
exists to close elsewhere.

Platforms covered: `windows-x64`, `linux-x64`, `linux-aarch64`, `darwin-x64`,
`darwin-aarch64`. Only `windows-x64` has actually been exercised.

## Making it hermetic

The missing piece is `node_modules` as a Bazel input. That is the one job
`rules_js` does well, and it would mean adding `aspect_rules_js` back purely
for `npm_translate_lock`, fed a lockfile it understands — pnpm, npm or yarn,
**not** `bun.lock`. That is the trade: a root `pnpm-lock.yaml` replaces the
root `bun.lock`, and the dev loop starts paying a runfiles-materialisation cost
on every invocation.
