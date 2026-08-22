// package.json templates, one per preset.
//
// ── NO CARBON DEPENDENCIES HERE ─────────────────────────────────────────────
// A scaffolded project declares only real npm packages. @carbon/mini-solid and
// the vite plugins are INJECTED by the build pipeline from the workspace — see
// the onResolve block in capabilities/tooling/bundling — exactly as the React
// reconciler and the DOM shim already were.
//
// V1 generated `file:` dependencies pointing into a packages/ directory. Two
// things were wrong with that. The directory has not existed since the
// migration, and `file:` does not work here at all: bun walks up from the
// dependency, finds the node_modules JUNCTION at the workspace root (the real
// tree is in .config/), and the copy fails with EPERM on Windows. Reproduced in
// isolation — the same package under a plain directory installs, under a
// junction it does not.
//
// The generated tsconfig maps @carbon/* to the workspace so the editor and
// `tsc` still resolve them. Only the installer is bypassed.

import type { PresetName } from "../../domain/value-objects/Preset.ts";

/** Just the runtime and solid-js. No vite plugins, no Tailwind. */
const BLANK = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
`;

/** Blank + transforms: console.log stripping, debug strip, codemod hooks. */
const BLANK_PLUGINS = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
`;

/** Tailwind only: class="..." support, without the transforms plugin. */
const TAILWIND = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0"
  }
}
`;

/** The most useful all-rounder — V1's original default. */
const TAILWIND_PLUGINS = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "solid-js": "^1.9.0"
  },
  "devDependencies": {

    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0"
  }
}
`;

const THREE = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {

    "solid-js": "^1.9.0",
    "three": "^r148"
  },
  "devDependencies": {

    "typescript": "^5.6.0"
  }
}
`;

const BY_PRESET: Record<PresetName, string> = {
  blank: BLANK,
  "blank-plugins": BLANK_PLUGINS,
  tailwind: TAILWIND,
  "tailwind-plugins": TAILWIND_PLUGINS,
  three: THREE
};

export function packageJsonTemplate(preset: PresetName): string {
  return BY_PRESET[preset];
}
