// Entry point loaded by `tsconfig.json: "types": ["@carbon/mini-react/types"]`.
//
// Triple-slash reference forces TypeScript to also pull in jsx.d.ts so the
// JSX intrinsic-elements augmentation runs. We can't `export *` here because
// jsx.d.ts is purely declaration-merging and has no value-side exports —
// the reference directive is what actually triggers it.

/// <reference path="./jsx.d.ts" />

export {};
