// jsx-runtime entry — what `tsconfig.json: "jsx": "react-jsx"` /
// `automatic` runtime imports per JSX expression.
//
// We just re-export React's own jsx-runtime. The carbon-mini-specific
// rendering happens at the reconciler layer (see ./index.ts), not at
// the JSX-factory layer. So `jsx`/`jsxs`/`Fragment` here behave exactly
// the same as in any React 18+ app — they produce ReactElement objects
// that `render()` reconciles.
//
// Set this as the `importSource` in your tsconfig:
//
//   { "compilerOptions": {
//       "jsx": "react-jsx",
//       "jsxImportSource": "@carbon/mini-react"
//     } }

export { jsx, jsxs, Fragment } from "react/jsx-runtime";
export { jsxDEV } from "react/jsx-dev-runtime";
