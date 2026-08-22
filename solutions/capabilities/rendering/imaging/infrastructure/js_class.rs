// CarbonImage rquickjs class definition.
//
// Follows the same pattern as carbon-fast-math's Vector3: hand-rolled
// JsClass impl with accessor properties for read-only fields, and a
// `toBytes()` method that returns a Uint8Array view of the RGBA8 data.
//
// JS API contract:
//   class CarbonImage {
//     readonly width: number;
//     readonly height: number;
//     readonly format: 'png' | 'jpeg' | ...;
//     textureId: number;   // -1 until GPU upload; writeable by GPU code
//     toBytes(): Uint8Array;
//   }

use std::sync::Arc;

use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Class, Ctx, Object, Result,
};

use crate::decoder::DecodedImage;

/// The Rust-side data backing a CarbonImage JS object.
pub struct CarbonImageJs {
    /// Shared decoded image (pixels + dimensions).
    pub image: Arc<DecodedImage>,
    /// GPU texture id. -1 if not yet uploaded. JS code may write this.
    pub texture_id: i32,
}

impl CarbonImageJs {
    /// Construct from a decoded image (shared via Arc, no copy).
    pub fn from_decoded(image: Arc<DecodedImage>) -> Self {
        Self {
            image,
            texture_id: -1,
        }
    }

    /// Build a JS Class<CarbonImageJs> object in the given context.
    pub fn into_js_object<'js>(
        ctx: &Ctx<'js>,
        img: CarbonImageJs,
    ) -> Result<Class<'js, CarbonImageJs>> {
        Class::instance(ctx.clone(), img)
    }
}

// rquickjs requires Trace for all class types.
impl<'js> Trace<'js> for CarbonImageJs {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {
        // Arc<DecodedImage> is pure Rust heap data; nothing GC-visible.
    }
}

unsafe impl rquickjs::JsLifetime<'_> for CarbonImageJs {
    type Changed<'to> = CarbonImageJs;
}

impl<'js> JsClass<'js> for CarbonImageJs {
    const NAME: &'static str = "CarbonImage";

    // Writable so JS can set textureId from the GPU integration layer.
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // ── Read-only accessor: width ─────────────────────────────────
        crate::common::define_ro_accessor(
            ctx,
            &proto,
            "width",
            Func::from(|this: This<Class<'js, CarbonImageJs>>| -> i32 {
                this.borrow().image.width as i32
            }),
        )?;

        // ── Read-only accessor: height ────────────────────────────────
        crate::common::define_ro_accessor(
            ctx,
            &proto,
            "height",
            Func::from(|this: This<Class<'js, CarbonImageJs>>| -> i32 {
                this.borrow().image.height as i32
            }),
        )?;

        // ── Read-only accessor: format ────────────────────────────────
        crate::common::define_ro_accessor(
            ctx,
            &proto,
            "format",
            Func::from(|this: This<Class<'js, CarbonImageJs>>| -> &'static str {
                this.borrow().image.format
            }),
        )?;

        // ── Read/write accessor: textureId ───────────────────────────
        crate::common::define_accessor(
            ctx,
            &proto,
            "textureId",
            Func::from(|this: This<Class<'js, CarbonImageJs>>| -> i32 { this.borrow().texture_id }),
            Func::from(|this: This<Class<'js, CarbonImageJs>>, v: i32| {
                this.borrow_mut().texture_id = v;
            }),
        )?;

        // ── toBytes(): Uint8Array — zero-copy clone of RGBA8 data ────
        // We clone the Vec<u8> into a QuickJS-owned ArrayBuffer so the
        // JS Uint8Array's lifetime is independent of the Rust Arc.
        // This is a single memcpy (~4 MB for a 1024×1024 image, ~1 ms).
        proto.set(
            "toBytes",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, CarbonImageJs>>|
                 -> Result<rquickjs::TypedArray<'js, u8>> {
                    let bytes = this.borrow().image.bytes.clone();
                    rquickjs::TypedArray::<u8>::new(ctx, bytes)
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(_ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        // CarbonImage is not directly constructible from JS —
        // instances are created only through the loader functions.
        // Returning None means `new CarbonImage()` in JS throws TypeError.
        Ok(None)
    }
}
