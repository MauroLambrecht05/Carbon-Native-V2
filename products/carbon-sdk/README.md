# carbon-sdk — the standard plugin collection

One directory per plugin, each an ordinary Carbon plugin (built against
`carbon-ext`'s SDK, same as anything scaffolded by `carbon plugin new`) —
nothing here is special-cased by the loader. What makes this collection
different from a plugin a developer writes themselves is purely that
`carbon plugin add <name>` knows to look here for it.

```
carbon plugin add fonts     # builds + installs products/carbon-sdk/fonts/
```

is the same two operations `carbon plugin build` + `carbon plugin install`
already do for a plugin's own directory, just resolved by name instead of
by path.

## Adding a new standard plugin

1. `carbon plugin new <name>` into a scratch directory, or hand-write the
   four files a plugin needs (`build.zig`, `build.zig.zon`, `carbon-plugin.toml`,
   `src/main.zig`) — see `fonts/` for a real example.
2. Move it under `products/carbon-sdk/<name>/`.
3. `carbon plugin check products/carbon-sdk/<name>` to verify the manifest.
4. `carbon plugin add <name>` from a scratch app to verify the whole
   build-and-install path end to end.

## Resolution today: local, not a registry

`carbon plugin add` resolves `<name>` against this directory in the SAME
workspace — there's no remote fetch yet. That's deliberate for now: every
plugin here ships with the source tree that built the runtime it loads
into, so there's no version-skew question to answer. A real registry
(fetch, signing, the sandboxed install broker) is a separate, larger piece
of work — see `.local/notes/roadmap/04-security-and-capabilities/README.md`
for the existing plan that "publish standard plugins" would plug into.

## Standard plugins

| Plugin | What it does |
|---|---|
| [`fonts`](./fonts) | Loads custom TTF/OTF fonts at runtime, selectable by name from CSS/JSX `font-family` — see its own header comment for the full picture. |
| [`clipboard`](./clipboard) | Read/write the system clipboard (text). |
| [`dialog`](./dialog) | Native file pickers and message boxes, including read/write-in-one-call variants that never expose a raw filesystem path to JS. |
| [`notification`](./notification) | Desktop toast notifications through the OS notification centre. |
| [`keychain`](./keychain) | OS credential storage (Credential Manager / Keychain Services / Secret Service), keyed by (service, account). |
| [`global-shortcuts`](./global-shortcuts) | System-wide keyboard shortcuts that fire even when the app is unfocused or minimized (Windows/macOS/Linux-X11). |
| [`tray`](./tray) | A system tray icon with an optional context menu (Windows/macOS/Linux-gtk). |
| [`deep-link`](./deep-link) | Custom URL scheme handling (`myapp://...`). Runtime self-registration on Windows/Linux; macOS needs a packaging-time Info.plist declaration instead (see the dmg generator). |

Clipboard/dialog/notification/keychain used to be always-on ambient globals
in the core runtime (`@carbon/runtime-bindings`) — moved here so they follow
the same opt-in pattern as fonts, since none of them mediate a permission
boundary the way filesystem/network access do.
