// @carbon/packaging — an artifact into an OS installer.
//
// All infrastructure: each generator turns a carbon manifest into the input one
// OS packager wants. No domain worth modelling.
//
// NOTE: nothing calls these yet. `carbon bundle` documents an --out flag but
// never invokes a generator. Inherited from V1.

export * from "./infrastructure/appimage.ts";
export * from "./infrastructure/deb.ts";
export * from "./infrastructure/dmg.ts";
export * from "./infrastructure/nsis.ts";
export * from "./infrastructure/wix.ts";
