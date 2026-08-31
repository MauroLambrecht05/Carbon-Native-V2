// @carbon/plugins — framework-facing wrappers around carbon-sdk's standard
// plugins. Each plugin's wrapper lives in its own file (fonts.ts, …) and is
// reachable both as a subpath (`@carbon/plugins/fonts`, the form that keeps
// an app's bundle from pulling in every wrapper just because it imported
// one) and re-exported here for convenience.
//
// Deliberately flat, and NOT reorganized into a subdirectory even though
// that's the usual "give it a role" rule for this tier — every already-
// scaffolded app's own tsconfig.json bakes an ABSOLUTE wildcard path
// (`"@carbon/plugins/*": [".../solutions/interface/plugins/*"]`) at
// creation time, which Bun's bundler resolves directly against the
// filesystem. Moving a file out of this exact directory breaks every
// existing app's build the moment it imports that plugin's wrapper — not
// hypothetically: confirmed directly (`@carbon/plugins/fonts` etc. failing
// to resolve, "Bundle failed") after trying exactly that move. See
// package.json's `"carbon": {"kind": "library"}` for how this stays clean
// under the workspace-layout checker without moving anything.

export * from "./fonts.ts";
export * from "./clipboard.ts";
export * from "./dialog.ts";
export * from "./notification.ts";
export * from "./keychain.ts";
export * from "./global-shortcuts.ts";
export * from "./tray.ts";
export * from "./deep-link.ts";
