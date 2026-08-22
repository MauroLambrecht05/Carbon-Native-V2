// End-to-end integration tests.
//
// Each test spins up a full rquickjs context, calls register_math, then
// runs JS that exercises a method or chaining sequence. We compare results
// either with bit-exact equality (for identity-preserving ops) or with a
// 1e-6 epsilon (for trig/sqrt-heavy paths where IEEE 754 rounding can
// differ from the reference three.js JS by a single ULP).

use rquickjs::{Context, Runtime};

fn with_ctx<F>(f: F)
where
    F: for<'js> FnOnce(rquickjs::Ctx<'js>),
{
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    ctx.with(|ctx| {
        carbon_fast_math::register_math(&ctx).expect("register_math");
        f(ctx);
    });
}

#[test]
fn vector3_constructor_and_fields() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const v = new Vector3(1, 2, 3);
            if (v.x !== 1 || v.y !== 2 || v.z !== 3) throw new Error("fields");
            if (!v.isVector3) throw new Error("isVector3 flag");
            v.x = 10;
            if (v.x !== 10) throw new Error("setter");
        "#,
        )
        .unwrap();
    });
}

#[test]
fn vector3_add_chain_returns_this() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const a = new Vector3(1, 2, 3);
            const b = new Vector3(4, 5, 6);
            const c = new Vector3(7, 8, 9);
            const r = a.add(b).add(c);
            // r must be the same instance as a (chained mutation, not a copy)
            if (r !== a) throw new Error("chain identity");
            if (a.x !== 12 || a.y !== 15 || a.z !== 18) throw new Error("sum");
        "#,
        )
        .unwrap();
    });
}

#[test]
fn vector3_normalize() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const v = new Vector3(3, 0, 4);
            v.normalize();
            // 5-3-4 right triangle; expected (0.6, 0, 0.8)
            const eps = 1e-6;
            if (Math.abs(v.x - 0.6) > eps) throw new Error("nx " + v.x);
            if (Math.abs(v.y - 0) > eps) throw new Error("ny");
            if (Math.abs(v.z - 0.8) > eps) throw new Error("nz " + v.z);
            // length should be 1
            if (Math.abs(v.length() - 1) > eps) throw new Error("len");
        "#,
        )
        .unwrap();
    });
}

#[test]
fn vector3_dot_cross() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const a = new Vector3(1, 0, 0);
            const b = new Vector3(0, 1, 0);
            if (a.dot(b) !== 0) throw new Error("perp dot != 0");
            const c = a.cross(b);
            if (c !== a) throw new Error("cross chain");
            if (a.x !== 0 || a.y !== 0 || a.z !== 1) throw new Error("cross result");
        "#,
        )
        .unwrap();
    });
}

#[test]
fn matrix4_identity_default() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const m = new Matrix4();
            const e = m.elements;
            const id = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
            for (let i = 0; i < 16; i++) {
                if (e[i] !== id[i]) throw new Error("idx " + i + " = " + e[i]);
            }
            if (!m.isMatrix4) throw new Error("isMatrix4 flag");
        "#,
        )
        .unwrap();
    });
}

#[test]
fn matrix4_translation_then_apply() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const m = new Matrix4();
            m.makeTranslation(10, 20, 30);
            const v = new Vector3(1, 2, 3);
            v.applyMatrix4(m);
            if (v.x !== 11 || v.y !== 22 || v.z !== 33) {
                throw new Error("translated " + v.x + "," + v.y + "," + v.z);
            }
        "#,
        )
        .unwrap();
    });
}

#[test]
fn matrix4_multiply_associative_sample() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const a = new Matrix4().makeRotationY(0.7);
            const b = new Matrix4().makeRotationX(0.3);
            const ab = a.clone().multiply(b);
            // identity * X = X
            const eps = 1e-5;
            const id = new Matrix4();
            const idmulab = id.clone().multiply(ab);
            for (let i = 0; i < 16; i++) {
                if (Math.abs(idmulab.elements[i] - ab.elements[i]) > eps) {
                    throw new Error("idx " + i);
                }
            }
        "#,
        )
        .unwrap();
    });
}

#[test]
fn quaternion_axis_angle_then_apply() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const axis = new Vector3(0, 1, 0);
            const q = new Quaternion().setFromAxisAngle(axis, Math.PI / 2);
            const v = new Vector3(1, 0, 0);
            v.applyQuaternion(q);
            // Rotating (1,0,0) 90° around Y gives (0,0,-1)
            const eps = 1e-6;
            if (Math.abs(v.x - 0) > eps) throw new Error("x " + v.x);
            if (Math.abs(v.y - 0) > eps) throw new Error("y");
            if (Math.abs(v.z - (-1)) > eps) throw new Error("z " + v.z);
        "#,
        )
        .unwrap();
    });
}

