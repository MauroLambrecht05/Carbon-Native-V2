// Matrix4 — three.js-compatible 4x4 column-major matrix.
//
// Layout: 16 f32s, column-major, identity at construction. Matches three.js
// (matrix.elements is a column-major Float32Array(16)).
//   index:    [0  4  8  12]
//             [1  5  9  13]
//             [2  6  10 14]
//             [3  7  11 15]
//
// We expose `elements` as an accessor property that returns a JS Array of
// 16 numbers — three.js's `.elements` is a Float32Array, but JS code that
// reads `m.elements[12]` works the same whichever shape we hand back. (We
// chose Array over Float32Array because typed-array support in QuickJS
// needs the array-buffer feature, and Array is universally available with
// no extra cost.)

use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Class, Ctx, IntoJs, JsLifetime, Object, Result, Value,
};

use crate::quaternion::Quaternion;
use crate::vector3::Vector3;

#[derive(Clone, Copy, Debug)]
pub struct Matrix4 {
    pub elements: [f32; 16],
}

impl Default for Matrix4 {
    fn default() -> Self {
        Self::identity()
    }
}

impl Matrix4 {
    #[inline]
    pub fn identity() -> Self {
        Self {
            elements: [
                1.0, 0.0, 0.0, 0.0, // col 0
                0.0, 1.0, 0.0, 0.0, // col 1
                0.0, 0.0, 1.0, 0.0, // col 2
                0.0, 0.0, 0.0, 1.0, // col 3
            ],
        }
    }
}

unsafe impl<'js> JsLifetime<'js> for Matrix4 {
    type Changed<'to> = Matrix4;
}

impl<'js> Trace<'js> for Matrix4 {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for Matrix4 {
    const NAME: &'static str = "Matrix4";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;
        proto.set("isMatrix4", true)?;

        // `elements` accessor — returns a fresh JS Array of 16 numbers each
        // call. Most three.js consumers only read .elements occasionally;
        // those that mutate via `m.elements[i] = …` won't write through to
        // the Rust storage. That's an explicit tradeoff (see PHASE3_IMPL.md).
        crate::common::define_accessor(
            ctx,
            &proto,
            "elements",
            Func::from(|ctx: Ctx<'js>, this: This<Class<'js, Matrix4>>| -> Result<rquickjs::Array<'js>> {
                let m = this.borrow();
                let arr = rquickjs::Array::new(ctx)?;
                for i in 0..16 {
                    arr.set(i, m.elements[i])?;
                }
                Ok(arr)
            }),
            // setter: copy 16 entries from the supplied array into our buffer.
            Func::from(|this: This<Class<'js, Matrix4>>, value: rquickjs::Array<'js>| -> Result<()> {
                let mut m = this.borrow_mut();
                for i in 0..16 {
                    m.elements[i] = value.get::<f32>(i).unwrap_or(0.0);
                }
                Ok(())
            }),
        )?;

