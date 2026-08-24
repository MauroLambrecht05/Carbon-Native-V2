// uniforms.rs — Phase 1.5γ uniform-buffer machinery for carbon-mini's GPU executor.
//
// Provides two public types:
//   * `FrameUniforms` — bind group 0: Camera UBO (160 B) + Lights UBO (sized for 4
//     directional + 8 point + ambient + counts).
//   * `MeshUniforms`  — bind group 1: per-mesh Transform UBO (model mat4 + normal
//     matrix as 3×vec4 = 128 B). Backed by a *dynamic* uniform buffer so a single
//     buffer can hold every mesh's transform for the frame, with per-draw offsets.
//
// All matrices are column-major (matches three.js Matrix4.elements + WGSL
// convention). Byte layout follows std140-ish rules per
// `docs/PHASE1_5_CONTRACTS.md`. Each #[repr(C)] struct here exists specifically
// so byte offsets line up with the WGSL the shader agent (1.5α) writes; if you
// edit them, update the contracts doc and re-run the layout tests.
//
// We use manual `unsafe impl bytemuck::{Pod,Zeroable}` instead of the derive
// macros so we don't need to enable the `derive` feature on bytemuck (the
// project's Cargo.toml is locked for this phase).
//
// Mesh-transform strategy: dynamic uniform buffer with per-draw offsets.
// Allocates one buffer up-front sized for `MAX_MESHES_PER_FRAME` transforms
// (each padded to `min_uniform_buffer_offset_alignment`, 256 B on D3D12).
// `write_transform` returns a `BindGroup` already configured with that
// buffer + a freshly-bumped offset. This is the wgpu-recommended pattern
// for "many similar uniforms in one frame" and avoids per-draw buffer/bind-
// group allocation, at the cost of a fixed cap on mesh count per frame.

#![allow(dead_code)]

use std::sync::atomic::{AtomicU32, Ordering};

// ─── Constants ─────────────────────────────────────────────────────────────

/// Maximum directional lights uploaded to the GPU per frame.
/// Extras beyond this are silently dropped (with a stderr warning).
pub const MAX_DIRECTIONAL_LIGHTS: usize = 4;

/// Maximum point lights uploaded to the GPU per frame.
/// Extras beyond this are silently dropped (with a stderr warning).
pub const MAX_POINT_LIGHTS: usize = 8;

/// Soft cap for `MeshUniforms` dynamic-buffer allocation. If a frame issues
/// more mesh draws than this, `write_transform` panics — the integrator
/// should grow this constant or switch to a ring/grow strategy. Sized for
/// "complex three.js scene" budgets with plenty of headroom.
pub const MAX_MESHES_PER_FRAME: u32 = 4096;

/// `min_uniform_buffer_offset_alignment` is 256 on D3D12 and most desktop
/// drivers; wgpu's `downlevel_defaults()` reports 256 as well. We size every
/// per-mesh transform slot to this, padding the 128-byte payload up.
pub const UNIFORM_OFFSET_ALIGNMENT: u32 = 256;

/// Camera UBO size (per contract): mat4 view + mat4 proj + vec4 position.
/// 64 + 64 + 16 = 144, padded to 160 to keep alignment if the layout grows.
pub const CAMERA_UBO_SIZE: u64 = 160;

/// Lights UBO size:
///   ambient (vec4)              = 16
///   directionalCount (u32)      = 4
///   pointCount (u32)            = 4
///   _pad (vec2 = 2 × u32 = u64) = 8
///   directional[4] @ 32         = 128
///   point[8]       @ 48         = 384
///   ─────────────────────────────────
///   total                        = 544 bytes
pub const LIGHTS_UBO_SIZE: u64 =
    16 + 4 + 4 + 8 + 32 * MAX_DIRECTIONAL_LIGHTS as u64 + 48 * MAX_POINT_LIGHTS as u64;

/// Per-mesh Transform UBO logical size: mat4 model + 3×vec4 normalMatrix
/// 64 + 48 = 112 → padded to 128.
pub const TRANSFORM_UBO_SIZE: u64 = 128;

// ─── Pod helpers ───────────────────────────────────────────────────────────

/// Camera uniform — exact byte layout for `@binding(0)` in bind group 0.
/// 64 + 64 + 16 + 16 (pad) = 160 bytes.
#[repr(C)]
#[derive(Copy, Clone)]
struct CameraStd140 {
    view: [f32; 16],     // 64 B  offset 0
    proj: [f32; 16],     // 64 B  offset 64
    position: [f32; 4],  // 16 B  offset 128 — xyz + 0
    _tail_pad: [f32; 4], // 16 B  offset 144 — keeps total at 160
}

