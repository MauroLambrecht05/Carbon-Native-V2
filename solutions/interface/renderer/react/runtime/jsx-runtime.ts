// jsx-runtime entry — what `tsconfig.json: "jsx": "react-jsx"` /
// `automatic` runtime imports per JSX expression.
//
// We just re-export React's own jsx-runtime. The carbon-mini-specific
// rendering happens at the reconciler layer (see ./index.ts), not at
// the JSX-factory layer. So `jsx`/`jsxs`/`Fragment` here behave exactly
// the same as in any React 18+ app — they produce ReactElement objects
// that `render()` reconciles.
//
// Scaffolded projects point `jsxImportSource` at plain "react", not at
// this module — see solutions/capabilities/tooling/scaffolding's
// TSCONFIG_REACT for why: `view`/`text`/`button`/`canvas`/`svg`/`input`
// all collide with real SVG/HTML element names, and TypeScript's global
// `JSX.IntrinsicElements` (declared unconditionally by @types/react,
// active the moment ANYTHING in the program imports "react" — which
// @carbon/mini-react's own files always do) wins that collision no
// matter what a custom jsxImportSource module declares. Verified
// directly against this TypeScript version: an exported `JSX` namespace
// here, even a complete one, never overrides it once react is loaded.
// So Carbon intrinsics type-check against their real SVGProps/HTMLProps
// shape — use `className` (not `class`) and camelCase style keys
// (`borderRadius`, not `border_radius`) for that reason. The runtime
// accepts all of it regardless: applyProps reads `className ?? class`,
// and the Rust scene parser matches camelCase, snake_case and
// kebab-case forms of every property name — see scene.rs.
//
// This module still exists (and is still exported from index.ts's
// package.json as a valid subpath) for anything that imports it
// explicitly rather than through the automatic JSX transform.

export { jsx, jsxs, Fragment } from "react/jsx-runtime";
export { jsxDEV } from "react/jsx-dev-runtime";
