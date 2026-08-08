// basic.wgsl — Phase 1.5α reference shader.
//
// Maps to three.js's MeshBasicMaterial: unlit, color * vertex-color *
// optional texture sample. No lighting math.
//
// Bind groups (locked by docs/PHASE1_5_CONTRACTS.md):
//   group(0) @binding(0) Camera  — view + proj + position
//   group(0) @binding(1) Lights  — present but unused here
//   group(1) @binding(0) Transform — model matrix + normal matrix
//   group(2) @binding(0) MaterialBasic — color (vec4), opacity (f32), pad
//   group(2) @binding(1) tex (texture_2d<f32>)
//   group(2) @binding(2) samp (sampler)
//
// Vertex layout: 48 B interleaved.

struct Camera {
    view:     mat4x4<f32>,
    proj:     mat4x4<f32>,
    position: vec4<f32>,
};

// We declare the Lights struct so the bind group layout matches across
// shaders even though Basic doesn't read from it. The pipeline-creation
// side gives every material the same group(0) layout.
struct DirectionalLight {
    direction: vec4<f32>,
    color:     vec4<f32>,
};
struct PointLight {
    position: vec4<f32>,
    color:    vec4<f32>,
    falloff:  vec4<f32>, // (range, decay, _, _)
};
struct Lights {
    ambient:           vec4<f32>,
    directional_count: u32,
    point_count:       u32,
    _pad0:             vec2<f32>,
    directional:       array<DirectionalLight, 4>,
    point:             array<PointLight, 8>,
};

struct Transform {
    model:         mat4x4<f32>,
    // normalMatrix is a mat3 padded as three vec4s for std140-ish layout.
    normal_matrix: mat3x3<f32>,
};

struct MaterialBasic {
    color:   vec4<f32>,
    opacity: f32,
    _pad:    vec3<f32>,
};

@group(0) @binding(0) var<uniform> camera:    Camera;
@group(0) @binding(1) var<uniform> lights:    Lights;
@group(1) @binding(0) var<uniform> transform: Transform;
@group(2) @binding(0) var<uniform> material:  MaterialBasic;
@group(2) @binding(1) var          tex:       texture_2d<f32>;
@group(2) @binding(2) var          samp:      sampler;

struct VsIn {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) color:    vec4<f32>,
};

struct VsOut {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv:                  vec2<f32>,
    @location(1) color:               vec4<f32>,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    let world = transform.model * vec4<f32>(in.position, 1.0);
    out.clip_position = camera.proj * camera.view * world;
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // The integrator binds a 1×1 white default texture when the material
    // has no map, so unconditionally sampling here is correct.
    let tex_sample = textureSample(tex, samp, in.uv);
    var rgb = material.color.rgb * in.color.rgb * tex_sample.rgb;
    var a   = material.color.a   * in.color.a   * tex_sample.a * material.opacity;
    if (a < 0.001) {
        discard;
    }
    return vec4<f32>(rgb, a);
}
