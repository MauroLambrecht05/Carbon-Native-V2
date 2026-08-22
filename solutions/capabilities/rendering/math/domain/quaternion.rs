// Quaternion — three.js-compatible (x, y, z, w) layout.
//
// Layout matches three.js exactly (x, y, z then scalar w). Methods mutate
// `this` and return `this` for chaining where three.js does so.

use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, Opt, This},
    Class, Ctx, IntoJs, JsLifetime, Object, Result, Value,
};

use crate::vector3::Vector3;

#[derive(Clone, Copy, Debug)]
pub struct Quaternion {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Default for Quaternion {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            w: 1.0,
        }
    }
}

impl Quaternion {
    /// Build a Quaternion from a rotation matrix (column-major 4x4 elements
    /// array). Used by Matrix4.decompose. Algorithm direct from three.js.
    pub fn from_rotation_matrix_elements(te: &[f32; 16]) -> Self {
        let m11 = te[0];
        let m12 = te[4];
        let m13 = te[8];
        let m21 = te[1];
        let m22 = te[5];
        let m23 = te[9];
        let m31 = te[2];
        let m32 = te[6];
        let m33 = te[10];

        let trace = m11 + m22 + m33;
        let (x, y, z, w);
        if trace > 0.0 {
            let s = 0.5 / (trace + 1.0).sqrt();
            w = 0.25 / s;
            x = (m32 - m23) * s;
            y = (m13 - m31) * s;
            z = (m21 - m12) * s;
        } else if m11 > m22 && m11 > m33 {
            let s = 2.0 * (1.0 + m11 - m22 - m33).sqrt();
            w = (m32 - m23) / s;
            x = 0.25 * s;
            y = (m12 + m21) / s;
            z = (m13 + m31) / s;
        } else if m22 > m33 {
            let s = 2.0 * (1.0 + m22 - m11 - m33).sqrt();
            w = (m13 - m31) / s;
            x = (m12 + m21) / s;
            y = 0.25 * s;
            z = (m23 + m32) / s;
        } else {
            let s = 2.0 * (1.0 + m33 - m11 - m22).sqrt();
            w = (m21 - m12) / s;
            x = (m13 + m31) / s;
            y = (m23 + m32) / s;
            z = 0.25 * s;
        }
        Self { x, y, z, w }
    }
}

unsafe impl JsLifetime<'_> for Quaternion {
    type Changed<'to> = Quaternion;
}

impl<'js> Trace<'js> for Quaternion {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for Quaternion {
    const NAME: &'static str = "Quaternion";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;
        proto.set("isQuaternion", true)?;

