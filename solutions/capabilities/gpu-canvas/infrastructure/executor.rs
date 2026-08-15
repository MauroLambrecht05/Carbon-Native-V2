// executor.rs — Phase 1.5δ: GPU command-list orchestrator.
//
// Consumes a parsed `Vec<DrawCommand>` and runs them against a CanvasSurface.
// Owns the per-canvas mutable GPU state (pipeline cache, geometry cache,
// frame/mesh uniforms, depth target). One CanvasExecutor per canvas; lazily
// constructed by `gpu.rs::CanvasRegistry` on the first execute_commands call.
//
// Design choices:
//   * Pipeline cache key = (MaterialKind, Side). Three sides × three kinds = 9
//     possible pipelines max. We build them lazily on first use and keep them
//     forever (they're cheap to hold; expensive to rebuild).
//   * Depth target lives here and resizes with the surface. We allocate it
//     lazily on first frame so the existing tests that don't render anything
//     don't pay for it.
//   * JSON parsing strategy: serde_json::Value (loose) so we can tolerate
//     missing fields gracefully — this is cross-language data and emit-side
//     bugs shouldn't crash the runtime.
//   * Vertex/index bytes arrive as base64-encoded strings; we decode in this
//     module (small inline base64 decoder, no extra crate). Empty strings
//     mean "geometry already cached, just bind".

#![allow(dead_code)]

use std::collections::HashMap;

use crate::geometry::GeometryCache;
use crate::gpu::{CanvasSurface, Gpu};
use crate::material::{create_shader_module, vertex_buffer_layout, Material, MaterialKind, Side};
use crate::uniforms::{DirectionalLight, FrameUniforms, Lights, MeshUniforms, PointLight};

// ─── DrawCommand parsed form ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum DrawCommand {
    Clear {
        rgba: [f32; 4],
    },
    SetCamera {
        view: [f32; 16],
        proj: [f32; 16],
        position: [f32; 3],
    },
    SetLights(Lights),
    Mesh(MeshCommand),
    Line(LineCommand),
    Points(PointsCommand),
}

#[derive(Debug, Clone)]
pub struct MeshCommand {
    pub geometry_id: u64,
    /// Interleaved 48-byte vertex stream. Empty when geometry already cached.
    pub vertices: Vec<u8>,
    /// Raw bytes of the index buffer. Empty when geometry already cached.
    pub indices: Vec<u8>,
    pub index_is_u32: bool,
    pub vertex_count: u32,
    pub index_count: u32,
    pub material: Material,
    pub model: [f32; 16],
    pub normal_matrix: [f32; 9],
}

#[derive(Debug, Clone)]
pub struct LineCommand {
    pub geometry_id: u64,
    pub vertices: Vec<u8>,
    pub indices: Vec<u8>,
    pub index_is_u32: bool,
    pub vertex_count: u32,
    pub index_count: u32,
    pub color: [f32; 4],
    pub model: [f32; 16],
    pub mode: u8, // 0 = LineList, 1 = LineStrip, 2 = LineLoop
}

#[derive(Debug, Clone)]
pub struct PointsCommand {
    pub geometry_id: u64,
    pub vertices: Vec<u8>,
    pub vertex_count: u32,
    pub color: [f32; 4],
    pub model: [f32; 16],
    pub size: f32,
}

// ─── Depth target ─────────────────────────────────────────────────────────

pub struct DepthTarget {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
}

impl DepthTarget {
    fn new(device: &wgpu::Device, w: u32, h: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("carbon-canvas-depth"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            texture,
            view,
            width: w,
            height: h,
        }
    }
}

// ─── Default texture + sampler for materials without `map` ────────────────
//
// A single 1×1 white texture + linear sampler we bind into group(2) bindings
// 1 and 2 when a material has no `map`. The shaders unconditionally sample
// the texture, so this is a "neutral element" that multiplies to 1.

struct DefaultTextures {
    view: wgpu::TextureView,
    sampler: wgpu::Sampler,
}

