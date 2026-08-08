# @carbon/three / Phase 1 ↔ Phase 2 integration interface

This document is the contract between Phase 2 (this package, JS-side
scene-walk and command emission) and Phase 1 (the Rust-side
`CanvasSurface::execute_commands` GPU executor).

Once Phase 1 lands, integration is wiring a single executor:

```ts
import { CarbonRenderer } from "@carbon/three";
import { CanvasSurfaceExecutor } from "@carbon/three/canvas-executor"; // ← Phase 1 ships this

const renderer = new CarbonRenderer({
  canvas,                                     // <canvas> intrinsic
  executor: new CanvasSurfaceExecutor(canvas) // wraps __carbon_canvas_execute_commands
});
renderer.render(scene, camera);
```

Phase 2 emits a `DrawCommand[]`. Phase 1 consumes it. Nothing else
changes between the two packages.

## DrawCommand schema (canonical)

`DrawCommand` is a discriminated union on the `type` field. The full
TypeScript schema lives in `src/types.ts`. Summarizing here for the Rust
side:

| `type`         | Meaning                                                     | Frequency               |
|----------------|-------------------------------------------------------------|-------------------------|
| `clear`        | Clear the offscreen target with the supplied RGBA           | 1× per frame, first     |
| `setCamera`    | Set view + projection matrices and camera world position    | 1× per frame, second    |
| `setLights`    | Set the per-frame light list (ambient, directional, point)  | 1× per frame, third     |
| `mesh`         | Draw an indexed triangle mesh with the supplied material    | 0..N× per frame         |
| `line`         | Draw a line list / strip / loop                             | 0..N× per frame         |
| `points`       | Draw a point sprite cloud                                   | 0..N× per frame         |

Order is guaranteed: `clear` → `setCamera` → `setLights` → 0..N
renderable commands. The renderer never emits a renderable before its
camera/lights are set.

### Geometry & texture caching

Every `mesh` / `line` / `points` command carries a `geometryId: number`.
This is a stable id per `BufferGeometry` (kept alive by a JS-side
`WeakMap`). The executor SHOULD cache the GPU vertex/index buffers
keyed by `geometryId`: once on the first occurrence, then reuse on
subsequent frames. The same applies to textures via `TextureDescriptor.id`
— `pixels: null` means "you've seen this id, reuse the cached upload".

Geometry buffers are TypedArray references to the *same* memory three.js
holds. Don't write to them. Phase 1 should treat them as read-only.

### Wire format (JS ↔ Rust)

Phase 1's host import:

```rust
fn __carbon_canvas_execute_commands(
    canvas_id: u32,
    cmd_ptr: *const u8,   // serialized DrawCommand[]
    cmd_len: usize,
)
```

Two viable encodings, decision is Phase 1's:

1. **Bincode-style binary** (suggested): `CarbonRenderer` serializes the
   `DrawCommand[]` into a single ArrayBuffer using a fixed header layout
   per command, and Rust decodes with zero copies for the typed arrays.
   The JS-side serializer is small and lives in
   `src/canvas-executor.ts` (Phase 1 will add this file).
2. **JSON via `JSON.stringify`**: simple but slow for ~1000+ meshes. Use
   only as a debugging fallback.

Either way, typed arrays should NOT be re-encoded as JSON arrays — they
must be passed through as raw bytes (the renderer guarantees
positions/normals/uvs/indices are TypedArray, never plain `number[]`).

## Mapping each command type to wgpu

What follows is the suggested wgpu translation. Phase 1 may diverge —
this is a starting point, not a hard requirement.

### `clear`

```rust
let mut encoder = device.create_command_encoder(...);
let view = offscreen_texture.create_view(...);
let _ = encoder.begin_render_pass(&RenderPassDescriptor {
    color_attachments: &[Some(RenderPassColorAttachment {
        view: &view,
        resolve_target: None,
        ops: Operations {
            load: LoadOp::Clear(Color { r, g, b, a }),
            store: StoreOp::Store,
        },
    })],
    depth_stencil_attachment: ...,
    ..
});
```

The `clear` command's `rgba` is in linear color space (three's `Color`
already converts from sRGB at construction time when `useLegacyLights`
is off and a renderer ColorManagement is enabled — but our renderer
emits the raw `Color.r/g/b` so the executor decides on color space).

### `setCamera`

Upload `view` + `projection` matrices into a per-frame uniform buffer.
`camera.position` is needed for specular term in Phong/Standard
materials.

```rust
struct CameraUniforms {
    view: [[f32; 4]; 4],         // column-major
    projection: [[f32; 4]; 4],   // column-major
    position: [f32; 3],
    _pad: f32,
}
```

Both matrices are column-major, matching wgpu's expected layout (no
transpose needed).

### `setLights`

Upload the variable-length light list into a uniform/storage buffer.
Suggested fixed-size layout (16-light cap is enough for Phase 2 scope):

```rust
struct LightUniforms {
    ambient_color: [f32; 3], _p0: f32,
    ambient_intensity: f32,   _p1: [f32; 3],
    n_directional: u32,
    n_point: u32,
    _p2: [u32; 2],
    directional: [DirectionalLight; 8],
    point: [PointLight; 8],
}
```

### `mesh`

Look up GPU buffers by `geometryId`. If absent, upload `positions`,
`normals`, `uvs`, `indices` and cache. Then:

1. Bind the appropriate pipeline by `material.type`:
   - `basic` → unlit textured pipeline
   - `phong` → Phong specular pipeline
   - `standard` → physically based pipeline
2. Push the `transform` (mat4) and `normalMatrix` (mat3) into the
   per-draw uniform/push-constant.
3. Push the material props (color, opacity, metalness/roughness/etc.)
   into the per-draw block.
4. Bind the texture if `material.map` is non-null (lookup by
   `material.map.id`, upload pixels first time only).
5. Issue `draw_indexed(indices.len(), 1, 0, 0, 0)`.

### `line`

Same as `mesh` but pipeline is the line pipeline (`PrimitiveTopology::LineList`
when `mode==0`, `LineStrip` when `mode==1`; `LineLoop` is not native
to wgpu — Phase 1 should expand it into LineStrip + a closing segment
when emitting).

### `points`

Render as billboarded quads (wgpu has no native point primitive
in WGSL beyond `PrimitiveTopology::PointList` which is one pixel). The
executor synthesizes a quad per point with `size` controlling the
screen-space extent and `sizeAttenuation` toggling perspective scaling.

## Sprite handling

Sprites are emitted as `mesh` commands with the special sentinel
`geometryId === -1`. Phase 1 may give them a billboard-aware shader
that re-orients the unit quad to face the camera, OR may treat them
identically to a regular mesh (the user gets a non-billboarded quad).
Either is acceptable; document the choice.

## What Phase 2 does NOT do

The renderer does not:
- allocate any GPU resources
- know the canvas's actual pixel dimensions (it just records what was
  set via `setSize`; the executor uses its own surface size for the
  viewport)
- handle present / readback / framebuffer composition (Phase 1's job)
- implement custom shaders, post-processing, instanced/skinned meshes,
  render targets, compute shaders

These are documented in `README.md` as Phase 2 scope limits.

## Test fixture

`test/fixtures/snapshot-scene.json` is a JSON-normalized capture of the
command stream for a canonical scene (one of each renderable type, mixed
materials, both light types, frustum-culled mesh). Phase 1's
implementation can dual-mode against this fixture: feed the scene to
the renderer with the GPU executor, and assert the same set of GPU
calls were issued in the same order.
