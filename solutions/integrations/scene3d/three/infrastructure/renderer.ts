// @carbon/three / renderer.ts
//
// `CarbonRenderer` is a drop-in shape for three.js's `WebGLRenderer`. It
// takes a scene + camera, walks the scene tree, and emits a stream of
// `DrawCommand`s to a `CommandExecutor` (mock in tests, GPU-backed via
// Phase 1's `CanvasSurface::execute_commands` in production).
//
// Scope (Phase 2):
//   * Mesh / Line / Points / Sprite renderables
//   * Basic / Standard / Phong materials (subset of props)
//   * Ambient / Directional / Point lights
//   * Perspective / Orthographic cameras
//   * `object.visible` + frustum culling
//
// Out of scope: ShaderMaterial, post-processing, InstancedMesh, SkinnedMesh,
// render targets. See README.md for the full list and rationale.

import * as THREE from "three";
import type {
  CameraDesc,
  ClearCommand,
  CommandExecutor,
  DrawCommand,
  LightDesc,
  LineCommand,
  MaterialDesc,
  MeshCommand,
  PointsCommand,
  SetCameraCommand,
  SetLightsCommand,
  SideValue,
  TextureDescriptor,
} from "../domain/draw-commands.js";

export interface CarbonRendererOptions {
  // The <canvas> intrinsic created by the carbon-mini scene graph. The
  // renderer doesn't draw to it directly — it asks the executor — but it
  // pulls width/height defaults from the canvas if `setSize` isn't called.
  canvas?: { width: number; height: number };
  // Override the default executor. In production this is the GPU-backed
  // executor wired to Phase 1's CanvasSurface. In tests, a mock recorder.
  executor?: CommandExecutor;
  // Background clear color. Mirrors three's `setClearColor`.
  clearColor?: [number, number, number, number];
  // Disable frustum culling globally. Useful for benchmarks comparing the
  // walk cost with vs without culling, and as an escape hatch when the
  // user manages culling externally.
  enableFrustumCulling?: boolean;
}

// ─── Geometry id assignment ───────────────────────────────────────────────
// We tag each `BufferGeometry` with a stable id so the executor can cache
// GPU buffers across frames. We don't mutate the geometry object — we use
// a WeakMap so the id is GC'd when the geometry is.
let nextGeometryId = 1;
const geometryIds = new WeakMap<THREE.BufferGeometry, number>();
function geometryIdOf(g: THREE.BufferGeometry): number {
  let id = geometryIds.get(g);
  if (id === undefined) {
    id = nextGeometryId++;
    geometryIds.set(g, id);
  }
  return id;
}

// ─── Texture id assignment ────────────────────────────────────────────────
let nextTextureId = 1;
const textureIds = new WeakMap<THREE.Texture, number>();
// Track which texture ids the executor has already seen this *renderer
// instance*. We send pixels only the first time. (Phase 1 will re-key on
// canvasId so multiple renderers can share textures, but that's not our
// problem here.)
function textureDescriptorFor(
  tex: THREE.Texture,
  uploaded: Set<number>
): TextureDescriptor | null {
  let id = textureIds.get(tex);
  if (id === undefined) {
    id = nextTextureId++;
    textureIds.set(tex, id);
  }
  if (uploaded.has(id)) {
    return { id, width: tex.image?.width ?? 0, height: tex.image?.height ?? 0, pixels: null };
  }
  uploaded.add(id);
  // Try to extract pixels. Three's `Texture.image` may be HTMLImageElement,
  // ImageBitmap, ImageData, or {data,width,height} (DataTexture). The Phase
  // 1 executor only needs RGBA8 + dims; we extract what we can.
  const img: any = tex.image;
  let pixels: Uint8Array | null = null;
  let width = 0;
  let height = 0;
  if (img && img.data instanceof Uint8Array) {
    // DataTexture.
    pixels = img.data;
    width = img.width ?? 0;
    height = img.height ?? 0;
  } else if (img && typeof img.width === "number" && typeof img.height === "number") {
    width = img.width;
    height = img.height;
    // Pixels not available without a canvas readback. Phase 1 will handle
    // the readback path (HTMLImageElement has no getImageData). For now
    // we stub `pixels = null` so the executor knows it has to fetch.
    pixels = null;
  }
  return { id, width, height, pixels };
}