impl DefaultTextures {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("carbon-default-white"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255u8, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("carbon-default-sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self { view, sampler }
    }
}

// ─── Bind group layouts (frame + mesh + 1 per material kind) ──────────────

struct MaterialBgl {
    bgl: wgpu::BindGroupLayout,
    uniform_size: u64,
}

struct BindGroupLayouts {
    frame: wgpu::BindGroupLayout,
    mesh: wgpu::BindGroupLayout,
    basic: MaterialBgl,
    standard: MaterialBgl,
    phong: MaterialBgl,
}

fn make_material_bgl(device: &wgpu::Device, label: &str, uniform_size: u64) -> MaterialBgl {
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &[
            // @binding(0) material UBO
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(uniform_size),
                },
                count: None,
            },
            // @binding(1) texture
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            // @binding(2) sampler
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });
    MaterialBgl { bgl, uniform_size }
}

// ─── Tiny base64 decoder (no extra crate) ─────────────────────────────────
//
// Standard alphabet, padding optional. Returns None on malformed input.
// Used only at command-execute time so perf isn't critical (it's still
// linear and pretty tight — a JIT-friendly tight loop).

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let mut clean: Vec<u8> = Vec::with_capacity(bytes.len());
    for &b in bytes {
        if b == b'=' || b == b'\n' || b == b'\r' || b == b' ' || b == b'\t' {
            continue;
        }
        clean.push(b);
    }
    let mut out = Vec::with_capacity(clean.len() * 3 / 4 + 3);
    let mut i = 0;
    while i + 4 <= clean.len() {
        let v0 = val(clean[i])?;
        let v1 = val(clean[i + 1])?;
        let v2 = val(clean[i + 2])?;
        let v3 = val(clean[i + 3])?;
        out.push((v0 << 2) | (v1 >> 4));
        out.push((v1 << 4) | (v2 >> 2));
        out.push((v2 << 6) | v3);
        i += 4;
    }
    let rem = clean.len() - i;
    if rem == 2 {
        let v0 = val(clean[i])?;
        let v1 = val(clean[i + 1])?;
        out.push((v0 << 2) | (v1 >> 4));
    } else if rem == 3 {
        let v0 = val(clean[i])?;
        let v1 = val(clean[i + 1])?;
        let v2 = val(clean[i + 2])?;
        out.push((v0 << 2) | (v1 >> 4));
        out.push((v1 << 4) | (v2 >> 2));
    }
    Some(out)
}

// ─── CanvasExecutor ───────────────────────────────────────────────────────

pub struct CanvasExecutor {
    pub geometry: GeometryCache,
    pub frame_u: FrameUniforms,
    pub mesh_u: MeshUniforms,
    pipelines: HashMap<(MaterialKind, Side, u8 /* topology variant */), wgpu::RenderPipeline>,
    bgls: BindGroupLayouts,
    depth: Option<DepthTarget>,
    default_tex: DefaultTextures,
    /// Re-usable per-mesh material UBO. We have one slot per material kind;
    /// since execute_commands serializes draws we can reuse a single buffer
    /// per kind by writing it before each draw and binding via has_dynamic_offset.
    /// For Phase 1.5 simplicity we allocate one buffer per material draw slot
    /// (sized to the largest material UBO = 48 B). With dynamic offsets this
    /// scales to many meshes per frame.
    mat_ring: MatRing,
}

/// A ring buffer of material UBOs: one big buffer with N slots, each
/// padded to UNIFORM_OFFSET_ALIGNMENT (256 B). Sized for `MAX_MAT_SLOTS`
/// material draws per frame. Mirrors the strategy in MeshUniforms but
/// for material data.
struct MatRing {
    buf: wgpu::Buffer,
    slot_size: u64,
    capacity: u32,
    next: std::cell::Cell<u32>,
}

const MAX_MAT_SLOTS: u32 = 4096;

