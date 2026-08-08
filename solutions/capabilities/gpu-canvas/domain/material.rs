// material.rs — Phase 1.5α: material variants + WGSL shader pipelines.
//
// Owned by 1.5α; consumed by the integrator (1.5δ). DO NOT modify gpu.rs,
// main.rs, scene.rs, or any other existing file from this module — the
// integrator wires this in.
//
// Responsibilities:
//   * Hold the three reference material variants the Phase 2 renderer
//     emits (Basic / Standard / Phong).
//   * Build a `wgpu::RenderPipeline` for a given variant against a caller-
//     supplied set of bind group layouts (group 0 = frame, group 1 = mesh,
//     group 2 = material).
//   * Pack each variant's per-material uniform into a tightly-laid-out
//     byte buffer matching docs/PHASE1_5_CONTRACTS.md (basic 32 B,
//     standard 32 B, phong 48 B).
//
// The shaders are loaded via `include_str!` so they're compiled into the
// final binary; there's no runtime file IO for shader source.

#![allow(dead_code)]

use bytemuck::{Pod, Zeroable};

// ─── Embedded WGSL source ──────────────────────────────────────────────────
//
// `include_str!` reads at compile time, so the path is relative to *this*
// source file. Keep these constants module-public so tests (and the
// integrator) can `naga`-validate them without re-reading from disk.

pub const SHADER_BASIC:    &str = include_str!("shaders/basic.wgsl");
pub const SHADER_STANDARD: &str = include_str!("shaders/standard.wgsl");
pub const SHADER_PHONG:    &str = include_str!("shaders/phong.wgsl");

// ─── Public types ──────────────────────────────────────────────────────────

/// Mirrors three.js's `FrontSide` / `BackSide` / `DoubleSide`. Maps to
/// `wgpu::PrimitiveState::cull_mode` in `build_pipeline`:
///   * `Front`  → `Some(Face::Back)`  (cull back faces)
///   * `Back`   → `Some(Face::Front)` (cull front faces)
///   * `Double` → `None`              (no culling)
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Front,
    Back,
    Double,
}

impl Default for Side {
    fn default() -> Self { Side::Front }
}

/// One reference material per shader. The optional `map` field is a
/// texture id the integrator (1.5δ) uses to look up a cached
/// `wgpu::TextureView` + `Sampler` to bind at group(2) bindings 1+2.
/// When `map` is `None` the integrator binds a 1×1 white default.
#[derive(Clone, Debug)]
pub enum Material {
    Basic {
        color:   [f32; 4],
        opacity: f32,
        side:    Side,
        map:     Option<u32>,
    },
    Standard {
        color:     [f32; 4],
        metalness: f32,
        roughness: f32,
        opacity:   f32,
        side:      Side,
        map:       Option<u32>,
    },
    Phong {
        color:     [f32; 4],
        specular:  [f32; 4],
        shininess: f32,
        opacity:   f32,
        side:      Side,
        map:       Option<u32>,
    },
}

// ─── Uniform structs (mirror the WGSL `MaterialBasic` / `Std` / `Phong`) ───
//
// These are the *exact* byte layouts the GPU sees. We use #[repr(C)] +
// bytemuck so `write_uniform` is a single memcpy from struct → dst slice.
//
// Sizes per contract:
//   * Basic    — 32 B (color vec4 + opacity f32 + pad vec3)
//   * Standard — 32 B (color vec4 + metalness/roughness/opacity f32 + pad f32)
//   * Phong    — 48 B (color vec4 + specular vec4 + shininess/opacity + pad vec2)

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct MaterialBasicUniform {
    pub color:   [f32; 4],
    pub opacity: f32,
    pub _pad:    [f32; 3],
}
const _: () = assert!(std::mem::size_of::<MaterialBasicUniform>() == 32);

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct MaterialStandardUniform {
    pub color:     [f32; 4],
    pub metalness: f32,
    pub roughness: f32,
    pub opacity:   f32,
    pub _pad:      f32,
}
const _: () = assert!(std::mem::size_of::<MaterialStandardUniform>() == 32);

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct MaterialPhongUniform {
    pub color:     [f32; 4],
    pub specular:  [f32; 4],
    pub shininess: f32,
    pub opacity:   f32,
    pub _pad:      [f32; 2],
}
const _: () = assert!(std::mem::size_of::<MaterialPhongUniform>() == 48);

// ─── Vertex layout (locked) ────────────────────────────────────────────────
//
// position vec3 (12 B), normal vec3 (12 B), uv vec2 (8 B), color vec4 (16 B)
// total 48 B per vertex, alignment 16. Matches geometry.rs's upload format.

