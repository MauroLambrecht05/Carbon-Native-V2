# carbon-fast-math

Drop-in three.js math classes (`Vector3`, `Matrix4`, `Quaternion`,
`Box3`, `Frustum`, `Color`) implemented in Rust and exposed to QuickJS
via rquickjs. Each class mirrors three.js's API exactly -- method names,
mutation semantics, `is*` flags, default arguments -- so existing code
that constructs and operates on math types keeps working unchanged.

## Why

Under QuickJS the JS execution model is interpreter-only -- no JIT, no
inline caching, every property access is a hash lookup. Three.js's
math classes are called millions of times per frame in non-trivial 3D
apps. Re-implementing them in Rust closes most of the JIT gap.

Real bench numbers (1M iterations, median of 5 samples, in QuickJS):

| Op | JS three.js-like | Rust | speedup |
|---|---:|---:|---:|
| `Matrix4.multiply` | 3,389 ms | 232 ms | 14.6x |
| `Vector3.applyMatrix4` | 982 ms | 223 ms | 4.4x |
| `Quaternion.slerp` | 645 ms | 237 ms | 2.7x |
| `Vector3.normalize` | 743 ms | 372 ms | 2.0x |

(See `docs/history/PHASE3_BENCH.md` in the carbon-native repo for the rest.)

## Usage

### From a Rust host (e.g. carbon-mini)

```rust
use rquickjs::{Context, Runtime};

let rt = Runtime::new()?;
let ctx = Context::full(&rt)?;
ctx.with(|ctx| {
    carbon_fast_math::register_math(&ctx)?;
    // Now `Vector3`, `Matrix4`, etc. are JS globals.
    Ok(())
})?;
```

### From a JS app

```js
import { Vector3, Matrix4 } from "carbon-fast-math";

const v = new Vector3(1, 2, 3);
v.normalize().multiplyScalar(10);

const m = new Matrix4().makeRotationY(Math.PI / 4);
v.applyMatrix4(m);
```

### Auto-rewriting `import { Vector3 } from "three"`

Use the companion Vite plugin `@carbon/vite-fast-import`:

```js
// vite.config.ts
import { carbonFastImport } from "@carbon/vite-fast-import";
export default {
  plugins: [carbonFastImport()],
};
```

Now any `import { Vector3 } from "three"` in your app is rewritten at
build time to `import { Vector3 } from "carbon-fast-math"`. Three.js's
own internal modules are left alone -- they continue using three's own
JS math classes for their internal cross-references.

## API surface

The full coverage list (and gaps) is in `docs/history/PHASE3_IMPL.md`. The short
version: every method that's commonly called in three.js user code is
implemented. Niche methods (`applyMatrix3`, `setFromSpherical`, named
CSS color strings) are intentionally skipped -- the binary stays small,
and apps that need them can fall back to three.js's own classes.

## Type compatibility with three.js

Our classes set the same `is*` flag properties (`isVector3`,
`isMatrix4`, ...) that three.js uses for its internal duck-typing. They
expose the same field names with the same f32 storage. So a
carbon-fast-math `Vector3` can be passed back into three.js APIs that
read `.x/.y/.z` (e.g. `mesh.position.copy(myFastVec)`) and work
correctly.

The reverse is **not** symmetric: passing a three.js `Vector3` into a
carbon-fast-math method (`fastVec.copy(threeVec)`) will throw because
we type-check arguments via the rquickjs class system. Stick to one
or the other for any given hot path.

## Building

```bash
cd carbon/runtime/features/math
cargo build --release
cargo test --release           # 13 integration tests
cargo run --release --bin bench_runner   # benchmarks
```

The crate is also pulled in as a path dependency by `runtime/mini/native`,
so `cargo build` in that runtime picks it up automatically.
