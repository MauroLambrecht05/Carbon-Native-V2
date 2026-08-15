// Color — three.js Color (linear RGB by default in modern three.js).
//
// We store as three f32s in [0, 1] linear space, matching three.js's
// internal representation. setHex / setRGB / setHSL / getHex / lerp are
// the high-frequency methods. Colorspace conversions (sRGB <-> linear)
// are *not* applied here — modern three.js leaves that to the renderer
// (you tell it `color.convertSRGBToLinear()` explicitly).

use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, Opt, This},
    Class, Ctx, IntoJs, JsLifetime, Object, Result, Value,
};

#[derive(Clone, Copy, Debug)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl Default for Color {
    fn default() -> Self {
        Self {
            r: 1.0,
            g: 1.0,
            b: 1.0,
        }
    }
}

impl Color {
    pub fn new(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b }
    }
}

unsafe impl JsLifetime<'_> for Color {
    type Changed<'to> = Color;
}

impl<'js> Trace<'js> for Color {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for Color {
    const NAME: &'static str = "Color";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;
        proto.set("isColor", true)?;

        macro_rules! accessor {
            ($name:literal, $field:ident) => {
                crate::common::define_accessor(
                    ctx,
                    &proto,
                    $name,
                    Func::from(|this: This<Class<'js, Color>>| -> f32 { this.borrow().$field }),
                    Func::from(|this: This<Class<'js, Color>>, v: f32| {
                        this.borrow_mut().$field = v;
                    }),
                )?;
            };
        }
        accessor!("r", r);
        accessor!("g", g);
        accessor!("b", b);

        proto.set(
            "set",
            Func::from(
                |this: This<Class<'js, Color>>, v: Value<'js>| -> Result<Class<'js, Color>> {
                    // three.js's `Color.set` is overloaded:
                    //   set(0xff00ff) — hex int
                    //   set("#ff00ff") / set("red") — string  (we only handle "#rrggbb" + "rgb()")
                    //   set(otherColor) — copy
                    //   set("rgb(255, 0, 255)") — also string parser (we handle the basic form)
                    if let Some(n) = v.as_number() {
                        let h = n as u32;
                        let mut c = this.borrow_mut();
                        c.r = ((h >> 16) & 0xff) as f32 / 255.0;
                        c.g = ((h >> 8) & 0xff) as f32 / 255.0;
                        c.b = (h & 0xff) as f32 / 255.0;
                    } else if let Some(s) = v.as_string() {
                        let raw = s.to_string()?;
                        parse_color_string(&raw, &mut this.borrow_mut());
                    } else if let Ok(other) = Class::<Color>::from_value(&v) {
                        let o = *other.borrow();
                        *this.borrow_mut() = o;
                    }
                    Ok(this.0.clone())
                },
            ),
        )?;

