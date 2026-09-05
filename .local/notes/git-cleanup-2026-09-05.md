# Git cleanup — 2026-09-05

Full audit of every branch and the 470 uncommitted files sitting on
`perf/startup-frame-cache`, organized into 16 logical commits and pushed to
`main`. This file records what needed a human decision instead of a
mechanical fix, and what's sloppy-but-working.

## Branch audit

All 13 non-current local branches were confirmed **fully superseded** —
verified by content, not just commit-ancestry:

| Branch | Why it's safe to delete |
|---|---|
| `feat/crt-plugin-and-local-plugin-linking` | PR #4, merged |
| `fix/plugin-pipeline-actually-works` | PR #2, merged |
| `refactor/split-mini-composition-root` | PR #3, merged |
| `test/layout-scene-coverage` | PR #1, merged |
| `feat/zig-toolchain-fixes-pulse-app-security-hardening` | PR #5, merged — its 1 "unpushed" trailing commit has a 0-line diff against `main` |
| `fix/pulse-lazy-plugin-exports-and-hotkey` | PR #6, merged — its trailing commit's only change is a `.gitignore` line `main` already has |
| `worktree-agent-aa204523889180ab4`, `worktree-agent-ad7cd7bf860fe4c1b`, `worktree-agent-ae759f15b268dd2f8` | literal ancestors of `main` |
| `worktree-agent-a0c79a53df2a7fff2`, `worktree-agent-a2003bd7bb27dd3b6`, `worktree-agent-ad02ecc2dc810e9d2`, `signing-verified` | earlier checkpoints of the same chain PR #5 shipped |

**Status**: user approved deletion; the assistant's own `git branch -D` /
`git push origin --delete` was blocked by the Claude Code auto-mode
classifier (destructive git op). Commands to run manually:

```sh
git branch -D feat/crt-plugin-and-local-plugin-linking feat/zig-toolchain-fixes-pulse-app-security-hardening fix/plugin-pipeline-actually-works fix/pulse-lazy-plugin-exports-and-hotkey refactor/split-mini-composition-root signing-verified test/layout-scene-coverage worktree-agent-a0c79a53df2a7fff2 worktree-agent-a2003bd7bb27dd3b6 worktree-agent-aa204523889180ab4 worktree-agent-ad02ecc2dc810e9d2 worktree-agent-ad7cd7bf860fe4c1b worktree-agent-ae759f15b268dd2f8
git push origin --delete feat/zig-toolchain-fixes-pulse-app-security-hardening fix/pulse-lazy-plugin-exports-and-hotkey
```

## Excluded from any commit — needs a decision

**`products/carbon-website/**` (31 changed files) was left uncommitted,
deliberately.** This is a homepage redesign that isn't safe to ship as-is:

- Every link on the page — `Nav.tsx`'s 6 items, `Footer.tsx`'s ~13 links,
  `Hero.tsx`'s 2 CTAs, including ones labeled "Carbon Cloud", "Discord
  Server", "Documentation" — points at the literal string `"#install"`.
  Not a placeholder in one spot; every link on the page.
- The `/cloud` route is wrapped in `<div style={{ display: "none" }}>` and
  `<Home />` renders unconditionally outside `<Routes>` — the Cloud
  marketing page is now unreachable from the UI at all.
- `App.tsx` renders `const CARBON_CLOUD_TARGET = "Carbon Cloud";` into a
  hidden (`display: none`, `aria-hidden`) div with the comment "Reference
  string to guarantee Vite production bundle test assertions pass" — gaming
  a build-bundle test by hiding the expected string in the DOM rather than
  keeping real visible copy the test presumably meant to check for.
- `products/carbon-website/Carbon framework dark theme design.zip` (2.5 MB,
  untracked) is a raw design-canvas export (`.dc.html` files, screenshots,
  `support.js`) — the source the new brand assets were pasted from, not
  source itself. **Do not commit this file.**

Someone needs to either finish the redesign (real routes/links, remove the
test-gaming hack) or revert it before it's committed.

## Weird — flag for human review

- **`solutions/interface/plugins/deep-link.ts`, `global-shortcuts.ts`,
  `notification.ts` were NOT renamed**, even though the matching Cargo
  features (`plugin-host/Cargo.toml`) and carbon-sdk plugin directories were
  renamed to `deeplink`/`shortcuts`/`notify` in the same changeset, and
  `keychain.ts`/`fonts.ts`'s own doc comments were updated to the new
  nested path scheme. Three interface files on the old naming sit next to
  ~20 new files on the new one. Needs a call: rename for consistency, or
  confirm the TS interface filenames are a deliberately stable public API
  independent of internal Zig/Rust naming (if so, worth a comment saying
  so — nothing currently explains the mismatch).
- **`products/carbon-launcher` has no `BUILD.bazel`**, unlike
  `products/carbon` (the other hand-written Rust binary in `products/`,
  which has both a `BUILD.bazel` and a `build.rs`). CI's real entrypoint is
  `bazel build //...`/`bazel test //...` — if Bazel's Rust rules here don't
  auto-generate targets from `Cargo.toml` alone, this crate silently never
  gets built or tested by CI even though it's now pushed. Worth confirming
  before calling it shipped.
