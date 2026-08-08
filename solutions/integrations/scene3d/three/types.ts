// @carbon/three / types.ts
//
// DrawCommand schema. This is the wire format between the JS-side scene-walk
// (CarbonRenderer) and the Rust-side executor (Phase 1's
// CanvasSurface::execute_commands). Phase 2 produces these; Phase 1 will
// consume them.
//
// Design notes:
//   * Commands are plain objects; binary buffers are typed arrays so they can
//     be moved across the JS↔Rust boundary as ArrayBuffers without copies.
//   * Transforms are flat Float32Array(16) in column-major order, matching
//     three.js's `Matrix4.elements` and wgpu's expected matrix layout.
//   * Lights are bundled as a separate command so the Rust executor can
//     upload them once per frame to a uniform buffer rather than per-mesh.

// ─── Material side enum ───────────────────────────────────────────────────
// Mirrors three's `FrontSide=0`, `BackSide=1`, `DoubleSide=2`.
export type SideValue = 0 | 1 | 2;

// ─── Texture descriptor ───────────────────────────────────────────────────
// We don't ship pixel data in every command — Phase 1 caches by `id`. First
// time the executor sees a texture id it uploads the pixels; subsequent
// commands referencing the same id reuse the GPU resource.
export interface TextureDescriptor {
  id: number;
  width: number;
  height: number;
  // RGBA8 unorm. `null` means "executor already has this id cached".
  pixels: Uint8Array | null;
}

// ─── Light descriptors ────────────────────────────────────────────────────
export interface AmbientLightDesc {
  type: "ambient";
  color: [number, number, number];
  intensity: number;
}

export interface DirectionalLightDesc {
  type: "directional";
  color: [number, number, number];
  intensity: number;
  // World-space direction (from light, normalized).
  direction: [number, number, number];
}

export interface PointLightDesc {
  type: "point";
  color: [number, number, number];
  intensity: number;
  // World-space position.
  position: [number, number, number];
  // 0 = no falloff (three default for distance==0); else linear falloff.
  distance: number;
  decay: number;
}

export type LightDesc = AmbientLightDesc | DirectionalLightDesc | PointLightDesc;

// ─── Camera descriptor ────────────────────────────────────────────────────
// Pre-computed projection * view; the executor doesn't need camera type info.
// The matrices live in their own command (set once per frame) so per-mesh
// commands can stay light.
export interface CameraDesc {
  // 4x4 column-major.
  view: Float32Array;
  projection: Float32Array;
  // World-space camera position — needed for specular lighting (Phong/Standard).
  position: [number, number, number];
}

// ─── Material descriptors ─────────────────────────────────────────────────
export interface BasicMaterialDesc {
  type: "basic";
  color: [number, number, number];
  opacity: number;
  transparent: boolean;
  side: SideValue;
  map: TextureDescriptor | null;
}

export interface StandardMaterialDesc {
  type: "standard";
  color: [number, number, number];
  opacity: number;
  transparent: boolean;
  side: SideValue;
  map: TextureDescriptor | null;
  metalness: number;
  roughness: number;
  emissive: [number, number, number];
}

export interface PhongMaterialDesc {
  type: "phong";
  color: [number, number, number];
  opacity: number;
  transparent: boolean;
  side: SideValue;
  map: TextureDescriptor | null;
  shininess: number;
  specular: [number, number, number];
  emissive: [number, number, number];
}

export type MaterialDesc =
  | BasicMaterialDesc
  | StandardMaterialDesc
  | PhongMaterialDesc;

// ─── Draw commands ────────────────────────────────────────────────────────
export interface ClearCommand {
  type: "clear";
  rgba: [number, number, number, number];
}

// Set the camera/lights for the rest of the frame. Always emitted exactly
// once per frame (after `clear`, before the first mesh).
export interface SetCameraCommand {
  type: "setCamera";
  camera: CameraDesc;
}

export interface SetLightsCommand {
  type: "setLights";
  lights: LightDesc[];
}

export interface MeshCommand {
  type: "mesh";
  // Stable id for the geometry (so Phase 1 can cache GPU buffers).
  geometryId: number;
  // Float32Array, length = vertexCount * 3.
  positions: Float32Array;
  // Float32Array, length = vertexCount * 3. May be null for unlit materials.
  normals: Float32Array | null;
  // Float32Array, length = vertexCount * 2. May be null when no texture map.
  uvs: Float32Array | null;
  // Triangle indices. Uint16 if vertexCount < 65536, else Uint32.
  indices: Uint16Array | Uint32Array;
  // 4x4 column-major world matrix.
  transform: Float32Array;
  // Pre-multiplied normal matrix (3x3 column-major, packed as Float32Array(9))
  // — saves the executor from computing inverse(transpose(transform_3x3)).
  normalMatrix: Float32Array;
  material: MaterialDesc;
}

export interface LineCommand {
  type: "line";
  geometryId: number;
  positions: Float32Array;
  // null => non-indexed (drawArrays-style).
  indices: Uint16Array | Uint32Array | null;
  color: [number, number, number];
  opacity: number;
  transparent: boolean;
  // 0 = LINES (every pair), 1 = LINE_STRIP, 2 = LINE_LOOP. Mirrors
  // gl.LINES(1)/gl.LINE_STRIP(3)/gl.LINE_LOOP(2) but normalized so the
  // executor doesn't need to know GL constants.
  mode: 0 | 1 | 2;
  transform: Float32Array;
}

export interface PointsCommand {
  type: "points";
  geometryId: number;
  positions: Float32Array;
  color: [number, number, number];
  size: number;
  opacity: number;
  transparent: boolean;
  // sizeAttenuation == true => points shrink with distance (default).
  sizeAttenuation: boolean;
  transform: Float32Array;
}

export type DrawCommand =
  | ClearCommand
  | SetCameraCommand
  | SetLightsCommand
  | MeshCommand
  | LineCommand
  | PointsCommand;

// ─── Executor interface ───────────────────────────────────────────────────
// Phase 1's `CanvasSurface::execute_commands` will implement this on the JS
// side as a thin wrapper that serializes into an ArrayBuffer + length and
// invokes `__carbon_canvas_execute_commands(canvasId, ptr, len)`.
//
// In Phase 2 we exercise the renderer against a mock implementation
// (see `mock-executor.ts`) that just records commands.
export interface CommandExecutor {
  execute(commands: DrawCommand[]): void;
}
