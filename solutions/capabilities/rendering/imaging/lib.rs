// carbon-image — native image loading for carbon-mini.
//
// # Architecture overview
//
// ```
//   JS call: __carbon_image_load_path(path)
//       │
//       ▼
//   register_image() host fn                   ← lib.rs (this file)
//       │ capability check (async_load.rs)
//       ▼
//   ImageCache lookup (cache.rs)
//       │ miss
//       ▼
//   decode_path / decode_bytes (decoder.rs)
//       │ → Arc<DecodedImage>
//       ▼
//   cache.insert()
//       │
//       ▼
//   CarbonImage JS class (js_class.rs)  → Promise<CarbonImage>
// ```
//
// # Opt-in binary cost
//
// This crate is an optional dependency of `carbon/runtime` (see that
// package's `image` feature), pulled in only when the host enables the
// `[runtime] image = true` flag in carbon.toml. When `image = false`
// (the default) the crate is not compiled in at all. The `register_image`
// function is guarded so there is no symbol-level cost even if someone links
// the crate by accident.

// ── Layout ──────────────────────────────────────────────────────────────────
// The files moved into domain/, application/ and infrastructure/; the module
// names did not. `#[path]` keeps every public path exactly where it was, so
// `carbon_image::cache::ImageCache` still resolves and nothing downstream
// changed. Rust resolves modules by filesystem position, which is precisely
// what a restructure moves.
//
// Which layer each belongs to:
//
//   domain/decoder    DecodedImage, and turning bytes into pixels. Decoding is
//                     pure computation over a byte slice — the `image` crate is
//                     a library, not an outside system — so this is model, not
//                     an adapter.
//   domain/cache      the RGBA cache and its eviction policy.
//   domain/common     shared helpers over those types.
//   application/      async_load: the load use case, including the capability
//                     check that decides whether a path may be read at all.
//   infrastructure/   js_class — the adapter over QuickJS. The one file that
//                     would be replaced to change JS engine.
//
// decoder.rs started out under infrastructure/ in this migration and moved,
// because cache.rs imports DecodedImage from it: a domain file reaching into
// infrastructure is the one direction this layering exists to forbid, and the
// import was correct — the classification was not.
#[path = "application/async_load.rs"]
pub mod async_load;
#[path = "domain/cache.rs"]
pub mod cache;
#[path = "domain/common.rs"]
mod common;
#[path = "domain/decoder.rs"]
pub mod decoder;
#[path = "infrastructure/js_class.rs"]
pub mod js_class;

pub use async_load::check_capability;
pub use cache::ImageCache;
pub use decoder::DecodedImage;
pub use image::ImageFormat;
pub use js_class::CarbonImageJs;

use std::sync::{Arc, Mutex};

#[allow(unused_imports)]
use rquickjs::IntoJs as _;
use rquickjs::{Class, Ctx, Exception, Function, Result as JsResult};

/// Register the `CarbonImage` class and the three loader globals onto the
/// QuickJS context.
///
/// Globals registered:
///   - `CarbonImage`                       — the class itself (read-only class)
///   - `__carbon_image_load_path(path)`    → `Promise<CarbonImage>`
///   - `__carbon_image_load_bytes(buf)`    → `Promise<CarbonImage>`
///   - `__carbon_image_decode_sync(buf)`   → `CarbonImage`
///
/// The `allowed_globs` list is the resolved `[app.capabilities] image.read`
/// list from carbon.toml, with `${APP}` / `${APPDATA}` already expanded.
///
/// `cache` is shared across all loader calls for the lifetime of the runtime.
///
/// # Capability model
///
/// `__carbon_image_load_path` checks every path against `allowed_globs`
/// before touching the filesystem. Paths that don't match any glob get a
/// synchronously-rejected Promise with a `TypeError`. The other two functions
/// (`load_bytes`, `decode_sync`) accept caller-supplied byte slices and are
/// not capability-checked — the bytes are already in the caller's memory.
pub fn register_image<'js>(
    ctx: &Ctx<'js>,
    cache: Arc<Mutex<ImageCache>>,
    allowed_globs: Vec<String>,
) -> JsResult<()> {
    let globals = ctx.globals();

    // ── Register the CarbonImage class ──────────────────────────────────
    Class::<CarbonImageJs>::define(&globals)?;

    // ── __carbon_image_load_path(path: string): Promise<CarbonImage> ───
    {
        let cache2 = cache.clone();
        let globs2 = allowed_globs.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx2: Ctx<'js>, path: String| -> JsResult<rquickjs::Value<'js>> {
                async_load::load_path_async(ctx2, path, cache2.clone(), &globs2)
            },
        )?;
        globals.set("__carbon_image_load_path", f)?;
    }

    // ── __carbon_image_load_bytes(buffer: ArrayBuffer): Promise<CarbonImage>
    {
        let f = Function::new(
            ctx.clone(),
            move |ctx2: Ctx<'js>,
                  buf: rquickjs::ArrayBuffer<'js>|
                  -> JsResult<rquickjs::Value<'js>> {
                let bytes = buf.as_bytes().unwrap_or(&[]).to_vec();
                async_load::load_bytes_async(ctx2, bytes)
            },
        )?;
        globals.set("__carbon_image_load_bytes", f)?;
    }

    // ── __carbon_image_decode_sync(buffer: ArrayBuffer): CarbonImage ───
    {
        let f = Function::new(
            ctx.clone(),
            move |ctx2: Ctx<'js>,
                  buf: rquickjs::ArrayBuffer<'js>|
                  -> JsResult<rquickjs::Object<'js>> {
                let bytes_slice = buf.as_bytes().unwrap_or(&[]);
                let decoded = decoder::decode_bytes(bytes_slice)
                    .map(Arc::new)
                    .map_err(|e| Exception::throw_message(&ctx2, &e.to_string()))?;
                async_load::make_carbon_image_object(&ctx2, &decoded)
            },
        )?;
        globals.set("__carbon_image_decode_sync", f)?;
    }

    // ── __carbon_canvas_create_texture stub ────────────────────────────
    //
    // TODO (Phase 2): implement this in carbon/runtime/mini.rs using the
    // wgpu device to upload an RGBA8 texture and return an integer texture id.
    //
    // Interface contract:
    //   __carbon_canvas_create_texture(
    //     id: number,           // canvas surface id (from __carbon_canvas_create)
    //     bytes: Uint8Array,    // RGBA8 pixel data, width*height*4 bytes
    //     width: number,
    //     height: number,
    //   ): number               // GPU texture id, or -1 on failure
    //
    // The <image> intrinsic calls this after a successful load to bind the
    // decoded image to a wgpu Texture2D on the canvas surface. Until this
    // is implemented, the intrinsic falls back to displaying dimensions as text.
    {
        let f = Function::new(
            ctx.clone(),
            move |_canvas_id: i32,
                  _bytes: rquickjs::TypedArray<'_, u8>,
                  _width: i32,
                  _height: i32|
                  -> i32 {
                // Phase 2 stub — log and return -1.
                eprintln!(
                    "[carbon-image] __carbon_canvas_create_texture: Phase 2 not yet implemented. \
                     Returning -1. See IMAGE_IMPL.md for the interface contract."
                );
                -1
            },
        )?;
        globals.set("__carbon_canvas_create_texture", f)?;
    }

    Ok(())
}

/// Convenience: create a cache with the default 256 MiB budget.
pub fn default_cache() -> Arc<Mutex<ImageCache>> {
    Arc::new(Mutex::new(ImageCache::with_default_cap()))
}