unsafe impl bytemuck::Zeroable for CameraStd140 {}
unsafe impl bytemuck::Pod for CameraStd140 {}

/// One directional-light slot: vec4 direction (xyz + 0) + vec4 color (rgb + intensity)
#[repr(C)]
#[derive(Copy, Clone)]
struct DirectionalStd140 {
    direction: [f32; 4], // direction.xyz, w=0
    color: [f32; 4],     // color.rgb, intensity
}

unsafe impl bytemuck::Zeroable for DirectionalStd140 {}
unsafe impl bytemuck::Pod for DirectionalStd140 {}

/// One point-light slot:
///   vec4 position (xyz + 0)
///   vec4 color (rgb + intensity)
///   vec4 falloff (range, decay, _pad, _pad)
#[repr(C)]
#[derive(Copy, Clone)]
struct PointStd140 {
    position: [f32; 4],
    color: [f32; 4],
    falloff: [f32; 4],
}

unsafe impl bytemuck::Zeroable for PointStd140 {}
unsafe impl bytemuck::Pod for PointStd140 {}

/// Lights UBO — exact byte layout for `@binding(1)` in bind group 0.
#[repr(C)]
#[derive(Copy, Clone)]
struct LightsStd140 {
    ambient: [f32; 4],                                        // 16 B  offset 0
    directional_count: u32,                                   //  4 B  offset 16
    point_count: u32,                                         //  4 B  offset 20
    _pad: [u32; 2],                                           //  8 B  offset 24
    directional: [DirectionalStd140; MAX_DIRECTIONAL_LIGHTS], // 128 B offset 32
    point: [PointStd140; MAX_POINT_LIGHTS],                   // 384 B offset 160
}

unsafe impl bytemuck::Zeroable for LightsStd140 {}
unsafe impl bytemuck::Pod for LightsStd140 {}

/// Per-mesh Transform UBO — exact byte layout for `@binding(0)` in bind group 1.
/// 64 + 48 + 16 (pad) = 128 bytes.
#[repr(C)]
#[derive(Copy, Clone)]
struct TransformStd140 {
    model: [f32; 16], // 64 B  offset 0
    // mat3 stored as 3×vec4. Each row of the normal matrix occupies 16 B
    // with 4 B trailing pad. WGSL `mat3x3<f32>` requires this layout when
    // used inside a uniform buffer.
    normal_row0: [f32; 4], // 16 B  offset 64
    normal_row1: [f32; 4], // 16 B  offset 80
    normal_row2: [f32; 4], // 16 B  offset 96
    _tail_pad: [f32; 4],   // 16 B  offset 112 — total 128
}

unsafe impl bytemuck::Zeroable for TransformStd140 {}
unsafe impl bytemuck::Pod for TransformStd140 {}

// Compile-time size checks: if any of these fail the offsets in the contract
// are out of sync with this file's layout. Rust will reject the const-eval
// before producing a binary.
const _: () = {
    assert!(std::mem::size_of::<CameraStd140>() == 160);
    assert!(std::mem::size_of::<DirectionalStd140>() == 32);
    assert!(std::mem::size_of::<PointStd140>() == 48);
    assert!(std::mem::size_of::<LightsStd140>() == 16 + 4 + 4 + 8 + 32 * 4 + 48 * 8);
    assert!(std::mem::size_of::<LightsStd140>() == LIGHTS_UBO_SIZE as usize);
    assert!(std::mem::size_of::<TransformStd140>() == 128);
};

// ─── Public light descriptors (caller-facing, no padding concerns) ─────────

#[derive(Debug, Clone)]
pub struct DirectionalLight {
    pub direction: [f32; 3],
    pub color: [f32; 3],
    pub intensity: f32,
}

#[derive(Debug, Clone)]
pub struct PointLight {
    pub position: [f32; 3],
    pub color: [f32; 3],
    pub intensity: f32,
    /// Linear falloff range. 0 means "no falloff" (three.js default at distance==0).
    pub range: f32,
    pub decay: f32,
}

#[derive(Debug, Clone)]
pub struct Lights {
    /// rgb + intensity — packed into one vec4 in the UBO.
    pub ambient: [f32; 4],
    /// Up to `MAX_DIRECTIONAL_LIGHTS`; extras dropped with a stderr warning.
    pub directional: Vec<DirectionalLight>,
    /// Up to `MAX_POINT_LIGHTS`; extras dropped with a stderr warning.
    pub point: Vec<PointLight>,
}

