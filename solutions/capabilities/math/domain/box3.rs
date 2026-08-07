// Box3 — three.js axis-aligned bounding box. Two Vector3 corners (min, max).

use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, Opt, This},
    Class, Ctx, IntoJs, JsLifetime, Object, Result, Value,
};

use crate::vector3::Vector3;

#[derive(Clone, Copy, Debug)]
pub struct Box3 {
    pub min: Vector3,
    pub max: Vector3,
}

impl Default for Box3 {
    fn default() -> Self {
        Self::empty()
    }
}

impl Box3 {
    pub fn empty() -> Self {
        Self {
            min: Vector3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY),
            max: Vector3::new(-f32::INFINITY, -f32::INFINITY, -f32::INFINITY),
        }
    }
}

unsafe impl<'js> JsLifetime<'js> for Box3 {
    type Changed<'to> = Box3;
}

impl<'js> Trace<'js> for Box3 {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for Box3 {
    const NAME: &'static str = "Box3";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;
        proto.set("isBox3", true)?;

        // min/max accessors. Each call returns a *fresh* Class<Vector3>
        // wrapping a copy of the stored corner. Mutations through the
        // returned vector won't propagate back — three.js stores actual
        // Vector3 references, so this is a small parity gap (documented
        // in PHASE3_IMPL.md). Hot paths (intersectsBox / containsPoint)
        // don't need that anyway.
        crate::common::define_accessor(
            ctx,
            &proto,
            "min",
            Func::from(|ctx: Ctx<'js>, this: This<Class<'js, Box3>>| -> Result<Class<'js, Vector3>> {
                let m = this.borrow().min;
                Class::instance(ctx, m)
            }),
            Func::from(|this: This<Class<'js, Box3>>, v: Class<'js, Vector3>| {
                let nv = *v.borrow();
                this.borrow_mut().min = nv;
            }),
        )?;
        crate::common::define_accessor(
            ctx,
            &proto,
            "max",
            Func::from(|ctx: Ctx<'js>, this: This<Class<'js, Box3>>| -> Result<Class<'js, Vector3>> {
                let m = this.borrow().max;
                Class::instance(ctx, m)
            }),
            Func::from(|this: This<Class<'js, Box3>>, v: Class<'js, Vector3>| {
                let nv = *v.borrow();
                this.borrow_mut().max = nv;
            }),
        )?;

        proto.set(
            "set",
            Func::from(
                |this: This<Class<'js, Box3>>,
                 min: Class<'js, Vector3>,
                 max: Class<'js, Vector3>|
                 -> Class<'js, Box3> {
                    {
                        let mn = *min.borrow();
                        let mx = *max.borrow();
                        let mut b = this.borrow_mut();
                        b.min = mn;
                        b.max = mx;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "makeEmpty",
            Func::from(|this: This<Class<'js, Box3>>| -> Class<'js, Box3> {
                *this.borrow_mut() = Box3::empty();
                this.0.clone()
            }),
        )?;

        proto.set(
            "isEmpty",
            Func::from(|this: This<Class<'js, Box3>>| -> bool {
                let b = this.borrow();
                b.max.x < b.min.x || b.max.y < b.min.y || b.max.z < b.min.z
            }),
        )?;

        proto.set(
            "copy",
            Func::from(
                |this: This<Class<'js, Box3>>, other: Class<'js, Box3>| -> Class<'js, Box3> {
                    {
                        let o = *other.borrow();
                        *this.borrow_mut() = o;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "clone",
            Func::from(|ctx: Ctx<'js>, this: This<Class<'js, Box3>>| -> Result<Class<'js, Box3>> {
                let b = *this.borrow();
                Class::instance(ctx, b)
            }),
        )?;

        proto.set(
            "expandByPoint",
            Func::from(
                |this: This<Class<'js, Box3>>, pt: Class<'js, Vector3>| -> Class<'js, Box3> {
                    {
                        let p = *pt.borrow();
                        let mut b = this.borrow_mut();
                        b.min.x = b.min.x.min(p.x);
                        b.min.y = b.min.y.min(p.y);
                        b.min.z = b.min.z.min(p.z);
                        b.max.x = b.max.x.max(p.x);
                        b.max.y = b.max.y.max(p.y);
                        b.max.z = b.max.z.max(p.z);
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "expandByScalar",
            Func::from(|this: This<Class<'js, Box3>>, s: f32| -> Class<'js, Box3> {
                {
                    let mut b = this.borrow_mut();
                    b.min.x -= s;
                    b.min.y -= s;
                    b.min.z -= s;
                    b.max.x += s;
                    b.max.y += s;
                    b.max.z += s;
                }
                this.0.clone()
            }),
        )?;

        proto.set(
            "expandByVector",
            Func::from(
                |this: This<Class<'js, Box3>>, v: Class<'js, Vector3>| -> Class<'js, Box3> {
                    {
                        let vv = *v.borrow();
                        let mut b = this.borrow_mut();
                        b.min.x -= vv.x;
                        b.min.y -= vv.y;
                        b.min.z -= vv.z;
                        b.max.x += vv.x;
                        b.max.y += vv.y;
                        b.max.z += vv.z;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "setFromPoints",
            Func::from(
                |this: This<Class<'js, Box3>>, points: rquickjs::Array<'js>| -> Result<Class<'js, Box3>> {
                    {
                        let mut b = this.borrow_mut();
                        *b = Box3::empty();
                        let len = points.len();
                        for i in 0..len {
                            let pt: Class<'js, Vector3> = points.get(i)?;
                            let p = *pt.borrow();
                            b.min.x = b.min.x.min(p.x);
                            b.min.y = b.min.y.min(p.y);
                            b.min.z = b.min.z.min(p.z);
                            b.max.x = b.max.x.max(p.x);
                            b.max.y = b.max.y.max(p.y);
                            b.max.z = b.max.z.max(p.z);
                        }
                    }
                    Ok(this.0.clone())
                },
            ),
        )?;

        proto.set(
            "containsPoint",
            Func::from(
                |this: This<Class<'js, Box3>>, pt: Class<'js, Vector3>| -> bool {
                    let p = *pt.borrow();
                    let b = this.borrow();
                    p.x >= b.min.x && p.x <= b.max.x &&
                    p.y >= b.min.y && p.y <= b.max.y &&
                    p.z >= b.min.z && p.z <= b.max.z
                },
            ),
        )?;

        proto.set(
            "containsBox",
            Func::from(|this: This<Class<'js, Box3>>, other: Class<'js, Box3>| -> bool {
                let o = *other.borrow();
                let b = this.borrow();
                b.min.x <= o.min.x && o.max.x <= b.max.x &&
                b.min.y <= o.min.y && o.max.y <= b.max.y &&
                b.min.z <= o.min.z && o.max.z <= b.max.z
            }),
        )?;

        proto.set(
            "intersectsBox",
            Func::from(|this: This<Class<'js, Box3>>, other: Class<'js, Box3>| -> bool {
                let o = *other.borrow();
                let b = this.borrow();
                !(o.max.x < b.min.x || o.min.x > b.max.x ||
                  o.max.y < b.min.y || o.min.y > b.max.y ||
                  o.max.z < b.min.z || o.min.z > b.max.z)
            }),
        )?;

        proto.set(
            "intersectsSphere",
            Func::from(|this: This<Class<'js, Box3>>,
                        center: Class<'js, Vector3>,
                        radius: f32|
                        -> bool {
                let c = *center.borrow();
                let b = this.borrow();
                let cx = c.x.max(b.min.x).min(b.max.x);
                let cy = c.y.max(b.min.y).min(b.max.y);
                let cz = c.z.max(b.min.z).min(b.max.z);
                let dx = cx - c.x;
                let dy = cy - c.y;
                let dz = cz - c.z;
                dx * dx + dy * dy + dz * dz <= radius * radius
            }),
        )?;

        proto.set(
            "getCenter",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, Box3>>,
                 target: Opt<Class<'js, Vector3>>|
                 -> Result<Class<'js, Vector3>> {
                    let b = this.borrow();
                    let cx = (b.min.x + b.max.x) * 0.5;
                    let cy = (b.min.y + b.max.y) * 0.5;
                    let cz = (b.min.z + b.max.z) * 0.5;
                    if let Some(t) = target.0 {
                        {
                            let mut tv = t.borrow_mut();
                            tv.x = cx;
                            tv.y = cy;
                            tv.z = cz;
                        }
                        Ok(t)
                    } else {
                        Class::instance(ctx, Vector3::new(cx, cy, cz))
                    }
                },
            ),
        )?;

        proto.set(
            "getSize",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, Box3>>,
                 target: Opt<Class<'js, Vector3>>|
                 -> Result<Class<'js, Vector3>> {
                    let b = this.borrow();
                    let sx = b.max.x - b.min.x;
                    let sy = b.max.y - b.min.y;
                    let sz = b.max.z - b.min.z;
                    if let Some(t) = target.0 {
                        {
                            let mut tv = t.borrow_mut();
                            tv.x = sx;
                            tv.y = sy;
                            tv.z = sz;
                        }
                        Ok(t)
                    } else {
                        Class::instance(ctx, Vector3::new(sx, sy, sz))
                    }
                },
            ),
        )?;

        proto.set(
            "equals",
            Func::from(|this: This<Class<'js, Box3>>, other: Class<'js, Box3>| -> bool {
                let a = *this.borrow();
                let b = *other.borrow();
                a.min.x == b.min.x && a.min.y == b.min.y && a.min.z == b.min.z &&
                a.max.x == b.max.x && a.max.y == b.max.y && a.max.z == b.max.z
            }),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        // new Box3(min?, max?). Three.js defaults to (Infinity, Infinity, Infinity)
        // for min and (-Infinity, -Infinity, -Infinity) for max.
        let c = Constructor::new_class::<Box3, _, _>(
            ctx.clone(),
            |min: Opt<Class<'js, Vector3>>, max: Opt<Class<'js, Vector3>>| -> Box3 {
                let mn = min.0.map(|c| *c.borrow()).unwrap_or_else(|| {
                    Vector3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY)
                });
                let mx = max.0.map(|c| *c.borrow()).unwrap_or_else(|| {
                    Vector3::new(-f32::INFINITY, -f32::INFINITY, -f32::INFINITY)
                });
                Box3 { min: mn, max: mx }
            },
        )?;
        Ok(Some(c))
    }
}

impl<'js> IntoJs<'js> for Box3 {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}
