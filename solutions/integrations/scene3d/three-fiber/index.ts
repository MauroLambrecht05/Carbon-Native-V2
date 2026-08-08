// @carbon/three-fiber
//
// Public entry point. Re-exports the Canvas component, the underlying
// three-fiber renderer (for advanced/test usage), and the intrinsic
// extension hook.

export { Canvas, useThree } from "./Canvas.js";
export type { CanvasProps, ThreeContextValue } from "./Canvas.js";

export { createThreeFiberRenderer, wrapAsNode } from "./renderer.js";
export type { ThreeNode, ThreeFiberRenderer } from "./renderer.js";

export {
  extend,
  getIntrinsicSpec,
  applyProp,
  applyInitialProps,
} from "./intrinsics.js";
export type { IntrinsicSpec, AttachTo } from "./intrinsics.js";

// Side-effect import to register JSX intrinsic types in user code that
// imports anything from this package. Has no runtime cost.
import "./types.js";