impl MatRing {
    fn new(device: &wgpu::Device) -> Self {
        let slot_size = 256u64; // matches UNIFORM_OFFSET_ALIGNMENT
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("carbon-material-ubo-ring"),
            size: slot_size * MAX_MAT_SLOTS as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self {
            buf,
            slot_size,
            capacity: MAX_MAT_SLOTS,
            next: std::cell::Cell::new(0),
        }
    }
    fn reset(&self) {
        self.next.set(0);
    }
    /// Reserve a slot, write `data` to it, return the byte offset.
    fn write(&self, queue: &wgpu::Queue, data: &[u8]) -> u64 {
        let slot = self.next.get();
        if slot >= self.capacity {
            // Wrap rather than panic — frame had too many materials but we
            // don't want to crash the runtime. Last-N draws will overwrite
            // earlier slots. (In practice this is always > 4k materials,
            // which doesn't happen in any reasonable scene.)
            self.next.set(0);
        }
        let slot = self.next.get();
        self.next.set(slot + 1);
        let offset = slot as u64 * self.slot_size;
        queue.write_buffer(&self.buf, offset, data);
        offset
    }
}

impl CanvasExecutor {
    pub fn new(gpu: &Gpu) -> Self {
        let device = &gpu.device;
        let queue = &gpu.queue;
        let frame_u = FrameUniforms::new(device);
        let mesh_u = MeshUniforms::new(device);
        let basic = make_material_bgl(
            device,
            "carbon-mat-basic-bgl",
            std::mem::size_of::<crate::material::MaterialBasicUniform>() as u64,
        );
        let standard = make_material_bgl(
            device,
            "carbon-mat-standard-bgl",
            std::mem::size_of::<crate::material::MaterialStandardUniform>() as u64,
        );
        let phong = make_material_bgl(
            device,
            "carbon-mat-phong-bgl",
            std::mem::size_of::<crate::material::MaterialPhongUniform>() as u64,
        );
        let bgls = BindGroupLayouts {
            frame: clone_layout_via_recreate(
                device,
                "carbon-frame-uniforms-layout-clone",
                &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(
                                crate::uniforms::CAMERA_UBO_SIZE,
                            ),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(
                                crate::uniforms::LIGHTS_UBO_SIZE,
                            ),
                        },
                        count: None,
                    },
                ],
            ),
            mesh: clone_layout_via_recreate(
                device,
                "carbon-mesh-uniforms-layout-clone",
                &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(
                            crate::uniforms::TRANSFORM_UBO_SIZE,
                        ),
                    },
                    count: None,
                }],
            ),
            basic,
            standard,
            phong,
        };

        let default_tex = DefaultTextures::new(device, queue);
        let mat_ring = MatRing::new(device);

        Self {
            geometry: GeometryCache::new(),
            frame_u,
            mesh_u,
            pipelines: HashMap::new(),
            bgls,
            depth: None,
            default_tex,
            mat_ring,
        }
    }

    fn ensure_depth(&mut self, device: &wgpu::Device, w: u32, h: u32) -> &DepthTarget {
        if self
            .depth
            .as_ref()
            .map(|d| d.width != w || d.height != h)
            .unwrap_or(true)
        {
            self.depth = Some(DepthTarget::new(device, w, h));
        }
        self.depth.as_ref().unwrap()
    }

    fn material_bgl(&self, kind: MaterialKind) -> &wgpu::BindGroupLayout {
        match kind {
            MaterialKind::Basic => &self.bgls.basic.bgl,
            MaterialKind::Standard => &self.bgls.standard.bgl,
            MaterialKind::Phong => &self.bgls.phong.bgl,
        }
    }

    fn pipeline_for(
        &mut self,
        device: &wgpu::Device,
        kind: MaterialKind,
        side: Side,
        topology: wgpu::PrimitiveTopology,
    ) -> &wgpu::RenderPipeline {
        let topo_key: u8 = match topology {
            wgpu::PrimitiveTopology::TriangleList => 0,
            wgpu::PrimitiveTopology::LineList => 1,
            wgpu::PrimitiveTopology::LineStrip => 2,
            wgpu::PrimitiveTopology::PointList => 3,
            _ => 0,
        };
        let key = (kind, side, topo_key);
        if !self.pipelines.contains_key(&key) {
            let module = create_shader_module(device, kind);
            let bgls: [&wgpu::BindGroupLayout; 3] =
                [&self.bgls.frame, &self.bgls.mesh, self.material_bgl(kind)];
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("carbon-pipeline-layout"),
                bind_group_layouts: &bgls,
                push_constant_ranges: &[],
            });
            let cull_mode = match side {
                Side::Front => Some(wgpu::Face::Back),
                Side::Back => Some(wgpu::Face::Front),
                Side::Double => None,
            };
            // Lines/points: no culling
            let cull_mode = if matches!(topology, wgpu::PrimitiveTopology::TriangleList) {
                cull_mode
            } else {
                None
            };
            let vbuf_layout = vertex_buffer_layout();
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("carbon-mat-pipeline"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: std::slice::from_ref(&vbuf_layout),
                },
                primitive: wgpu::PrimitiveState {
                    topology,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode,
                    unclipped_depth: false,
                    polygon_mode: wgpu::PolygonMode::Fill,
                    conservative: false,
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth32Float,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::Less,
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState {
                    count: 1,
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview: None,
                cache: None,
            });
            self.pipelines.insert(key, pipeline);
        }
        self.pipelines.get(&key).unwrap()
    }

    /// Run the command list against the surface. Begins/ends render pass
    /// internally, submits the queue. Errors logged + returned silently.
    pub fn execute(&mut self, gpu: &Gpu, surface: &mut CanvasSurface, commands: &[DrawCommand]) {
        let device = &gpu.device;
        let queue = &gpu.queue;

        if std::env::var_os("CARBON_MINI_TIMING").is_some() {
            let mut clears = 0;
            let mut cams = 0;
            let mut lights = 0;
            let mut meshes = 0;
            for c in commands {
                match c {
                    DrawCommand::Clear { .. } => clears += 1,
                    DrawCommand::SetCamera { .. } => cams += 1,
                    DrawCommand::SetLights(_) => lights += 1,
                    DrawCommand::Mesh(_) => meshes += 1,
                    _ => {}
                }
            }
            eprintln!(
                "[carbon-mini-timing] phase=executor_cmds clears={clears} cams={cams} lights={lights} meshes={meshes}"
            );
        }

        // Reset per-frame slot allocators.
        self.mesh_u.reset_for_frame();
        self.mat_ring.reset();

        // Find the first Clear (if any). All renderable commands run inside one
        // render pass. We process Clear first, then SetCamera/SetLights, then
        // Mesh/Line/Points draws.
        let mut clear_color = [0.0f32, 0.0, 0.0, 0.0];
        let mut have_clear = false;
        for c in commands {
            if let DrawCommand::Clear { rgba } = c {
                clear_color = *rgba;
                have_clear = true;
                break;
            }
        }

        // Apply camera / lights from the command list before opening the pass.
        for c in commands {
            match c {
                DrawCommand::SetCamera {
                    view,
                    proj,
                    position,
                } => {
                    self.frame_u.write_camera(queue, view, proj, *position);
                }
                DrawCommand::SetLights(lights) => {
                    self.frame_u.write_lights(queue, lights);
                }
                _ => {}
            }
        }

        let (sw, sh) = (surface.width(), surface.height());
        // Allocate / resize depth target
        let _ = self.ensure_depth(device, sw, sh);

        // Pre-warm the pipeline cache: walk all Mesh commands and ensure
        // a pipeline exists for their (kind, side) before opening the
        // render pass. Doing this inside the pass would require &mut self
        // while rpass holds an immutable borrow of self.frame_u, which
        // the borrow checker rejects.
        for c in commands {
            if let DrawCommand::Mesh(m) = c {
                let _ = self.pipeline_for(
                    device,
                    m.material.kind(),
                    m.material.side(),
                    wgpu::PrimitiveTopology::TriangleList,
                );
            }
        }

        let depth_view = &self.depth.as_ref().unwrap().view;

        let color_view = surface.texture_view();

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("carbon-canvas-execute"),
        });

        // ── Single render pass for the whole frame ───────────────────────
        {
            let load = if have_clear {
                wgpu::LoadOp::Clear(wgpu::Color {
                    r: clear_color[0] as f64,
                    g: clear_color[1] as f64,
                    b: clear_color[2] as f64,
                    a: clear_color[3] as f64,
                })
            } else {
                wgpu::LoadOp::Load
            };
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("carbon-frame-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &color_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            for c in commands {
                match c {
                    DrawCommand::Clear { .. } => {}
                    DrawCommand::SetCamera { .. } => {}
                    DrawCommand::SetLights(_) => {}
                    DrawCommand::Mesh(m) => {
                        // 1. Geometry: upload if first sight
                        if !m.vertices.is_empty() {
                            self.geometry.upload(
                                device,
                                queue,
                                m.geometry_id,
                                &m.vertices,
                                &m.indices,
                                m.index_is_u32,
                                m.vertex_count,
                                m.index_count,
                            );
                        }
                        let g = match self.geometry.get(m.geometry_id) {
                            Some(g) => g,
                            None => continue, // missing geometry — skip
                        };

                        // 2. Mesh transform
                        let (mesh_offset, _bg_throwaway) = self.mesh_u.write_transform_with_offset(
                            queue,
                            &m.model,
                            &m.normal_matrix,
                        );
                        let mesh_bg = self.mesh_u.bind_group.clone();

                        // 3. Material UBO + bind group
                        let mat_size = m.material.uniform_size();
                        let mut mat_buf = vec![0u8; mat_size];
                        m.material.write_uniform(&mut mat_buf);
                        let mat_offset = self.mat_ring.write(queue, &mat_buf);

                        let mat_bgl = self.material_bgl(m.material.kind());
                        let mat_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("carbon-material-bg"),
                            layout: mat_bgl,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                        buffer: &self.mat_ring.buf,
                                        offset: mat_offset,
                                        size: wgpu::BufferSize::new(mat_size as u64),
                                    }),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::TextureView(
                                        &self.default_tex.view,
                                    ),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 2,
                                    resource: wgpu::BindingResource::Sampler(
                                        &self.default_tex.sampler,
                                    ),
                                },
                            ],
                        });

                        // 4. Pipeline (pre-warmed above; immutable lookup only)
                        let topo_key: u8 = 0; // TriangleList
                        let pipeline = match self.pipelines.get(&(
                            m.material.kind(),
                            m.material.side(),
                            topo_key,
                        )) {
                            Some(p) => p,
                            None => continue,
                        };

                        // 5. Draw
                        rpass.set_pipeline(pipeline);
                        rpass.set_bind_group(0, &self.frame_u.bind_group, &[]);
                        rpass.set_bind_group(1, &mesh_bg, &[mesh_offset]);
                        rpass.set_bind_group(2, &mat_bg, &[]);
                        rpass.set_vertex_buffer(0, g.vbuf.slice(..));
                        rpass.set_index_buffer(g.ibuf.slice(..), g.index_format);
                        rpass.draw_indexed(0..g.index_count, 0, 0..1);
                    }
                    DrawCommand::Line(_) | DrawCommand::Points(_) => {
                        // Lines/points: out of scope for the spinning-cube smoke
                        // test. They're parsed but we don't draw them yet.
                        // (TODO Phase 5: dedicated line/points pipelines.)
                    }
                }
            }
        }

        queue.submit(Some(encoder.finish()));
        surface.mark_dirty();
    }
}