        // x/y/z/w accessors
        macro_rules! accessor {
            ($name:literal, $field:ident) => {
                crate::common::define_accessor(
                    ctx,
                    &proto,
                    $name,
                    Func::from(|this: This<Class<'js, Quaternion>>| -> f32 {
                        this.borrow().$field
                    }),
                    Func::from(|this: This<Class<'js, Quaternion>>, v: f32| {
                        this.borrow_mut().$field = v;
                    }),
                )?;
            };
        }
        accessor!("x", x);
        accessor!("y", y);
        accessor!("z", z);
        accessor!("w", w);

        proto.set(
            "set",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 x: f32,
                 y: f32,
                 z: f32,
                 w: f32|
                 -> Class<'js, Quaternion> {
                    {
                        let mut q = this.borrow_mut();
                        q.x = x;
                        q.y = y;
                        q.z = z;
                        q.w = w;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "copy",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 other: Class<'js, Quaternion>|
                 -> Class<'js, Quaternion> {
                    {
                        let o = *other.borrow();
                        let mut q = this.borrow_mut();
                        *q = o;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "clone",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, Quaternion>>|
                 -> Result<Class<'js, Quaternion>> {
                    let q = *this.borrow();
                    Class::instance(ctx, q)
                },
            ),
        )?;

        proto.set(
            "identity",
            Func::from(
                |this: This<Class<'js, Quaternion>>| -> Class<'js, Quaternion> {
                    {
                        let mut q = this.borrow_mut();
                        *q = Quaternion::default();
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "setFromAxisAngle",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 axis: Class<'js, Vector3>,
                 angle: f32|
                 -> Class<'js, Quaternion> {
                    let a = *axis.borrow();
                    let half = angle / 2.0;
                    let s = half.sin();
                    {
                        let mut q = this.borrow_mut();
                        q.x = a.x * s;
                        q.y = a.y * s;
                        q.z = a.z * s;
                        q.w = half.cos();
                    }
                    this.0.clone()
                },
            ),
        )?;

        // setFromEuler accepts (eulerLike, update?) where eulerLike has
        // {x, y, z, _order} or `order` getter. We accept x/y/z/order args
        // directly for the fast path; the JS shim version (which is what
        // user code would call) is the (eulerLike) form. Provide both:
        //   q.setFromEuler({ x, y, z, order: 'XYZ' })
        //   q.setFromEuler(x, y, z, order)  -- carbon-fast-math extension
        proto.set(
            "setFromEuler",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 a: Value<'js>,
                 b: Opt<Value<'js>>,
                 c: Opt<f32>,
                 d: Opt<rquickjs::String<'js>>|
                 -> Result<Class<'js, Quaternion>> {
                    let (x, y, z, order) = if let Some(obj) = a.as_object() {
                        let x: f32 = obj.get("_x").or_else(|_| obj.get::<_, f32>("x"))?;
                        let y: f32 = obj.get("_y").or_else(|_| obj.get::<_, f32>("y"))?;
                        let z: f32 = obj.get("_z").or_else(|_| obj.get::<_, f32>("z"))?;
                        let order: String = obj
                            .get::<_, String>("_order")
                            .or_else(|_| obj.get::<_, String>("order"))
                            .unwrap_or_else(|_| "XYZ".to_string());
                        (x, y, z, order)
                    } else {
                        let x: f32 = a.as_number().map(|n| n as f32).unwrap_or(0.0);
                        let y: f32 =
                            b.0.and_then(|v| v.as_number())
                                .map(|n| n as f32)
                                .unwrap_or(0.0);
                        let z: f32 = c.0.unwrap_or(0.0);
                        let order: String =
                            d.0.and_then(|s| s.to_string().ok())
                                .unwrap_or_else(|| "XYZ".to_string());
                        (x, y, z, order)
                    };

                    let (c1, s1) = (x / 2.0).cos_sin();
                    let (c2, s2) = (y / 2.0).cos_sin();
                    let (c3, s3) = (z / 2.0).cos_sin();
                    let (qx, qy, qz, qw) = match order.as_str() {
                        "XYZ" => (
                            s1 * c2 * c3 + c1 * s2 * s3,
                            c1 * s2 * c3 - s1 * c2 * s3,
                            c1 * c2 * s3 + s1 * s2 * c3,
                            c1 * c2 * c3 - s1 * s2 * s3,
                        ),
                        "YXZ" => (
                            s1 * c2 * c3 + c1 * s2 * s3,
                            c1 * s2 * c3 - s1 * c2 * s3,
                            c1 * c2 * s3 - s1 * s2 * c3,
                            c1 * c2 * c3 + s1 * s2 * s3,
                        ),
                        "ZXY" => (
                            s1 * c2 * c3 - c1 * s2 * s3,
                            c1 * s2 * c3 + s1 * c2 * s3,
                            c1 * c2 * s3 + s1 * s2 * c3,
                            c1 * c2 * c3 - s1 * s2 * s3,
                        ),
                        "ZYX" => (
                            s1 * c2 * c3 - c1 * s2 * s3,
                            c1 * s2 * c3 + s1 * c2 * s3,
                            c1 * c2 * s3 - s1 * s2 * c3,
                            c1 * c2 * c3 + s1 * s2 * s3,
                        ),
                        "YZX" => (
                            s1 * c2 * c3 + c1 * s2 * s3,
                            c1 * s2 * c3 + s1 * c2 * s3,
                            c1 * c2 * s3 - s1 * s2 * c3,
                            c1 * c2 * c3 - s1 * s2 * s3,
                        ),
                        "XZY" => (
                            s1 * c2 * c3 - c1 * s2 * s3,
                            c1 * s2 * c3 - s1 * c2 * s3,
                            c1 * c2 * s3 + s1 * s2 * c3,
                            c1 * c2 * c3 + s1 * s2 * s3,
                        ),
                        _ => (0.0, 0.0, 0.0, 1.0),
                    };
                    {
                        let mut q = this.borrow_mut();
                        q.x = qx;
                        q.y = qy;
                        q.z = qz;
                        q.w = qw;
                    }
                    Ok(this.0.clone())
                },
            ),
        )?;

        proto.set(
            "multiply",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 other: Class<'js, Quaternion>|
                 -> Class<'js, Quaternion> {
                    let q = *this.borrow();
                    let o = *other.borrow();
                    let r = quat_mul(q, o);
                    *this.borrow_mut() = r;
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "premultiply",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 other: Class<'js, Quaternion>|
                 -> Class<'js, Quaternion> {
                    let q = *this.borrow();
                    let o = *other.borrow();
                    let r = quat_mul(o, q);
                    *this.borrow_mut() = r;
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiplyQuaternions",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 a: Class<'js, Quaternion>,
                 b: Class<'js, Quaternion>|
                 -> Class<'js, Quaternion> {
                    let av = *a.borrow();
                    let bv = *b.borrow();
                    *this.borrow_mut() = quat_mul(av, bv);
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "conjugate",
            Func::from(
                |this: This<Class<'js, Quaternion>>| -> Class<'js, Quaternion> {
                    {
                        let mut q = this.borrow_mut();
                        q.x = -q.x;
                        q.y = -q.y;
                        q.z = -q.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "invert",
            Func::from(
                |this: This<Class<'js, Quaternion>>| -> Class<'js, Quaternion> {
                    // Three.js inverts unit quaternions via conjugate. Match.
                    {
                        let mut q = this.borrow_mut();
                        q.x = -q.x;
                        q.y = -q.y;
                        q.z = -q.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "dot",
            Func::from(
                |this: This<Class<'js, Quaternion>>, other: Class<'js, Quaternion>| -> f32 {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
                },
            ),
        )?;

        proto.set(
            "lengthSq",
            Func::from(|this: This<Class<'js, Quaternion>>| -> f32 {
                let q = *this.borrow();
                q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w
            }),
        )?;

        proto.set(
            "length",
            Func::from(|this: This<Class<'js, Quaternion>>| -> f32 {
                let q = *this.borrow();
                (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).sqrt()
            }),
        )?;

        proto.set(
            "normalize",
            Func::from(
                |this: This<Class<'js, Quaternion>>| -> Class<'js, Quaternion> {
                    {
                        let mut q = this.borrow_mut();
                        let len = (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).sqrt();
                        if len == 0.0 {
                            q.x = 0.0;
                            q.y = 0.0;
                            q.z = 0.0;
                            q.w = 1.0;
                        } else {
                            let inv = 1.0 / len;
                            q.x *= inv;
                            q.y *= inv;
                            q.z *= inv;
                            q.w *= inv;
                        }
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "slerp",
            Func::from(
                |this: This<Class<'js, Quaternion>>,
                 qb: Class<'js, Quaternion>,
                 t: f32|
                 -> Class<'js, Quaternion> {
                    if t == 0.0 {
                        return this.0.clone();
                    }
                    if t == 1.0 {
                        let b = *qb.borrow();
                        *this.borrow_mut() = b;
                        return this.0.clone();
                    }
                    let a = *this.borrow();
                    let b = *qb.borrow();
                    let r = quat_slerp(a, b, t);
                    *this.borrow_mut() = r;
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "equals",
            Func::from(
                |this: This<Class<'js, Quaternion>>, other: Class<'js, Quaternion>| -> bool {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    a.x == b.x && a.y == b.y && a.z == b.z && a.w == b.w
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        let c = Constructor::new_class::<Quaternion, _, _>(
            ctx.clone(),
            |x: Opt<f32>, y: Opt<f32>, z: Opt<f32>, w: Opt<f32>| Quaternion {
                x: x.0.unwrap_or(0.0),
                y: y.0.unwrap_or(0.0),
                z: z.0.unwrap_or(0.0),
                w: w.0.unwrap_or(1.0),
            },
        )?;
        Ok(Some(c))
    }
}

impl<'js> IntoJs<'js> for Quaternion {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

#[inline]
pub fn quat_mul(a: Quaternion, b: Quaternion) -> Quaternion {
    Quaternion {
        x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
        y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
        z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    }
}

#[inline]
pub fn quat_slerp(a: Quaternion, b: Quaternion, t: f32) -> Quaternion {
    // three.js's Quaternion.slerp algorithm.
    let mut x = a.x;
    let mut y = a.y;
    let mut z = a.z;
    let mut w = a.w;

    let mut cos_half_theta = w * b.w + x * b.x + y * b.y + z * b.z;
    let (bx, by, bz, bw) = if cos_half_theta < 0.0 {
        cos_half_theta = -cos_half_theta;
        (-b.x, -b.y, -b.z, -b.w)
    } else {
        (b.x, b.y, b.z, b.w)
    };

    if cos_half_theta >= 1.0 {
        return Quaternion { x, y, z, w };
    }

    let sqr_sin_half_theta = 1.0 - cos_half_theta * cos_half_theta;
    if sqr_sin_half_theta <= f32::EPSILON {
        let s = 1.0 - t;
        let nw = s * w + t * bw;
        let nx = s * x + t * bx;
        let ny = s * y + t * by;
        let nz = s * z + t * bz;
        let len = (nw * nw + nx * nx + ny * ny + nz * nz).sqrt();
        let inv = if len == 0.0 { 1.0 } else { 1.0 / len };
        return Quaternion {
            x: nx * inv,
            y: ny * inv,
            z: nz * inv,
            w: nw * inv,
        };
    }

    let sin_half_theta = sqr_sin_half_theta.sqrt();
    let half_theta = sin_half_theta.atan2(cos_half_theta);
    let ratio_a = ((1.0 - t) * half_theta).sin() / sin_half_theta;
    let ratio_b = (t * half_theta).sin() / sin_half_theta;

    w = w * ratio_a + bw * ratio_b;
    x = x * ratio_a + bx * ratio_b;
    y = y * ratio_a + by * ratio_b;
    z = z * ratio_a + bz * ratio_b;
    Quaternion { x, y, z, w }
}

// f32::cos_sin doesn't exist; Rust has sin_cos. Wrap so the (cos, sin)
// order in the Euler conversion code reads naturally.
trait CosSin {
    fn cos_sin(self) -> (f32, f32);
}
impl CosSin for f32 {
    #[inline]
    fn cos_sin(self) -> (f32, f32) {
        let (s, c) = self.sin_cos();
        (c, s)
    }
}
