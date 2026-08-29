// The files that are the same within each renderer.
//
// Two tsconfig variants — one per renderer — because jsxImportSource and the
// @carbon/* path alias differ between Solid and React.

import type { Renderer } from "../../domain/value-objects/Preset.ts";

/**
 * Solid tsconfig — jsxImportSource: solid-js, maps @carbon/mini-solid.
 * @@ROOT@@ is replaced with the path to the workspace root (relative for
 * projects inside the workspace, absolute for standalone installs).
 */
export const TSCONFIG_SOLID = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "strict": false,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "types": [],
    "paths": {
      "@carbon/mini-solid": ["@@ROOT@@/solutions/interface/renderer/solid/index.ts"],
      "@carbon/mini-solid/*": ["@@ROOT@@/solutions/interface/renderer/solid/*"]
    }
  },
  "include": ["App.tsx", "src/**/*"]
}
`;

/**
 * React tsconfig — automatic JSX runtime, jsxImportSource: react.
 *
 * Deliberately plain "react", not "@carbon/mini-react": \`view\`, \`text\`,
 * \`button\`, \`canvas\`, \`svg\`, \`input\` all collide with real SVG/HTML
 * element names, and @types/react declares a plain, unconditional GLOBAL
 * \`JSX.IntrinsicElements\` the moment ANYTHING in the program imports
 * "react" — which @carbon/mini-react's own files always do, so it is
 * always present for a real app regardless of jsxImportSource. Verified
 * directly: a custom jsxImportSource module's own exported \`JSX\`
 * namespace never wins that collision once react's global one exists,
 * even a complete one. So Carbon's React intrinsics type-check against
 * their real SVGProps/HTMLProps shape, not a Carbon-specific one — use
 * \`className\` (not \`class\`) and camelCase style keys (\`borderRadius\`,
 * not \`border_radius\`) in App.tsx for that reason. The runtime accepts
 * both regardless — applyProps reads \`className ?? class\`, and the Rust
 * scene parser matches camelCase, snake_case and kebab-case forms of
 * every property name — so this is a types-only adjustment, not a
 * runtime behavior change. See runtime/jsx-runtime.ts for the rest of
 * the story.
 */
export const TSCONFIG_REACT = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "strict": false,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "types": [],
    "paths": {
      "@carbon/mini-react": ["@@ROOT@@/solutions/interface/renderer/react/index.ts"],
      "@carbon/mini-react/*": ["@@ROOT@@/solutions/interface/renderer/react/*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx", "**/*.d.ts"]
}
`;

export function tsconfigTemplate(renderer: Renderer): string {
  return renderer === "react" ? TSCONFIG_REACT : TSCONFIG_SOLID;
}

export const GITIGNORE = `node_modules
dist
.carbon-cache
bun.lock
`;
