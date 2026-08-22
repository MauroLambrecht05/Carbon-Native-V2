// Vector3 — three.js-compatible 3D vector, Rust-native under QuickJS.
//
// Implementation notes
// --------------------
// Three.js's Vector3 mutates `this` and returns `this` for chaining
// (`v.add(b).add(c).normalize()`). To preserve that semantic in rquickjs
// we implement the prototype manually with `Function::new(...)` taking
// `This<Class<Vector3>>` and returning the same `Class<Vector3>` so the
// JS-side identity round-trips. Trying the same with `#[rquickjs::methods]`
// would force us to choose between `&mut self` (no return value) and
// returning `Vector3` (which would clone — and three.js *callers* expect
// the original object to be mutated in place, so a clone would silently
// break programs that hold references to a vector).
//
// Memory layout: x, y, z are three contiguous f32s. Same as three.js's
// `THREE.Vector3` — no shape mismatch when our instances flow back into
// three.js APIs. We expose `isVector3 = true` so three.js's runtime
// type checks pass.
//
// Speed: each method does the math directly in Rust. Hot operations
// (add/sub/multiply/normalize) are a single instruction sequence with
// no JS dispatch, no property lookups, no allocator traffic.

use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, Opt, This},
    Class, Ctx, IntoJs, JsLifetime, Object, Result, Value,
};

use crate::matrix4::Matrix4;
use crate::quaternion::Quaternion;

/// Rust-native three.js Vector3.
#[derive(Clone, Copy, Debug)]
pub struct Vector3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Default for Vector3 {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }
}

impl Vector3 {
    #[inline]
    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
}

unsafe impl JsLifetime<'_> for Vector3 {
    type Changed<'to> = Vector3;
}

impl<'js> Trace<'js> for Vector3 {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {
        // Vector3 holds only POD floats — nothing for the GC to see.
    }
}

impl<'js> JsClass<'js> for Vector3 {
    const NAME: &'static str = "Vector3";

    // Writable so JS code can mutate (we expose accessor properties).
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // Three.js types check `obj.isVector3` instead of using `instanceof`.
        // Putting the flag on the prototype means it's available via property
        // lookup but doesn't bloat per-instance memory.
        proto.set("isVector3", true)?;

        // x/y/z accessor properties — read/write the underlying Rust fields.
        // We install them via Object.defineProperty so JS sees them as
        // getter/setter pairs rather than plain data properties (which is
        // the only shape that lets us forward into the opaque Class data).
        crate::common::define_accessor(
            ctx,
            &proto,
            "x",
            Func::from(|this: This<Class<'js, Vector3>>| -> f32 { this.borrow().x }),
            Func::from(|this: This<Class<'js, Vector3>>, v: f32| {
                this.borrow_mut().x = v;
            }),
        )?;
        crate::common::define_accessor(
            ctx,
            &proto,
            "y",
            Func::from(|this: This<Class<'js, Vector3>>| -> f32 { this.borrow().y }),
            Func::from(|this: This<Class<'js, Vector3>>, v: f32| {
                this.borrow_mut().y = v;
            }),
        )?;
        crate::common::define_accessor(
            ctx,
            &proto,
            "z",
            Func::from(|this: This<Class<'js, Vector3>>| -> f32 { this.borrow().z }),
            Func::from(|this: This<Class<'js, Vector3>>, v: f32| {
                this.borrow_mut().z = v;
            }),
        )?;

