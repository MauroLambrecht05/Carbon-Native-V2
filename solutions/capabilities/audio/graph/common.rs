// common.rs — shared helpers used by every audio class.
//
// This mirrors carbon/runtime/features/math/src/common.rs exactly.

use rquickjs::{Ctx, Function, IntoJs, Object, Result, Value};

/// Install an accessor (getter/setter) property on `target` using
/// `Object.defineProperty`. This is the only way to bind Rust-side state
/// to JS getter/setter semantics with rquickjs.
pub(crate) fn define_accessor<'js, G, S>(
    ctx: &Ctx<'js>,
    target: &Object<'js>,
    name: &str,
    getter: G,
    setter: S,
) -> Result<()>
where
    G: IntoJs<'js>,
    S: IntoJs<'js>,
{
    let object_ctor: Object<'js> = ctx.globals().get("Object")?;
    let define_property: Function<'js> = object_ctor.get("defineProperty")?;
    let descriptor = Object::new(ctx.clone())?;
    descriptor.set("get", getter)?;
    descriptor.set("set", setter)?;
    descriptor.set("configurable", true)?;
    let _: Value<'js> = define_property.call((target.clone(), name.to_string(), descriptor))?;
    Ok(())
}
