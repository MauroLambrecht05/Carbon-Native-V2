// Ambient declaration for react-refresh, which ships no types.
//
// Loose and minimal on purpose — runtime/refresh.ts casts the import to its
// own local, precise interface immediately after importing it (see the
// comment there), so a more detailed type here would just be a second copy
// of that interface with no way to keep the two in sync. What this buys is
// the same thing solutions/capabilities/tooling/bundling/infrastructure/
// vendor.d.ts's declarations buy: a typo in the specifier becomes a
// missing-module error instead of silently resolving to `any`.
declare module "react-refresh/runtime" {
  const runtime: unknown;
  export default runtime;
}