// Helper: rebuild a layout matching the one inside FrameUniforms / MeshUniforms.
// We can't share the layout reference because FrameUniforms owns its own;
// instead we recreate an identical layout here for use in pipeline construction.
// wgpu treats two identically-shaped layouts as compatible at bind time.
fn clone_layout_via_recreate(
    device: &wgpu::Device,
    label: &str,
    entries: &[wgpu::BindGroupLayoutEntry],
) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries,
    })
}

// ─── JSON parsing ─────────────────────────────────────────────────────────
//
// Wire format follows stdlib/three/src/types.ts. JSON arrives
// from `__carbon_canvas_execute_commands(canvas_id, jsonString)`. Numbers
// arrive as f64; we cast to f32. Vertex/index typed-array bytes arrive as
// base64 strings (per the canvas-executor.ts encoder).

pub fn parse_commands(json: &str) -> Result<Vec<DrawCommand>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let arr = v
        .as_array()
        .ok_or_else(|| "expected array of commands".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for cmd in arr {
        match parse_one(cmd) {
            Ok(c) => out.push(c),
            Err(e) => eprintln!("[carbon-mini] skipping malformed command: {e}"),
        }
    }
    Ok(out)
}

fn parse_one(v: &serde_json::Value) -> Result<DrawCommand, String> {
    let ty = v
        .get("type")
        .and_then(|x| x.as_str())
        .ok_or("missing type")?;
    match ty {
        "clear" => {
            let rgba = parse_f32_array4(v.get("rgba"))?;
            Ok(DrawCommand::Clear { rgba })
        }
        "setCamera" => {
            let cam = v.get("camera").ok_or("missing camera")?;
            let view = parse_f32_buffer16(cam.get("view"))?;
            let proj = parse_f32_buffer16(cam.get("projection"))?;
            let position = parse_f32_array3(cam.get("position"))?;
            Ok(DrawCommand::SetCamera {
                view,
                proj,
                position,
            })
        }
        "setLights" => {
            let arr = v
                .get("lights")
                .and_then(|x| x.as_array())
                .ok_or("missing lights array")?;
            let mut lights = Lights::default();
            for l in arr {
                let lty = l.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match lty {
                    "ambient" => {
                        let color = parse_f32_array3(l.get("color")).unwrap_or([0.0; 3]);
                        let intensity =
                            l.get("intensity").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
                        // Combine: store color in xyz, intensity in w
                        lights.ambient = [color[0], color[1], color[2], intensity];
                    }
                    "directional" => {
                        let color = parse_f32_array3(l.get("color")).unwrap_or([1.0; 3]);
                        let intensity =
                            l.get("intensity").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
                        let direction =
                            parse_f32_array3(l.get("direction")).unwrap_or([0.0, -1.0, 0.0]);
                        lights.directional.push(DirectionalLight {
                            direction,
                            color,
                            intensity,
                        });
                    }
                    "point" => {
                        let color = parse_f32_array3(l.get("color")).unwrap_or([1.0; 3]);
                        let intensity =
                            l.get("intensity").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
                        let position = parse_f32_array3(l.get("position")).unwrap_or([0.0; 3]);
                        let distance =
                            l.get("distance").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
                        let decay = l.get("decay").and_then(|x| x.as_f64()).unwrap_or(2.0) as f32;
                        lights.point.push(PointLight {
                            position,
                            color,
                            intensity,
                            range: if distance <= 0.0 { 1000.0 } else { distance },
                            decay,
                        });
                    }
                    _ => {}
                }
            }
            Ok(DrawCommand::SetLights(lights))
        }
        "mesh" => parse_mesh(v),
        "line" => parse_line(v),
        "points" => parse_points(v),
        other => Err(format!("unknown command type {other}")),
    }
}