// ─── Per-frame state ──────────────────────────────────────────────────────
// Allocated once and reused across frames to avoid GC pressure during the
// scene walk. The walk is the hottest path and does no compute beyond
// matrix multiplies — Vector3/Box3/Frustum allocations would dominate.
class FrameContext {
  commands: DrawCommand[] = [];
  lights: LightDesc[] = [];
  uploadedTextures = new Set<number>();
  // Reusable matrices/vectors. Resetting an existing object is ~free vs
  // allocating a new one each call.
  readonly viewProjection = new THREE.Matrix4();
  readonly frustum = new THREE.Frustum();
  readonly tmpVec3 = new THREE.Vector3();
  readonly tmpVec3b = new THREE.Vector3();
  readonly tmpMat3 = new THREE.Matrix3();
  // Bounding sphere lookup helper.
  readonly tmpSphere = new THREE.Sphere();

  reset(): void {
    this.commands.length = 0;
    this.lights.length = 0;
    this.uploadedTextures.clear();
  }
}

// ─── CarbonRenderer ───────────────────────────────────────────────────────
export class CarbonRenderer {
  // Shape-compat with three.WebGLRenderer for things like
  // `renderer.setSize(...)` calls in user code.
  width = 800;
  height = 600;
  pixelRatio = 1;
  enableFrustumCulling: boolean;

  private readonly executor: CommandExecutor;
  private readonly clearColor: [number, number, number, number];
  private readonly ctx = new FrameContext();
  // Accumulated stats — exposed for tests/benchmarks.
  stats = {
    framesRendered: 0,
    objectsVisited: 0,
    objectsCulled: 0,
    drawCommandsLastFrame: 0,
  };

  constructor(opts: CarbonRendererOptions = {}) {
    if (!opts.executor) {
      throw new Error(
        "CarbonRenderer: `executor` is required. In tests use MockCommandExecutor; in production Phase 1's CanvasSurface executor."
      );
    }
    this.executor = opts.executor;
    this.clearColor = opts.clearColor ?? [0, 0, 0, 1];
    this.enableFrustumCulling = opts.enableFrustumCulling ?? true;
    if (opts.canvas) {
      this.width = opts.canvas.width;
      this.height = opts.canvas.height;
    }
  }

  // three.WebGLRenderer compat: `renderer.setSize(w, h, updateStyle?)`.
  setSize(width: number, height: number, _updateStyle = true): void {
    this.width = width;
    this.height = height;
  }