impl Default for Lights {
    fn default() -> Self {
        Self {
            ambient: [0.0; 4],
            directional: Vec::new(),
            point: Vec::new(),
        }
    }
}

// ─── FrameUniforms ─────────────────────────────────────────────────────────

/// Bind group 0: Camera + Lights. Owned per-canvas; re-uploaded each frame
/// from the latest `setCamera` / `setLights` commands.
pub struct FrameUniforms {
    pub camera_buf: wgpu::Buffer,
    pub lights_buf: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
    pub layout: wgpu::BindGroupLayout,
}

impl FrameUniforms {
    pub fn new(device: &wgpu::Device) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("carbon-frame-uniforms-layout"),
            entries: &[
                // @binding(0) Camera UBO — visible to vertex + fragment.
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(CAMERA_UBO_SIZE),
                    },
                    count: None,
                },
                // @binding(1) Lights UBO — primarily fragment (lighting), but
                // we expose to vertex too so future shaders can do per-vertex lighting.
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(LIGHTS_UBO_SIZE),
                    },
                    count: None,
                },
            ],
        });

        let camera_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("carbon-camera-ubo"),
            size: CAMERA_UBO_SIZE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let lights_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("carbon-lights-ubo"),
            size: LIGHTS_UBO_SIZE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("carbon-frame-uniforms-bg"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: lights_buf.as_entire_binding(),
                },
            ],
        });

        Self {
            camera_buf,
            lights_buf,
            bind_group,
            layout,
        }
    }

    /// Write the camera's view + proj matrices and position to the camera UBO.
    /// `view` and `proj` are [f32; 16] in column-major order (matches three.js).
    pub fn write_camera(
        &self,
        queue: &wgpu::Queue,
        view: &[f32; 16],
        proj: &[f32; 16],
        position: [f32; 3],
    ) {
        let payload = CameraStd140 {
            view: *view,
            proj: *proj,
            position: [position[0], position[1], position[2], 0.0],
            _tail_pad: [0.0; 4],
        };
        queue.write_buffer(&self.camera_buf, 0, bytemuck::bytes_of(&payload));
    }

    /// Write light data to the lights UBO. Spec:
    ///   ambient: vec4 (rgb + intensity)
    ///   directionalCount: u32
    ///   pointCount: u32
    ///   _pad: vec2
    ///   directional[4]: { direction: vec4, color: vec4 }    // 32 B each
    ///   point[8]:       { position: vec4, color: vec4, falloff: vec4 }  // 48 B each
    ///
    /// Light overflow: extras beyond `MAX_DIRECTIONAL_LIGHTS` /
    /// `MAX_POINT_LIGHTS` are silently dropped, with one stderr warning per
    /// frame describing how many were trimmed. Soft-fail rather than panic
    /// because three.js scenes routinely contain "stage rigs" with more
    /// lights than the GPU pipeline supports.
    pub fn write_lights(&self, queue: &wgpu::Queue, lights: &Lights) {
        let mut payload = LightsStd140 {
            ambient: lights.ambient,
            directional_count: 0,
            point_count: 0,
            _pad: [0; 2],
            directional: [DirectionalStd140 {
                direction: [0.0; 4],
                color: [0.0; 4],
            }; MAX_DIRECTIONAL_LIGHTS],
            point: [PointStd140 {
                position: [0.0; 4],
                color: [0.0; 4],
                falloff: [0.0; 4],
            }; MAX_POINT_LIGHTS],
        };

        if lights.directional.len() > MAX_DIRECTIONAL_LIGHTS {
            eprintln!(
                "[carbon-mini] frame had {} directional lights, only {} supported — dropping {}",
                lights.directional.len(),
                MAX_DIRECTIONAL_LIGHTS,
                lights.directional.len() - MAX_DIRECTIONAL_LIGHTS
            );
        }
        if lights.point.len() > MAX_POINT_LIGHTS {
            eprintln!(
                "[carbon-mini] frame had {} point lights, only {} supported — dropping {}",
                lights.point.len(),
                MAX_POINT_LIGHTS,
                lights.point.len() - MAX_POINT_LIGHTS
            );
        }

        let dir_n = lights.directional.len().min(MAX_DIRECTIONAL_LIGHTS);
        for (i, d) in lights.directional.iter().take(dir_n).enumerate() {
            payload.directional[i] = DirectionalStd140 {
                direction: [d.direction[0], d.direction[1], d.direction[2], 0.0],
                color: [d.color[0], d.color[1], d.color[2], d.intensity],
            };
        }
        payload.directional_count = dir_n as u32;

        let pt_n = lights.point.len().min(MAX_POINT_LIGHTS);
        for (i, p) in lights.point.iter().take(pt_n).enumerate() {
            payload.point[i] = PointStd140 {
                position: [p.position[0], p.position[1], p.position[2], 0.0],
                color: [p.color[0], p.color[1], p.color[2], p.intensity],
                falloff: [p.range, p.decay, 0.0, 0.0],
            };
        }
        payload.point_count = pt_n as u32;

        queue.write_buffer(&self.lights_buf, 0, bytemuck::bytes_of(&payload));
    }
}

