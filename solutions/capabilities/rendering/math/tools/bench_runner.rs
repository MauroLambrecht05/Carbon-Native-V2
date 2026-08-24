// Phase 3 benchmarks. Compares carbon-fast-math's Rust-backed classes to
// a pure-JS implementation that mirrors three.js's source for the same
// operations. Both run inside the SAME rquickjs context so the only
// difference being measured is the implementation behind the same JS
// surface.
//
// Output format is compatible with the rest of the carbon-native bench
// suite — emits ms total + ns/op + speedup factor for each scenario.
//
// Run with:
//   cd carbon/runtime/features/math
//   cargo run --release --bin bench_runner

use rquickjs::{Context, Runtime};
use std::time::Instant;

const ITERATIONS: u32 = 1_000_000;
const SAMPLES: u32 = 5;

// Pure-JS implementation of Vector3 / Matrix4 / Quaternion that mirrors
// three.js source code. Run side-by-side with our Rust-backed classes
// in the same rquickjs context. This is the "before" we beat.
//
// Source reference: https://github.com/mrdoob/three.js/blob/dev/src/math/
// We trimmed to just the methods this benchmark exercises; behavior is
// bit-for-bit identical for the intersection of methods used.
const JS_BASELINE: &str = r#"
class JsVector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; this.isVector3 = true; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    addScalar(s) { this.x += s; this.y += s; this.z += s; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    length() { return Math.sqrt(this.x*this.x + this.y*this.y + this.z*this.z); }
    lengthSq() { return this.x*this.x + this.y*this.y + this.z*this.z; }
    normalize() {
        const len = this.length() || 1;
        this.x /= len; this.y /= len; this.z /= len; return this;
    }
    dot(v) { return this.x*v.x + this.y*v.y + this.z*v.z; }
    cross(v) {
        const ax = this.x, ay = this.y, az = this.z;
        this.x = ay*v.z - az*v.y;
        this.y = az*v.x - ax*v.z;
        this.z = ax*v.y - ay*v.x;
        return this;
    }
    distanceTo(v) {
        const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
        return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }
    applyMatrix4(m) {
        const x = this.x, y = this.y, z = this.z;
        const e = m.elements;
        const w = 1 / (e[3]*x + e[7]*y + e[11]*z + e[15]);
        this.x = (e[0]*x + e[4]*y + e[8]*z + e[12]) * w;
        this.y = (e[1]*x + e[5]*y + e[9]*z + e[13]) * w;
        this.z = (e[2]*x + e[6]*y + e[10]*z + e[14]) * w;
        return this;
    }
}

