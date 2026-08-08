// CSS-string parsers for the rendering primitives that don't fit the
// "single number" / "single hex color" pattern: gradients, transforms,
// box-shadow. Also a richer color parser that handles `rgb(...)` /
// `rgba(...)` / `hsl(...)` / `hsla(...)` / named transparent — the
// hex-only parser in scene.rs is fine for solid background but
// gradients/shadows almost always come with alpha, so they need rgba().
//
// Output types live on `crate::scene::{GradientDef, GradientShape,
// GradientStopDef, BoxShadow, TransformList, TransformOp}`.

use crate::scene::{
    BoxShadow, ClipPath, GradientDef, GradientShape, GradientStopDef, Len, TransformList, TransformOp,
};

/// Splits a CSS argument list on top-level commas — commas inside `()`
/// (e.g. `rgba(0, 0, 0, 0.5)`) are ignored. Used by the gradient and
/// box-shadow parsers, both of which take a top-level comma list.
fn split_top_level(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for c in s.chars() {
        match c {
            '(' => { depth += 1; cur.push(c); }
            ')' => { depth -= 1; cur.push(c); }
            ',' if depth == 0 => { out.push(cur.trim().to_string()); cur.clear(); }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Parse any of: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`,
/// `rgba(r,g,b,a)`, `hsl(h,s%,l%)`, `hsla(h,s%,l%,a)`, `transparent`,
/// `currentColor` (returns None — caller substitutes). Returns
/// 0xAARRGGBB.
pub fn parse_color_str(input: &str) -> Option<u32> {
    let s = input.trim();
    if s.eq_ignore_ascii_case("transparent") {
        return Some(0x00_00_00_00);
    }
    if s.eq_ignore_ascii_case("currentcolor") {
        return None;
    }
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex(hex);
    }
    if let Some(args) = strip_fn(s, "rgb").or_else(|| strip_fn(s, "rgba")) {
        return parse_rgb_args(&args);
    }
    if let Some(args) = strip_fn(s, "hsl").or_else(|| strip_fn(s, "hsla")) {
        return parse_hsl_args(&args);
    }
    // CSS named colors — fall back to the common HTML4/CSS3 set. Real
    // browsers ship the full ~140-name table; the subset here covers
    // what apps reach for as quick debug colours (red/blue/yellow) and
    // the few semantic names (linkblue, lime, etc.) that some libraries
    // use as defaults. Unknown names return None.
    parse_named_color(s)
}

fn parse_named_color(s: &str) -> Option<u32> {
    let n = s.to_ascii_lowercase();
    Some(0xFF000000 | match n.as_str() {
        "black" => 0x000000,
        "white" => 0xFFFFFF,
        "red" => 0xFF0000,
        "green" => 0x008000,
        "lime" => 0x00FF00,
        "blue" => 0x0000FF,
        "yellow" => 0xFFFF00,
        "cyan" | "aqua" => 0x00FFFF,
        "magenta" | "fuchsia" => 0xFF00FF,
        "gray" | "grey" => 0x808080,
        "silver" => 0xC0C0C0,
        "maroon" => 0x800000,
        "olive" => 0x808000,
        "navy" => 0x000080,
        "purple" => 0x800080,
        "teal" => 0x008080,
        "orange" => 0xFFA500,
        "pink" => 0xFFC0CB,
        "brown" => 0xA52A2A,
        "gold" => 0xFFD700,
        "violet" => 0xEE82EE,
        "indigo" => 0x4B0082,
        "lightgray" | "lightgrey" => 0xD3D3D3,
        "darkgray" | "darkgrey" => 0xA9A9A9,
        "lightblue" => 0xADD8E6,
        "darkblue" => 0x00008B,
        "lightgreen" => 0x90EE90,
        "darkgreen" => 0x006400,
        "lightred" => 0xFFCCCB,
        "darkred" => 0x8B0000,
        "skyblue" => 0x87CEEB,
        "tomato" => 0xFF6347,
        "salmon" => 0xFA8072,
        "coral" => 0xFF7F50,
        "khaki" => 0xF0E68C,
        "crimson" => 0xDC143C,
        "lavender" => 0xE6E6FA,
        "plum" => 0xDDA0DD,
        "beige" => 0xF5F5DC,
        "azure" => 0xF0FFFF,
        "ivory" => 0xFFFFF0,
        "mintcream" => 0xF5FFFA,
        "snow" => 0xFFFAFA,
        "wheat" => 0xF5DEB3,
        "tan" => 0xD2B48C,
        "chocolate" => 0xD2691E,
        "sienna" => 0xA0522D,
        "peru" => 0xCD853F,
        _ => return None,
    })
}

fn strip_fn<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let lower = s.to_ascii_lowercase();
    if !lower.starts_with(&format!("{name}(")) {
        return None;
    }
    let start = name.len() + 1;
    if !s.ends_with(')') {
        return None;
    }
    Some(&s[start..s.len() - 1])
}

fn parse_hex(s: &str) -> Option<u32> {
    let n = match s.len() {
        3 => {
            // #rgb -> #rrggbb
            let r = u32::from_str_radix(&s[0..1], 16).ok()? * 0x11;
            let g = u32::from_str_radix(&s[1..2], 16).ok()? * 0x11;
            let b = u32::from_str_radix(&s[2..3], 16).ok()? * 0x11;
            0xFF000000 | (r << 16) | (g << 8) | b
        }
        6 => 0xFF000000 | u32::from_str_radix(s, 16).ok()?,
        8 => {
            let v = u32::from_str_radix(s, 16).ok()?;
            // CSS #rrggbbaa → our 0xAARRGGBB
            ((v & 0xFF) << 24) | (v >> 8)
        }
        _ => return None,
    };
    Some(n)
}

fn parse_channel(s: &str) -> Option<u8> {
    let t = s.trim();
    if let Some(pct) = t.strip_suffix('%') {
        let p: f32 = pct.trim().parse().ok()?;
        Some(((p / 100.0) * 255.0).round().clamp(0.0, 255.0) as u8)
    } else {
        let v: f32 = t.parse().ok()?;
        Some(v.round().clamp(0.0, 255.0) as u8)
    }
}

fn parse_alpha(s: &str) -> Option<u8> {
    let t = s.trim();
    if let Some(pct) = t.strip_suffix('%') {
        let p: f32 = pct.trim().parse().ok()?;
        Some(((p / 100.0) * 255.0).round().clamp(0.0, 255.0) as u8)
    } else {
        let v: f32 = t.parse().ok()?;
        Some((v * 255.0).round().clamp(0.0, 255.0) as u8)
    }
}

fn parse_rgb_args(args: &str) -> Option<u32> {
    // Accepts both comma- and space-separated forms.
    let parts: Vec<&str> = if args.contains(',') {
        args.split(',').collect()
    } else {
        args.split_whitespace().collect()
    };
    if parts.len() != 3 && parts.len() != 4 {
        return None;
    }
    let r = parse_channel(parts[0])? as u32;
    let g = parse_channel(parts[1])? as u32;
    let b = parse_channel(parts[2])? as u32;
    let a = if parts.len() == 4 { parse_alpha(parts[3])? as u32 } else { 255 };
    Some((a << 24) | (r << 16) | (g << 8) | b)
}

fn parse_hsl_args(args: &str) -> Option<u32> {
    let parts: Vec<&str> = if args.contains(',') {
        args.split(',').collect()
    } else {
        args.split_whitespace().collect()
    };
    if parts.len() != 3 && parts.len() != 4 {
        return None;
    }
    let h = parts[0].trim().trim_end_matches("deg").parse::<f32>().ok()?;
    let s = parts[1].trim().trim_end_matches('%').parse::<f32>().ok()? / 100.0;
    let l = parts[2].trim().trim_end_matches('%').parse::<f32>().ok()? / 100.0;
    let a = if parts.len() == 4 { parse_alpha(parts[3])? as u32 } else { 255 };
    let (r, g, b) = hsl_to_rgb(h, s, l);
    Some((a << 24) | ((r as u32) << 16) | ((g as u32) << 8) | b as u32)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    // Standard HSL → RGB conversion (CSS Color 3 §4.2.4).
    let h = (((h % 360.0) + 360.0) % 360.0) / 360.0;
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let r = hue_to_rgb(p, q, h + 1.0 / 3.0);
    let g = hue_to_rgb(p, q, h);
    let b = hue_to_rgb(p, q, h - 1.0 / 3.0);
    (
        (r * 255.0).round().clamp(0.0, 255.0) as u8,
        (g * 255.0).round().clamp(0.0, 255.0) as u8,
        (b * 255.0).round().clamp(0.0, 255.0) as u8,
    )
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 { t += 1.0; }
    if t > 1.0 { t -= 1.0; }
    if t < 1.0 / 6.0 { return p + (q - p) * 6.0 * t; }
    if t < 1.0 / 2.0 { return q; }
    if t < 2.0 / 3.0 { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    p
}

// ─── Gradients ────────────────────────────────────────────────────────────

/// `linear-gradient(180deg, #f00, #00f 50%, rgba(0,0,0,0.5) 100%)` etc.
/// Defaults the angle to 180° (≡ `to bottom` in CSS) if omitted.
pub fn parse_linear_gradient(s: &str) -> Option<GradientDef> {
    let args = strip_fn(s.trim(), "linear-gradient")?;
    let parts = split_top_level(args);
    if parts.is_empty() { return None; }

    let mut stops_start = 0usize;
    let mut angle = 180.0f32;
    let first = parts[0].trim();
    if let Some(a) = parse_angle(first) {
        angle = a;
        stops_start = 1;
    } else if let Some(a) = parse_direction(first) {
        angle = a;
        stops_start = 1;
    }
    let stops = parse_stops(&parts[stops_start..])?;
    if stops.len() < 2 { return None; }
    Some(GradientDef { shape: GradientShape::Linear { angle_deg: angle }, stops })
}

/// `radial-gradient(circle at center, #f00, #00f)` — we accept any
/// prefix but always paint as an ellipse fitted to the box (CSS
/// default `farthest-corner`-ish). Position defaults to center.
pub fn parse_radial_gradient(s: &str) -> Option<GradientDef> {
    let args = strip_fn(s.trim(), "radial-gradient")?;
    let parts = split_top_level(args);
    if parts.is_empty() { return None; }

    let mut stops_start = 0usize;
    let mut cx = 0.5f32;
    let mut cy = 0.5f32;
    let first = parts[0].trim().to_ascii_lowercase();
    let looks_like_position = first.contains("at ") || first.starts_with("circle")
        || first.starts_with("ellipse") || first.starts_with("closest")
        || first.starts_with("farthest");
    if looks_like_position {
        if let Some(rest) = first.find("at ") {
            let pos = &first[rest + 3..];
            let mut it = pos.split_whitespace();
            if let Some(p) = it.next() { cx = parse_position_axis(p).unwrap_or(0.5); }
            if let Some(p) = it.next() { cy = parse_position_axis(p).unwrap_or(0.5); }
        }
        stops_start = 1;
    }
    let stops = parse_stops(&parts[stops_start..])?;
    if stops.len() < 2 { return None; }
    Some(GradientDef { shape: GradientShape::Radial { cx, cy }, stops })
}

fn parse_position_axis(s: &str) -> Option<f32> {
    let t = s.trim();
    match t {
        "left" | "top" => Some(0.0),
        "right" | "bottom" => Some(1.0),
        "center" => Some(0.5),
        _ => {
            if let Some(pct) = t.strip_suffix('%') {
                pct.parse::<f32>().ok().map(|v| v / 100.0)
            } else {
                t.strip_suffix("px").unwrap_or(t).parse::<f32>().ok()
            }
        }
    }
}

fn parse_angle(s: &str) -> Option<f32> {
    let t = s.trim();
    if let Some(num) = t.strip_suffix("deg") {
        return num.trim().parse::<f32>().ok();
    }
    if let Some(num) = t.strip_suffix("rad") {
        let r: f32 = num.trim().parse().ok()?;
        return Some(r.to_degrees());
    }
    if let Some(num) = t.strip_suffix("turn") {
        let r: f32 = num.trim().parse().ok()?;
        return Some(r * 360.0);
    }
    None
}

fn parse_direction(s: &str) -> Option<f32> {
    // CSS `to <side>` shorthand. We map to angles in CSS convention
    // (0° = "to top", increases clockwise).
    let t = s.trim().to_ascii_lowercase();
    let rest = t.strip_prefix("to ")?;
    match rest.trim() {
        "top" => Some(0.0),
        "top right" | "right top" => Some(45.0),
        "right" => Some(90.0),
        "bottom right" | "right bottom" => Some(135.0),
        "bottom" => Some(180.0),
        "bottom left" | "left bottom" => Some(225.0),
        "left" => Some(270.0),
        "top left" | "left top" => Some(315.0),
        _ => None,
    }
}

fn parse_stops(parts: &[String]) -> Option<Vec<GradientStopDef>> {
    let mut stops: Vec<GradientStopDef> = Vec::with_capacity(parts.len());
    for (i, p) in parts.iter().enumerate() {
        // A stop is "<color> [<offset>]" — split on the LAST whitespace
        // since the color itself might contain whitespace (rgb(0 0 0)).
        // Easier: try to parse the trailing token as a percent / length;
        // if it fails, the whole part is the color.
        let trimmed = p.trim();
        let (color_str, offset) = if let Some(idx) = trimmed.rfind(char::is_whitespace) {
            let (head, tail) = trimmed.split_at(idx);
            if let Some(off) = parse_position_axis(tail.trim()) {
                (head.trim(), Some(off))
            } else {
                (trimmed, None)
            }
        } else {
            (trimmed, None)
        };
        let color = parse_color_str(color_str)?;
        let offset = offset.unwrap_or_else(|| {
            // Auto-distribute when no explicit offset: 0%, 100% for the
            // endpoints, evenly spaced in between.
            let n = parts.len() as f32;
            if n <= 1.0 { 0.0 } else { i as f32 / (n - 1.0) }
        });
        stops.push(GradientStopDef { offset: offset.clamp(0.0, 1.0), color });
    }
    Some(stops)
}

// ─── Box-shadow ───────────────────────────────────────────────────────────

/// CSS box-shadow: `<offsetX> <offsetY> [<blur>] [<spread>] <color>`,
/// optionally prefixed with `inset`. Comma-separated entries become
/// multiple shadows; CSS paints them in declaration order (first on
/// top), and outset shadows sit underneath the box bg while inset
/// shadows sit on top of it.
pub fn parse_box_shadow(s: &str) -> Vec<BoxShadow> {
    split_top_level(s).into_iter()
        .filter_map(|entry| parse_box_shadow_one(&entry))
        .collect()
}

fn parse_box_shadow_one(s: &str) -> Option<BoxShadow> {
    let tokens = tokenize_shadow(s);
    if tokens.is_empty() { return None; }
    // Detect leading or trailing `inset` keyword.
    let mut inset = false;
    let mut toks: Vec<&str> = tokens.iter().map(|t| t.as_str()).collect();
    if let Some(i) = toks.iter().position(|t| t.eq_ignore_ascii_case("inset")) {
        inset = true;
        toks.remove(i);
    }
    if toks.len() < 3 { return None; }
    let (color_idx, color) = toks.iter().enumerate().rev()
        .find_map(|(i, t)| parse_color_str(t).map(|c| (i, c)))?;
    let nums: Vec<f32> = toks[..color_idx].iter()
        .map(|t| parse_length(t).unwrap_or(0.0))
        .collect();
    let offset_x = nums.first().copied().unwrap_or(0.0);
    let offset_y = nums.get(1).copied().unwrap_or(0.0);
    let blur = nums.get(2).copied().unwrap_or(0.0).max(0.0);
    let spread = nums.get(3).copied().unwrap_or(0.0);
    Some(BoxShadow { offset_x, offset_y, blur, spread, color, inset })
}

fn tokenize_shadow(s: &str) -> Vec<String> {
    // Split on whitespace but keep function-call parens together.
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' => { depth += 1; cur.push(c); }
            ')' => { depth -= 1; cur.push(c); }
            _ if c.is_whitespace() && depth == 0 => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

fn parse_length(s: &str) -> Option<f32> {
    let t = s.trim();
    if t == "0" { return Some(0.0); }
    let num = t.strip_suffix("px").unwrap_or(t);
    num.parse::<f32>().ok()
}

/// Parse a translate component, returning (value, is_percent). A `%` suffix
/// yields the raw percentage number (e.g. "-50%" → (-50.0, true)); px/unitless
/// yields (px, false). Used so `translate(-50%, -50%)` resolves against the
/// element's own size at paint time instead of collapsing to 0.
fn parse_translate_component(s: &str) -> (f32, bool) {
    let t = s.trim();
    if let Some(p) = t.strip_suffix('%') {
        return (p.trim().parse::<f32>().unwrap_or(0.0), true);
    }
    (parse_length(t).unwrap_or(0.0), false)
}

// ─── Transform ────────────────────────────────────────────────────────────

/// CSS `transform: translate(...) rotate(...) scale(...) translateX(...)
/// translateY(...) scaleX(...) scaleY(...)`. Order matters per the CSS
/// spec: applied left-to-right around the element's center.
pub fn parse_transform(s: &str) -> Option<TransformList> {
    let mut ops = Vec::new();
    let mut rest = s.trim();
    while !rest.is_empty() {
        // Find next "name(args)" call.
        let paren = rest.find('(')?;
        let name = rest[..paren].trim();
        // Find matching ')' (no nested parens expected here).
        let close = rest[paren + 1..].find(')')?;
        let args = &rest[paren + 1..paren + 1 + close];
        rest = rest[paren + 1 + close + 1..].trim();

        let parts: Vec<&str> = args.split(',').map(|p| p.trim()).collect();
        let op = match name.to_ascii_lowercase().as_str() {
            "translate" => {
                let (x, x_pct) = parse_translate_component(parts.first().copied().unwrap_or("0"));
                let (y, y_pct) = parse_translate_component(parts.get(1).copied().unwrap_or("0"));
                TransformOp::Translate { x, y, x_pct, y_pct }
            }
            "translatex" => {
                let (x, x_pct) = parse_translate_component(parts.first().copied().unwrap_or("0"));
                TransformOp::Translate { x, y: 0.0, x_pct, y_pct: false }
            }
            "translatey" => {
                let (y, y_pct) = parse_translate_component(parts.first().copied().unwrap_or("0"));
                TransformOp::Translate { x: 0.0, y, x_pct: false, y_pct }
            }
            // framer-motion emits `translate3d(x, y, z)` (+ `translateZ(0)`)
            // for GPU-hinted transforms; take x/y, ignore z.
            "translate3d" => {
                let (x, x_pct) = parse_translate_component(parts.first().copied().unwrap_or("0"));
                let (y, y_pct) = parse_translate_component(parts.get(1).copied().unwrap_or("0"));
                TransformOp::Translate { x, y, x_pct, y_pct }
            }
            "translatez" => continue, // z has no effect in 2D
            "rotate" => {
                let a = parts.first().copied().unwrap_or("0");
                let deg = parse_angle(a).unwrap_or_else(|| a.parse::<f32>().unwrap_or(0.0));
                TransformOp::Rotate { rad: deg.to_radians() }
            }
            "scale" => {
                let x: f32 = parts.first().and_then(|p| p.parse().ok()).unwrap_or(1.0);
                let y: f32 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(x);
                TransformOp::Scale { x, y }
            }
            "scalex" => {
                let x: f32 = parts.first().and_then(|p| p.parse().ok()).unwrap_or(1.0);
                TransformOp::Scale { x, y: 1.0 }
            }
            "scaley" => {
                let y: f32 = parts.first().and_then(|p| p.parse().ok()).unwrap_or(1.0);
                TransformOp::Scale { x: 1.0, y }
            }
            _ => continue, // unsupported (skew, matrix, perspective) — silently drop
        };
        ops.push(op);
    }
    if ops.is_empty() { None } else { Some(TransformList(ops)) }
}

// ─── clip-path ────────────────────────────────────────────────────────────

/// Parse a `Len` accepting px or % suffix. Empty / unrecognised → None.
fn parse_clip_len(s: &str) -> Option<Len> {
    let t = s.trim();
    if t.is_empty() { return None; }
    if let Some(num) = t.strip_suffix('%') {
        return num.trim().parse::<f32>().ok().map(Len::Percent);
    }
    if let Some(num) = t.strip_suffix("px") {
        return num.trim().parse::<f32>().ok().map(Len::Length);
    }
    // Bare number → treat as px (CSS unitless is invalid here, but
    // common in handwritten values).
    t.parse::<f32>().ok().map(Len::Length)
}

/// CSS `clip-path: inset(...) | circle(...) | ellipse(...) | polygon(...) | none`.
/// Returns None for `none` / unrecognised; returns Some(ClipPath) otherwise.
pub fn parse_clip_path(s: &str) -> Option<ClipPath> {
    let t = s.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("none") { return None; }
    let paren = t.find('(')?;
    let name = t[..paren].trim().to_ascii_lowercase();
    let close = t.rfind(')')?;
    if close < paren { return None; }
    let args = t[paren + 1..close].trim();
    match name.as_str() {
        "inset" => parse_clip_inset(args),
        "circle" => parse_clip_circle(args),
        "ellipse" => parse_clip_ellipse(args),
        "polygon" => parse_clip_polygon(args),
        _ => None,
    }
}

fn parse_clip_inset(args: &str) -> Option<ClipPath> {
    // Two parts: `<lengths>` and optional `round <radius>`.
    let (before_round, radius_str) = if let Some(idx) = find_word(args, "round") {
        (args[..idx].trim(), Some(args[idx + 5..].trim()))
    } else {
        (args, None)
    };
    let parts: Vec<&str> = before_round.split_ascii_whitespace().collect();
    let (t, r, b, l) = match parts.len() {
        1 => {
            let v = parse_clip_len(parts[0])?;
            (v, v, v, v)
        }
        2 => {
            let v = parse_clip_len(parts[0])?;
            let h = parse_clip_len(parts[1])?;
            (v, h, v, h)
        }
        3 => {
            let top = parse_clip_len(parts[0])?;
            let hor = parse_clip_len(parts[1])?;
            let bot = parse_clip_len(parts[2])?;
            (top, hor, bot, hor)
        }
        4 => (
            parse_clip_len(parts[0])?,
            parse_clip_len(parts[1])?,
            parse_clip_len(parts[2])?,
            parse_clip_len(parts[3])?,
        ),
        _ => return None,
    };
    let radius = radius_str
        .and_then(|s| parse_clip_len(s.split_ascii_whitespace().next().unwrap_or("")))
        .unwrap_or(Len::Length(0.0));
    Some(ClipPath::Inset { top: t, right: r, bottom: b, left: l, radius })
}

fn parse_clip_circle(args: &str) -> Option<ClipPath> {
    // `<r> at <cx> <cy>` — `r` and the `at` clause are both optional.
    let (radius_str, center_str) = if let Some(idx) = find_word(args, "at") {
        (args[..idx].trim(), Some(args[idx + 2..].trim()))
    } else {
        (args, None)
    };
    let r = if radius_str.is_empty() {
        // CSS default is "closest-side" — we approximate as 50%.
        Len::Percent(50.0)
    } else {
        parse_clip_len(radius_str)?
    };
    let (cx, cy) = parse_center(center_str)?;
    Some(ClipPath::Circle { cx, cy, r })
}

fn parse_clip_ellipse(args: &str) -> Option<ClipPath> {
    // `<rx> <ry> at <cx> <cy>` — both clauses optional.
    let (radii_str, center_str) = if let Some(idx) = find_word(args, "at") {
        (args[..idx].trim(), Some(args[idx + 2..].trim()))
    } else {
        (args, None)
    };
    let radii: Vec<&str> = radii_str.split_ascii_whitespace().collect();
    let (rx, ry) = match radii.len() {
        0 => (Len::Percent(50.0), Len::Percent(50.0)),
        1 => {
            let v = parse_clip_len(radii[0])?;
            (v, v)
        }
        _ => (parse_clip_len(radii[0])?, parse_clip_len(radii[1])?),
    };
    let (cx, cy) = parse_center(center_str)?;
    Some(ClipPath::Ellipse { cx, cy, rx, ry })
}

fn parse_clip_polygon(args: &str) -> Option<ClipPath> {
    // Optional `fill-rule, ` prefix is ignored; everything after the
    // first comma (if any of the leading tokens is `nonzero`/`evenodd`)
    // is treated as the vertex list.
    let mut rest = args.trim();
    if let Some(comma) = rest.find(',') {
        let first = rest[..comma].trim();
        if first.eq_ignore_ascii_case("nonzero") || first.eq_ignore_ascii_case("evenodd") {
            rest = rest[comma + 1..].trim();
        }
    }
    let mut points = Vec::new();
    for v in split_top_level(rest) {
        let coords: Vec<&str> = v.split_ascii_whitespace().collect();
        if coords.len() < 2 { return None; }
        let x = parse_clip_len(coords[0])?;
        let y = parse_clip_len(coords[1])?;
        points.push((x, y));
    }
    if points.len() < 3 { return None; }
    Some(ClipPath::Polygon(points))
}

fn parse_center(s: Option<&str>) -> Option<(Len, Len)> {
    let s = match s {
        Some(v) if !v.is_empty() => v,
        _ => return Some((Len::Percent(50.0), Len::Percent(50.0))),
    };
    let parts: Vec<&str> = s.split_ascii_whitespace().collect();
    match parts.len() {
        1 => {
            let v = parse_position_keyword(parts[0])?;
            Some((v, Len::Percent(50.0)))
        }
        _ => Some((
            parse_position_keyword(parts[0])?,
            parse_position_keyword(parts[1])?,
        )),
    }
}

fn parse_position_keyword(s: &str) -> Option<Len> {
    match s.to_ascii_lowercase().as_str() {
        "left" | "top" => Some(Len::Percent(0.0)),
        "center" => Some(Len::Percent(50.0)),
        "right" | "bottom" => Some(Len::Percent(100.0)),
        _ => parse_clip_len(s),
    }
}

/// Find the byte index of a whitespace-delimited word in a string,
/// case-insensitive. Returns None if the word isn't present as a whole
/// token. Used to split `inset(10px round 4px)` and `circle(10px at 50% 50%)`.
fn find_word(s: &str, word: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    let mut pos = 0;
    while let Some(i) = lower[pos..].find(word) {
        let abs = pos + i;
        let before_ok = abs == 0 || s.as_bytes()[abs - 1].is_ascii_whitespace();
        let after = abs + word.len();
        let after_ok = after >= s.len() || s.as_bytes()[after].is_ascii_whitespace();
        if before_ok && after_ok { return Some(abs); }
        pos = abs + 1;
    }
    None
}
