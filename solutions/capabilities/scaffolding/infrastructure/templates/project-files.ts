// The files that are the same under every preset.

/**
 * `jsx: "preserve"` matters: the JSX is compiled by the vite pipeline, not by
 * tsc, so tsc must leave it alone. `strict: false` is deliberate for a starter
 * project — a scaffold that does not typecheck on the first save is a bad
 * first impression.
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
    "types": ["@carbon/mini-solid/types"]
  },
  "include": ["App.tsx", "src/**/*"]
}
`;

export const GITIGNORE = `node_modules
dist
.carbon-cache
bun.lock
`;