fn parse_mesh(v: &serde_json::Value) -> Result<DrawCommand, String> {
    let geometry_id = v
        .get("geometryId")
        .and_then(|x| x.as_i64())
        .ok_or("missing geometryId")? as u64;
    // Optional: `verticesB64` — base64 of the interleaved vertex stream.
    // Optional: `indicesB64` — base64 of u16 or u32 index buffer.
    // If omitted the executor relies on its cache (hit by geometry_id).
    let vertices = decode_b64_field(v, "verticesB64");
    let indices = decode_b64_field(v, "indicesB64");
    let index_is_u32 = v
        .get("indexIsU32")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let vertex_count = v.get("vertexCount").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let index_count = v.get("indexCount").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let model = parse_f32_buffer16(v.get("transform"))?;
    let normal_matrix = parse_f32_buffer9(v.get("normalMatrix"))?;
    let material = parse_material(v.get("material").ok_or("missing material")?)?;
    Ok(DrawCommand::Mesh(MeshCommand {
        geometry_id,
        vertices,
        indices,
        index_is_u32,
        vertex_count,
        index_count,
        material,
        model,
        normal_matrix,
    }))
}

fn parse_line(v: &serde_json::Value) -> Result<DrawCommand, String> {
    let geometry_id = v
        .get("geometryId")
        .and_then(|x| x.as_i64())
        .ok_or("missing geometryId")? as u64;
    let vertices = decode_b64_field(v, "verticesB64");
    let indices = decode_b64_field(v, "indicesB64");
    let index_is_u32 = v
        .get("indexIsU32")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let vertex_count = v.get("vertexCount").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let index_count = v.get("indexCount").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let model = parse_f32_buffer16(v.get("transform"))?;
    let mode = v.get("mode").and_then(|x| x.as_u64()).unwrap_or(0) as u8;
    let color3 = parse_f32_array3(v.get("color")).unwrap_or([1.0; 3]);
    let opacity = v.get("opacity").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
    Ok(DrawCommand::Line(LineCommand {
        geometry_id,
        vertices,
        indices,
        index_is_u32,
        vertex_count,
        index_count,
        color: [color3[0], color3[1], color3[2], opacity],
        model,
        mode,
    }))
}

