// carbon-fast-math — three.js math API, implemented in Rust, exposed to
// QuickJS via rquickjs's class macros.
//
// Goals:
//   1. API parity with three.js. Method names (camelCase), mutation
//      semantics (most methods mutate `this` and return `this` so user
//      code's `a.add(b).normalize()` chains work), and the `is*` flag
//      properties three.js uses for runtime type checks all match.
//   2. Speed. Under QuickJS, calling `Vector3.add` in JS is ~20× slower
//      than V8 because the engine does no JIT and walks every property
//      access through a hash table. Doing the math in Rust collapses the
//      cost of each operation into a single FFI call.
//   3. Type-compat with three.js's own Vector3. Three.js never asks "is
//      this object a Vector3 by class identity"; instead it checks
//      `obj.isVector3 === true` and reads `.x/.y/.z` directly. We expose
//      both, so passing one of our Vector3s into `mesh.position.copy(v)`
//      works without modification.
//
// Layout note: under glam, Vec3 is plain [f32; 3] (no padding). That's the
// same shape three.js uses internally, so there's never a need to copy.
// Mat4 is column-major 4x4 of f32 — also identical to three.js
// (matrix.elements is a column-major Float32Array(16)).

use rquickjs::{Class, Ctx, Result};

// ── Layout ──────────────────────────────────────────────────────────────────
// The types live under domain/ because that is what they are: the model, with
// no I/O and no knowledge of who calls them. The `#[path]` attributes keep the
// module names exactly as they were, so `carbon_fast_math::vector3::Vector3`
// still resolves and nothing downstream had to change when the files moved.
//
// Without them, `pub mod vector3;` would look for vector3.rs beside this file
// and the crate would not compile — Rust resolves modules by filesystem
// position, which is the one thing a restructure changes.
#[path = "domain/box3.rs"]
pub mod box3;
#[path = "domain/color.rs"]
pub mod color;
#[path = "domain/common.rs"]
mod common;
#[path = "domain/frustum.rs"]
pub mod frustum;
#[path = "domain/matrix4.rs"]
pub mod matrix4;
#[path = "domain/quaternion.rs"]
pub mod quaternion;
#[path = "domain/vector3.rs"]
pub mod vector3;

pub use box3::Box3;
pub use color::Color;
pub use frustum::Frustum;
pub use matrix4::Matrix4;
pub use quaternion::Quaternion;
pub use vector3::Vector3;

/// Register every fast-math class onto the given QuickJS context's globals.
///
/// Backends opt-in by calling this at startup. The result is that user JS
/// can then write `new Vector3(1,2,3)` directly, and three.js types in user
/// code (when shipped through the carbon-fast-import Vite plugin) resolve
/// to these implementations.
///
/// We do not auto-register — keeping it explicit means a host that doesn't
/// want the math classes (e.g. a UI-only app) doesn't pay the prototype
/// allocation cost (~6 prototypes × a handful of methods each).
pub fn register_math(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();
    Class::<Vector3>::define(&globals)?;
    Class::<Matrix4>::define(&globals)?;
    Class::<Quaternion>::define(&globals)?;
    Class::<Box3>::define(&globals)?;
    Class::<Frustum>::define(&globals)?;
    Class::<Color>::define(&globals)?;
    Ok(())
}