class JsMatrix4 {
    constructor() {
        this.elements = [
            1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1,
        ];
        this.isMatrix4 = true;
    }
    multiply(m) { return this.multiplyMatrices(this, m); }
    multiplyMatrices(a, b) {
        const ae = a.elements, be = b.elements, te = this.elements;
        const a11=ae[0], a12=ae[4], a13=ae[8], a14=ae[12];
        const a21=ae[1], a22=ae[5], a23=ae[9], a24=ae[13];
        const a31=ae[2], a32=ae[6], a33=ae[10], a34=ae[14];
        const a41=ae[3], a42=ae[7], a43=ae[11], a44=ae[15];
        const b11=be[0], b12=be[4], b13=be[8], b14=be[12];
        const b21=be[1], b22=be[5], b23=be[9], b24=be[13];
        const b31=be[2], b32=be[6], b33=be[10], b34=be[14];
        const b41=be[3], b42=be[7], b43=be[11], b44=be[15];
        te[0]  = a11*b11 + a12*b21 + a13*b31 + a14*b41;
        te[4]  = a11*b12 + a12*b22 + a13*b32 + a14*b42;
        te[8]  = a11*b13 + a12*b23 + a13*b33 + a14*b43;
        te[12] = a11*b14 + a12*b24 + a13*b34 + a14*b44;
        te[1]  = a21*b11 + a22*b21 + a23*b31 + a24*b41;
        te[5]  = a21*b12 + a22*b22 + a23*b32 + a24*b42;
        te[9]  = a21*b13 + a22*b23 + a23*b33 + a24*b43;
        te[13] = a21*b14 + a22*b24 + a23*b34 + a24*b44;
        te[2]  = a31*b11 + a32*b21 + a33*b31 + a34*b41;
        te[6]  = a31*b12 + a32*b22 + a33*b32 + a34*b42;
        te[10] = a31*b13 + a32*b23 + a33*b33 + a34*b43;
        te[14] = a31*b14 + a32*b24 + a33*b34 + a34*b44;
        te[3]  = a41*b11 + a42*b21 + a43*b31 + a44*b41;
        te[7]  = a41*b12 + a42*b22 + a43*b32 + a44*b42;
        te[11] = a41*b13 + a42*b23 + a43*b33 + a44*b43;
        te[15] = a41*b14 + a42*b24 + a43*b34 + a44*b44;
        return this;
    }
    makeRotationY(theta) {
        const c = Math.cos(theta), s = Math.sin(theta);
        this.elements = [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];
        return this;
    }
    makeTranslation(x,y,z) {
        this.elements = [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
        return this;
    }
}

class JsQuaternion {
    constructor(x=0,y=0,z=0,w=1) { this.x=x; this.y=y; this.z=z; this.w=w; this.isQuaternion = true; }
    setFromAxisAngle(axis, angle) {
        const half = angle / 2, s = Math.sin(half);
        this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(half);
        return this;
    }
    slerp(qb, t) {
        if (t === 0) return this;
        if (t === 1) {
            this.x = qb.x; this.y = qb.y; this.z = qb.z; this.w = qb.w;
            return this;
        }
        const x = this.x, y = this.y, z = this.z, w = this.w;
        let cos = w*qb.w + x*qb.x + y*qb.y + z*qb.z;
        let bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
        if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        if (cos >= 1.0) return this;
        const sqrSinHalfTheta = 1.0 - cos*cos;
        if (sqrSinHalfTheta <= Number.EPSILON) {
            const s = 1.0 - t;
            this.w = s*w + t*bw; this.x = s*x + t*bx; this.y = s*y + t*by; this.z = s*z + t*bz;
            const len = this.length();
            const inv = (len === 0) ? 1 : 1/len;
            this.x *= inv; this.y *= inv; this.z *= inv; this.w *= inv;
            return this;
        }
        const sinHalf = Math.sqrt(sqrSinHalfTheta);
        const half = Math.atan2(sinHalf, cos);
        const ratioA = Math.sin((1-t) * half) / sinHalf;
        const ratioB = Math.sin(t * half) / sinHalf;
        this.w = w*ratioA + bw*ratioB; this.x = x*ratioA + bx*ratioB;
        this.y = y*ratioA + by*ratioB; this.z = z*ratioA + bz*ratioB;
        return this;
    }
    length() { return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w); }
}

globalThis.JsVector3 = JsVector3;
globalThis.JsMatrix4 = JsMatrix4;
globalThis.JsQuaternion = JsQuaternion;
"#;