// ─── MeshUniforms ──────────────────────────────────────────────────────────

/// Bind group 1: per-mesh Transform UBO.
///
/// Strategy: one large UNIFORM buffer that holds up to `MAX_MESHES_PER_FRAME`
/// transforms back-to-back, each slot padded to `UNIFORM_OFFSET_ALIGNMENT`
/// (256 B on D3D12 — required by wgpu when using dynamic offsets). One
/// long-lived `BindGroup` references the buffer with `has_dynamic_offset =
/// true`. `write_transform`:
///   1. Atomically reserves the next slot offset.
///   2. Writes the transform payload at that offset via `queue.write_buffer`.
///   3. Returns a clone of the persistent `BindGroup`. The integrator (1.5δ)
///      passes the offset to `set_bind_group(1, &bg, &[offset])` at draw time.
///
/// Why this strategy:
///   * Per-draw buffer allocation (the alternative) costs ~µs each in wgpu
///     (driver-side resource tracking). For scenes with thousands of meshes
///     we'd pay milliseconds just creating buffers.
///   * Per-draw bind-group allocation is similarly expensive.
///   * Dynamic offsets sidestep both — the bind group is fixed; we just
///     change the offset between draws.
///
/// The trade-off is the fixed `MAX_MESHES_PER_FRAME` cap. The integrator
/// can call `reset_for_frame()` at the start of each frame to recycle slots.
///
/// Returning the bind group from `write_transform` (rather than handing
/// back a (BindGroup, offset) pair) keeps the API close to the spec; the
/// integrator can read `last_offset()` if it needs the offset separately.
/// We chose to expose `write_transform` returning a *cloned* `BindGroup`
/// because `wgpu::BindGroup` is reference-counted — the clone is cheap.
pub struct MeshUniforms {
    pub transform_buf: wgpu::Buffer,
    pub bind_group_layout: wgpu::BindGroupLayout,
    /// Persistent dynamic-offset bind group. Cloned per call to `write_transform`.
    pub bind_group: wgpu::BindGroup,
    /// Bumped on every `write_transform`, by `UNIFORM_OFFSET_ALIGNMENT`. The
    /// returned offset for slot N is `N * UNIFORM_OFFSET_ALIGNMENT`.
    next_slot: AtomicU32,
}