fn parse_points(v: &serde_json::Value) -> Result<DrawCommand, String> {
    let geometry_id = v
        .get("geometryId")
        .and_then(|x| x.as_i64())
        .ok_or("missing geometryId")? as u64;
    let vertices = decode_b64_field(v, "verticesB64");
    let vertex_count = v.get("vertexCount").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let model = parse_f32_buffer16(v.get("transform"))?;
    let color3 = parse_f32_array3(v.get("color")).unwrap_or([1.0; 3]);
    let opacity = v.get("opacity").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
    let size = v.get("size").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
    Ok(DrawCommand::Points(PointsCommand {
        geometry_id,
        vertices,
        vertex_count,
        color: [color3[0], color3[1], color3[2], opacity],
        model,
        size,
    }))
}

fn parse_material(v: &serde_json::Value) -> Result<Material, String> {
    let ty = v
        .get("type")
        .and_then(|x| x.as_str())
        .ok_or("material missing type")?;
    let color3 = parse_f32_array3(v.get("color")).unwrap_or([1.0; 3]);
    let opacity = v.get("opacity").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
    let side_n = v.get("side").and_then(|x| x.as_u64()).unwrap_or(0);
    let side = match side_n {
        0 => Side::Front,
        1 => Side::Back,
        _ => Side::Double,
    };
    let map = None; // texture binding handled later
    let color = [color3[0], color3[1], color3[2], 1.0];
    match ty {
        "basic" => Ok(Material::Basic {
            color,
            opacity,
            side,
            map,
        }),
        "standard" => {
            let metalness = v.get("metalness").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
            let roughness = v.get("roughness").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
            Ok(Material::Standard {
                color,
                metalness,
                roughness,
                opacity,
                side,
                map,
            })
        }
        "phong" => {
            let shininess = v.get("shininess").and_then(|x| x.as_f64()).unwrap_or(30.0) as f32;
            let s = parse_f32_array3(v.get("specular")).unwrap_or([0.07; 3]);
            let specular = [s[0], s[1], s[2], 1.0];
            Ok(Material::Phong {
                color,
                specular,
                shininess,
                opacity,
                side,
                map,
            })
        }
        _ => Err(format!("unknown material type {ty}")),
    }
}

