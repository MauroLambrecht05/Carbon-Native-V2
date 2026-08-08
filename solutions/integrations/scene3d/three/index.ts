// @carbon/three
//
// Public entry point. Re-exports the renderer + mock executor + DrawCommand
// schema. Phase 1 will add a real `CanvasSurfaceExecutor` next to this file
// that wraps `__carbon_canvas_execute_commands(...)`; until then, only
// `MockCommandExecutor` is available.

export { CarbonRenderer } from "./renderer.js";
export type { CarbonRendererOptions } from "./renderer.js";

export { MockCommandExecutor } from "./mock-executor.js";
export type { MockMode, MockStats } from "./mock-executor.js";

export { CanvasSurfaceExecutor } from "./canvas-executor.js";

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
} from "./types.js";