const VERTEX_ATTRS: [wgpu::VertexAttribute; 4] = [
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x3,
        offset: 0,
        shader_location: 0,
    },
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x3,
        offset: 12,
        shader_location: 1,
    },
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x2,
        offset: 24,
        shader_location: 2,
    },
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x4,
        offset: 32,
        shader_location: 3,
    },
];

/// The single vertex buffer layout every Phase 1.5 pipeline uses.
pub fn vertex_buffer_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: 48,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &VERTEX_ATTRS,
    }
}

// ─── Shader module cache helpers ───────────────────────────────────────────

/// Compile (and label) the WGSL source for a given material kind.
/// The integrator calls this once per kind and keeps the resulting
/// module around for any number of pipelines built against it.
pub fn create_shader_module(device: &wgpu::Device, kind: MaterialKind) -> wgpu::ShaderModule {
    let (label, source) = match kind {
        MaterialKind::Basic    => ("carbon-mat-basic",    SHADER_BASIC),
        MaterialKind::Standard => ("carbon-mat-standard", SHADER_STANDARD),
        MaterialKind::Phong    => ("carbon-mat-phong",    SHADER_PHONG),
    };
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    })
}

/// Discriminant-only mirror of `Material`. Used by the integrator to key
/// pipeline caches without dragging the per-material props along.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum MaterialKind {
    Basic,
    Standard,
    Phong,
}

// ─── Material API ──────────────────────────────────────────────────────────

impl Material {
    pub fn kind(&self) -> MaterialKind {
        match self {
            Material::Basic    { .. } => MaterialKind::Basic,
            Material::Standard { .. } => MaterialKind::Standard,
            Material::Phong    { .. } => MaterialKind::Phong,
        }
    }

    pub fn side(&self) -> Side {
        match *self {
            Material::Basic    { side, .. } => side,
            Material::Standard { side, .. } => side,
            Material::Phong    { side, .. } => side,
        }
    }

    pub fn opacity(&self) -> f32 {
        match *self {
            Material::Basic    { opacity, .. } => opacity,
            Material::Standard { opacity, .. } => opacity,
            Material::Phong    { opacity, .. } => opacity,
        }
    }

    pub fn map(&self) -> Option<u32> {
        match *self {
            Material::Basic    { map, .. } => map,
            Material::Standard { map, .. } => map,
            Material::Phong    { map, .. } => map,
        }
    }

    /// Byte size of the uniform struct this material packs into. Used by
    /// the integrator to size the per-material uniform buffer.
    pub fn uniform_size(&self) -> usize {
        match self {
            Material::Basic    { .. } => std::mem::size_of::<MaterialBasicUniform>(),
            Material::Standard { .. } => std::mem::size_of::<MaterialStandardUniform>(),
            Material::Phong    { .. } => std::mem::size_of::<MaterialPhongUniform>(),
        }
    }

    /// Pack this material's properties into the given byte slice.
    /// `dst.len()` must be at least `self.uniform_size()`. Panics
    /// otherwise (a buffer-sizing mistake is a bug, not an error).
    pub fn write_uniform(&self, dst: &mut [u8]) {
        match *self {
            Material::Basic { color, opacity, .. } => {
                let u = MaterialBasicUniform { color, opacity, _pad: [0.0; 3] };
                let bytes = bytemuck::bytes_of(&u);
                dst[..bytes.len()].copy_from_slice(bytes);
            }
            Material::Standard { color, metalness, roughness, opacity, .. } => {
                let u = MaterialStandardUniform {
                    color, metalness, roughness, opacity, _pad: 0.0,
                };
                let bytes = bytemuck::bytes_of(&u);
                dst[..bytes.len()].copy_from_slice(bytes);
            }
            Material::Phong { color, specular, shininess, opacity, .. } => {
                let u = MaterialPhongUniform {
                    color, specular, shininess, opacity, _pad: [0.0; 2],
                };
                let bytes = bytemuck::bytes_of(&u);
                dst[..bytes.len()].copy_from_slice(bytes);
            }
        }
    }

