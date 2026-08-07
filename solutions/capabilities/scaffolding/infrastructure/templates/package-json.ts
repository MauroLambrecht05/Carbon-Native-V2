// package.json templates, one per preset.
//
// The `file:@@PACKAGES@@/...` dependencies are the known-broken part — see
// domain/value-objects/PackagesPath.ts. Preserved verbatim from V1 rather than
// pointed somewhere that resolves today.

import type { PresetName } from "../../domain/value-objects/Preset.ts";

/** Just the runtime and solid-js. No vite plugins, no Tailwind. */
const BLANK = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@carbon/mini-solid": "file:@@PACKAGES@@/mini-runtime",
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
    "@carbon/mini-solid": "file:@@PACKAGES@@/mini-runtime",
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "@carbon/vite/transforms": "file:@@PACKAGES@@/vite-plugin-carbon-transforms",
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
    "@carbon/mini-solid": "file:@@PACKAGES@@/mini-runtime",
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "@carbon/vite/tailwind": "file:@@PACKAGES@@/vite-plugin-tailwind",
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
    "@carbon/mini-solid": "file:@@PACKAGES@@/mini-runtime",
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "@carbon/vite/tailwind": "file:@@PACKAGES@@/vite-plugin-tailwind",
    "@carbon/vite/transforms": "file:@@PACKAGES@@/vite-plugin-carbon-transforms",
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
    "@carbon/mini-solid": "file:@@PACKAGES@@/mini-runtime",
    "@carbon/three": "file:@@PACKAGES@@/carbon-three-renderer",
    "solid-js": "^1.9.0",
    "three": "^r148"
  },
  "devDependencies": {
    "@carbon/vite/tailwind": "file:@@PACKAGES@@/vite-plugin-tailwind",
    "@carbon/vite/transforms": "file:@@PACKAGES@@/vite-plugin-carbon-transforms",
    "typescript": "^5.6.0"
  }
}
`;

const BY_PRESET: Record<PresetName, string> = {
  blank: BLANK,
  "blank-plugins": BLANK_PLUGINS,
  tailwind: TAILWIND,
  "tailwind-plugins": TAILWIND_PLUGINS,
  three: THREE,
};

export function packageJsonTemplate(preset: PresetName): string {
  return BY_PRESET[preset];
}