fn parse_f32_array3(v: Option<&serde_json::Value>) -> Result<[f32; 3], String> {
    let arr = v
        .and_then(|x| x.as_array())
        .ok_or("expected array of length 3")?;
    if arr.len() < 3 {
        return Err("array too short".into());
    }
    Ok([
        arr[0].as_f64().unwrap_or(0.0) as f32,
        arr[1].as_f64().unwrap_or(0.0) as f32,
        arr[2].as_f64().unwrap_or(0.0) as f32,
    ])
}

fn parse_f32_array4(v: Option<&serde_json::Value>) -> Result<[f32; 4], String> {
    let arr = v
        .and_then(|x| x.as_array())
        .ok_or("expected array of length 4")?;
    if arr.len() < 4 {
        return Err("array too short".into());
    }
    Ok([
        arr[0].as_f64().unwrap_or(0.0) as f32,
        arr[1].as_f64().unwrap_or(0.0) as f32,
        arr[2].as_f64().unwrap_or(0.0) as f32,
        arr[3].as_f64().unwrap_or(0.0) as f32,
    ])
}

fn parse_f32_buffer16(v: Option<&serde_json::Value>) -> Result<[f32; 16], String> {
    // Accepts a JSON array of 16 numbers, or a base64-encoded f32 buffer.
    if let Some(s) = v.and_then(|x| x.as_str()) {
        let bytes = b64_decode(s).ok_or("bad base64 in matrix16")?;
        if bytes.len() < 64 {
            return Err("matrix16 too short".into());
        }
        let mut out = [0.0f32; 16];
        for i in 0..16 {
            let off = i * 4;
            out[i] =
                f32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
        }
        return Ok(out);
    }
    let arr = v
        .and_then(|x| x.as_array())
        .ok_or("expected array of length 16")?;
    if arr.len() < 16 {
        return Err("matrix16 too short".into());
    }
    let mut out = [0.0f32; 16];
    for i in 0..16 {
        out[i] = arr[i].as_f64().unwrap_or(0.0) as f32;
    }
    Ok(out)
}

