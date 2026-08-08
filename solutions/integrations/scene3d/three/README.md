# @carbon/three

A custom three.js renderer that emits a stream of `DrawCommand`s instead
of rasterizing directly. Pairs with carbon-mini's `<canvas>` GPU surface
(Phase 1) to render three.js scenes without a webview, without the DOM,
and without a WebGL/WebGPU spec implementation in JS.

> Status: Phase 2 — scaffolding. The JS-side scene-walker and command
> emitter are complete and tested against a mock executor. The GPU-backed
> executor lands with Phase 1.

## Usage

```ts
import * as THREE from "three";
import { CarbonRenderer, MockCommandExecutor } from "@carbon/three";

// Phase 2 mock — records every command for inspection.
const executor = new MockCommandExecutor();

const renderer = new CarbonRenderer({
  canvas: { width: 800, height: 600 },
  executor,
});
renderer.setSize(800, 600);
renderer.setClearColor(0x202020);

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshStandardMaterial({ color: 0xff8800 })
));

const camera = new THREE.PerspectiveCamera(75, 4 / 3, 0.1, 100);
camera.position.set(0, 0, 5);

renderer.render(scene, camera);

console.log(executor.lastFrame());
// → [{type:"clear",...}, {type:"setCamera",...}, {type:"setLights",...},
//    {type:"mesh", geometryId, positions, indices, ...}]
```

When Phase 1 ships its real executor, swap the `MockCommandExecutor` for
a `CanvasSurfaceExecutor` and the same `render(scene, camera)` call hits
the GPU. See `INTEGRATION.md`.

## API surface

`CarbonRenderer` mimics three.js's `WebGLRenderer`:

| Method                       | Notes                                            |
|------------------------------|--------------------------------------------------|
| `new CarbonRenderer(opts)`   | `executor` is required; `canvas` optional        |
| `setSize(w, h)`              | Stored on the renderer; executor handles viewport|
| `setPixelRatio(r)`           | Stored; executor handles                         |
| `setClearColor(c, a?)`       | Updates the per-frame `clear` command            |
| `render(scene, camera)`      | The hot path: walks, emits, hands off            |
| `dispose()`                  | No-op — executor owns GPU resources              |
| `enableFrustumCulling`       | Bool, also accepted in `opts`                    |
| `stats`                      | `{framesRendered, objectsVisited, objectsCulled, drawCommandsLastFrame}` |

## Supported features (Phase 2 scope)

- **Geometries**: `BufferGeometry` of any kind. We read `position`,
  `normal`, `uv`, and the index buffer; we don't care how the geometry
  was constructed (`BoxGeometry`, `SphereGeometry`, `PlaneGeometry`,
  `BufferGeometry.setFromPoints`, etc. all work). Non-indexed
  geometries are auto-indexed at emit time.
- **Materials**: `MeshBasicMaterial`, `MeshStandardMaterial`,
  `MeshPhongMaterial`. Props read: `color`, `opacity`, `transparent`,
  `side`, `map`, plus material-specific fields (`metalness` /
  `roughness` / `emissive` for Standard; `shininess` / `specular` /
  `emissive` for Phong). `MeshLambertMaterial` is treated as Basic
  (no Lambert pipeline yet — issues a console warning).
- **Lights**: `AmbientLight`, `DirectionalLight`, `PointLight`. We
  emit them once per frame in a `setLights` command before any
  renderable.
- **Cameras**: `PerspectiveCamera`, `OrthographicCamera`. We pass the
  view + projection matrices through unchanged.
- **Transforms**: full `matrixWorld` propagation through
  `Group`/`Object3D` chains. The walker calls
  `scene.updateMatrixWorld(false)` itself, matching three's convention.
- **Visibility**: `object.visible === false` skips the object and its
  subtree. Frustum culling against the bounding sphere of each
  geometry; respects `obj.frustumCulled === false` to disable per-object.
- **Lines**: `THREE.Line`, `THREE.LineSegments`, `THREE.LineLoop` with
  `LineBasicMaterial`.
- **Points**: `THREE.Points` with `PointsMaterial`.
- **Sprites**: `THREE.Sprite` — emitted as a unit-quad mesh with the
  sprite's `SpriteMaterial.map`. Phase 1 may billboard the quad in the
  shader; until then the quad renders facing the +Z axis in local space.
- **Textures**: `Texture`, `DataTexture`. We extract pixels from
  `DataTexture` (the only kind with directly-accessible pixel data).
  For `Texture`-with-image-source the pixel readback is the executor's
  job (Phase 1 will use a tiny offscreen canvas).

## Out of scope (later)

These are intentionally not handled. Each will become its own native
plugin in a follow-up phase, slotted in alongside `CarbonRenderer`.

| Feature                           | Reason                                          |
|-----------------------------------|-------------------------------------------------|
| `ShaderMaterial`, `RawShaderMaterial` | Custom shader pipeline = its own native plugin. Falls back to magenta + warns. |
| Post-processing (`EffectComposer`)| Needs render targets + multi-pass scheduling.   |
| `InstancedMesh`                   | Needs an instanced draw path; Phase 2 emits one mesh-per-mesh. |
| `SkinnedMesh`                     | Skinning matrix upload + skinning shader path.  |
| Compute shaders                   | wgpu compute pipeline — separate plugin.        |
| Render targets / `WebGLRenderTarget` | Phase 1 owns one offscreen surface; user-controlled targets need a Phase 1 extension. |
| Multi-material meshes (`Geometry.groups`) | We emit one command using `material[0]`. Acceptable for Phase 2; documented gap. |
| Shadow maps                       | Multi-pass + depth-target plumbing.             |
| `TextureLoader` async fallbacks   | Renderer reads pixels at emit time; loaders that haven't resolved emit empty textures. |

## Testing

```sh
bun test                            # unit tests
bun run shared/tests/ecosystem/system/stdlib/three/snapshot.regen.ts      # regenerate fixture (after schema change)
```

29 tests covering header commands, mesh emission, material translation,
lights, visibility/culling, lines, points, repeat-render correctness,
plus a snapshot test against `test/fixtures/snapshot-scene.json`.

## Benchmarks

```sh
pwsh ../../scripts/bench-phase2.ps1 -N 5
```

Results land in `docs/history/PHASE2_BENCH.md` at the repo root. Three benches:

1. **Scene-walk cost** at 100 / 1000 / 10000 cubes — ns/object.
2. **Frustum culling effectiveness** — same scene with the camera
   looking the other way; verify ~half the meshes are skipped.
3. **Repeated-render perf** — 60 consecutive frames; report the
   per-frame cost as a frame budget.

## Architecture notes

See `docs/history/PHASE2_IMPL.md` at the repo root for design decisions and
trade-offs (why JS-side walk vs Rust-side, why pre-computed normal
matrices, why a frame-context object pool, etc.).

## Integration with Phase 1

See `INTEGRATION.md` in this folder. Short version: Phase 1 ships a
`CanvasSurfaceExecutor` that implements `CommandExecutor` by
serializing the array and invoking
`__carbon_canvas_execute_commands(canvasId, ptr, len)`. Drop it into
`new CarbonRenderer({ executor })` and you're done.
