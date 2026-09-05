# carbon-sdk capability catalog

One row per capability family. Every feature that touches the same area —
all tray behavior, all filesystem behavior, and so on — lives in a single
row's description instead of being scattered across multiple rows. `Done`
is checked once the row's core behavior is shipped and verified, not just
started.

## Must have

| Done | Capability | Description |
|---|---|---|
| [x] | Filesystem | Read, write, copy, move, and delete files scoped to the app's own data, config, cache, and temp directories (`fs.rs`, verified). Resolves standard paths. Watches files for live changes — not yet built. Reads the app's own bundled resources with no path traversal possible — not yet built. |
| [ ] | Storage | Persisted key-value settings store — shipped (`store.rs`, ambient `localStorage`-shaped). Embedded SQLite — shipped (the `sqlite` plugin, ABI 1.9), but the runtime binary must be built with `--features sqlite` for it to actually work — not wired into any build path yet, so not counted done. Encrypted-at-rest storage and a local vector store — not yet built. |
| [x] | Network | Fetch, Headers, Request, Response, AbortController, and URL as ambient globals, restricted to an origin allowlist — shipped and verified (`net.rs`). WebSocket client — shipped. Upload and download progress events, and reachability probes — not yet built. |
| [x] | Window | Create, close, focus, resize, and move windows; decorations, fullscreen — shipped (`window.rs`). Window-state persistence across launches — shipped (`window_state.rs`). Always-on-top, multi-monitor and display-change events, vibrancy and blur, custom shapes, and HDR capability query — not yet built. |
| [x] | Menu | Native app menu bar — shipped (the `menu` plugin, ABI 1.7, via `muda`/`tray-icon`'s re-export). Per-element right-click context menus — already ambient/shipped separately (`__cm_dispatch_context_menu`, wrapped as `onContextMenu` in the Solid renderer) — not yet built. |
| [x] | Tray | Tray icon with a context menu — shipped. Live icon and tooltip updates, and a menu-bar-only no-dock-icon mode — not yet built. |
| [x] | Taskbar | Badge (overlay icon) and progress bar — shipped (the `taskbar` plugin, ABI 1.10, via the `windows` crate's `ITaskbarList3`). Jump lists and thumbnail toolbar buttons — not yet built. |
| [x] | Drag and Drop | Native file drop onto a window — already ambient/shipped (`WindowEvent::DroppedFile`/`HoveredFile` in `run_loop.rs`, wrapped as `onFileDrag` in the Solid renderer) — this capability catalog entry was simply wrong before; corrected here, not newly built. Dragging files OUT of the app into Explorer/Finder, and React-renderer parity for the existing hooks — not yet built. |
| [x] | Shortcuts | System-wide keyboard shortcuts that fire even when the app is unfocused or minimized — shipped. |
| [x] | Keychain | OS credential storage, keyed by service and account — shipped. |
| [x] | Trust | Plugin signing and load-time verification — shipped. Verifying the signature of another installed app — not yet built. |
| [x] | Notifications | Desktop toast notifications — shipped. Actionable buttons and inline reply, grouping and scheduling, an in-app toast helper, and system alert sounds — not yet built. |
| [ ] | Process | Spawning sidecar binaries and allowlisted commands — shipped, gated. Launch-at-login — shipped (`autostart.rs`). Single-instance lock — shipped (the `instance` plugin, ABI 1.8, a Windows named mutex; may exit the process directly, same contract as deep-link's forwarding). Graceful-quit lifecycle hooks and self-restart on unexpected exit — not yet built. |
| [x] | System Info | Platform, architecture, OS version, and locale — shipped (`os.rs`). CPU, memory, disk, GPU, thermal, timezone, and env-var reads — not yet built. |
| [x] | Clipboard | Reading and writing the system clipboard, text only — shipped. Images, files, and clipboard history — not yet built. |
| [x] | Dialog | Native file pickers and message boxes, including read-and-write-in-one-call variants that never expose a raw path to JS — shipped. |
| [x] | Deep Link | Custom URL scheme handling — shipped. Universal-link verification status — not yet built. |
| [x] | Search | Fast file search across the filesystem — shipped (as file-search). |
| [x] | Fonts | Loading custom fonts at runtime, selectable by name from CSS — shipped. System font list enumeration — not yet built. |
| [x] | Terminal | Embedded terminal — shipped. |

## Should have

| Done | Capability | Description |
|---|---|---|
| [x] | Theme | Live system theme and window-focus change listeners — already ambient (`onThemeChange`/`onWindowFocus` in the Solid renderer's app-events.ts, no carbon-sdk plugin needed). Accent color, high-contrast, and reduced-motion preference detection — shipped (the `theme` plugin, ABI 1.11, a point-in-time query, not a subscription). |
| [ ] | Input | Basic keydown — already ambient (`onKeyDown`). Modifier/caps-lock/num-lock state polling, synthetic keyboard/mouse events, and active-keyboard-layout detection — shipped (the `input` plugin, ABI 1.17, Windows `SendInput`/`GetKeyState`). Multi-touch trackpad gestures, Force Touch, pen/stylus curves, on-screen keyboard control, and keyboard-layout CHANGE events (this is a point-in-time query, not a subscription) — not yet built. |
| [ ] | Camera | Live RGBA8 video frame capture from the first available camera — shipped (the `camera` plugin, ABI 1.22, WinRT `MediaCapture`'s frame-reader pipeline, frames delivered via the binary-event pipe). Device enumeration/selection, resolution/format negotiation, still-photo capture, and virtual-camera publishing — not yet built. |
| [ ] | Microphone | Live PCM capture from the default device — shipped (the `microphone` plugin, ABI 1.21, WinRT `AudioGraph`, interleaved float32 frames delivered via the new binary-event pipe). Device enumeration/selection, gain control, voice-activity detection, and system-audio loopback capture — not yet built. |
| [ ] | Screen Capture | Still screenshots of a window or display — shipped (the `screencapture` plugin, ABI 1.15, GDI BitBlt, own window or full screen only). Screen recording as video, and a per-window flag to exclude it from another app's screen share or recording — not yet built. |
| [ ] | Media | System audio volume/mute control and hardware media-key handling (play/pause/next/previous/stop) — shipped (the `media` plugin, ABI 1.16). Now-playing metadata shown in the OS media overlay (needs WinRT SystemMediaTransportControls) and a native, hardware-accelerated video decode surface (needs Media Foundation) — not yet built, materially larger pieces of work. |
| [ ] | Bluetooth | Scanning, connecting, GATT-notify-subscribe, and writing characteristics — shipped (the `bluetooth` plugin, ABI 1.20, WinRT `Devices.Bluetooth`/`GenericAttributeProfile`, notification bytes delivered via the new binary-event pipe). A one-shot GATT read and full service/characteristic enumeration — not yet built (see the plugin's own header for why read specifically needs a separate request-id correlation scheme). |
| [x] | Biometrics | Windows Hello user-consent verification gate — shipped (the `biometrics` plugin, ABI 1.18, WinRT `UserConsentVerifier`, dispatched async via a dedicated MTA thread to avoid deadlocking the JS/event-loop apartment — see the plugin's own header). Touch ID/Face ID (macOS) and a Linux equivalent — not yet built. |
| [x] | Updater | Update checks and installer UI hooks — shipped, via a different mechanism than the carbon-sdk plugin ABI (`@carbon/api/updater`'s `check()`/`downloadAndInstall()`, backed by `carbon-launcher`'s A/B slot updater and the app-command `invoke()` bridge, not a Zig plugin). |
| [x] | Logging | Structured native logs written to a file with rotation — shipped (the `logging` plugin, ABI 1.12, JSONL format, one `.1` backup on rotation). |
| [ ] | Sharing | Title/text/URL via the native OS share sheet — shipped (the `sharing` plugin, ABI 1.19, WinRT `DataTransferManager`/`IDataTransferManagerInterop`). Sharing files — not yet built. |
| [x] | Accessibility | Detects when a screen reader is active so the app can adapt its UI — shipped (the `accessibility` plugin, ABI 1.13, a point-in-time query). |
| [x] | Developer Tools | A layout-debug element-inspector overlay (colored outlines over every node, Chrome-DevTools-style) — shipped, toggled by Ctrl+Space at the runtime level (`scene.rs`'s `debug_layout` flag). Not a separate devtools window/protocol. |
| [x] | Printing | Sends a document or page to a system print job — shipped (the `printing` plugin, ABI 1.14, via ShellExecute's "print" verb — prints an existing file, doesn't render arbitrary content itself). |

## Could have

| Done | Capability | Description |
|---|---|---|
| [ ] | Peripherals | USB device enumeration and hotplug events. Serial port read and write. Raw HID device access. Docking-station and external-display plug or unplug events. Thunderbolt and eGPU presence detection. |
| [ ] | WiFi | Wi-Fi network scans, including SSID and signal strength. |
| [ ] | NFC | Reading and writing NFC tags. |
| [ ] | MIDI | MIDI input and output. |
| [ ] | Barcode | Scanning barcodes and QR codes through the camera, and generating them. |
| [ ] | Scanner | Document and photo scanning through TWAIN or WIA. |
| [ ] | Vision | Text recognition from a captured image. Image classification and object detection. Background removal and image super-resolution. |
| [ ] | Sensors | Accelerometer, gyroscope, and magnetometer for 2-in-1 and tablet devices. Ambient light. Device orientation. Proximity. |
| [ ] | Gamepad | Controller input plus force feedback and rumble. |
| [ ] | Secure Input | A keylogger-resistant input mode for password fields. |
| [ ] | Licensing | Hardware machine-ID fingerprinting for license binding. License-key activation and deactivation against a self-hosted server. Trial-period countdown enforcement. Store entitlement and in-app-purchase checks. |
| [ ] | Crash Reporting | Crash-dump capture with a symbolication upload hook. |
| [ ] | Background Tasks | Interval-based scheduling that runs even when the window is closed. A power-save blocker to prevent sleep during long operations. Idle and away detection. |
| [ ] | Shell Integration | Explorer and Finder shell extensions, including context-menu entries and custom icon overlays. A Quick Look-style file preview panel. Spotlight and Windows Search content indexing. Reading and toggling Focus or Do Not Disturb mode. Remote-desktop-session detection. |
| [ ] | App Directory | Enumerating installed apps and other running processes or windows, for launcher and automation-style apps. Registering and querying the default app for a protocol or file type. |
| [ ] | File Utilities | Zip and tar archive read and write. File checksumming and hashing. Trash and recycle-bin move instead of hard delete. Recent-files list management. |
| [ ] | Automation | An AppleScript or PowerShell bridge for scripted OS automation. Accessibility-tree access for building automation tools. Registering the app as a scriptable automation target. |
| [ ] | Speech | Native speech-to-text and text-to-speech using OS voices. On-device translation. |
| [ ] | Machine Learning | An on-device LLM inference bridge. Local embeddings generation. |
| [ ] | Contacts | Reading and writing contacts. |
| [ ] | Calendar | Creating calendar events. |
| [ ] | Localization | Input-method-editor composition-state events. Locale-aware number, currency, and date formatting through the OS. An accessibility-tree-aware narrator and text-to-speech hook. |
| [ ] | Management | Reading MDM or policy restrictions on managed machines. Silent install and update hooks for managed deployment. A telemetry opt-in and opt-out toggle exposed to end users. |

## Carbon-specific

Not OS/Tauri-parity capabilities — these connect to Carbon's own infrastructure,
or expose Carbon-native implementation details no other framework has an
equivalent of. Several of these already exist as internal machinery
(`solutions/capabilities/cloud/*`, `solutions/capabilities/plugin/*`,
`solutions/capabilities/rendering/snapshot`) and just need an SDK-facing
surface; others are genuinely new infra.

Named like the rest of Carbon's own tooling (`carbon-cli`, `carbon-sdk`,
`carbon-launcher`) — every row below is a `carbon-<word>` product, not a
generic capability name.

As of 2026-09-04: rows marked "local" below are real, working carbon-sdk
plugins, no backend involved. Rows marked "self-hosted only" have real
client+server code (`solutions/capabilities/cloud/*`, `products/carbon-cloud`)
but no Carbon-operated server exists yet, so no SDK plugin wraps them yet.
Every other row has NO backend anywhere, not even self-hosted — building an
SDK plugin for one would just be a client calling a URL that doesn't exist.
See `.local/notes/roadmap/05-carbon-specific-infrastructure/README.md` for
the build order and full plugin → infrastructure dependency map before
picking any of those up.

| Done | Capability | Description |
|---|---|---|
| [ ] | carbon-identity | Sign in with a Carbon account — the org, developer, and team identity that owns billing, plugin publishing, and everything else below. Real, working client+server (`solutions/capabilities/cloud/identity`, real Postgres repo) — but no Carbon-operated server exists, only self-hosted, so no SDK plugin wraps it yet. See `.local/notes/roadmap/05-carbon-specific-infrastructure/README.md` Phase 0. |
| [ ] | carbon-auth | End-user authentication as a service for an app's own customers — email, magic link, and OAuth sign-in, sessions, and user records. Only the worker-token issue/verify slice exists today (real, small); magic-link/OAuth for an app's own end users is new scope — see the roadmap doc's Phase 1. |
| [x] | carbon-secrets | The credential-broker fetch: an OS-keychain secret is looked up and substituted into a request header entirely inside Rust, so the value never becomes a JS-visible string — shipped. |
| [x] | carbon-runtime | Which backend binary is running (mini/blitz) and which of its own Cargo feature flags were compiled in — shipped (the `carbon-runtime` plugin, ABI 1.23, plain-field reads composed once by the composition root at startup). |
| [x] | carbon-manifest | Reads the app's own carbon.toml at runtime — shipped (the `carbon-manifest` plugin, ABI 1.23, re-parsed fresh on every call). Deliberately excludes `[dev-signing] trusted_keys` and each plugin's free-form config blob. |
| [x] | carbon-framecache | Startup frame-cache hit/miss diagnostics and a force-rebuild control — shipped (the `carbon-framecache` plugin, ABI 1.23, wraps `products/carbon/composition/frame_cache.rs`, mini backend only). |
| [x] | carbon-snapshot | Whether this session's JS runtime was restored from a QuickJS heap snapshot — shipped (the `carbon-snapshot` plugin, ABI 1.23). Corrected from the original description: this is a JS-heap snapshot (`solutions/capabilities/rendering/snapshot`), not a render-tree pixel capture — no such capability exists. |
| [ ] | carbon-database | A managed, hosted Postgres database for an app's own data, with row-level policies — Carbon's Supabase equivalent. |
| [ ] | carbon-storage | Hosted object and file storage for uploads, images, and exports, with signed URLs — Carbon's S3 or Supabase Storage equivalent. Separate from the local device Storage capability above. |
| [ ] | carbon-realtime | Realtime subscriptions over carbon-database rows and custom channels, pushed to the app over a managed socket. |
| [ ] | carbon-search | Hosted full-text search over carbon-database tables with no separate search cluster to run. |
| [ ] | carbon-vector | A hosted vector database for embeddings and semantic search, pairing with carbon-ai. |
| [ ] | carbon-migrations | Schema migration and rollback tooling for carbon-database, versioned alongside the app's own source. |
| [ ] | carbon-backup | Automated backup and point-in-time restore for carbon-database and carbon-storage. |
| [ ] | carbon-functions | Serverless, HTTP-triggered functions hosted by Carbon and deployed alongside the app. |
| [ ] | carbon-queue | A managed message queue for background jobs, distinct from dispatching straight to carbon-worker. |
| [ ] | carbon-cron | Scheduled and recurring job execution hosted by Carbon, with no always-on process required. |
| [ ] | carbon-worker | Dispatches background compute jobs to Carbon's managed worker fleet instead of standing up your own job queue. Today this is Carbon's OWN build pipeline only (`builds` table, real claim/complete protocol) — generalizing it to arbitrary app-submitted jobs is new scope, roadmap doc Phase 3. |
| [ ] | carbon-orchestration | Deploys and manages a companion cloud-side workload for a Carbon app. Real client+server exists (`solutions/capabilities/cloud/orchestration`, `products/carbon-cloud`) but scoped to Carbon's own build pipeline today, and only self-hosted — no Carbon-operated instance. Roadmap doc Phase 0. |
| [ ] | carbon-edge | Edge-deployed compute close to the user for latency-sensitive functions, distinct from carbon-functions' regional deployment. |
| [ ] | carbon-ai | A hosted LLM and inference proxy — the AI-proxy path the runtime's SSRF-hardening machinery already protects — so an app calls a model without holding its own API key. |
| [ ] | carbon-email | Transactional email sending — verification, receipts, digests — through Carbon's own mail infrastructure. |
| [ ] | carbon-sms | Transactional SMS sending through Carbon's own gateway. |
| [ ] | carbon-webhooks | Managed outbound webhook delivery with retries, plus a verified inbound webhook receiver. |
| [ ] | carbon-push | Hosted push-notification fanout to an app's users across every device they're signed into, distinct from the local, per-device Notifications capability above. |
| [ ] | carbon-logs | Centralized cloud log aggregation and search across every install of an app, distinct from the local, per-device Logging capability above. |
| [ ] | carbon-monitoring | The crash and error aggregation dashboard that the local Crash Reporting hook uploads into. |
| [ ] | carbon-analytics | Carbon-hosted, opt-in product analytics for an app's own usage metrics — distinct from the generic bundled analytics SDK marked out of scope below. |
| [ ] | carbon-flags | A hosted feature-flag and remote-config service, read at startup and live-updated. |
| [ ] | carbon-status | A hosted status page and incident-communication feed for an app's own service health. |
| [ ] | carbon-billing | Sell subscriptions or plans through Carbon's own billing platform instead of integrating a payment processor directly. Real Stripe Checkout integration exists (`solutions/capabilities/cloud/billing`) plus usage/plan tables — a full self-serve plan UI doesn't, and there's no Carbon-operated instance, only self-hosted. Roadmap doc Phase 0. |
| [ ] | carbon-payments | Hosted checkout and payment rails, with Carbon as merchant of record, for one-off purchases — the app never touches raw card data. Distinct from carbon-billing's recurring subscriptions. |
| [ ] | carbon-teams | The organization, team, and workspace membership model reused from Carbon's own account system, for apps that need multi-user collaboration without building it from scratch. |
| [ ] | carbon-support | An embeddable customer-support widget and ticket inbox backed by Carbon's own hosted support system. |
| [ ] | carbon-cdn | Edge-cached asset delivery for an app's static files and carbon-storage objects. |
| [ ] | carbon-domains | Custom domain and DNS management for anything an app exposes to the web — auth callback URLs, a marketing site, webhook endpoints. |
| [ ] | carbon-registry | A real, hosted Carbon plugin registry — fetch, signing, and a sandboxed install broker — so `carbon plugin add <name>` resolves against a remote catalog instead of only the local `products/carbon-sdk/` workspace copy it does today. Tracked as future work in the security roadmap. |
| [ ] | carbon-trust | `carbon plugin dev-key`'s per-developer signing key, `carbon-import-check`'s module and symbol denylist, and `carbon-plugin-sign` exist as real, working standalone binaries (`solutions/capabilities/plugin/trust/rust/tools`) — CLI/publish-pipeline tooling, not a JS-callable app-runtime plugin. Wiring into `carbon-registry`'s publish pipeline is Phase 11 of `.local/notes/roadmap/05-carbon-specific-infrastructure/README.md`. |
| [ ] | carbon-effects | The effects-as-data pattern every Zig plugin already uses — a plugin returns a `CarbonEffect` value instead of calling the OS directly, and only the trusted Rust host interprets it. An internal Rust/Zig authoring convention, not something with a JS-facing surface at all — nothing to build here, only to document. |
| [ ] | carbon-test | A native, deterministic post-render test-eval hook (the `CARBON_TEST_EVAL_AFTER_MS` pattern) — already real (`products/carbon/composition/mini.rs`/`run_loop.rs`), already externally triggerable via `CARBON_TEST_EVAL_AFTER_MS`/`CARBON_TEST_EVAL_SCRIPT` env vars set before launch. No JS-facing plugin surface makes sense — an external test harness drives this from outside the process, app code never calls into it. |
| [ ] | carbon-publish | Publishes a build to Carbon's own distribution and update channel — the publish side that the generic Updater capability's install side pairs with. |
| [ ] | carbon-buildcache | Shared, remote build-cache integration for Carbon's own toolchain, so a plugin or app build skips work another machine already did. |
| [ ] | carbon-daemon | A pre-warmed process pool (`products/carbon-launcher`) that hands `carbon run`/`dev` an already-running process instead of paying OS process-creation cost — real, functional, and already wired (`DaemonClient.ts` from `dev.command.ts`/`run.command.ts`), not a stub. CLI/dev-tooling internals, no app-facing JS surface makes sense — an app has no reason to introspect its own launcher's warm-pool state. |

## Needs a design decision first

| Done | Capability | Description |
|---|---|---|
| [ ] | Raw Socket | A narrow, allowlisted raw TCP or UDP socket. High-risk verb, needs its own scoping design before it exists. |
| [ ] | Native Surface | Embedding a DirectX, Metal, or Vulkan child surface inside a window region. |
| [ ] | Input Recorder | A global, low-level input hook. Macro-recorder-class capability with high abuse potential. |
| [ ] | Virtual Camera | Publishing processed video as a system camera source. |
| [ ] | Elevation | A relaunch-as-admin trigger. |
| [ ] | Remote Control | Input injection for remote-support-style tools. Needs a consent flow designed before it ships. |
| [ ] | Cloud Paths | Resolving OneDrive and iCloud Drive placeholder files. |

## Explicitly out of scope

| Done | Capability | Description |
|---|---|---|
| — | Mobile Parity | Full iOS and Android capability parity — SMS, call log, cellular telephony. Not a target platform. |
| — | AR VR | Augmented and virtual reality device APIs. |
| — | Blockchain | Blockchain and wallet integration. |
| — | Cloud Sync | A cloud-sync backend. Apps build this themselves on top of the Network capability. |
| — | DRM | A content-protection or DRM framework. |
| — | VPN | A general-purpose VPN client. |
| — | Payments | Payment processing and card handling. Belongs in a PCI-scoped web flow, not the native SDK. |
| — | Pedometer | Step counting. Mobile-only signal with no desktop equivalent. |
| — | Analytics SDK | A bundled analytics or tracking SDK. Apps can call their own vendor's SDK over the Network capability instead. |
