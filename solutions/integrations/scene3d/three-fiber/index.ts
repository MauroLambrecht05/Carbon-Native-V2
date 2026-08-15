// @carbon/three-fiber
//
// Public entry point. Re-exports the Canvas component, the underlying
// three-fiber renderer (for advanced/test usage), and the intrinsic
// extension hook.
//
// ── LAYOUT ──────────────────────────────────────────────────────────────────
//   infrastructure/  the intrinsic registry, the Solid universal renderer it
//                    drives, the builder the vite plugin's output calls, and
//                    the <Canvas> component that owns a frame loop
//   types/           the JSX intrinsic typings an app puts in tsconfig
//
// There is no domain/, and that is a measurement rather than an omission:
// every file here imports three.js. Its sibling integrations/scene3d/three
// does have one, because the DrawCommand schema genuinely names no vendor.
// A domain/ here would be a label on a directory, not a boundary.
//
// `build/` used to hold intrinsics.ts and r3f-build.ts, which read as
// build-time code and is not what either is: both run in the app, every
// frame. They are infrastructure like the rest.

export { Canvas, useThree } from "./infrastructure/components/Canvas.js";
export type { CanvasProps, ThreeContextValue } from "./infrastructure/components/Canvas.js";

export { createThreeFiberRenderer, wrapAsNode } from "./infrastructure/renderer.js";
export type { ThreeNode, ThreeFiberRenderer } from "./infrastructure/renderer.js";

export {
  extend,
  getIntrinsicSpec,
  applyProp,
  applyInitialProps,
} from "./infrastructure/intrinsics.js";
export type { IntrinsicSpec, AttachTo } from "./infrastructure/intrinsics.js";

// Side-effect import to register JSX intrinsic types in user code that
// imports anything from this package. Has no runtime cost.
import "./types.js";
