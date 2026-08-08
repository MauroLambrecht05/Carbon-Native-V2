// The optional GPU canvas subsystem: a wgpu-backed 2D/3D drawing surface
// exposed to JS as `<canvas>` GPU commands. Extracted from carbon-mini's
// main.rs as one crate rather than five, because gpu.rs and executor.rs
// import each other directly (Cargo forbids circular crate dependencies),
// and executor.rs also pulls in geometry.rs/material.rs/uniforms.rs — the
// whole cluster only makes sense compiled together.
//
// gpu.rs is the only module anything outside this crate calls
// (`carbon-mini`'s main.rs uses `gpu::{create_surface, execute_commands_json,
// ...}`) — executor/material/geometry/uniforms are internal to how gpu.rs
// implements the canvas, not a public surface of their own.
// ── Layout ──────────────────────────────────────────────────────────────────
//
//   domain/          geometry, material, uniforms — vertex data, material
//                    definitions and uniform-buffer layouts. Plain data with
//                    no `use crate::` between them and nothing below them.
//                    domain/shaders/ holds the WGSL, which material.rs pulls
//                    in with include_str! — they live beside it because that
//                    macro resolves relative to the FILE, and because the
//                    shader source is part of what a material *is*.
//
//   infrastructure/  gpu and executor. These two import each other — gpu.rs
//                    calls into executor.rs and executor.rs calls back — which
//                    is exactly why this was extracted as one crate rather
//                    than five in V1: Cargo forbids circular crate deps. A
//                    cycle cannot straddle a layer boundary either, so they
//                    share one.
//
// `gpu` is the only module anything outside this crate calls. executor,
// material, geometry and uniforms are how gpu implements the canvas, not a
// public surface of their own — but they stay `pub` because that is what they
// were, and narrowing visibility is a separate decision from moving files.
//
// `#[path]` keeps every module name where it was, so the public API is
// unchanged.
#[path = "infrastructure/gpu.rs"]
pub mod gpu;
#[path = "infrastructure/executor.rs"]
pub mod executor;
#[path = "domain/material.rs"]
pub mod material;
#[path = "domain/geometry.rs"]
pub mod geometry;
#[path = "domain/uniforms.rs"]
pub mod uniforms;