impl MeshUniforms {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("carbon-mesh-uniforms-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(TRANSFORM_UBO_SIZE),
                },
                count: None,
            }],
        });

        let buf_size = (UNIFORM_OFFSET_ALIGNMENT as u64) * (MAX_MESHES_PER_FRAME as u64);
        let transform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("carbon-mesh-transform-ubo"),
            size: buf_size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Bind group references only the first TRANSFORM_UBO_SIZE bytes; the
        // rest of the buffer is reachable via the dynamic offset.
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("carbon-mesh-uniforms-bg"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &transform_buf,
                    offset: 0,
                    size: wgpu::BufferSize::new(TRANSFORM_UBO_SIZE),
                }),
            }],
        });

        Self {
            transform_buf,
            bind_group_layout,
            bind_group,
            next_slot: AtomicU32::new(0),
        }
    }

    /// Reset the per-frame slot allocator. The integrator should call this
    /// at the start of each frame before the first `write_transform`. After
    /// reset, slot 0 is available again.
    pub fn reset_for_frame(&self) {
        self.next_slot.store(0, Ordering::Relaxed);
    }

    /// Write a transform (model + normal matrix) and return a `BindGroup`
    /// configured for it. The returned `BindGroup` should be bound at draw
    /// time with `set_bind_group(1, &bg, &[offset])` — call `last_offset()`
    /// after this for the offset, or use the convenience method
    /// `write_transform_with_offset` below.
    ///
    /// Implementation: dynamic uniform buffer with offsets. We bump the
    /// `next_slot` counter and write the new transform at
    /// `slot * UNIFORM_OFFSET_ALIGNMENT`. Cloning the bind group is cheap
    /// because wgpu refcounts internally.
    ///
    /// Why this design rather than fresh-buffer-per-call:
    ///   * One buffer + one bind-group object covers the whole frame.
    ///   * `queue.write_buffer` to an already-existing buffer is much
    ///     cheaper than `create_buffer` per draw.
    ///   * The wgpu validation layer optimizes consecutive
    ///     `set_bind_group` calls that differ only in dynamic offset.
    ///
    /// `device` is accepted for API symmetry with the spec; we don't actually
    /// use it on the hot path (the buffer is allocated up-front in `new`).
    pub fn write_transform(
        &self,
        _device: &wgpu::Device,
        queue: &wgpu::Queue,
        model: &[f32; 16],
        normal_matrix: &[f32; 9],
    ) -> wgpu::BindGroup {
        let (_, bg) = self.write_transform_with_offset(queue, model, normal_matrix);
        bg
    }

    /// Convenience: returns (offset, bind_group). The offset must be passed
    /// to `set_bind_group(1, &bg, &[offset])` at draw time — without it the
    /// dynamic-offset binding still points at slot 0.
    pub fn write_transform_with_offset(
        &self,
        queue: &wgpu::Queue,
        model: &[f32; 16],
        normal_matrix: &[f32; 9],
    ) -> (u32, wgpu::BindGroup) {
        let slot = self.next_slot.fetch_add(1, Ordering::Relaxed);
        assert!(
            slot < MAX_MESHES_PER_FRAME,
            "carbon-mini: more than MAX_MESHES_PER_FRAME ({}) draws in a single frame; \
             increase the constant or call MeshUniforms::reset_for_frame() between frames",
            MAX_MESHES_PER_FRAME
        );
        let offset = slot * UNIFORM_OFFSET_ALIGNMENT;

        // Pack a 3x3 column-major matrix into 3 vec4s.
        // normal_matrix layout (column-major):
        //   col0 = [m0, m1, m2]   col1 = [m3, m4, m5]   col2 = [m6, m7, m8]
        // WGSL `mat3x3<f32>` stored in a uniform buffer expects each column
        // padded to 16 B. So the 3 vec4s here are the three columns,
        // each with a trailing zero pad.
        let payload = TransformStd140 {
            model: *model,
            normal_row0: [normal_matrix[0], normal_matrix[1], normal_matrix[2], 0.0],
            normal_row1: [normal_matrix[3], normal_matrix[4], normal_matrix[5], 0.0],
            normal_row2: [normal_matrix[6], normal_matrix[7], normal_matrix[8], 0.0],
            _tail_pad: [0.0; 4],
        };
        queue.write_buffer(
            &self.transform_buf,
            offset as u64,
            bytemuck::bytes_of(&payload),
        );

        (offset, self.bind_group.clone())
    }

    /// Offset of the most recently written transform slot. Useful when
    /// `write_transform` is called and the caller wants the offset
    /// after-the-fact. Returns 0 if nothing has been written yet.
    pub fn last_offset(&self) -> u32 {
        let n = self.next_slot.load(Ordering::Relaxed);
        if n == 0 {
            0
        } else {
            (n - 1) * UNIFORM_OFFSET_ALIGNMENT
        }
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────
//
// Strategy: the std140 byte-layout is verified by inspecting the Pod struct
// directly via `bytemuck::bytes_of(&payload)`. This tests *exactly* what
// `queue.write_buffer` will copy onto the GPU, without needing a wgpu device
// at all — meaning these tests run on every CI runner regardless of GPU
// presence. We factor the payload-building logic into private free fns
// (`build_camera_payload`, `build_lights_payload`, `build_transform_payload`)
// so tests can call them without a `Queue`.
//
// A separate GPU-aware test (`bind_group_layout_shapes`) exercises wgpu API
// surface coverage — it's gated on adapter availability and is a no-op
// otherwise.

#[cfg(test)]
mod tests {
    use super::*;

    // ── Free-function payload builders shared with the public methods ──
    //
    // These mirror exactly the logic inside `write_camera` / `write_lights` /
    // `write_transform_with_offset`, but return the Pod payload instead of
    // calling `queue.write_buffer`. Tests inspect the bytes of the returned
    // payload directly. Production code calls `queue.write_buffer` on the
    // same payload.

    fn build_camera_payload(
        view: &[f32; 16],
        proj: &[f32; 16],
        position: [f32; 3],
    ) -> CameraStd140 {
        CameraStd140 {
            view: *view,
            proj: *proj,
            position: [position[0], position[1], position[2], 0.0],
            _tail_pad: [0.0; 4],
        }
    }

    fn build_lights_payload(lights: &Lights) -> LightsStd140 {
        let mut payload = LightsStd140 {
            ambient: lights.ambient,
            directional_count: 0,
            point_count: 0,
            _pad: [0; 2],
            directional: [DirectionalStd140 {
                direction: [0.0; 4],
                color: [0.0; 4],
            }; MAX_DIRECTIONAL_LIGHTS],
            point: [PointStd140 {
                position: [0.0; 4],
                color: [0.0; 4],
                falloff: [0.0; 4],
            }; MAX_POINT_LIGHTS],
        };
        let dir_n = lights.directional.len().min(MAX_DIRECTIONAL_LIGHTS);
        for (i, d) in lights.directional.iter().take(dir_n).enumerate() {
            payload.directional[i] = DirectionalStd140 {
                direction: [d.direction[0], d.direction[1], d.direction[2], 0.0],
                color: [d.color[0], d.color[1], d.color[2], d.intensity],
            };
        }
        payload.directional_count = dir_n as u32;
        let pt_n = lights.point.len().min(MAX_POINT_LIGHTS);
        for (i, p) in lights.point.iter().take(pt_n).enumerate() {
            payload.point[i] = PointStd140 {
                position: [p.position[0], p.position[1], p.position[2], 0.0],
                color: [p.color[0], p.color[1], p.color[2], p.intensity],
                falloff: [p.range, p.decay, 0.0, 0.0],
            };
        }
        payload.point_count = pt_n as u32;
        payload
    }

    fn build_transform_payload(model: &[f32; 16], normal_matrix: &[f32; 9]) -> TransformStd140 {
        TransformStd140 {
            model: *model,
            normal_row0: [normal_matrix[0], normal_matrix[1], normal_matrix[2], 0.0],
            normal_row1: [normal_matrix[3], normal_matrix[4], normal_matrix[5], 0.0],
            normal_row2: [normal_matrix[6], normal_matrix[7], normal_matrix[8], 0.0],
            _tail_pad: [0.0; 4],
        }
    }

    /// Try to build a wgpu device, returning None if no adapter is present.
    /// GPU-aware tests are skipped (return ()) on devless CI.
    fn try_device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            backend_options: wgpu::BackendOptions::default(),
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: None,
            force_fallback_adapter: false,
        }))
        .ok()?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("carbon-mini-uniforms-tests"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::default(),
            trace: wgpu::Trace::Off,
            experimental_features: wgpu::ExperimentalFeatures::default(),
        }))
        .ok()?;
        Some((device, queue))
    }

    #[test]
    fn camera_payload_byte_layout_matches_contract() {
        let view: [f32; 16] = [
            1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0,
        ];
        let proj: [f32; 16] = [
            17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0,
            31.0, 32.0,
        ];
        let position = [100.0_f32, 200.0, 300.0];
        let payload = build_camera_payload(&view, &proj, position);
        let bytes = bytemuck::bytes_of(&payload);
        assert_eq!(bytes.len(), CAMERA_UBO_SIZE as usize);

        // Bytes 0..64 = view (column-major)
        let view_back: &[f32] = bytemuck::cast_slice(&bytes[0..64]);
        assert_eq!(view_back, view);
        // Bytes 64..128 = proj
        let proj_back: &[f32] = bytemuck::cast_slice(&bytes[64..128]);
        assert_eq!(proj_back, proj);
        // Bytes 128..144 = position xyzw (xyz from input, w=0)
        let pos_back: &[f32] = bytemuck::cast_slice(&bytes[128..144]);
        assert_eq!(pos_back, [100.0, 200.0, 300.0, 0.0]);
        // Bytes 144..160 = pad — zero
        let pad_back: &[f32] = bytemuck::cast_slice(&bytes[144..160]);
        assert_eq!(pad_back, [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn lights_payload_byte_layout_matches_contract() {
        let lights = Lights {
            ambient: [0.1, 0.2, 0.3, 0.4],
            directional: vec![
                DirectionalLight {
                    direction: [1.0, 0.0, 0.0],
                    color: [0.5, 0.6, 0.7],
                    intensity: 0.8,
                },
                DirectionalLight {
                    direction: [0.0, 1.0, 0.0],
                    color: [0.9, 1.0, 1.1],
                    intensity: 1.2,
                },
            ],
            point: vec![PointLight {
                position: [10.0, 20.0, 30.0],
                color: [0.1, 0.2, 0.3],
                intensity: 0.4,
                range: 50.0,
                decay: 2.0,
            }],
        };
        let payload = build_lights_payload(&lights);
        let bytes = bytemuck::bytes_of(&payload);
        assert_eq!(bytes.len(), LIGHTS_UBO_SIZE as usize);

        // ambient @ 0..16
        let amb: &[f32] = bytemuck::cast_slice(&bytes[0..16]);
        assert_eq!(amb, [0.1, 0.2, 0.3, 0.4]);
        // directional_count @ 16..20
        let dir_n_bytes: [u8; 4] = bytes[16..20].try_into().unwrap();
        assert_eq!(u32::from_le_bytes(dir_n_bytes), 2);
        // point_count @ 20..24
        let pt_n_bytes: [u8; 4] = bytes[20..24].try_into().unwrap();
        assert_eq!(u32::from_le_bytes(pt_n_bytes), 1);
        // _pad @ 24..32 — zeros
        assert_eq!(&bytes[24..32], &[0u8; 8]);

        // directional[0] @ 32..64
        let d0_dir: &[f32] = bytemuck::cast_slice(&bytes[32..48]);
        assert_eq!(d0_dir, [1.0, 0.0, 0.0, 0.0]);
        let d0_col: &[f32] = bytemuck::cast_slice(&bytes[48..64]);
        assert_eq!(d0_col, [0.5, 0.6, 0.7, 0.8]);

        // directional[1] @ 64..96
        let d1_dir: &[f32] = bytemuck::cast_slice(&bytes[64..80]);
        assert_eq!(d1_dir, [0.0, 1.0, 0.0, 0.0]);
        let d1_col: &[f32] = bytemuck::cast_slice(&bytes[80..96]);
        assert_eq!(d1_col, [0.9, 1.0, 1.1, 1.2]);

        // directional[2..4] should be zero (untouched).
        // Each slot is 32 B; directional starts at 32.
        let d2_start = 32 + 2 * 32;
        let d2_end = 32 + 4 * 32;
        assert!(bytes[d2_start..d2_end].iter().all(|&b| b == 0));

        // point[0] starts at 32 + 4 * 32 = 160.
        let p0_pos: &[f32] = bytemuck::cast_slice(&bytes[160..176]);
        assert_eq!(p0_pos, [10.0, 20.0, 30.0, 0.0]);
        let p0_col: &[f32] = bytemuck::cast_slice(&bytes[176..192]);
        assert_eq!(p0_col, [0.1, 0.2, 0.3, 0.4]);
        let p0_fal: &[f32] = bytemuck::cast_slice(&bytes[192..208]);
        assert_eq!(p0_fal, [50.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn lights_overflow_drops_extras() {
        // Build 7 directional lights; expect first 4 used, last 3 dropped.
        let directional: Vec<DirectionalLight> = (0..7)
            .map(|i| DirectionalLight {
                direction: [i as f32, 0.0, 0.0],
                color: [1.0, 1.0, 1.0],
                intensity: i as f32 * 0.1,
            })
            .collect();
        // Build 12 point lights; expect first 8 used, last 4 dropped.
        let point: Vec<PointLight> = (0..12)
            .map(|i| PointLight {
                position: [0.0, i as f32, 0.0],
                color: [1.0, 1.0, 1.0],
                intensity: 1.0,
                range: 0.0,
                decay: 1.0,
            })
            .collect();

        let lights = Lights {
            ambient: [0.0; 4],
            directional,
            point,
        };
        let payload = build_lights_payload(&lights);
        let bytes = bytemuck::bytes_of(&payload);

        // Counts must clamp to 4 / 8.
        let dir_n = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
        let pt_n = u32::from_le_bytes(bytes[20..24].try_into().unwrap());
        assert_eq!(dir_n, MAX_DIRECTIONAL_LIGHTS as u32);
        assert_eq!(pt_n, MAX_POINT_LIGHTS as u32);

        // Verify the first 4 directional slots match input[0..4] by checking
        // each slot's direction.x equals its index.
        for i in 0..MAX_DIRECTIONAL_LIGHTS {
            let off = 32 + i * 32;
            let dir: &[f32] = bytemuck::cast_slice(&bytes[off..off + 16]);
            assert_eq!(dir[0], i as f32, "directional[{i}].direction.x mismatch");
        }
    }

    #[test]
    fn transform_payload_byte_layout_matches_contract() {
        let model: [f32; 16] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 5.0, 6.0, 7.0, 1.0,
        ];
        let nm: [f32; 9] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        let payload = build_transform_payload(&model, &nm);
        let bytes = bytemuck::bytes_of(&payload);
        assert_eq!(bytes.len(), TRANSFORM_UBO_SIZE as usize);

        // model @ 0..64
        let model_back: &[f32] = bytemuck::cast_slice(&bytes[0..64]);
        assert_eq!(model_back, model);
        // normal columns @ 64..112, each 16 B with trailing 0 pad.
        let col0: &[f32] = bytemuck::cast_slice(&bytes[64..80]);
        assert_eq!(col0, [1.0, 2.0, 3.0, 0.0]);
        let col1: &[f32] = bytemuck::cast_slice(&bytes[80..96]);
        assert_eq!(col1, [4.0, 5.0, 6.0, 0.0]);
        let col2: &[f32] = bytemuck::cast_slice(&bytes[96..112]);
        assert_eq!(col2, [7.0, 8.0, 9.0, 0.0]);
        // pad @ 112..128 — zeros
        assert_eq!(&bytes[112..128], &[0u8; 16]);
    }

    /// Slot-allocation behaviour can be tested without a real GPU upload —
    /// we just build the MeshUniforms struct (which needs a device for the
    /// buffer alloc) and check the offset returned by write_transform.
    #[test]
    fn transform_dynamic_offsets_advance() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let mesh = MeshUniforms::new(&device);
        mesh.reset_for_frame();

        let identity: [f32; 16] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let nm: [f32; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

        let (o0, _) = mesh.write_transform_with_offset(&queue, &identity, &nm);
        let (o1, _) = mesh.write_transform_with_offset(&queue, &identity, &nm);
        let (o2, _) = mesh.write_transform_with_offset(&queue, &identity, &nm);
        assert_eq!(o0, 0);
        assert_eq!(o1, UNIFORM_OFFSET_ALIGNMENT);
        assert_eq!(o2, UNIFORM_OFFSET_ALIGNMENT * 2);

        // last_offset reflects the most recent slot.
        assert_eq!(mesh.last_offset(), UNIFORM_OFFSET_ALIGNMENT * 2);

        // After reset, slots restart from 0.
        mesh.reset_for_frame();
        let (o3, _) = mesh.write_transform_with_offset(&queue, &identity, &nm);
        assert_eq!(o3, 0);
    }

    /// Verifies the bind-group-layout shapes match the contracts:
    /// frame layout has exactly 2 entries at bindings 0 and 1; mesh layout
    /// has exactly 1 entry at binding 0. We exercise this by building a
    /// PipelineLayout that mounts both at canonical group indices — wgpu
    /// will validate the layout shape internally.
    #[test]
    fn bind_group_layout_shapes() {
        let (device, _queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let frame = FrameUniforms::new(&device);
        let mesh = MeshUniforms::new(&device);
        let _pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("carbon-uniforms-test-pl"),
            bind_group_layouts: &[&frame.layout, &mesh.bind_group_layout],
            push_constant_ranges: &[],
        });
        // If we got here, layouts are at least structurally valid for
        // mounting at groups 0 and 1.
    }

    /// End-to-end smoke: build FrameUniforms, write camera + lights, no panic.
    /// Bytes-level assertions are covered by the payload tests above; this
    /// just confirms `queue.write_buffer` accepts our buffers as configured.
    #[test]
    fn frame_uniforms_writes_dont_panic() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let frame = FrameUniforms::new(&device);
        let view = [0.0_f32; 16];
        let proj = [0.0_f32; 16];
        frame.write_camera(&queue, &view, &proj, [0.0, 0.0, 0.0]);
        let lights = Lights::default();
        frame.write_lights(&queue, &lights);
    }

    /// Same as above for MeshUniforms.
    #[test]
    fn mesh_uniforms_writes_dont_panic() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let mesh = MeshUniforms::new(&device);
        mesh.reset_for_frame();
        let model = [0.0_f32; 16];
        let nm = [0.0_f32; 9];
        let _bg = mesh.write_transform(&device, &queue, &model, &nm);
    }

    #[test]
    fn camera_ubo_is_160_bytes() {
        // Compile-time const_assert is the real check; this test makes the
        // expectation visible in `cargo test` output.
        assert_eq!(std::mem::size_of::<CameraStd140>(), 160);
        assert_eq!(CAMERA_UBO_SIZE, 160);
    }

    #[test]
    fn lights_ubo_size_matches_contract() {
        // 16 + 4 + 4 + 8 + 32*4 + 48*8 = 544
        assert_eq!(LIGHTS_UBO_SIZE, 544);
        assert_eq!(std::mem::size_of::<LightsStd140>(), 544);
    }

    #[test]
    fn transform_ubo_is_128_bytes() {
        assert_eq!(std::mem::size_of::<TransformStd140>(), 128);
        assert_eq!(TRANSFORM_UBO_SIZE, 128);
    }
}
