// phong.wgsl — Phase 1.5α reference shader.
//
// Maps to three.js's MeshPhongMaterial: classical Blinn-Phong lighting
// (ambient + Lambertian diffuse + Blinn-Phong specular). Cheaper than
// Standard, no metalness/roughness — just `specular` color and `shininess`.
//
// Bind groups: same as basic/standard.

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
    falloff:  vec4<f32>,
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

struct MaterialPhong {
    color:     vec4<f32>,
    specular:  vec4<f32>,
    shininess: f32,
    opacity:   f32,
    _pad:      vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera:    Camera;
@group(0) @binding(1) var<uniform> lights:    Lights;
@group(1) @binding(0) var<uniform> transform: Transform;
@group(2) @binding(0) var<uniform> material:  MaterialPhong;
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

// Per-light Blinn-Phong contribution (diffuse + specular).
fn phong_light(
    light_dir: vec3<f32>,
    light_color: vec3<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    albedo: vec3<f32>,
    specular: vec3<f32>,
    shininess: f32,
) -> vec3<f32> {
    let n_dot_l = max(dot(n, light_dir), 0.0);
    let diffuse = albedo * n_dot_l;

    // Blinn-Phong: half vector instead of reflect(); cheaper and plausible.
    let h = normalize(v + light_dir);
    let n_dot_h = max(dot(n, h), 0.0);
    // Skip specular when the light is behind the surface.
    let spec_strength = select(0.0, pow(n_dot_h, max(shininess, 1.0)), n_dot_l > 0.0);
    let spec = specular * spec_strength;

    return (diffuse + spec) * light_color;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let tex_sample = textureSample(tex, samp, in.uv);
    let albedo = material.color.rgb * in.color.rgb * tex_sample.rgb;
    let alpha  = material.color.a   * in.color.a   * tex_sample.a * material.opacity;
    if (alpha < 0.001) { discard; }

    let n = normalize(in.world_normal);
    let v = normalize(camera.position.xyz - in.world_pos);
    let spec = material.specular.rgb;
    let shininess = material.shininess;

    // Ambient term — three.js multiplies ambient by the material color.
    var lo = lights.ambient.rgb * lights.ambient.a * albedo;

    for (var i: u32 = 0u; i < lights.directional_count; i = i + 1u) {
        let dl = lights.directional[i];
        let ldir = normalize(-dl.direction.xyz);
        let lcol = dl.color.rgb * dl.color.a;
        lo = lo + phong_light(ldir, lcol, n, v, albedo, spec, shininess);
    }

    for (var i: u32 = 0u; i < lights.point_count; i = i + 1u) {
        let pl = lights.point[i];
        let to_light = pl.position.xyz - in.world_pos;
        let dist = length(to_light);
        let ldir = to_light / max(dist, 1e-4);
        let range = max(pl.falloff.x, 1e-4);
        let decay = pl.falloff.y;
        let att = 1.0 / (1.0 + decay * dist + (decay * dist * dist) / (range * range));
        let lcol = pl.color.rgb * pl.color.a * att;
        lo = lo + phong_light(ldir, lcol, n, v, albedo, spec, shininess);
    }

    return vec4<f32>(lo, alpha);
}
