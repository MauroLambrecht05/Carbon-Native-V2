// @carbon/plugins — framework-facing wrappers around carbon-sdk's standard
// plugins. Each plugin's wrapper lives in its own file (fonts.ts, …) and is
// reachable both as a subpath (`@carbon/plugins/fonts`, the form that keeps
// an app's bundle from pulling in every wrapper just because it imported
// one) and re-exported here for convenience.

export * from "./fonts.ts";
export * from "./clipboard.ts";
export * from "./dialog.ts";
export * from "./notification.ts";
export * from "./keychain.ts";
export * from "./global-shortcuts.ts";
export * from "./tray.ts";
export * from "./deep-link.ts";