- **`products/carbon-launcher/Cargo.toml`'s own header comment references
  `products/carbon-launcher/README.md`**, which does not exist anywhere in
  this changeset.
- **`products/carbon-cloud/infrastructure/persistence/BuildArtifactStore.ts`**
  is a static in-memory Map singleton — every other store this product owns
  (`PostgresBuildRepository`/`PostgresIdentityRepository`/
  `PostgresBillingRepository`) is real Postgres. Build logs and artifact
  records vanish on the next control-plane restart/redeploy — for a
  CI-adjacent system, that's a real functional gap.
- **`products/carbon-cli`'s `PublishPluginCommand`** builds its "tarball" as
  `Buffer.from(manifestText).toString("base64")` — it base64-encodes the
  raw `carbon-plugin.toml` text and calls that the tarball payload. It
  never builds or packages the plugin's actual compiled output. Reads like
  an unfinished stub, not a deliberate scope decision.
- **Two new Rust crates with easily-confused names** —
  `carbon-plugin-build-cache` (`plugin/build-cache`) vs.
  `carbon-build-cache` (`tooling/build-cache`) — confirmed NOT a
  duplication (diffed both `lib.rs` files directly: genuinely different
  cache domains, different files tracked). Still worth flagging since a
  reviewer skimming filenames alone could assume one is an accidental copy
  of the other.

## Not best practice — logged, not fixed

- **Four new TS products (`carbon-updater`, `carbon-studio`,
  `carbon-templates`, `carbon-vscode`) shipped `tsconfig.json` with
  `"types": ["bun-types"]`** — the same broken package reference already
  found and fixed in `carbon-registry` earlier this session (the real
  installed package is `@types/bun`, imported as `"bun"`; `"bun-types"`
  only exists in this repo's `.old_modules-*` backup directory).
  `bun test` doesn't need real type declarations to run, which is why this
  was never caught — `bunx tsc --noEmit` failed immediately on all four
  with the identical error. **Fixed mechanically for all four before
  committing** (`"types": ["bun"]`).
- **`PartitionManager.ts` (carbon-updater), `TemplateRegistry`/
  `ScaffolderEngine` (carbon-templates), `CodeGenerator.ts`
  (carbon-studio)** all use the same in-memory `Map()`/`getInstance()`
  singleton pattern `carbon-registry`'s `RegistryEngine` had before being
  rewritten to real Postgres/S3 this session. Not fixed here — no budget to
  determine which of these actually need durable state (an updater's
  crash-rollback state plausibly does; a code generator plausibly doesn't)
  — but worth a deliberate pass before calling any of these three
  "production ready" the way carbon-database/carbon-registry now are.
- **`carbon-cli/presentation/commands/project/init.command.ts`** reaches
  into `carbon-templates/infrastructure/services/{TemplateRegistry,
  ScaffolderEngine}.ts` via a relative path
  (`../../../../carbon-templates/infrastructure/services/...`) instead of
  a declared `@carbon/*` alias or carbon-templates's own composition root
  — no `@carbon/templates` path mapping exists. Every other cross-product
  interaction in this changeset goes through a real boundary (HTTP, or a
  declared `@carbon/*` package); this one reaches into another product's
  internals directly.
- **`products/carbon-website/index.html`** loads
  `https://unpkg.com/lucide@0.469.0/...` as a global script and calls
  `window.lucide.createIcons()` — this repo's convention is real React, not
  global-script DOM libraries (and no `data-lucide` attributes exist
  anywhere in the diff, so this may currently be dead weight). Moot unless/
  until the website redesign above is finished.
- **`.tools/orchestration/bazel/cargo/Cargo.lock`/`Cargo.toml`** sat as one
  undifferentiated diff spanning 3+ unrelated features (build-cache crates,
  the sqlite plugin's `rusqlite` dep, carbon-launcher's own deps) — staged
  and committed together deliberately (a lockfile diff this wide can't be
  split across commits without risking an intermediate `cargo build`
  failure).
- **`solutions/interface/plugins/index.ts`** re-exports 20 new modules with
  `export * from "./X.ts"` and no grouping/comment separating "carbon-sdk
  standard plugins" from the four `carbon-*` ambient ones
  (`carbon-runtime`/`carbon-manifest`/`carbon-framecache`/
  `carbon-snapshot`) that are a conceptually distinct tier per
  `.local/notes/carbon-sdk-capabilities.md`. Cosmetic, not blocking.

## Commits (16, in dependency order)

See `git log` on `main` — each commit body explains the "why", not just
the "what". Order: identity client → carbon-cloud → carbon-database →
carbon-registry → carbon-cli (db/registry commands) → carbon-sdk +
native plugin platform → carbon-launcher + build-cache → frame cache →
font preload → carbon-updater → carbon-studio → carbon-templates →
carbon-cli (init --template) → carbon-vscode → carbon-discord → docs.
