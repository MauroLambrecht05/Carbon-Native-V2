# carbon-sdk — the standard plugin collection

`plugins/<category>/<name>/` — a category folder per area (`carbon-desktop`,
`carbon-dev`, `carbon-security`, ...) grouping the plugins for that area,
each an ordinary Carbon plugin (built against `carbon-ext`'s SDK, same as
anything scaffolded by `carbon plugin new`) in its own subdirectory —
nothing here is special-cased by the loader. A category folder itself has
no `build.zig` and installs nothing on its own; it's purely an
organizational grouping. What makes a plugin here different from one a
developer writes themselves is purely that `carbon plugin add <name>` knows
to look here for it.

```
carbon plugin add clipboard   # builds + installs plugins/carbon-desktop/clipboard/
```

`<name>` is just the plugin's own name, never category-qualified —
`resolveStandardPluginDir` (`solutions/capabilities/plugin/lifecycle/
application/usecases/resolveStandardPluginDir.ts`) searches every category
folder under `plugins/` for a subdirectory matching it. Once found, adding
it is the same two operations `carbon plugin build` + `carbon plugin
install` already do for a plugin's own directory, just resolved by name
instead of by path.

## Categories, not merged plugins

Grouping by category is purely a folder convention — every plugin under a
category compiles, installs, and is added independently, exactly like a
flat collection would. Related plugins are still called out together for
readers by *area*, not folded into one compiled artifact: `carbon-desktop`'s
clipboard/dialog/notification/tray plugins have nothing that couples them
at the ABI level, so `carbon plugin add clipboard` never has to pull in
tray just because they share a category folder.

## Adding a new standard plugin

1. `carbon plugin new <name>` into a scratch directory, or hand-write the
   four files a plugin needs (`build.zig`, `build.zig.zon`, `carbon-plugin.toml`,
   `src/main.zig`) — see `plugins/carbon-security/keychain/` for a real,
   minimal example.
2. Move it under `products/carbon-sdk/plugins/<category>/<name>/` — an
   existing category if the plugin's area already has one, otherwise a new
   category folder (just a directory; nothing to register).
3. `carbon plugin check products/carbon-sdk/plugins/<category>/<name>` to
   verify the manifest.
4. `carbon plugin add <name>` from a scratch app to verify the whole
   build-and-install path end to end.

## Resolution today: local, not a registry

`carbon plugin add` resolves `<name>` against `plugins/` in this SAME
workspace — there's no remote fetch yet. That's deliberate for now: every
plugin here ships with the source tree that built the runtime it loads
into, so there's no version-skew question to answer. A real registry
(fetch, signing, the sandboxed install broker) is a separate, larger piece
of work — see `.local/notes/roadmap/04-security-and-capabilities/README.md`
for the existing plan that "publish standard plugins" would plug into, and
`.local/notes/carbon-sdk-capabilities.md`'s Carbon-specific tier
(`carbon-registry`) for where that surfaces in the wider capability catalog.

## Standard plugins

Every plugin's own name is a single, short word — `carbon plugin add <name>`
reads the same way regardless of which one you're adding. Where a plugin's
JS module name is a longer, more descriptive `carbon:*` specifier (kept
exactly as it always has been, since that's app-facing API surface, not an
install-time identifier), the table calls it out separately.

