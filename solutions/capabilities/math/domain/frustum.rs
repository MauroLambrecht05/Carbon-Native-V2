// Frustum — three.js view frustum, 6 planes (near, far, left, right, top, bottom).
//
// We represent each plane as `Plane { normal, constant }`. Internally we
// keep them as a flat [f32; 24] (6 planes × 4 floats: nx, ny, nz, d) to
// avoid pointer chasing in `intersectsBox`/`intersectsSphere` — those are
// the hottest culling primitives in any 3D app and live in the inner
// loops of scene traversal.
//
// API parity: setFromProjectionMatrix(m: Matrix4) is the only common path
// users hit; intersectsBox / intersectsSphere are the per-object queries.
// We omit `containsPoint` (rarely used in production); user code that
// needs it should use Box3.containsPoint on a 1-pixel box.

use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Class, Ctx, IntoJs, JsLifetime, Object, Result, Value,
};

use crate::box3::Box3;
use crate::matrix4::Matrix4;
use crate::vector3::Vector3;

#[derive(Clone, Copy, Debug)]
pub struct Frustum {
    /// 6 planes × 4 floats: [nx0, ny0, nz0, d0, nx1, ...].
    pub planes: [f32; 24],
}

impl Default for Frustum {
    fn default() -> Self {
        Self { planes: [0.0; 24] }
    }
}

unsafe impl<'js> JsLifetime<'js> for Frustum {
    type Changed<'to> = Frustum;
}

impl<'js> Trace<'js> for Frustum {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for Frustum {
    const NAME: &'static str = "Frustum";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;
        proto.set("isFrustum", true)?;

        proto.set(
            "setFromProjectionMatrix",
            Func::from(
                |this: This<Class<'js, Frustum>>, m: Class<'js, Matrix4>| -> Class<'js, Frustum> {
                    let me = m.borrow().elements;
                    {
                        let mut f = this.borrow_mut();
                        let p = &mut f.planes;
                        // Direct port of three.js Frustum.setFromProjectionMatrix
                        // (WebGL coordinate system: NDC z in [-1, 1]).
                        // Plane order: right, left, bottom, top, far, near
                        // (matches three.js).
                        set_plane(p, 0, me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]);
                        set_plane(p, 1, me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]);
                        set_plane(p, 2, me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]);
                        set_plane(p, 3, me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]);
                        set_plane(p, 4, me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);
                        set_plane(p, 5, me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "intersectsBox",
            Func::from(|this: This<Class<'js, Frustum>>, b: Class<'js, Box3>| -> bool {
                let f = *this.borrow();
                let bx = *b.borrow();
                for i in 0..6 {
                    let nx = f.planes[i * 4];
                    let ny = f.planes[i * 4 + 1];
                    let nz = f.planes[i * 4 + 2];
                    let d  = f.planes[i * 4 + 3];
                    // Pick the corner of the box farthest along the plane
                    // normal — same algorithm three.js uses.
                    let px = if nx > 0.0 { bx.max.x } else { bx.min.x };
                    let py = if ny > 0.0 { bx.max.y } else { bx.min.y };
                    let pz = if nz > 0.0 { bx.max.z } else { bx.min.z };
                    if nx * px + ny * py + nz * pz + d < 0.0 {
                        return false;
                    }
                }
                true
            }),
        )?;

        proto.set(
            "intersectsSphere",
            Func::from(|this: This<Class<'js, Frustum>>, center: Class<'js, Vector3>, radius: f32| -> bool {
                let f = *this.borrow();
                let c = *center.borrow();
                let neg_r = -radius;
                for i in 0..6 {
                    let nx = f.planes[i * 4];
                    let ny = f.planes[i * 4 + 1];
                    let nz = f.planes[i * 4 + 2];
                    let d  = f.planes[i * 4 + 3];
                    let dist = nx * c.x + ny * c.y + nz * c.z + d;
                    if dist < neg_r {
                        return false;
                    }
                }
                true
            }),
        )?;

        proto.set(
            "containsPoint",
            Func::from(|this: This<Class<'js, Frustum>>, pt: Class<'js, Vector3>| -> bool {
                let f = *this.borrow();
                let p = *pt.borrow();
                for i in 0..6 {
                    let nx = f.planes[i * 4];
                    let ny = f.planes[i * 4 + 1];
                    let nz = f.planes[i * 4 + 2];
                    let d  = f.planes[i * 4 + 3];
                    if nx * p.x + ny * p.y + nz * p.z + d < 0.0 {
                        return false;
                    }
                }
                true
            }),
        )?;

        proto.set(
            "copy",
            Func::from(|this: This<Class<'js, Frustum>>, other: Class<'js, Frustum>| -> Class<'js, Frustum> {
                {
                    let o = *other.borrow();
                    *this.borrow_mut() = o;
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "clone",
            Func::from(|ctx: Ctx<'js>, this: This<Class<'js, Frustum>>| -> Result<Class<'js, Frustum>> {
                let f = *this.borrow();
                Class::instance(ctx, f)
            }),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        let c = Constructor::new_class::<Frustum, _, _>(
            ctx.clone(),
            || Frustum { planes: [0.0; 24] },
        )?;
        Ok(Some(c))
    }
}

impl<'js> IntoJs<'js> for Frustum {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

#[inline]
fn set_plane(p: &mut [f32; 24], i: usize, nx: f32, ny: f32, nz: f32, d: f32) {
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    let inv = if len == 0.0 { 1.0 } else { 1.0 / len };
    p[i * 4]     = nx * inv;
    p[i * 4 + 1] = ny * inv;
    p[i * 4 + 2] = nz * inv;
    p[i * 4 + 3] = d * inv;
}
