// @carbon/plugins — framework-facing wrappers around carbon-sdk's standard
// plugins. Each plugin's wrapper lives in its own file under wrappers/
// (fonts.ts, …) and is reachable both as a subpath (`@carbon/plugins/fonts`,
// the form that keeps an app's bundle from pulling in every wrapper just
// because it imported one — see package.json's `exports` map) and
// re-exported here for convenience.

export * from "./wrappers/fonts.ts";
export * from "./wrappers/clipboard.ts";
export * from "./wrappers/dialog.ts";
export * from "./wrappers/notification.ts";
export * from "./wrappers/keychain.ts";
export * from "./wrappers/global-shortcuts.ts";
export * from "./wrappers/tray.ts";
export * from "./wrappers/deep-link.ts";