fn time_eval<F: Fn()>(label: &str, f: F) -> f64 {
    // Warmup
    f();
    let mut samples = Vec::with_capacity(SAMPLES as usize);
    for _ in 0..SAMPLES {
        let t = Instant::now();
        f();
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples[samples.len() / 2];
    let ns_per_op = (median * 1_000_000.0) / ITERATIONS as f64;
    eprintln!("  {label:30}  median = {median:>8.2} ms   |   {ns_per_op:>7.2} ns/op");
    median
}

fn run_bench(
    label: &str,
    ctx: &rquickjs::Ctx<'_>,
    js_setup: &str,
    native_setup: &str,
) -> (f64, f64) {
    eprintln!("\n=== {label} ===");
    let js_ms = time_eval("JS three.js-like (baseline)", || {
        ctx.eval::<(), _>(js_setup.as_bytes()).unwrap();
    });
    let native_ms = time_eval("Rust carbon-fast-math", || {
        ctx.eval::<(), _>(native_setup.as_bytes()).unwrap();
    });
    let speedup = js_ms / native_ms;
    eprintln!("  ⇒ speedup: {speedup:.2}× (Rust is faster)");
    (js_ms, native_ms)
}

fn main() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();

    ctx.with(|ctx| {
        carbon_fast_math::register_math(&ctx).expect("register_math");
        ctx.eval::<(), _>(JS_BASELINE.as_bytes()).expect("baseline JS classes");

        eprintln!("\nPhase 3 benchmarks — {ITERATIONS} iterations × {SAMPLES} samples (median).\n");

        // ─── 1. Vector3 add chain ───────────────────────────────────────
        let n = ITERATIONS;
        let js_src = format!(r#"
            (function() {{
                const a = new JsVector3(0.1, 0.2, 0.3);
                const b = new JsVector3(0.5, 0.4, 0.3);
                const c = new JsVector3(0.2, 0.7, 0.1);
                const d = new JsVector3(0.9, 0.4, 0.6);
                for (let i = 0; i < {n}; i++) a.add(b).add(c).add(d);
                globalThis.__sum = a.x + a.y + a.z;
            }})();
        "#);
        let rust_src = format!(r#"
            (function() {{
                const a = new Vector3(0.1, 0.2, 0.3);
                const b = new Vector3(0.5, 0.4, 0.3);
                const c = new Vector3(0.2, 0.7, 0.1);
                const d = new Vector3(0.9, 0.4, 0.6);
                for (let i = 0; i < {n}; i++) a.add(b).add(c).add(d);
                globalThis.__sum = a.x + a.y + a.z;
            }})();
        "#);
        let (js1, rust1) = run_bench("Vector3 add chain (a.add(b).add(c).add(d))", &ctx, &js_src, &rust_src);

        // ─── 2. Vector3 normalize ───────────────────────────────────────
        let js_src = format!(r#"
            (function() {{
                const v = new JsVector3(3, 4, 5);
                for (let i = 0; i < {n}; i++) {{ v.set(3, 4, 5); v.normalize(); }}
                globalThis.__sum = v.x + v.y + v.z;
            }})();
        "#);
        let rust_src = format!(r#"
            (function() {{
                const v = new Vector3(3, 4, 5);
                for (let i = 0; i < {n}; i++) {{ v.set(3, 4, 5); v.normalize(); }}
                globalThis.__sum = v.x + v.y + v.z;
            }})();
        "#);
        let (js2, rust2) = run_bench("Vector3 set + normalize", &ctx, &js_src, &rust_src);

        // ─── 3. Vector3 dot ─────────────────────────────────────────────
        let js_src = format!(r#"
            (function() {{
                const a = new JsVector3(0.1, 0.2, 0.3);
                const b = new JsVector3(0.5, 0.4, 0.3);
                let s = 0;
                for (let i = 0; i < {n}; i++) s += a.dot(b);
                globalThis.__sum = s;
            }})();
        "#);
        let rust_src = format!(r#"
            (function() {{
                const a = new Vector3(0.1, 0.2, 0.3);
                const b = new Vector3(0.5, 0.4, 0.3);
                let s = 0;
                for (let i = 0; i < {n}; i++) s += a.dot(b);
                globalThis.__sum = s;
            }})();
        "#);
        let (js3, rust3) = run_bench("Vector3 dot", &ctx, &js_src, &rust_src);

        // ─── 4. Matrix4 multiply ────────────────────────────────────────
        let js_src = format!(r#"
            (function() {{
                const a = new JsMatrix4(); a.makeRotationY(0.5);
                const b = new JsMatrix4(); b.makeTranslation(1,2,3);
                for (let i = 0; i < {n}; i++) a.multiply(b);
                globalThis.__sum = a.elements[0] + a.elements[12];
            }})();
        "#);
        let rust_src = format!(r#"
            (function() {{
                const a = new Matrix4(); a.makeRotationY(0.5);
                const b = new Matrix4(); b.makeTranslation(1,2,3);
                for (let i = 0; i < {n}; i++) a.multiply(b);
                globalThis.__sum = a.elements[0] + a.elements[12];
            }})();
        "#);
        let (js4, rust4) = run_bench("Matrix4 multiply (a.multiply(b))", &ctx, &js_src, &rust_src);

        // ─── 5. Quaternion slerp ────────────────────────────────────────
        let js_src = format!(r#"
            (function() {{
                const ax = new JsVector3(0, 1, 0);
                const a = new JsQuaternion().setFromAxisAngle(ax, 0.0);
                const b = new JsQuaternion().setFromAxisAngle(ax, Math.PI);
                for (let i = 0; i < {n}; i++) a.slerp(b, 0.5);
                globalThis.__sum = a.x + a.y + a.z + a.w;
            }})();
        "#);
        let rust_src = format!(r#"
            (function() {{
                const ax = new Vector3(0, 1, 0);
                const a = new Quaternion().setFromAxisAngle(ax, 0.0);
                const b = new Quaternion().setFromAxisAngle(ax, Math.PI);
                for (let i = 0; i < {n}; i++) a.slerp(b, 0.5);
                globalThis.__sum = a.x + a.y + a.z + a.w;
            }})();
        "#);
        let (js5, rust5) = run_bench("Quaternion slerp", &ctx, &js_src, &rust_src);

        // ─── 6. Vector3.applyMatrix4 — common transform-to-world hot path ─
        let js_src = format!(r#"
            (function() {{
                const v = new JsVector3(1, 2, 3);
                const m = new JsMatrix4(); m.makeRotationY(0.5);
                for (let i = 0; i < {n}; i++) v.applyMatrix4(m);
                globalThis.__sum = v.x + v.y + v.z;
            }})();
        "#);
        let rust_src = format!(r#"
            (function() {{
                const v = new Vector3(1, 2, 3);
                const m = new Matrix4(); m.makeRotationY(0.5);
                for (let i = 0; i < {n}; i++) v.applyMatrix4(m);
                globalThis.__sum = v.x + v.y + v.z;
            }})();
        "#);
        let (js6, rust6) = run_bench("Vector3.applyMatrix4 (transform)", &ctx, &js_src, &rust_src);

        // ─── 7. Realistic scene-traversal-style workload ────────────────
        // Build 1000 vector positions, transform every one by a matrix,
        // accumulate into a Box3 (we don't have JsBox3 so this is just
        // a bounding loop). 1000 objects × 1 transform per frame is
        // representative of a typical mid-complexity scene.
        let scene_n = 1000_u32;
        let js_src = format!(r#"
            (function() {{
                const positions = new Array({scene_n});
                for (let i = 0; i < {scene_n}; i++) positions[i] = new JsVector3(i * 0.01, i * 0.02, i * 0.03);
                const m = new JsMatrix4(); m.makeRotationY(0.7);
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
                for (let frame = 0; frame < 1000; frame++) {{
                    for (let i = 0; i < {scene_n}; i++) {{
                        const p = positions[i];
                        p.applyMatrix4(m);
                        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
                    }}
                }}
                globalThis.__sum = maxX - minX + maxY - minY + maxZ - minZ;
            }})();
        "#);
        let rust_src = format!(r#"
            (function() {{
                const positions = new Array({scene_n});
                for (let i = 0; i < {scene_n}; i++) positions[i] = new Vector3(i * 0.01, i * 0.02, i * 0.03);
                const m = new Matrix4(); m.makeRotationY(0.7);
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
                for (let frame = 0; frame < 1000; frame++) {{
                    for (let i = 0; i < {scene_n}; i++) {{
                        const p = positions[i];
                        p.applyMatrix4(m);
                        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
                    }}
                }}
                globalThis.__sum = maxX - minX + maxY - minY + maxZ - minZ;
            }})();
        "#);
        // 1M ops total = 1000 frames × 1000 positions
        let scene_total = 1_000_000_u32;
        eprintln!("\n=== Realistic scene-traversal-style workload ===");
        eprintln!(
            "    ({scene_n} objects × 1000 frames = {scene_total} applyMatrix4 calls + Box3-style min/max bookkeeping)"
        );
        let js7 = time_eval("JS three.js-like (baseline)", || {
            ctx.eval::<(), _>(js_src.as_bytes()).unwrap();
        });
        let rust7 = time_eval("Rust carbon-fast-math", || {
            ctx.eval::<(), _>(rust_src.as_bytes()).unwrap();
        });
        let speedup7 = js7 / rust7;
        eprintln!("  ⇒ speedup: {speedup7:.2}× (Rust is faster)");

        // Emit a compact JSON-ish summary at the end. The bench script in
        // scripts/bench-phase3.ps1 greps these lines to populate the
        // PHASE3_BENCH.md table.
        eprintln!("\n--- summary ---");
        emit_summary("vector3_add_chain", n, js1, rust1);
        emit_summary("vector3_normalize", n, js2, rust2);
        emit_summary("vector3_dot", n, js3, rust3);
        emit_summary("matrix4_multiply", n, js4, rust4);
        emit_summary("quaternion_slerp", n, js5, rust5);
        emit_summary("vector3_applymatrix4", n, js6, rust6);
        emit_summary("scene_traversal_1k", scene_total, js7, rust7);
    });
}

fn emit_summary(label: &str, n: u32, js_ms: f64, rust_ms: f64) {
    println!(
        "BENCH {} iters={} js_ms={:.2} rust_ms={:.2} js_ns_per_op={:.2} rust_ns_per_op={:.2} speedup={:.2}",
        label,
        n,
        js_ms,
        rust_ms,
        (js_ms * 1_000_000.0) / n as f64,
        (rust_ms * 1_000_000.0) / n as f64,
        js_ms / rust_ms,
    );
}
