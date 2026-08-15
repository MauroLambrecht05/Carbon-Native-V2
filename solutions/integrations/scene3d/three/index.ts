// @carbon/three
//
// Public entry point. Re-exports the renderer + executors + DrawCommand
// schema.
//
// ── LAYOUT ──────────────────────────────────────────────────────────────────
//   domain/          the DrawCommand schema — the wire format between the
//                    JS scene-walk and the Rust executor. Imports no three.js
//                    and no host function: both sides of that boundary have
//                    to agree on it, so it must not drag either one in.
//   infrastructure/  the vendor-facing half: the renderer that walks a
//                    three.js scene, and the executors the commands go to.
//
// Same split as integrations/bundler/vite.

export { CarbonRenderer } from "./infrastructure/renderer.js";
export type { CarbonRendererOptions } from "./infrastructure/renderer.js";

export { MockCommandExecutor } from "./infrastructure/executors/mock-executor.js";
export type { MockMode, MockStats } from "./infrastructure/executors/mock-executor.js";

export { CanvasSurfaceExecutor } from "./infrastructure/executors/canvas-executor.js";

export type {
  CommandExecutor,
  DrawCommand,
  ClearCommand,
  SetCameraCommand,
  SetLightsCommand,
  MeshCommand,
  LineCommand,
  PointsCommand,
  MaterialDesc,
  BasicMaterialDesc,
  StandardMaterialDesc,
  PhongMaterialDesc,
  LightDesc,
  AmbientLightDesc,
  DirectionalLightDesc,
  PointLightDesc,
  CameraDesc,
  TextureDescriptor,
  SideValue,
} from "./domain/draw-commands.js";
