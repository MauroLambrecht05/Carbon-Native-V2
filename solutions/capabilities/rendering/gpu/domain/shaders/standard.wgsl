// standard.wgsl — Phase 1.5α reference shader.
//
// Maps to three.js's MeshStandardMaterial. PBR-ish: Lambertian diffuse +
// GGX-lite specular. NOT a full Cook-Torrance with image-based lighting —
// this is a ~30-line approximation suitable for Phase 1.5 reference use.
//
// What we approximate vs. drop:
//   * F0 (base reflectance) lerped between dielectric 0.04 and the albedo
//     by metalness — same trick three's MeshStandardMaterial uses.
//   * D (NDF) is GGX/Trowbridge-Reitz, exact.
//   * G (geometry) is Smith-GGX with k = (rough+1)^2/8 (UE4 simplification).
//   * F (Fresnel) is Schlick.
//   * NO specular IBL, NO diffuse IBL. Ambient is a flat term.
//   * Energy conservation between diffuse and specular is via (1 - F)*(1 - metalness).
//
// Bind groups: see basic.wgsl. Material uniform here is MaterialStd.

struct Camera {
    view:     mat4x4<f32>,
    proj:     mat4x4<f32>,
    position: vec4<f32>,
};

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
    normal_matrix: mat3x3<f32>,
};

struct MaterialStd {
    color:     vec4<f32>,
    metalness: f32,
    roughness: f32,
    opacity:   f32,
    _pad:      f32,
};

@group(0) @binding(0) var<uniform> camera:    Camera;
@group(0) @binding(1) var<uniform> lights:    Lights;
@group(1) @binding(0) var<uniform> transform: Transform;
@group(2) @binding(0) var<uniform> material:  MaterialStd;
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
    @location(0) world_pos:           vec3<f32>,
    @location(1) world_normal:        vec3<f32>,
    @location(2) uv:                  vec2<f32>,
    @location(3) color:               vec4<f32>,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    let world = transform.model * vec4<f32>(in.position, 1.0);
    out.clip_position = camera.proj * camera.view * world;
    out.world_pos = world.xyz;
    out.world_normal = normalize(transform.normal_matrix * in.normal);
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

// ─── PBR helpers (compact GGX) ─────────────────────────────────────────────

fn distribution_ggx(n_dot_h: f32, rough: f32) -> f32 {
    let a   = rough * rough;
    let a2  = a * a;
    let d   = (n_dot_h * n_dot_h) * (a2 - 1.0) + 1.0;
    let pi  = 3.14159265;
    return a2 / max(pi * d * d, 1e-6);
}

fn geometry_schlick_ggx(n_dot_v: f32, rough: f32) -> f32 {
    let r = rough + 1.0;
    let k = (r * r) / 8.0;
    return n_dot_v / (n_dot_v * (1.0 - k) + k);
}

fn geometry_smith(n_dot_v: f32, n_dot_l: f32, rough: f32) -> f32 {
    return geometry_schlick_ggx(n_dot_v, rough) *
           geometry_schlick_ggx(n_dot_l, rough);
}

fn fresnel_schlick(cos_theta: f32, f0: vec3<f32>) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

// Per-light contribution.
fn pbr_light(
    light_dir: vec3<f32>,    // FROM surface TO light, normalized
    light_color: vec3<f32>,  // pre-attenuated radiance
    n: vec3<f32>,
    v: vec3<f32>,
    albedo: vec3<f32>,
    metalness: f32,
    rough: f32,
    f0: vec3<f32>,
) -> vec3<f32> {
    let h = normalize(v + light_dir);
    let n_dot_l = max(dot(n, light_dir), 0.0);
    let n_dot_v = max(dot(n, v), 1e-4);
    let n_dot_h = max(dot(n, h), 0.0);
    let v_dot_h = max(dot(v, h), 0.0);

    let d = distribution_ggx(n_dot_h, rough);
    let g = geometry_smith(n_dot_v, n_dot_l, rough);
    let f = fresnel_schlick(v_dot_h, f0);

    let spec = (d * g * f) / max(4.0 * n_dot_v * n_dot_l, 1e-4);

    // Energy conservation: kd shrinks where ks is high; metals have no diffuse.
    let kd = (vec3<f32>(1.0) - f) * (1.0 - metalness);
    let pi = 3.14159265;
    let diffuse = kd * albedo / pi;

    return (diffuse + spec) * light_color * n_dot_l;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let tex_sample = textureSample(tex, samp, in.uv);
    let albedo = material.color.rgb * in.color.rgb * tex_sample.rgb;
    let alpha  = material.color.a   * in.color.a   * tex_sample.a * material.opacity;
    if (alpha < 0.001) { discard; }

    let n = normalize(in.world_normal);
    let v = normalize(camera.position.xyz - in.world_pos);

    // F0: 0.04 for dielectrics, lerp toward albedo as metalness rises.
    let f0 = mix(vec3<f32>(0.04), albedo, material.metalness);

    // Ambient — flat. (Real PBR would use IBL here.)
    var lo = lights.ambient.rgb * lights.ambient.a * albedo;

    // Directional lights.
    for (var i: u32 = 0u; i < lights.directional_count; i = i + 1u) {
        let dl = lights.directional[i];
        // direction stored is the direction FROM the light, so we negate.
        let ldir = normalize(-dl.direction.xyz);
        let lcol = dl.color.rgb * dl.color.a;
        lo = lo + pbr_light(ldir, lcol, n, v, albedo, material.metalness, material.roughness, f0);
    }

    // Point lights.
    for (var i: u32 = 0u; i < lights.point_count; i = i + 1u) {
        let pl = lights.point[i];
        let to_light = pl.position.xyz - in.world_pos;
        let dist = length(to_light);
        let ldir = to_light / max(dist, 1e-4);
        // Falloff: matches three's distance/decay model.
        // attenuation = 1 / (1 + decay * dist + decay * dist^2 / range^2)
        let range = max(pl.falloff.x, 1e-4);
        let decay = pl.falloff.y;
        let att = 1.0 / (1.0 + decay * dist + (decay * dist * dist) / (range * range));
        let lcol = pl.color.rgb * pl.color.a * att;
        lo = lo + pbr_light(ldir, lcol, n, v, albedo, material.metalness, material.roughness, f0);
    }

    return vec4<f32>(lo, alpha);
}