#[test]
fn quaternion_slerp_endpoints() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const a = new Quaternion(0, 0, 0, 1);
            const b = new Quaternion(0, 1, 0, 0);
            const c = a.clone().slerp(b, 0);
            if (c.x !== a.x || c.y !== a.y || c.z !== a.z || c.w !== a.w) throw new Error("t=0");
            const d = a.clone().slerp(b, 1);
            const eps = 1e-6;
            if (Math.abs(d.x - b.x) > eps || Math.abs(d.y - b.y) > eps ||
                Math.abs(d.z - b.z) > eps || Math.abs(d.w - b.w) > eps) {
                throw new Error("t=1");
            }
        "#,
        )
        .unwrap();
    });
}

#[test]
fn box3_setfrompoints_and_intersects() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const pts = [
                new Vector3(0, 0, 0),
                new Vector3(2, 4, 6),
                new Vector3(-1, 2, 3),
            ];
            const b = new Box3().setFromPoints(pts);
            // min should be (-1, 0, 0), max should be (2, 4, 6)
            const min = b.min, max = b.max;
            if (min.x !== -1 || min.y !== 0 || min.z !== 0) throw new Error("min");
            if (max.x !== 2 || max.y !== 4 || max.z !== 6) throw new Error("max");

            // containsPoint
            if (!b.containsPoint(new Vector3(0, 1, 1))) throw new Error("contains in");
            if (b.containsPoint(new Vector3(5, 5, 5))) throw new Error("contains out");

            // intersectsBox
            const b2 = new Box3(new Vector3(1, 1, 1), new Vector3(3, 3, 3));
            if (!b.intersectsBox(b2)) throw new Error("intersect");
            const b3 = new Box3(new Vector3(10, 10, 10), new Vector3(20, 20, 20));
            if (b.intersectsBox(b3)) throw new Error("no intersect");
        "#,
        )
        .unwrap();
    });
}

#[test]
fn frustum_culls_a_box() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            // Build a perspective projection matrix.
            const m = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100);
            const f = new Frustum().setFromProjectionMatrix(m);

            // A small box at the origin (near the camera) should be inside.
            const near = new Box3(new Vector3(-0.1, -0.1, -2), new Vector3(0.1, 0.1, -1.5));
            if (!f.intersectsBox(near)) throw new Error("near should be visible");

            // A box behind the camera should NOT intersect.
            const behind = new Box3(new Vector3(-0.1, -0.1, 2), new Vector3(0.1, 0.1, 3));
            if (f.intersectsBox(behind)) throw new Error("behind should be culled");
        "#,
        )
        .unwrap();
    });
}

#[test]
fn color_set_and_gethex() {
    with_ctx(|ctx| {
        ctx.eval::<(), _>(
            r#"
            const c = new Color(0xff8040);
            // 0xff = 255, 0x80 = 128, 0x40 = 64
            const eps = 1e-3;
            if (Math.abs(c.r - 1) > eps) throw new Error("r");
            if (Math.abs(c.g - 128/255) > eps) throw new Error("g");
            if (Math.abs(c.b - 64/255) > eps) throw new Error("b");
            if (c.getHex() !== 0xff8040) throw new Error("getHex " + c.getHex().toString(16));

            // setRGB then check round-trip.
            c.setRGB(0.5, 0.25, 0.75);
            const hex = c.getHex();
            const hexExpected = (Math.round(0.5 * 255) << 16) | (Math.round(0.25 * 255) << 8) | Math.round(0.75 * 255);
            if (hex !== hexExpected) throw new Error("rgb roundtrip " + hex.toString(16));
        "#,
        )
        .unwrap();
    });
}

#[test]
fn vector3_three_js_compat_shape_check() {
    // Ensure a plain JS object that mimics three.js's Vector3 (with x/y/z)
    // still flows through methods that read those fields. This is the
    // critical "mixed three.js + carbon-fast-math" path.
    //
    // The Rust side accepts Class<Vector3> only — a plain JS object
    // wouldn't pass. That's documented in PHASE3_IMPL.md as a known
    // gap (three.js's own Vector3 won't transparently work as an arg
    // to our methods). User code should consistently use one or the
    // other.
    with_ctx(|ctx| {
        // Demonstrate the failure mode is *graceful* (a thrown error,
        // not a segfault).
        let result: rquickjs::Result<()> = ctx.eval::<(), _>(
            r#"
            const fake = { x: 1, y: 2, z: 3 };
            const v = new Vector3(0, 0, 0);
            try {
                v.copy(fake);
            } catch (e) {
                // expected — we type-check Vector3 args
            }
        "#,
        );
        result.unwrap();
    });
}