fn parse_f32_buffer9(v: Option<&serde_json::Value>) -> Result<[f32; 9], String> {
    if let Some(s) = v.and_then(|x| x.as_str()) {
        let bytes = b64_decode(s).ok_or("bad base64 in matrix9")?;
        if bytes.len() < 36 {
            return Err("matrix9 too short".into());
        }
        let mut out = [0.0f32; 9];
        for i in 0..9 {
            let off = i * 4;
            out[i] =
                f32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
        }
        return Ok(out);
    }
    let arr = v
        .and_then(|x| x.as_array())
        .ok_or("expected array of length 9")?;
    if arr.len() < 9 {
        return Err("matrix9 too short".into());
    }
    let mut out = [0.0f32; 9];
    for i in 0..9 {
        out[i] = arr[i].as_f64().unwrap_or(0.0) as f32;
    }
    Ok(out)
}

fn decode_b64_field(v: &serde_json::Value, key: &str) -> Vec<u8> {
    v.get(key)
        .and_then(|x| x.as_str())
        .and_then(|s| if s.is_empty() { None } else { b64_decode(s) })
        .unwrap_or_default()
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_decode_roundtrip() {
        // "hello" -> "aGVsbG8="
        let decoded = b64_decode("aGVsbG8=").unwrap();
        assert_eq!(&decoded, b"hello");
        // 4-byte float 1.0 little-endian = [0x00, 0x00, 0x80, 0x3f]
        let decoded = b64_decode("AACAPw==").unwrap();
        assert_eq!(&decoded, &[0x00u8, 0x00, 0x80, 0x3f]);
        let f = f32::from_le_bytes([decoded[0], decoded[1], decoded[2], decoded[3]]);
        assert!((f - 1.0).abs() < 1e-6);
    }

    #[test]
    fn parse_clear() {
        let json = r#"[{"type":"clear","rgba":[0.1,0.2,0.3,1.0]}]"#;
        let cmds = parse_commands(json).unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            DrawCommand::Clear { rgba } => {
                assert!((rgba[0] - 0.1).abs() < 1e-5);
                assert!((rgba[3] - 1.0).abs() < 1e-5);
            }
            _ => panic!("expected Clear"),
        }
    }

    #[test]
    fn parse_set_camera_array_form() {
        let json = r#"[{"type":"setCamera","camera":{
            "view":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "projection":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "position":[0,0,5]}}]"#;
        let cmds = parse_commands(json).unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            DrawCommand::SetCamera { view, position, .. } => {
                assert_eq!(view[0], 1.0);
                assert_eq!(position[2], 5.0);
            }
            _ => panic!("expected SetCamera"),
        }
    }
}
