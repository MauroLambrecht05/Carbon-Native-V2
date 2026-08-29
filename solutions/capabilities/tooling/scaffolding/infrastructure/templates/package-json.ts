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
//
// ── WHY EVERY PRESET SHIPS `"trustedDependencies": []` ──────────────────────
// A scaffolded project starts with npm lifecycle scripts (preinstall /
// postinstall / prepare) unable to run at all, for any dependency.
//
// The empty array is not a no-op. Bun does block dependency scripts by
// default, but only relative to a BUILT-IN allowlist of ~366 package names
// (`bun pm default-trusted`). Declaring the field REPLACES that list instead
// of extending it, so `[]` — and only `[]` — means "nothing". Verified
// against bun 1.3.10: a package on the default list runs its postinstall when
// the field is absent, and reports "Blocked 1 postinstall" when it is `[]`.
//
// This is the first of the four independent walls in
// `.local/notes/roadmap/04-security-and-capabilities`: a compromised
// dependency's install script never executes on the developer's machine, so
// it never reaches the runtime-level protections at all.
//
// A developer who genuinely needs one adds the package name here themselves —
// an explicit, reviewable, one-line decision rather than a silent default.
// Bun matches plain names only; `"pkg@1.2.3"` matches nothing (verified), so
// version-pinned trust is not expressible here yet.

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
  },
  "trustedDependencies": []
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
  },
  "trustedDependencies": []
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
  },
  "trustedDependencies": []
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
  },
  "trustedDependencies": []
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
  },
  "trustedDependencies": []
}
`;

// ── React variants ────────────────────────────────────────────────────────

// react-refresh is a devDependency, not a runtime one the app code ever
// imports directly — but it MUST be installed here, into the project's own
// node_modules, not just referenced from the workspace. React Fast Refresh
// (see solutions/interface/renderer/react/runtime/refresh.ts) needs it
// resolvable from a dev/HMR build's dist/.vendor-entry.cjs, which lives
// inside THIS project's own directory tree — a standalone-mode project
// (see PackagesPath's workspacePathFrom) has no other node_modules on its
// resolution path up to the workspace's. Confirmed directly: without this,
// the vendor bundle step fails to resolve it at all.
const REACT_BLANK = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "react-refresh": "^0.14.0",
    "typescript": "^5.6.0"
  },
  "trustedDependencies": []
}
`;

const REACT_TAILWIND = `{
  "name": "@@NAME@@",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "react-refresh": "^0.14.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0"
  },
  "trustedDependencies": []
}
`;

const BY_PRESET: Record<PresetName, string> = {
  // New names
  "solid-blank":            BLANK,
  "solid-tailwind":         TAILWIND,
  "solid-tailwind-plugins": TAILWIND_PLUGINS,
  "react-blank":            REACT_BLANK,
  "react-tailwind":         REACT_TAILWIND,
  "react-tailwind-plugins": REACT_TAILWIND,
  "three":                  THREE,
  // Legacy aliases
  "blank":           BLANK,
  "blank-plugins":   BLANK_PLUGINS,
  "tailwind":        TAILWIND,
  "tailwind-plugins":TAILWIND_PLUGINS,
};

export function packageJsonTemplate(preset: PresetName): string {
  return BY_PRESET[preset];
}
