// The files that are the same under every preset.

/**
 * `jsx: "preserve"` matters: the JSX is compiled by the build pipeline, not by
 * tsc, so tsc must leave it alone. `strict: false` is deliberate for a starter
 * project — a scaffold that does not typecheck on the first save is a bad
 * first impression.
 *
 * The `paths` entry is what makes @carbon/mini-solid resolve in an editor. The
 * package is not installed into the project — the build pipeline injects it
 * from the workspace — so without this the imports would be red in the editor
 * while building fine, which is its own kind of broken.
 */
export const TSCONFIG_JSON = `{
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

export const GITIGNORE = `node_modules
dist
.carbon-cache
bun.lock
`;