        // set(n11, n12, ..., n44) — three.js's row-major signature that
        // populates the column-major storage. Mirrors three.js exactly.
        //
        // rquickjs's IntoJsFunc only implements up to 8 positional args, so
        // we pull the 16 values out of the JS-side `Rest` (our caller still
        // passes them as 16 positional floats — three.js style). This costs
        // a tiny bit of dispatch overhead but matches the user-visible API.
        proto.set(
            "set",
            Func::from(
                |this: This<Class<'js, Matrix4>>, args: rquickjs::function::Rest<f32>| -> Class<'js, Matrix4> {
                    let n = args.0;
                    if n.len() == 16 {
                        let mut m = this.borrow_mut();
                        let e = &mut m.elements;
                        e[0]  = n[0];  e[4]  = n[1];  e[8]  = n[2];  e[12] = n[3];
                        e[1]  = n[4];  e[5]  = n[5];  e[9]  = n[6];  e[13] = n[7];
                        e[2]  = n[8];  e[6]  = n[9];  e[10] = n[10]; e[14] = n[11];
                        e[3]  = n[12]; e[7]  = n[13]; e[11] = n[14]; e[15] = n[15];
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "identity",
            Func::from(|this: This<Class<'js, Matrix4>>| -> Class<'js, Matrix4> {
                {
                    let mut m = this.borrow_mut();
                    m.elements = Matrix4::identity().elements;
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "clone",
            Func::from(|ctx: Ctx<'js>, this: This<Class<'js, Matrix4>>| -> Result<Class<'js, Matrix4>> {
                let m = *this.borrow();
                Class::instance(ctx, m)
            }),
        )?;

        proto.set(
            "copy",
            Func::from(
                |this: This<Class<'js, Matrix4>>, other: Class<'js, Matrix4>| -> Class<'js, Matrix4> {
                    {
                        let o = *other.borrow();
                        let mut m = this.borrow_mut();
                        m.elements = o.elements;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiply",
            Func::from(
                |this: This<Class<'js, Matrix4>>, other: Class<'js, Matrix4>| -> Class<'js, Matrix4> {
                    {
                        let o = *other.borrow();
                        let a = *this.borrow();
                        let r = mat4_mul(&a.elements, &o.elements);
                        this.borrow_mut().elements = r;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "premultiply",
            Func::from(
                |this: This<Class<'js, Matrix4>>, other: Class<'js, Matrix4>| -> Class<'js, Matrix4> {
                    {
                        let o = *other.borrow();
                        let a = *this.borrow();
                        let r = mat4_mul(&o.elements, &a.elements);
                        this.borrow_mut().elements = r;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiplyMatrices",
            Func::from(
                |this: This<Class<'js, Matrix4>>,
                 a: Class<'js, Matrix4>,
                 b: Class<'js, Matrix4>|
                 -> Class<'js, Matrix4> {
                    let av = *a.borrow();
                    let bv = *b.borrow();
                    let r = mat4_mul(&av.elements, &bv.elements);
                    this.borrow_mut().elements = r;
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiplyScalar",
            Func::from(|this: This<Class<'js, Matrix4>>, s: f32| -> Class<'js, Matrix4> {
                {
                    let mut m = this.borrow_mut();
                    for v in m.elements.iter_mut() {
                        *v *= s;
                    }
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "determinant",
            Func::from(|this: This<Class<'js, Matrix4>>| -> f32 {
                let e = this.borrow().elements;
                determinant(&e)
            }),
        )?;

        proto.set(
            "transpose",
            Func::from(|this: This<Class<'js, Matrix4>>| -> Class<'js, Matrix4> {
                {
                    let mut m = this.borrow_mut();
                    let e = &mut m.elements;
                    e.swap(1, 4);
                    e.swap(2, 8);
                    e.swap(6, 9);
                    e.swap(3, 12);
                    e.swap(7, 13);
                    e.swap(11, 14);
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "invert",
            Func::from(|this: This<Class<'js, Matrix4>>| -> Class<'js, Matrix4> {
                {
                    let me = this.borrow().elements;
                    let inv = mat4_invert(&me);
                    this.borrow_mut().elements = inv;
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "makeTranslation",
            Func::from(|this: This<Class<'js, Matrix4>>, x: f32, y: f32, z: f32| -> Class<'js, Matrix4> {
                {
                    let mut m = this.borrow_mut();
                    m.elements = [
                        1.0, 0.0, 0.0, 0.0,
                        0.0, 1.0, 0.0, 0.0,
                        0.0, 0.0, 1.0, 0.0,
                          x,   y,   z, 1.0,
                    ];
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "makeScale",
            Func::from(|this: This<Class<'js, Matrix4>>, x: f32, y: f32, z: f32| -> Class<'js, Matrix4> {
                {
                    let mut m = this.borrow_mut();
                    m.elements = [
                          x, 0.0, 0.0, 0.0,
                        0.0,   y, 0.0, 0.0,
                        0.0, 0.0,   z, 0.0,
                        0.0, 0.0, 0.0, 1.0,
                    ];
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "makeRotationX",
            Func::from(|this: This<Class<'js, Matrix4>>, theta: f32| -> Class<'js, Matrix4> {
                let (s, c) = theta.sin_cos();
                {
                    let mut m = this.borrow_mut();
                    m.elements = [
                        1.0, 0.0, 0.0, 0.0,
                        0.0,   c,   s, 0.0,
                        0.0,  -s,   c, 0.0,
                        0.0, 0.0, 0.0, 1.0,
                    ];
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "makeRotationY",
            Func::from(|this: This<Class<'js, Matrix4>>, theta: f32| -> Class<'js, Matrix4> {
                let (s, c) = theta.sin_cos();
                {
                    let mut m = this.borrow_mut();
                    m.elements = [
                          c, 0.0,  -s, 0.0,
                        0.0, 1.0, 0.0, 0.0,
                          s, 0.0,   c, 0.0,
                        0.0, 0.0, 0.0, 1.0,
                    ];
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "makeRotationZ",
            Func::from(|this: This<Class<'js, Matrix4>>, theta: f32| -> Class<'js, Matrix4> {
                let (s, c) = theta.sin_cos();
                {
                    let mut m = this.borrow_mut();
                    m.elements = [
                          c,   s, 0.0, 0.0,
                         -s,   c, 0.0, 0.0,
                        0.0, 0.0, 1.0, 0.0,
                        0.0, 0.0, 0.0, 1.0,
                    ];
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "makeRotationFromQuaternion",
            Func::from(|this: This<Class<'js, Matrix4>>, q: Class<'js, Quaternion>| -> Class<'js, Matrix4> {
                let qb = *q.borrow();
                {
                    let mut m = this.borrow_mut();
                    m.elements = compose_matrix(0.0, 0.0, 0.0, qb, 1.0, 1.0, 1.0);
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "compose",
            Func::from(
                |this: This<Class<'js, Matrix4>>,
                 position: Class<'js, Vector3>,
                 quaternion: Class<'js, Quaternion>,
                 scale: Class<'js, Vector3>|
                 -> Class<'js, Matrix4> {
                    let p = *position.borrow();
                    let q = *quaternion.borrow();
                    let s = *scale.borrow();
                    {
                        let mut m = this.borrow_mut();
                        m.elements = compose_matrix(p.x, p.y, p.z, q, s.x, s.y, s.z);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "decompose",
            Func::from(
                |this: This<Class<'js, Matrix4>>,
                 position: Class<'js, Vector3>,
                 quaternion: Class<'js, Quaternion>,
                 scale: Class<'js, Vector3>|
                 -> Class<'js, Matrix4> {
                    let me = this.borrow().elements;
                    let (px, py, pz, q, sx, sy, sz) = decompose_matrix(&me);
                    {
                        let mut p = position.borrow_mut();
                        p.x = px;
                        p.y = py;
                        p.z = pz;
                    }
                    {
                        let mut qb = quaternion.borrow_mut();
                        *qb = q;
                    }
                    {
                        let mut s = scale.borrow_mut();
                        s.x = sx;
                        s.y = sy;
                        s.z = sz;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "makePerspective",
            Func::from(
                |this: This<Class<'js, Matrix4>>,
                 left: f32, right: f32, top: f32, bottom: f32,
                 near: f32, far: f32|
                 -> Class<'js, Matrix4> {
                    // three.js (post WebGPU update) uses NDC depth [0,1] when
                    // coordinateSystem is WebGPUCoordinateSystem; default
                    // (WebGLCoordinateSystem) is [-1,1]. We match the WebGL
                    // default since that's what most three.js code expects.
                    let x = 2.0 * near / (right - left);
                    let y = 2.0 * near / (top - bottom);
                    let a = (right + left) / (right - left);
                    let b = (top + bottom) / (top - bottom);
                    let c = -(far + near) / (far - near);
                    let d = -2.0 * far * near / (far - near);
                    {
                        let mut m = this.borrow_mut();
                        m.elements = [
                              x, 0.0, 0.0,  0.0,
                            0.0,   y, 0.0,  0.0,
                              a,   b,   c, -1.0,
                            0.0, 0.0,   d,  0.0,
                        ];
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "makeOrthographic",
            Func::from(
                |this: This<Class<'js, Matrix4>>,
                 left: f32, right: f32, top: f32, bottom: f32,
                 near: f32, far: f32|
                 -> Class<'js, Matrix4> {
                    let w = 1.0 / (right - left);
                    let h = 1.0 / (top - bottom);
                    let p = 1.0 / (far - near);
                    let x = (right + left) * w;
                    let y = (top + bottom) * h;
                    let z = (far + near) * p;
                    {
                        let mut m = this.borrow_mut();
                        m.elements = [
                            2.0 * w,   0.0,        0.0, 0.0,
                                0.0, 2.0 * h,    0.0, 0.0,
                                0.0,   0.0, -2.0 * p, 0.0,
                                 -x,    -y,       -z, 1.0,
                        ];
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "lookAt",
            Func::from(
                |this: This<Class<'js, Matrix4>>,
                 eye: Class<'js, Vector3>,
                 target: Class<'js, Vector3>,
                 up: Class<'js, Vector3>|
                 -> Class<'js, Matrix4> {
                    let ev = *eye.borrow();
                    let tv = *target.borrow();
                    let uv = *up.borrow();
                    {
                        let mut m = this.borrow_mut();
                        m.elements = look_at(&ev, &tv, &uv, &m.elements);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "equals",
            Func::from(
                |this: This<Class<'js, Matrix4>>, other: Class<'js, Matrix4>| -> bool {
                    let a = this.borrow().elements;
                    let b = other.borrow().elements;
                    a == b
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        // Three.js's `new Matrix4()` returns the identity. No required args.
        let c = Constructor::new_class::<Matrix4, _, _>(ctx.clone(), || Matrix4::identity())?;
        Ok(Some(c))
    }
}

impl<'js> IntoJs<'js> for Matrix4 {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

// ─── Pure-Rust math helpers (also used by tests directly) ────────────────

/// Matrix-matrix multiply: r = a * b. Column-major in, column-major out.
/// Inlined manually rather than using glam::Mat4 because we want exact
/// f32 fidelity with three.js's source ordering for tests; glam may use
/// fused-multiply-add reorderings on some targets that change the last
/// ULP. Pure scalar sequence is cheap and predictable.
#[inline]
pub fn mat4_mul(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut r = [0.0_f32; 16];
    // three.js source, modified to read from arrays (columns 0..3 of a, b).
    let a11 = a[0]; let a12 = a[4]; let a13 = a[8];  let a14 = a[12];
    let a21 = a[1]; let a22 = a[5]; let a23 = a[9];  let a24 = a[13];
    let a31 = a[2]; let a32 = a[6]; let a33 = a[10]; let a34 = a[14];
    let a41 = a[3]; let a42 = a[7]; let a43 = a[11]; let a44 = a[15];

    let b11 = b[0]; let b12 = b[4]; let b13 = b[8];  let b14 = b[12];
    let b21 = b[1]; let b22 = b[5]; let b23 = b[9];  let b24 = b[13];
    let b31 = b[2]; let b32 = b[6]; let b33 = b[10]; let b34 = b[14];
    let b41 = b[3]; let b42 = b[7]; let b43 = b[11]; let b44 = b[15];

    r[0]  = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    r[4]  = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    r[8]  = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    r[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

    r[1]  = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    r[5]  = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    r[9]  = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    r[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

    r[2]  = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    r[6]  = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    r[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    r[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

    r[3]  = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    r[7]  = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    r[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    r[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
    r
}

#[inline]
pub fn determinant(e: &[f32; 16]) -> f32 {
    // three.js's Matrix4.determinant — cofactor expansion along the first
    // row of the 4x4. Matches three.js exactly so test parity holds.
    let n11 = e[0]; let n12 = e[4]; let n13 = e[8];  let n14 = e[12];
    let n21 = e[1]; let n22 = e[5]; let n23 = e[9];  let n24 = e[13];
    let n31 = e[2]; let n32 = e[6]; let n33 = e[10]; let n34 = e[14];
    let n41 = e[3]; let n42 = e[7]; let n43 = e[11]; let n44 = e[15];

    n41 * (
        n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33
            + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34
    ) + n42 * (
        n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33
            - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31
    ) + n43 * (
        n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32
            + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31
    ) + n44 * (
        -n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33
            + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31
    )
}

/// Invert a 4x4 matrix, using three.js's source verbatim. If the matrix
/// is singular returns the zero matrix (matches three.js's behavior).
#[inline]
pub fn mat4_invert(me: &[f32; 16]) -> [f32; 16] {
    let n11 = me[0]; let n21 = me[1]; let n31 = me[2];  let n41 = me[3];
    let n12 = me[4]; let n22 = me[5]; let n32 = me[6];  let n42 = me[7];
    let n13 = me[8]; let n23 = me[9]; let n33 = me[10]; let n43 = me[11];
    let n14 = me[12]; let n24 = me[13]; let n34 = me[14]; let n44 = me[15];

    let t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43
        - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    let t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43
        + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    let t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43
        - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    let t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33
        + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

    let det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if det == 0.0 {
        return [0.0; 16];
    }
    let inv_det = 1.0 / det;
    let mut r = [0.0_f32; 16];
    r[0]  = t11 * inv_det;
    r[1]  = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43
        + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * inv_det;
    r[2]  = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42
        - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * inv_det;
    r[3]  = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42
        + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * inv_det;

    r[4]  = t12 * inv_det;
    r[5]  = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43
        - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * inv_det;
    r[6]  = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42
        + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * inv_det;
    r[7]  = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42
        - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * inv_det;

    r[8]  = t13 * inv_det;
    r[9]  = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43
        + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * inv_det;
    r[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42
        - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * inv_det;
    r[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42
        + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * inv_det;

    r[12] = t14 * inv_det;
    r[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33
        - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * inv_det;
    r[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32
        + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * inv_det;
    r[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32
        - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * inv_det;
    r
}

/// Compose a TRS matrix from position, rotation (quat), scale.
/// Direct port of three.js Matrix4.compose.
#[inline]
pub fn compose_matrix(px: f32, py: f32, pz: f32, q: Quaternion, sx: f32, sy: f32, sz: f32) -> [f32; 16] {
    let x = q.x; let y = q.y; let z = q.z; let w = q.w;
    let x2 = x + x;  let y2 = y + y;  let z2 = z + z;
    let xx = x * x2; let xy = x * y2; let xz = x * z2;
    let yy = y * y2; let yz = y * z2; let zz = z * z2;
    let wx = w * x2; let wy = w * y2; let wz = w * z2;

    [
        (1.0 - (yy + zz)) * sx, (xy + wz) * sx,        (xz - wy) * sx,        0.0,
        (xy - wz) * sy,         (1.0 - (xx + zz)) * sy, (yz + wx) * sy,        0.0,
        (xz + wy) * sz,         (yz - wx) * sz,         (1.0 - (xx + yy)) * sz, 0.0,
        px, py, pz, 1.0,
    ]
}

/// Decompose a TRS matrix into position, rotation, scale.
/// Direct port of three.js Matrix4.decompose.
#[inline]
pub fn decompose_matrix(te: &[f32; 16]) -> (f32, f32, f32, Quaternion, f32, f32, f32) {
    let mut sx = (te[0] * te[0] + te[1] * te[1] + te[2] * te[2]).sqrt();
    let sy = (te[4] * te[4] + te[5] * te[5] + te[6] * te[6]).sqrt();
    let sz = (te[8] * te[8] + te[9] * te[9] + te[10] * te[10]).sqrt();

    // If determinant is negative, flip first axis so the rotation matrix has det +1.
    let det = determinant(te);
    if det < 0.0 {
        sx = -sx;
    }

    let inv_sx = 1.0 / sx;
    let inv_sy = 1.0 / sy;
    let inv_sz = 1.0 / sz;

    // Build the rotation matrix as a fresh Mat4 and feed that to setFromRotationMatrix.
    let mut rot = [0.0_f32; 16];
    rot[0] = te[0] * inv_sx;
    rot[1] = te[1] * inv_sx;
    rot[2] = te[2] * inv_sx;
    rot[3] = 0.0;

    rot[4] = te[4] * inv_sy;
    rot[5] = te[5] * inv_sy;
    rot[6] = te[6] * inv_sy;
    rot[7] = 0.0;

    rot[8]  = te[8]  * inv_sz;
    rot[9]  = te[9]  * inv_sz;
    rot[10] = te[10] * inv_sz;
    rot[11] = 0.0;

    rot[12] = 0.0;
    rot[13] = 0.0;
    rot[14] = 0.0;
    rot[15] = 1.0;

    let q = Quaternion::from_rotation_matrix_elements(&rot);
    (te[12], te[13], te[14], q, sx, sy, sz)
}

/// three.js's Matrix4.lookAt — builds a basis from eye/target/up and
/// writes it into the rotation portion of the matrix while preserving the
/// existing translation column. Direct port of three.js's logic.
#[inline]
pub fn look_at(eye: &Vector3, target: &Vector3, up: &Vector3, current: &[f32; 16]) -> [f32; 16] {
    let zx = eye.x - target.x;
    let zy = eye.y - target.y;
    let zz = eye.z - target.z;
    let zlen_sq = zx * zx + zy * zy + zz * zz;
    let (zx, zy, zz) = if zlen_sq == 0.0 {
        // eye and target are at the same location — push forward by 1.
        (0.0, 0.0, 1.0)
    } else {
        let inv = 1.0 / zlen_sq.sqrt();
        (zx * inv, zy * inv, zz * inv)
    };

    // x = up.cross(z), normalize. If the cross is degenerate (up parallel
    // to z), nudge it. Three.js does the same nudge sequence.
    let mut xx = up.y * zz - up.z * zy;
    let mut xy = up.z * zx - up.x * zz;
    let mut xz = up.x * zy - up.y * zx;
    let mut xlen_sq = xx * xx + xy * xy + xz * xz;

    if xlen_sq == 0.0 {
        // try nudging z first
        let zz_n = if zz.abs() < 1e-6 { zz + 0.0001 } else { zz };
        let zx_n = if zx.abs() < 1e-6 { zx + 0.0001 } else { zx };
        xx = up.y * zz_n - up.z * zy;
        xy = up.z * zx_n - up.x * zz_n;
        xz = up.x * zy - up.y * zx_n;
        xlen_sq = xx * xx + xy * xy + xz * xz;
    }
    let inv = 1.0 / xlen_sq.sqrt();
    let xx = xx * inv;
    let xy = xy * inv;
    let xz = xz * inv;

    // y = z.cross(x)
    let yx = zy * xz - zz * xy;
    let yy = zz * xx - zx * xz;
    let yz = zx * xy - zy * xx;

    let mut e = *current;
    e[0] = xx; e[1] = xy; e[2] = xz;
    e[4] = yx; e[5] = yy; e[6] = yz;
    e[8] = zx; e[9] = zy; e[10] = zz;
    e
}
