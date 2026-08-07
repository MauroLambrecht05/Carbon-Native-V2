// carbon.toml templates, one per manifest shape.
//
// Raw strings rather than a templates/ directory of real files: the templates
// have to survive being compiled into a single-file binary, and a `.toml` on
// disk beside the source would not. V1's Rust CLI used include_str! for the
// same reason, and these are byte-identical to what it emitted.
//
// Placeholders are @@NAME@@ / @@DISPLAY@@ / @@PACKAGES@@ — see render().

import type { ManifestShape } from "../../domain/value-objects/Preset.ts";

const BASE = `[app]
name = "@@NAME@@"
version = "0.1.0"
display_name = "@@DISPLAY@@"

[runtime]
backend = "mini"
bytecode = true
`;

const TAILWIND = `[app]
name = "@@NAME@@"
version = "0.1.0"
display_name = "@@DISPLAY@@"

[runtime]
backend = "mini"
bytecode = true

[tailwind]
enabled = true
`;

const THREE = `[app]
name = "@@NAME@@"
version = "0.1.0"
display_name = "@@DISPLAY@@"

[runtime]
backend = "mini"
bytecode = true

[runtime.plugins]
canvas = { capabilities = ["gpu"] }
`;

const BY_SHAPE: Record<ManifestShape, string> = {
  base: BASE,
  tailwind: TAILWIND,
  three: THREE,
};

export function manifestTemplate(shape: ManifestShape): string {
  return BY_SHAPE[shape];
}
