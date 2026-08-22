// Shared helpers for carbon-image's rquickjs class implementations.
// Mirrors the pattern in carbon-fast-math/src/common.rs.

use rquickjs::{Ctx, Function, IntoJs, Object, Result, Value};

/// Install a read/write accessor (getter + setter) on `target`.
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

/// Install a read-only accessor (getter only) on `target`.
/// Attempting to set the property from JS is a no-op (strict mode would throw;
/// we don't enforce strict mode here — just silently ignore the write).
pub(crate) fn define_ro_accessor<'js, G>(
    ctx: &Ctx<'js>,
    target: &Object<'js>,
    name: &str,
    getter: G,
) -> Result<()>
where
    G: IntoJs<'js>,
{
    let object_ctor: Object<'js> = ctx.globals().get("Object")?;
    let define_property: Function<'js> = object_ctor.get("defineProperty")?;
    let descriptor = Object::new(ctx.clone())?;
    descriptor.set("get", getter)?;
    descriptor.set("configurable", true)?;
    descriptor.set("enumerable", true)?;
    // No "set" → property is effectively read-only.
    let _: Value<'js> = define_property.call((target.clone(), name.to_string(), descriptor))?;
    Ok(())
}