        proto.set(
            "setHex",
            Func::from(
                |this: This<Class<'js, Color>>, hex: u32| -> Class<'js, Color> {
                    {
                        let mut c = this.borrow_mut();
                        c.r = ((hex >> 16) & 0xff) as f32 / 255.0;
                        c.g = ((hex >> 8) & 0xff) as f32 / 255.0;
                        c.b = (hex & 0xff) as f32 / 255.0;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "setRGB",
            Func::from(
                |this: This<Class<'js, Color>>, r: f32, g: f32, b: f32| -> Class<'js, Color> {
                    {
                        let mut c = this.borrow_mut();
                        c.r = r;
                        c.g = g;
                        c.b = b;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "setHSL",
            Func::from(
                |this: This<Class<'js, Color>>, h: f32, s: f32, l: f32| -> Class<'js, Color> {
                    let (r, g, b) = hsl_to_rgb(h, s, l);
                    {
                        let mut c = this.borrow_mut();
                        c.r = r;
                        c.g = g;
                        c.b = b;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "getHex",
            Func::from(|this: This<Class<'js, Color>>| -> u32 {
                let c = *this.borrow();
                let r = (c.r.clamp(0.0, 1.0) * 255.0).round() as u32;
                let g = (c.g.clamp(0.0, 1.0) * 255.0).round() as u32;
                let b = (c.b.clamp(0.0, 1.0) * 255.0).round() as u32;
                (r << 16) | (g << 8) | b
            }),
        )?;

        proto.set(
            "getHexString",
            Func::from(|this: This<Class<'js, Color>>| -> String {
                let c = *this.borrow();
                let r = (c.r.clamp(0.0, 1.0) * 255.0).round() as u32;
                let g = (c.g.clamp(0.0, 1.0) * 255.0).round() as u32;
                let b = (c.b.clamp(0.0, 1.0) * 255.0).round() as u32;
                format!("{:06x}", (r << 16) | (g << 8) | b)
            }),
        )?;

        proto.set(
            "copy",
            Func::from(
                |this: This<Class<'js, Color>>, other: Class<'js, Color>| -> Class<'js, Color> {
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
            Func::from(
                |ctx: Ctx<'js>, this: This<Class<'js, Color>>| -> Result<Class<'js, Color>> {
                    let c = *this.borrow();
                    Class::instance(ctx, c)
                },
            ),
        )?;

        proto.set(
            "lerp",
            Func::from(
                |this: This<Class<'js, Color>>,
                 color: Class<'js, Color>,
                 alpha: f32|
                 -> Class<'js, Color> {
                    {
                        let o = *color.borrow();
                        let mut c = this.borrow_mut();
                        c.r += (o.r - c.r) * alpha;
                        c.g += (o.g - c.g) * alpha;
                        c.b += (o.b - c.b) * alpha;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "lerpColors",
            Func::from(
                |this: This<Class<'js, Color>>,
                 a: Class<'js, Color>,
                 b: Class<'js, Color>,
                 t: f32|
                 -> Class<'js, Color> {
                    let av = *a.borrow();
                    let bv = *b.borrow();
                    {
                        let mut c = this.borrow_mut();
                        c.r = av.r + (bv.r - av.r) * t;
                        c.g = av.g + (bv.g - av.g) * t;
                        c.b = av.b + (bv.b - av.b) * t;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiply",
            Func::from(
                |this: This<Class<'js, Color>>, other: Class<'js, Color>| -> Class<'js, Color> {
                    {
                        let o = *other.borrow();
                        let mut c = this.borrow_mut();
                        c.r *= o.r;
                        c.g *= o.g;
                        c.b *= o.b;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "multiplyScalar",
            Func::from(
                |this: This<Class<'js, Color>>, s: f32| -> Class<'js, Color> {
                    {
                        let mut c = this.borrow_mut();
                        c.r *= s;
                        c.g *= s;
                        c.b *= s;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "add",
            Func::from(
                |this: This<Class<'js, Color>>, other: Class<'js, Color>| -> Class<'js, Color> {
                    {
                        let o = *other.borrow();
                        let mut c = this.borrow_mut();
                        c.r += o.r;
                        c.g += o.g;
                        c.b += o.b;
                    }
                    this.0.clone()
                },
            ),
        )?;

        proto.set(
            "equals",
            Func::from(
                |this: This<Class<'js, Color>>, other: Class<'js, Color>| -> bool {
                    let a = *this.borrow();
                    let b = *other.borrow();
                    a.r == b.r && a.g == b.g && a.b == b.b
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        // new Color() — defaults to white (1, 1, 1) in three.js.
        // new Color(0xff0000) — hex int
        // new Color(r, g, b) — three floats in [0, 1]
        // new Color('red') / new Color('#fff') — string (basic parser)
        let c = Constructor::new_class::<Color, _, _>(
            ctx.clone(),
            |a: Opt<Value<'js>>, b: Opt<f32>, c: Opt<f32>| -> Color {
                match (a.0, b.0, c.0) {
                    (None, _, _) => Color::default(),
                    (Some(v), None, None) => {
                        if let Some(n) = v.as_number() {
                            let h = n as u32;
                            Color {
                                r: ((h >> 16) & 0xff) as f32 / 255.0,
                                g: ((h >> 8) & 0xff) as f32 / 255.0,
                                b: (h & 0xff) as f32 / 255.0,
                            }
                        } else if let Some(s) = v.as_string() {
                            let raw = s.to_string().unwrap_or_default();
                            let mut out = Color::default();
                            parse_color_string(&raw, &mut out);
                            out
                        } else {
                            Color::default()
                        }
                    }
                    (Some(rv), Some(gv), Some(bv)) => Color {
                        r: rv.as_number().unwrap_or(0.0) as f32,
                        g: gv,
                        b: bv,
                    },
                    _ => Color::default(),
                }
            },
        )?;
        Ok(Some(c))
    }
}

impl<'js> IntoJs<'js> for Color {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

#[inline]
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    // three.js's hue2rgb-based conversion. Hue is in [0, 1].
    if s == 0.0 {
        return (l, l, l);
    }
    let p = if l <= 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let q = 2.0 * l - p;
    let r = hue2rgb(q, p, h + 1.0 / 3.0);
    let g = hue2rgb(q, p, h);
    let b = hue2rgb(q, p, h - 1.0 / 3.0);
    (r, g, b)
}

#[inline]
fn hue2rgb(p: f32, q: f32, t: f32) -> f32 {
    let mut t = t;
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 1.0 / 2.0 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * 6.0 * (2.0 / 3.0 - t);
    }
    p
}

/// Bare-bones color string parser. Accepts `#rgb`, `#rrggbb`, and the
/// `rgb(r, g, b)` decimal form — the most common cases. Anything else
/// silently leaves the color unchanged. Three.js has a much larger
/// parser (named CSS colors like 'red', 'aliceblue', etc.); we skip
/// that to keep the binary lean. Documented in PHASE3_IMPL.md.
fn parse_color_string(s: &str, out: &mut Color) {
    let trimmed = s.trim();
    if let Some(stripped) = trimmed.strip_prefix('#') {
        if stripped.len() == 6 {
            if let Ok(h) = u32::from_str_radix(stripped, 16) {
                out.r = ((h >> 16) & 0xff) as f32 / 255.0;
                out.g = ((h >> 8) & 0xff) as f32 / 255.0;
                out.b = (h & 0xff) as f32 / 255.0;
            }
        } else if stripped.len() == 3 {
            if let Ok(h) = u32::from_str_radix(stripped, 16) {
                let r = (h >> 8) & 0xf;
                let g = (h >> 4) & 0xf;
                let b = h & 0xf;
                out.r = ((r << 4) | r) as f32 / 255.0;
                out.g = ((g << 4) | g) as f32 / 255.0;
                out.b = ((b << 4) | b) as f32 / 255.0;
            }
        }
    } else if trimmed.starts_with("rgb(") && trimmed.ends_with(')') {
        let inner = &trimmed[4..trimmed.len() - 1];
        let parts: Vec<&str> = inner.split(',').map(|p| p.trim()).collect();
        if parts.len() == 3 {
            if let (Ok(r), Ok(g), Ok(b)) = (
                parts[0].parse::<f32>(),
                parts[1].parse::<f32>(),
                parts[2].parse::<f32>(),
            ) {
                out.r = r / 255.0;
                out.g = g / 255.0;
                out.b = b / 255.0;
            }
        }
    }
}
