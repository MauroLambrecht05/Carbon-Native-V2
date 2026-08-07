// Shared helpers used by every math class.

use rquickjs::{Ctx, Function, IntoJs, Object, Result, Value};

/// Install an accessor (getter/setter) property on `target` using
/// `Object.defineProperty(target, name, { get, set, configurable: true })`.
///
/// Why we need this: the Rust state for our classes lives behind an opaque
/// pointer that's accessible only from within `This<Class<C>>`. Plain data
/// properties on JS instances would require hand-rolling a layout that
/// rquickjs doesn't expose. Accessor properties on the *prototype* let us
/// give `v.x = 5` and `v.x` the right semantics with one set of code paths.
///
/// We accept the getter/setter as already-built `Function`s (rather than
/// raw closures) so each call site can pick its own argument tuple — the
/// trait-bound gymnastics of accepting `IntoJsFunc` here would be worse
/// than the convention "build the Func at the call site".
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