    /// Build a `wgpu::RenderPipeline` for this material variant against
    /// the supplied bind group layouts (frame=0, mesh=1, material=2).
    ///
    /// Defaults baked in:
    ///   * topology      = TriangleList (lines/points use a separate path
    ///     in the integrator, not this builder)
    ///   * front_face    = CCW (matches three.js)
    ///   * cull_mode     = derived from `Side`
    ///   * depth_format  = Depth32Float, depth_write = on, depth_compare = Less
    ///   * color target  = the `target_format` arg, blend = ALPHA_BLENDING
    ///                     (premultiplied-alpha-friendly enough for our
    ///                     RGBA8Unorm offscreen target)
    ///   * multisample   = none (sample_count = 1)
    pub fn build_pipeline(
        &self,
        device: &wgpu::Device,
        target_format: wgpu::TextureFormat,
        bind_group_layouts: &[&wgpu::BindGroupLayout; 3],
    ) -> wgpu::RenderPipeline {
        let kind = self.kind();
        let module = create_shader_module(device, kind);

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(match kind {
                MaterialKind::Basic    => "carbon-mat-basic-layout",
                MaterialKind::Standard => "carbon-mat-standard-layout",
                MaterialKind::Phong    => "carbon-mat-phong-layout",
            }),
            bind_group_layouts,
            push_constant_ranges: &[],
        });

        let cull_mode = match self.side() {
            Side::Front  => Some(wgpu::Face::Back),
            Side::Back   => Some(wgpu::Face::Front),
            Side::Double => None,
        };

        let vbuf_layout = vertex_buffer_layout();

        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(match kind {
                MaterialKind::Basic    => "carbon-mat-basic-pipeline",
                MaterialKind::Standard => "carbon-mat-standard-pipeline",
                MaterialKind::Phong    => "carbon-mat-phong-pipeline",
            }),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: std::slice::from_ref(&vbuf_layout),
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
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
                    format: target_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview: None,
            cache: None,
        })
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Round-trip `write_uniform` → bytemuck::from_bytes → assert fields.

    #[test]
    fn write_uniform_basic_round_trip() {
        let m = Material::Basic {
            color:   [0.25, 0.5, 0.75, 0.9],
            opacity: 0.5,
            side:    Side::Front,
            map:     None,
        };
        assert_eq!(m.uniform_size(), 32);
        let mut buf = [0u8; 32];
        m.write_uniform(&mut buf);
        let parsed: &MaterialBasicUniform = bytemuck::from_bytes(&buf);
        assert_eq!(parsed.color,   [0.25, 0.5, 0.75, 0.9]);
        assert_eq!(parsed.opacity, 0.5);
    }

    #[test]
    fn write_uniform_standard_round_trip() {
        let m = Material::Standard {
            color:     [0.1, 0.2, 0.3, 0.4],
            metalness: 0.6,
            roughness: 0.7,
            opacity:   0.8,
            side:      Side::Double,
            map:       Some(7),
        };
        assert_eq!(m.uniform_size(), 32);
        let mut buf = [0u8; 32];
        m.write_uniform(&mut buf);
        let parsed: &MaterialStandardUniform = bytemuck::from_bytes(&buf);
        assert_eq!(parsed.color,     [0.1, 0.2, 0.3, 0.4]);
        assert_eq!(parsed.metalness, 0.6);
        assert_eq!(parsed.roughness, 0.7);
        assert_eq!(parsed.opacity,   0.8);
    }

    #[test]
    fn write_uniform_phong_round_trip() {
        let m = Material::Phong {
            color:     [0.1, 0.2, 0.3, 1.0],
            specular:  [0.9, 0.8, 0.7, 1.0],
            shininess: 32.0,
            opacity:   1.0,
            side:      Side::Back,
            map:       None,
        };
        assert_eq!(m.uniform_size(), 48);
        let mut buf = [0u8; 48];
        m.write_uniform(&mut buf);
        let parsed: &MaterialPhongUniform = bytemuck::from_bytes(&buf);
        assert_eq!(parsed.color,     [0.1, 0.2, 0.3, 1.0]);
        assert_eq!(parsed.specular,  [0.9, 0.8, 0.7, 1.0]);
        assert_eq!(parsed.shininess, 32.0);
        assert_eq!(parsed.opacity,   1.0);
    }

    #[test]
    fn material_metadata_accessors() {
        let m = Material::Basic {
            color: [1.0, 1.0, 1.0, 1.0],
            opacity: 0.42,
            side: Side::Double,
            map: Some(3),
        };
        assert_eq!(m.kind(), MaterialKind::Basic);
        assert_eq!(m.side(), Side::Double);
        assert_eq!(m.opacity(), 0.42);
        assert_eq!(m.map(), Some(3));
    }

    // Naga WGSL parse — catches shader syntax errors at `cargo test` time
    // instead of waiting for the GPU to compile them at runtime. wgpu
    // re-exports its own naga via `wgpu::naga` when the `wgsl` feature is
    // on (which we enable in Cargo.toml).

    fn parse_wgsl_panic(name: &str, src: &str) {
        match wgpu::naga::front::wgsl::parse_str(src) {
            Ok(_) => {}
            Err(e) => panic!("naga rejected {name}: {}", e.emit_to_string(src)),
        }
    }

    #[test]
    fn shader_basic_parses() {
        parse_wgsl_panic("basic.wgsl", SHADER_BASIC);
    }

    #[test]
    fn shader_standard_parses() {
        parse_wgsl_panic("standard.wgsl", SHADER_STANDARD);
    }

    #[test]
    fn shader_phong_parses() {
        parse_wgsl_panic("phong.wgsl", SHADER_PHONG);
    }
}
