// The bundler resolves "carbon:*" specifiers to real globals at build time
// (@carbon/vite/imports, driven by each plugin's carbon-plugin.toml
// [exports."carbon:..."] table) — this file just tells the TS toolchain the
// same shape, so the editor and `tsc` agree with what actually ships.
//
// A plain top-level file (no imports/exports of its own) so TS treats each
// `declare module` below as a fresh ambient declaration rather than an
// augmentation of a module that would need to already exist.

declare module "carbon:carbon-pulse" {
  export function setActive(active: boolean): void;
}