  // three.WebGLRenderer compat — no-op in our world (executor owns the
  // canvas). Kept so user code that calls `renderer.setPixelRatio(devicePixelRatio)`
  // doesn't crash.
  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }

  // three.WebGLRenderer compat: clear-color setter. Two overloads in three:
  // `(color)` and `(color, alpha)`. We accept either three.Color, hex, or rgb.
  setClearColor(color: THREE.ColorRepresentation, alpha = 1): void {
    const c = new THREE.Color(color);
    this.clearColor[0] = c.r;
    this.clearColor[1] = c.g;
    this.clearColor[2] = c.b;
    this.clearColor[3] = alpha;
  }

  /** Forward a canvas id to the executor (Phase 1.5δ wire-up).
   *  The Canvas component calls this once the wgpu surface is ready, so the
   *  CanvasSurfaceExecutor knows where to dispatch its draw commands. The
   *  MockCommandExecutor doesn't need this and ignores the call.
   */
  setCanvasId(id: number): void {
    const exec = this.executor as any;
    if (exec && typeof exec.setCanvasId === "function") {
      exec.setCanvasId(id);
    }
  }

  dispose(): void {
    // Nothing to free on the JS side — the executor owns GPU resources.
  }

  // The hot path. Walk the scene, emit commands, hand them off.
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const ctx = this.ctx;
    ctx.reset();

    // 1. Make sure all world matrices are current. Three's standard
    //    convention: callers may have set `matrixAutoUpdate=false` on
    //    selected nodes, so we still respect updates from the root.
    if (scene.matrixWorldAutoUpdate !== false) {
      scene.updateMatrixWorld(false);
    }

    // 2. Camera matrices. Three's `Camera.matrixWorldInverse` is the view
    //    matrix; `projectionMatrix` is computed by the camera subclass.
    camera.updateMatrixWorld(false);
    if ((camera as any).updateProjectionMatrix) {
      // PerspectiveCamera / OrthographicCamera both have this; cheap if
      // the projection hasn't changed (three skips work internally).
      (camera as any).updateProjectionMatrix();
    }
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    // 3. Build the frustum once for culling.
    if (this.enableFrustumCulling) {
      ctx.viewProjection.multiplyMatrices(
        (camera as THREE.PerspectiveCamera).projectionMatrix,
        camera.matrixWorldInverse
      );
      ctx.frustum.setFromProjectionMatrix(ctx.viewProjection);
    }

    // 4. Emit clear + camera + lights commands in order. Lights are
    //    collected in a first pass (they're not draw-ordered, so we want
    //    them set before any mesh).
    const clear: ClearCommand = { type: "clear", rgba: [...this.clearColor] };
    ctx.commands.push(clear);

    const cameraDesc: CameraDesc = this.describeCamera(camera);
    const setCameraCmd: SetCameraCommand = { type: "setCamera", camera: cameraDesc };
    ctx.commands.push(setCameraCmd);

    // First pass: collect lights only. We need them assembled before we
    // emit any mesh because the executor wants `setLights` first.
    this.collectLights(scene, ctx);
    const setLightsCmd: SetLightsCommand = { type: "setLights", lights: ctx.lights.slice() };
    ctx.commands.push(setLightsCmd);

    // 5. Walk and emit renderables.
    this.stats.objectsVisited = 0;
    this.stats.objectsCulled = 0;
    this.walk(scene, ctx);

    // 6. Hand off.
    this.stats.framesRendered++;
    this.stats.drawCommandsLastFrame = ctx.commands.length;
    this.executor.execute(ctx.commands);
  }

  // ─── Scene-walk ─────────────────────────────────────────────────────────
  private walk(obj: THREE.Object3D, ctx: FrameContext): void {
    if (obj.visible === false) return;
    this.stats.objectsVisited++;

    // Type discrimination: three uses `isMesh`, `isLine`, `isPoints`, etc.
    // Cheaper than `instanceof` and works across module copies (which can
    // happen with mismatched three versions in user setups).
    const o: any = obj;

    if (o.isMesh) {
      this.emitMesh(o, ctx);
    } else if (o.isLineSegments || o.isLineLoop || o.isLine) {
      this.emitLine(o, ctx);
    } else if (o.isPoints) {
      this.emitPoints(o, ctx);
    } else if (o.isSprite) {
      // Sprite: render as a 2-triangle quad facing the camera. We expand
      // it into a mesh-like command on the fly. Simpler than teaching the
      // executor about a separate "sprite" command type.
      this.emitSprite(o, ctx);
    }
    // Group / Object3D / Light / Camera / Scene → no draw, recurse.

    const children = obj.children;
    for (let i = 0, len = children.length; i < len; i++) {
      this.walk(children[i], ctx);
    }
  }

  private collectLights(obj: THREE.Object3D, ctx: FrameContext): void {
    if (obj.visible === false) return;
    const o: any = obj;
    if (o.isAmbientLight) {
      const c = (obj as THREE.AmbientLight).color;
      ctx.lights.push({
        type: "ambient",
        color: [c.r, c.g, c.b],
        intensity: (obj as THREE.AmbientLight).intensity,
      });
    } else if (o.isDirectionalLight) {
      const dl = obj as THREE.DirectionalLight;
      // three's directional light shines from `position` toward `target.position`.
      // Direction in world space = normalize(target.world - light.world).
      dl.target.updateMatrixWorld(false);
      ctx.tmpVec3.setFromMatrixPosition(dl.matrixWorld);
      ctx.tmpVec3b.setFromMatrixPosition(dl.target.matrixWorld);
      ctx.tmpVec3b.sub(ctx.tmpVec3).normalize();
      ctx.lights.push({
        type: "directional",
        color: [dl.color.r, dl.color.g, dl.color.b],
        intensity: dl.intensity,
        direction: [ctx.tmpVec3b.x, ctx.tmpVec3b.y, ctx.tmpVec3b.z],
      });
    } else if (o.isPointLight) {
      const pl = obj as THREE.PointLight;
      ctx.tmpVec3.setFromMatrixPosition(pl.matrixWorld);
      ctx.lights.push({
        type: "point",
        color: [pl.color.r, pl.color.g, pl.color.b],
        intensity: pl.intensity,
        position: [ctx.tmpVec3.x, ctx.tmpVec3.y, ctx.tmpVec3.z],
        distance: pl.distance,
        decay: pl.decay,
      });
    }
    const children = obj.children;
    for (let i = 0, len = children.length; i < len; i++) {
      this.collectLights(children[i], ctx);
    }
  }

  // ─── Renderable emitters ────────────────────────────────────────────────
  private emitMesh(mesh: THREE.Mesh, ctx: FrameContext): void {
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return;
    if (this.cull(mesh, geometry, ctx)) {
      this.stats.objectsCulled++;
      return;
    }

    const positions = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!positions) return;
    const positionsArr = positions.array as Float32Array;

    const normalsAttr = geometry.getAttribute("normal") as
      | THREE.BufferAttribute
      | undefined;
    const normals = normalsAttr ? (normalsAttr.array as Float32Array) : null;

    const uvsAttr = geometry.getAttribute("uv") as
      | THREE.BufferAttribute
      | undefined;
    const uvs = uvsAttr ? (uvsAttr.array as Float32Array) : null;

    const indexAttr = geometry.getIndex();
    let indices: Uint16Array | Uint32Array;
    if (indexAttr) {
      indices = indexAttr.array as Uint16Array | Uint32Array;
    } else {
      // Non-indexed geometry → synthesize a contiguous index list. Cheaper
      // than asking the executor to special-case drawArrays.
      const vertCount = positionsArr.length / 3;
      if (vertCount < 65536) {
        indices = new Uint16Array(vertCount);
        for (let i = 0; i < vertCount; i++) indices[i] = i;
      } else {
        indices = new Uint32Array(vertCount);
        for (let i = 0; i < vertCount; i++) indices[i] = i;
      }
    }

    // Material: pick the first material if it's an array (multi-material
    // meshes — three slices the geometry into groups; we don't yet, so we
    // emit one command with material[0] and ignore groups. Documented as a
    // Phase 2 limitation.).
    const rawMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!rawMat) return;
    const material = this.describeMaterial(rawMat as any, ctx);
    if (!material) return;

    // Transform: mesh.matrixWorld is already current (updateMatrixWorld
    // was called by three on the scene graph in `render`). Copy because
    // the executor owns the buffer for the rest of the frame.
    const transform = new Float32Array(mesh.matrixWorld.elements);

    // Normal matrix: inverse-transpose of the upper 3x3. Three has
    // `Matrix3.getNormalMatrix(m4)` which does exactly this. Pre-computing
    // here saves the executor from doing 9 mul + 9 div per mesh per frame.
    ctx.tmpMat3.getNormalMatrix(mesh.matrixWorld);
    const normalMatrix = new Float32Array(ctx.tmpMat3.elements);

    const cmd: MeshCommand = {
      type: "mesh",
      geometryId: geometryIdOf(geometry),
      positions: positionsArr,
      normals,
      uvs,
      indices,
      transform,
      normalMatrix,
      material,
    };
    ctx.commands.push(cmd);
  }

  private emitLine(line: any, ctx: FrameContext): void {
    const geometry = line.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return;
    if (this.cull(line, geometry, ctx)) {
      this.stats.objectsCulled++;
      return;
    }

    const positions = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!positions) return;
    const positionsArr = positions.array as Float32Array;

    const indexAttr = geometry.getIndex();
    const indices = indexAttr
      ? (indexAttr.array as Uint16Array | Uint32Array)
      : null;

    // Determine line mode from three's class flags.
    let mode: 0 | 1 | 2 = 1; // LINE_STRIP default for THREE.Line
    if (line.isLineSegments) mode = 0; // LINES (every pair = segment)
    else if (line.isLineLoop) mode = 2; // LINE_LOOP

    const mat = (Array.isArray(line.material) ? line.material[0] : line.material) as
      | THREE.LineBasicMaterial
      | THREE.LineDashedMaterial
      | undefined;
    if (!mat) return;
    const color = mat.color
      ? ([mat.color.r, mat.color.g, mat.color.b] as [number, number, number])
      : [1, 1, 1] as [number, number, number];

    const cmd: LineCommand = {
      type: "line",
      geometryId: geometryIdOf(geometry),
      positions: positionsArr,
      indices,
      color,
      opacity: mat.opacity ?? 1,
      transparent: mat.transparent ?? false,
      mode,
      transform: new Float32Array(line.matrixWorld.elements),
    };
    ctx.commands.push(cmd);
  }

  private emitPoints(points: THREE.Points, ctx: FrameContext): void {
    const geometry = points.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return;
    if (this.cull(points, geometry, ctx)) {
      this.stats.objectsCulled++;
      return;
    }

    const positions = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!positions) return;
    const positionsArr = positions.array as Float32Array;

    const mat = (Array.isArray(points.material)
      ? points.material[0]
      : points.material) as THREE.PointsMaterial | undefined;
    if (!mat) return;
    const color = mat.color
      ? ([mat.color.r, mat.color.g, mat.color.b] as [number, number, number])
      : [1, 1, 1] as [number, number, number];

    const cmd: PointsCommand = {
      type: "points",
      geometryId: geometryIdOf(geometry),
      positions: positionsArr,
      color,
      size: mat.size ?? 1,
      opacity: mat.opacity ?? 1,
      transparent: mat.transparent ?? false,
      sizeAttenuation: mat.sizeAttenuation ?? true,
      transform: new Float32Array(points.matrixWorld.elements),
    };
    ctx.commands.push(cmd);
  }

  // Sprite → 2-triangle quad expanded into a mesh command. The quad is in
  // local space (-0.5..0.5 on x/y), and the executor's mesh shader is
  // expected to billboard it via the camera matrix. Phase 1 will need a
  // sprite-aware shader path; for the JS-side we just emit geometry +
  // a material flagged via `material.type = "basic"` with the sprite's map.
  private emitSprite(sprite: any, ctx: FrameContext): void {
    if (this.cull(sprite, null, ctx)) {
      this.stats.objectsCulled++;
      return;
    }
    // Cached unit-quad geometry — same id reused for every sprite, so the
    // executor uploads the buffer once.
    const positions = SPRITE_POSITIONS;
    const uvs = SPRITE_UVS;
    const indices = SPRITE_INDICES;

    const mat = sprite.material as THREE.SpriteMaterial | undefined;
    if (!mat) return;
    const color = mat.color
      ? ([mat.color.r, mat.color.g, mat.color.b] as [number, number, number])
      : [1, 1, 1] as [number, number, number];

    const material: MaterialDesc = {
      type: "basic",
      color,
      opacity: mat.opacity ?? 1,
      transparent: mat.transparent ?? true,
      side: 2 satisfies SideValue, // DoubleSide by default for sprites
      map: mat.map ? textureDescriptorFor(mat.map, ctx.uploadedTextures) : null,
    };

    const cmd: MeshCommand = {
      type: "mesh",
      geometryId: SPRITE_GEOMETRY_ID,
      positions,
      normals: null,
      uvs,
      indices,
      transform: new Float32Array(sprite.matrixWorld.elements),
      // Identity normal matrix — sprites are unlit by definition in three.
      normalMatrix: SPRITE_NORMAL_MATRIX,
      material,
    };
    ctx.commands.push(cmd);
  }

  // ─── Material translation ───────────────────────────────────────────────
  private describeMaterial(
    mat: THREE.Material,
    ctx: FrameContext
  ): MaterialDesc | null {
    const m: any = mat;
    const side = (mat.side ?? 0) as SideValue;
    const opacity = (mat as any).opacity ?? 1;
    const transparent = (mat as any).transparent ?? false;
    const map: TextureDescriptor | null = m.map
      ? textureDescriptorFor(m.map, ctx.uploadedTextures)
      : null;
    if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
      const c = m.color ?? new THREE.Color(1, 1, 1);
      const e = m.emissive ?? new THREE.Color(0, 0, 0);
      return {
        type: "standard",
        color: [c.r, c.g, c.b],
        opacity,
        transparent,
        side,
        map,
        metalness: m.metalness ?? 0,
        roughness: m.roughness ?? 1,
        emissive: [e.r, e.g, e.b],
      };
    }
    if (m.isMeshPhongMaterial) {
      const c = m.color ?? new THREE.Color(1, 1, 1);
      const e = m.emissive ?? new THREE.Color(0, 0, 0);
      const s = m.specular ?? new THREE.Color(0.07, 0.07, 0.07);
      return {
        type: "phong",
        color: [c.r, c.g, c.b],
        opacity,
        transparent,
        side,
        map,
        shininess: m.shininess ?? 30,
        specular: [s.r, s.g, s.b],
        emissive: [e.r, e.g, e.b],
      };
    }
    if (m.isMeshBasicMaterial || m.isMeshLambertMaterial) {
      // Lambert is rare in modern code; treat as Basic for Phase 2 (the
      // executor doesn't have a Lambert pipeline). Documented in README.
      const c = m.color ?? new THREE.Color(1, 1, 1);
      return {
        type: "basic",
        color: [c.r, c.g, c.b],
        opacity,
        transparent,
        side,
        map,
      };
    }
    // Unknown / out-of-scope material (ShaderMaterial etc.) — fall back
    // to a magenta basic so the user sees something is wrong.
    if (m.isShaderMaterial || m.isRawShaderMaterial) {
      // eslint-disable-next-line no-console
      console.warn(
        "[@carbon/three] ShaderMaterial is out of Phase 2 scope; falling back to magenta MeshBasicMaterial."
      );
      return {
        type: "basic",
        color: [1, 0, 1],
        opacity,
        transparent,
        side,
        map: null,
      };
    }
    return null;
  }

  // ─── Frustum culling ────────────────────────────────────────────────────
  // Returns true when the object can be skipped. We mirror three's policy:
  //   * Skip culling when `obj.frustumCulled === false` (three's default opt-out)
  //   * Skip culling when the renderer has it disabled
  //   * For objects without a geometry (sprites): cull by world position only
  private cull(
    obj: THREE.Object3D,
    geometry: THREE.BufferGeometry | null,
    ctx: FrameContext
  ): boolean {
    if (!this.enableFrustumCulling) return false;
    if (obj.frustumCulled === false) return false;

    if (!geometry) {
      // Sprite-style: just test the world-space origin.
      ctx.tmpVec3.setFromMatrixPosition(obj.matrixWorld);
      ctx.tmpSphere.set(ctx.tmpVec3, 0.5);
      return !ctx.frustum.intersectsSphere(ctx.tmpSphere);
    }

    // Compute the bounding sphere lazily (three caches it on the geometry).
    if (geometry.boundingSphere === null) {
      geometry.computeBoundingSphere();
    }
    const sphere = geometry.boundingSphere!;
    // Transform sphere into world space without allocating.
    ctx.tmpSphere.copy(sphere).applyMatrix4(obj.matrixWorld);
    return !ctx.frustum.intersectsSphere(ctx.tmpSphere);
  }

  // ─── Camera packing ─────────────────────────────────────────────────────
  private describeCamera(camera: THREE.Camera): CameraDesc {
    // We pre-compute and pack matrices so the executor stays dumb. Both
    // PerspectiveCamera and OrthographicCamera populate `projectionMatrix`
    // — the executor doesn't care which projection it is.
    const view = new Float32Array(camera.matrixWorldInverse.elements);
    const projection = new Float32Array(
      (camera as THREE.PerspectiveCamera).projectionMatrix.elements
    );
    const pos = camera.position;
    return {
      view,
      projection,
      position: [pos.x, pos.y, pos.z],
    };
  }
}

// ─── Sprite shared geometry ───────────────────────────────────────────────
// Cached unit quad. ID is a fixed sentinel so the executor recognizes "this
// is the sprite quad" — Phase 1 may give it a special shader path.
const SPRITE_GEOMETRY_ID = -1;
// Two triangles, centered at origin, in XY plane.
// prettier-ignore
const SPRITE_POSITIONS = new Float32Array([
  -0.5, -0.5, 0,
   0.5, -0.5, 0,
   0.5,  0.5, 0,
  -0.5,  0.5, 0,
]);
// prettier-ignore
const SPRITE_UVS = new Float32Array([
  0, 0,
  1, 0,
  1, 1,
  0, 1,
]);
const SPRITE_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);
// Identity 3x3.
const SPRITE_NORMAL_MATRIX = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