| Category | Plugin | JS module | What it does |
|---|---|---|---|
| `carbon-desktop` | [`clipboard`](./plugins/carbon-desktop/clipboard) | `carbon:clipboard` | Read/write the system clipboard (text). |
| `carbon-desktop` | [`dialog`](./plugins/carbon-desktop/dialog) | `carbon:dialog` | Native file pickers and message boxes, including read/write-in-one-call variants that never expose a raw filesystem path to JS. |
| `carbon-desktop` | [`notify`](./plugins/carbon-desktop/notify) | `carbon:notification` | Desktop toast notifications through the OS notification centre. |
| `carbon-desktop` | [`tray`](./plugins/carbon-desktop/tray) | `carbon:tray` | A system tray icon with an optional context menu (Windows/macOS/Linux-gtk). |
| `carbon-desktop` | [`menu`](./plugins/carbon-desktop/menu) | `carbon:menu` | A native application menu bar (Windows only today, via `muda`/`tray-icon`'s re-export). |
| `carbon-desktop` | [`taskbar`](./plugins/carbon-desktop/taskbar) | `carbon:taskbar` | A taskbar badge (overlay icon) and progress bar (Windows only today, via `ITaskbarList3`). |
| `carbon-desktop` | [`theme`](./plugins/carbon-desktop/theme) | `carbon:theme` | Point-in-time query of accent color, high-contrast, and reduced-motion OS preferences (Windows only today). |
| `carbon-desktop` | [`accessibility`](./plugins/carbon-desktop/accessibility) | `carbon:accessibility` | Whether a screen reader is currently active (Windows only today). |
| `carbon-desktop` | [`printing`](./plugins/carbon-desktop/printing) | `carbon:printing` | Print a file through the OS print pipeline (Windows only today, via `ShellExecuteW`). |
| `carbon-desktop` | [`screencapture`](./plugins/carbon-desktop/screencapture) | `carbon:screencapture` | Screenshot a screen or a window to an image file (Windows only today, via GDI `BitBlt`). Still images only — no video/GIF capture. |
| `carbon-desktop` | [`media`](./plugins/carbon-desktop/media) | `carbon:media` | System audio volume/mute and hardware media-key handling (Windows only today). No now-playing metadata or video decode surface. |
| `carbon-desktop` | [`input`](./plugins/carbon-desktop/input) | `carbon:input` | Modifier/lock-key state, synthetic keyboard/mouse input, and active keyboard-layout detection (Windows only today). No multi-touch, Force Touch, pen/stylus, or on-screen keyboard control. |
| `carbon-desktop` | [`sharing`](./plugins/carbon-desktop/sharing) | `carbon:sharing` | The native OS share sheet for title/text/URL (Windows only today, via `DataTransferManager`). No file sharing. |
| `carbon-desktop` | [`microphone`](./plugins/carbon-desktop/microphone) | `carbon:microphone` | Live PCM capture from the default microphone (Windows only today, via `AudioGraph`). No device selection, gain control, or system-audio loopback. |
| `carbon-desktop` | [`camera`](./plugins/carbon-desktop/camera) | `carbon:camera` | Live RGBA8 video frame capture from the first available camera (Windows only today, via `MediaCapture`'s frame-reader pipeline). No device selection, resolution negotiation, still-photo capture, or virtual-camera publishing. |
| `carbon-dev` | [`terminal`](./plugins/carbon-dev/terminal) | `carbon:terminal` | A real terminal (xterm.js-style), backed by a real ConPTY session. |
| `carbon-dev` | [`deeplink`](./plugins/carbon-dev/deeplink) | `carbon:deep-link` | Custom URL scheme handling (`myapp://...`). Runtime self-registration on Windows/Linux; macOS needs a packaging-time Info.plist declaration instead (see the dmg generator). |
| `carbon-dev` | [`fonts`](./plugins/carbon-dev/fonts) | `carbon:fonts` | Loads custom TTF/OTF fonts at runtime, selectable by name from CSS/JSX `font-family` — see its own header comment for the full picture. |
| `carbon-dev` | [`logging`](./plugins/carbon-dev/logging) | `carbon:logging` | Structured JSONL file logging with size-based rotation, no dependency on the OS event log. |
| `carbon-security` | [`keychain`](./plugins/carbon-security/keychain) | `carbon:keychain` | OS credential storage (Credential Manager / Keychain Services / Secret Service), keyed by (service, account). |
| `carbon-security` | [`biometrics`](./plugins/carbon-security/biometrics) | `carbon:biometrics` | Windows Hello user-consent verification (Windows only today). Dispatches, then delivers the verified/not-verified outcome asynchronously via a `biometrics.result` event — see the plugin's own header for why. |
| `carbon-system` | [`shortcuts`](./plugins/carbon-system/shortcuts) | `carbon:global-shortcuts` | System-wide keyboard shortcuts that fire even when the app is unfocused or minimized (Windows/macOS/Linux-X11). |
| `carbon-system` | [`instance`](./plugins/carbon-system/instance) | `carbon:instance` | A single-instance lock (Windows named mutex today). May exit the process directly if another instance already holds it. |
| `carbon-system` | [`bluetooth`](./plugins/carbon-system/bluetooth) | `carbon:bluetooth` | BLE scan, connect, GATT-notify-subscribe, and characteristic write (Windows only today). No one-shot GATT read or service/characteristic enumeration — see the plugin's own header. |
| `carbon-storage` | [`search`](./plugins/carbon-storage/search) | `carbon:file-search` | In-app gitignore-aware grep/glob/search. |
| `carbon-storage` | [`sqlite`](./plugins/carbon-storage/sqlite) | `carbon:sqlite` | Embedded SQLite storage (bundled, no system `sqlite3.dll` dependency). Real and tested, but **not usable yet** — `carbon-plugin-host` must be built with `--features sqlite`, which no build path wires up automatically today (deliberately left out of that crate's default features — see its own Cargo.toml comment). |
| `carbon-platform` | [`carbon-runtime`](./plugins/carbon-platform/carbon-runtime) | `carbon:carbon-runtime` | Which backend binary is running (mini/blitz) and which of its own Cargo feature flags were compiled in. Carbon self-introspection, not an OS/cloud capability. |
| `carbon-platform` | [`carbon-manifest`](./plugins/carbon-platform/carbon-manifest) | `carbon:carbon-manifest` | Reads the app's own carbon.toml at runtime — declared capabilities, `[runtime]` flags, plugin grants. |
| `carbon-platform` | [`carbon-framecache`](./plugins/carbon-platform/carbon-framecache) | `carbon:carbon-framecache` | Startup warm-start frame-cache diagnostics and control (mini backend only). |
| `carbon-platform` | [`carbon-snapshot`](./plugins/carbon-platform/carbon-snapshot) | `carbon:carbon-snapshot` | Whether this session's JS runtime was restored from a QuickJS heap snapshot — a cold-start optimization, unrelated to screen capture despite the name. |

Clipboard/dialog/notification/keychain used to be always-on ambient globals
in the core runtime (`@carbon/runtime-bindings`) — moved here so they follow
the same opt-in pattern as fonts, since none of them mediate a permission
boundary the way filesystem/network access do.

Each category above is deliberately named for room to grow, not for what it
holds today: `carbon-security` has grown to keychain + biometrics, with
secure-input-mode still to come; `carbon-system` has grown to shortcuts +
single-instance locking + Bluetooth, with process lifecycle and background
tasks still to come; `carbon-storage` has grown to file search + SQLite,
with a filesystem plugin and a key-value store still to come.
`carbon-platform` is different in kind from every other category here —
its four plugins introspect Carbon's OWN runtime/build state
(backend/features, carbon.toml, the warm-start frame cache, the JS heap
snapshot), not an OS capability or a hosted Carbon service; see
`.local/notes/carbon-sdk-capabilities.md`'s "Carbon-specific" tier and
`.local/notes/roadmap/05-carbon-specific-infrastructure/README.md` for why
most of that tier (carbon-database, carbon-billing, etc.) has no plugin
here yet — it needs hosted infrastructure that doesn't exist. See
`.local/notes/carbon-sdk-capabilities.md` for the full capability catalog
these categories grow into.