        // === Mutating methods that return `this` for chaining ===
        proto.set(
            "set",
            Func::from(
                |this: This<Class<'js, Vector3>>, x: f32, y: f32, z: f32| -> Class<'js, Vector3> {
                    {
                        let mut b = this.borrow_mut();
                        b.x = x;
                        b.y = y;
                        b.z = z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "setScalar",
            Func::from(
                |this: This<Class<'js, Vector3>>, s: f32| -> Class<'js, Vector3> {
                    {
                        let mut b = this.borrow_mut();
                        b.x = s;
                        b.y = s;
                        b.z = s;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "setX",
            Func::from(
                |this: This<Class<'js, Vector3>>, v: f32| -> Class<'js, Vector3> {
                    this.borrow_mut().x = v;
                    this.0.clone()
                },
            ),
        )?;
        proto.set(
            "setY",
            Func::from(
                |this: This<Class<'js, Vector3>>, v: f32| -> Class<'js, Vector3> {
                    this.borrow_mut().y = v;
                    this.0.clone()
                },
            ),
        )?;
        proto.set(
            "setZ",
            Func::from(
                |this: This<Class<'js, Vector3>>, v: f32| -> Class<'js, Vector3> {
                    this.borrow_mut().z = v;
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "copy",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        b.x = o.x;
                        b.y = o.y;
                        b.z = o.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "add",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        b.x += o.x;
                        b.y += o.y;
                        b.z += o.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "addScalar",
            Func::from(
                |this: This<Class<'js, Vector3>>, s: f32| -> Class<'js, Vector3> {
                    {
                        let mut b = this.borrow_mut();
                        b.x += s;
                        b.y += s;
                        b.z += s;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "addVectors",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 a: Class<'js, Vector3>,
                 b_arg: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let av = *a.borrow();
                        let bv = *b_arg.borrow();
                        let mut t = this.borrow_mut();
                        t.x = av.x + bv.x;
                        t.y = av.y + bv.y;
                        t.z = av.z + bv.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "addScaledVector",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 v: Class<'js, Vector3>,
                 s: f32|
                 -> Class<'js, Vector3> {
                    {
                        let vv = *v.borrow();
                        let mut t = this.borrow_mut();
                        t.x += vv.x * s;
                        t.y += vv.y * s;
                        t.z += vv.z * s;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "sub",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        b.x -= o.x;
                        b.y -= o.y;
                        b.z -= o.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "subScalar",
            Func::from(
                |this: This<Class<'js, Vector3>>, s: f32| -> Class<'js, Vector3> {
                    {
                        let mut b = this.borrow_mut();
                        b.x -= s;
                        b.y -= s;
                        b.z -= s;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "subVectors",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 a: Class<'js, Vector3>,
                 b_arg: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let av = *a.borrow();
                        let bv = *b_arg.borrow();
                        let mut t = this.borrow_mut();
                        t.x = av.x - bv.x;
                        t.y = av.y - bv.y;
                        t.z = av.z - bv.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiply",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        b.x *= o.x;
                        b.y *= o.y;
                        b.z *= o.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiplyScalar",
            Func::from(
                |this: This<Class<'js, Vector3>>, s: f32| -> Class<'js, Vector3> {
                    {
                        let mut b = this.borrow_mut();
                        b.x *= s;
                        b.y *= s;
                        b.z *= s;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiplyVectors",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 a: Class<'js, Vector3>,
                 b_arg: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let av = *a.borrow();
                        let bv = *b_arg.borrow();
                        let mut t = this.borrow_mut();
                        t.x = av.x * bv.x;
                        t.y = av.y * bv.y;
                        t.z = av.z * bv.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "divide",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        b.x /= o.x;
                        b.y /= o.y;
                        b.z /= o.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "divideScalar",
            Func::from(
                |this: This<Class<'js, Vector3>>, s: f32| -> Class<'js, Vector3> {
                    {
                        // three.js: `this.multiplyScalar( 1 / scalar )`. Same float
                        // semantics including division-by-zero -> Infinity.
                        let inv = 1.0 / s;
                        let mut b = this.borrow_mut();
                        b.x *= inv;
                        b.y *= inv;
                        b.z *= inv;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "negate",
            Func::from(|this: This<Class<'js, Vector3>>| -> Class<'js, Vector3> {
                {
                    let mut b = this.borrow_mut();
                    b.x = -b.x;
                    b.y = -b.y;
                    b.z = -b.z;
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "dot",
            Func::from(
                |this: This<Class<'js, Vector3>>, other: Class<'js, Vector3>| -> f32 {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    a.x * b.x + a.y * b.y + a.z * b.z
                },
            ),
        )?;

        proto.set(
            "lengthSq",
            Func::from(|this: This<Class<'js, Vector3>>| -> f32 {
                let v = *this.borrow();
                v.x * v.x + v.y * v.y + v.z * v.z
            }),
        )?;

        proto.set(
            "length",
            Func::from(|this: This<Class<'js, Vector3>>| -> f32 {
                let v = *this.borrow();
                (v.x * v.x + v.y * v.y + v.z * v.z).sqrt()
            }),
        )?;

        proto.set(
            "manhattanLength",
            Func::from(|this: This<Class<'js, Vector3>>| -> f32 {
                let v = *this.borrow();
                v.x.abs() + v.y.abs() + v.z.abs()
            }),
        )?;

        proto.set(
            "normalize",
            Func::from(|this: This<Class<'js, Vector3>>| -> Class<'js, Vector3> {
                {
                    let mut b = this.borrow_mut();
                    let len = (b.x * b.x + b.y * b.y + b.z * b.z).sqrt();
                    // three.js: divides by length-or-1, so a zero vector
                    // stays a zero vector (no NaN).
                    let inv = if len == 0.0 { 1.0 } else { 1.0 / len };
                    b.x *= inv;
                    b.y *= inv;
                    b.z *= inv;
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "setLength",
            Func::from(
                |this: This<Class<'js, Vector3>>, length: f32| -> Class<'js, Vector3> {
                    {
                        let mut b = this.borrow_mut();
                        let cur = (b.x * b.x + b.y * b.y + b.z * b.z).sqrt();
                        let inv = if cur == 0.0 { 1.0 } else { 1.0 / cur };
                        let factor = inv * length;
                        b.x *= factor;
                        b.y *= factor;
                        b.z *= factor;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "cross",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        let ax = b.x;
                        let ay = b.y;
                        let az = b.z;
                        b.x = ay * o.z - az * o.y;
                        b.y = az * o.x - ax * o.z;
                        b.z = ax * o.y - ay * o.x;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "crossVectors",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 a: Class<'js, Vector3>,
                 b_arg: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let av = *a.borrow();
                        let bv = *b_arg.borrow();
                        let mut t = this.borrow_mut();
                        t.x = av.y * bv.z - av.z * bv.y;
                        t.y = av.z * bv.x - av.x * bv.z;
                        t.z = av.x * bv.y - av.y * bv.x;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "lerp",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 v: Class<'js, Vector3>,
                 alpha: f32|
                 -> Class<'js, Vector3> {
                    {
                        let vv = *v.borrow();
                        let mut t = this.borrow_mut();
                        t.x += (vv.x - t.x) * alpha;
                        t.y += (vv.y - t.y) * alpha;
                        t.z += (vv.z - t.z) * alpha;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "lerpVectors",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 v1: Class<'js, Vector3>,
                 v2: Class<'js, Vector3>,
                 alpha: f32|
                 -> Class<'js, Vector3> {
                    {
                        let a = *v1.borrow();
                        let b = *v2.borrow();
                        let mut t = this.borrow_mut();
                        t.x = a.x + (b.x - a.x) * alpha;
                        t.y = a.y + (b.y - a.y) * alpha;
                        t.z = a.z + (b.z - a.z) * alpha;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "applyMatrix4",
            Func::from(
                |this: This<Class<'js, Vector3>>, m: Class<'js, Matrix4>| -> Class<'js, Vector3> {
                    let (x, y, z) = {
                        let v = this.borrow();
                        (v.x, v.y, v.z)
                    };
                    let mb = m.borrow();
                    // three.js stores elements column-major.
                    let e = &mb.elements;
                    let w = 1.0 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
                    let nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
                    let ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
                    let nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
                    drop(mb);
                    {
                        let mut t = this.borrow_mut();
                        t.x = nx;
                        t.y = ny;
                        t.z = nz;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "applyQuaternion",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 q: Class<'js, Quaternion>|
                 -> Class<'js, Vector3> {
                    let (x, y, z) = {
                        let v = this.borrow();
                        (v.x, v.y, v.z)
                    };
                    let qb = *q.borrow();
                    let qx = qb.x;
                    let qy = qb.y;
                    let qz = qb.z;
                    let qw = qb.w;
                    // calculate quat * vector
                    let ix = qw * x + qy * z - qz * y;
                    let iy = qw * y + qz * x - qx * z;
                    let iz = qw * z + qx * y - qy * x;
                    let iw = -qx * x - qy * y - qz * z;
                    // calculate result * inverse quat
                    let nx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
                    let ny = iy * qw + iw * -qy + iz * -qx - ix * -qz;
                    let nz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
                    {
                        let mut t = this.borrow_mut();
                        t.x = nx;
                        t.y = ny;
                        t.z = nz;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "distanceTo",
            Func::from(
                |this: This<Class<'js, Vector3>>, other: Class<'js, Vector3>| -> f32 {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    let dx = a.x - b.x;
                    let dy = a.y - b.y;
                    let dz = a.z - b.z;
                    (dx * dx + dy * dy + dz * dz).sqrt()
                },
            ),
        )?;

        proto.set(
            "distanceToSquared",
            Func::from(
                |this: This<Class<'js, Vector3>>, other: Class<'js, Vector3>| -> f32 {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    let dx = a.x - b.x;
                    let dy = a.y - b.y;
                    let dz = a.z - b.z;
                    dx * dx + dy * dy + dz * dz
                },
            ),
        )?;

        proto.set(
            "manhattanDistanceTo",
            Func::from(
                |this: This<Class<'js, Vector3>>, other: Class<'js, Vector3>| -> f32 {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    (a.x - b.x).abs() + (a.y - b.y).abs() + (a.z - b.z).abs()
                },
            ),
        )?;

        proto.set(
            "min",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        b.x = b.x.min(o.x);
                        b.y = b.y.min(o.y);
                        b.z = b.z.min(o.z);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "max",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 other: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let o = *other.borrow();
                        let mut b = this.borrow_mut();
                        b.x = b.x.max(o.x);
                        b.y = b.y.max(o.y);
                        b.z = b.z.max(o.z);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "clamp",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 min: Class<'js, Vector3>,
                 max: Class<'js, Vector3>|
                 -> Class<'js, Vector3> {
                    {
                        let mn = *min.borrow();
                        let mx = *max.borrow();
                        let mut b = this.borrow_mut();
                        b.x = b.x.max(mn.x).min(mx.x);
                        b.y = b.y.max(mn.y).min(mx.y);
                        b.z = b.z.max(mn.z).min(mx.z);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "clampScalar",
            Func::from(
                |this: This<Class<'js, Vector3>>, mn: f32, mx: f32| -> Class<'js, Vector3> {
                    {
                        let mut b = this.borrow_mut();
                        b.x = b.x.max(mn).min(mx);
                        b.y = b.y.max(mn).min(mx);
                        b.z = b.z.max(mn).min(mx);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "floor",
            Func::from(|this: This<Class<'js, Vector3>>| -> Class<'js, Vector3> {
                {
                    let mut b = this.borrow_mut();
                    b.x = b.x.floor();
                    b.y = b.y.floor();
                    b.z = b.z.floor();
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "ceil",
            Func::from(|this: This<Class<'js, Vector3>>| -> Class<'js, Vector3> {
                {
                    let mut b = this.borrow_mut();
                    b.x = b.x.ceil();
                    b.y = b.y.ceil();
                    b.z = b.z.ceil();
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "round",
            Func::from(|this: This<Class<'js, Vector3>>| -> Class<'js, Vector3> {
                {
                    let mut b = this.borrow_mut();
                    // three.js uses Math.round which rounds half-to-positive
                    // (1.5 -> 2, -1.5 -> -1). Rust's f32::round is half-away-
                    // from-zero (1.5 -> 2, -1.5 -> -2). Match three.js.
                    b.x = (b.x + 0.5).floor();
                    b.y = (b.y + 0.5).floor();
                    b.z = (b.z + 0.5).floor();
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "equals",
            Func::from(
                |this: This<Class<'js, Vector3>>, other: Class<'js, Vector3>| -> bool {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    a.x == b.x && a.y == b.y && a.z == b.z
                },
            ),
        )?;

        proto.set(
            "clone",
            Func::from(
                |ctx: Ctx<'js>, this: This<Class<'js, Vector3>>| -> Result<Class<'js, Vector3>> {
                    let v = *this.borrow();
                    Class::instance(ctx, v)
                },
            ),
        )?;

        proto.set(
            "fromArray",
            Func::from(
                |this: This<Class<'js, Vector3>>,
                 arr: rquickjs::Array<'js>,
                 offset: Opt<i32>|
                 -> Result<Class<'js, Vector3>> {
                    let off = offset.0.unwrap_or(0).max(0) as usize;
                    let x: f32 = arr.get(off)?;
                    let y: f32 = arr.get(off + 1)?;
                    let z: f32 = arr.get(off + 2)?;
                    {
                        let mut b = this.borrow_mut();
                        b.x = x;
                        b.y = y;
                        b.z = z;
                    }
                    Ok(this.0.clone())
                },
            ),
        )?;

        proto.set(
            "toArray",
            Func::from(
                |ctx: Ctx<'js>, this: This<Class<'js, Vector3>>| -> Result<rquickjs::Array<'js>> {
                    let v = *this.borrow();
                    let arr = rquickjs::Array::new(ctx)?;
                    arr.set(0, v.x)?;
                    arr.set(1, v.y)?;
                    arr.set(2, v.z)?;
                    Ok(arr)
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        let c = Constructor::new_class::<Vector3, _, _>(
            ctx.clone(),
            |x: Opt<f32>, y: Opt<f32>, z: Opt<f32>| Vector3 {
                x: x.0.unwrap_or(0.0),
                y: y.0.unwrap_or(0.0),
                z: z.0.unwrap_or(0.0),
            },
        )?;
        Ok(Some(c))
    }
}

// Plain Vector3 (POD) -> JS value: wrap in a Class instance.
impl<'js> IntoJs<'js> for Vector3 {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}
