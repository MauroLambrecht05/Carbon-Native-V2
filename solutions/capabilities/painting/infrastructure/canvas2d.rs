// Native CanvasRenderingContext2D — a CPU 2D canvas backed by tiny-skia.
//
// This is the "canvas primitive" half of carbon-mini's graphics layer: it
// lets any npm package that draws to a `<canvas>` 2D context (xterm.js's
// canvas renderer, chart libraries, color-parsing helpers, off-screen
// glyph atlases, …) run UNMODIFIED — no per-package shim. The DOM/CSS
// half is the scene graph + carbon-dom-shim; this is the immediate-mode
// half.
//
// Model:
//   * Each `<canvas>` (or OffscreenCanvas) owns a tiny-skia `Pixmap`,
//     keyed by the canvas element's scene-node id.
//   * JS batches 2D draw calls into a small command list and flushes it
//     via `__cm_canvas2d_flush(id, json)`. We replay the commands onto
//     the surface's pixmap, keeping ctx state (transform, fillStyle,
//     path, clip, …) across flushes — exactly like a real stateful 2D
//     context.
//   * Synchronous reads that JS needs an answer for immediately
//     (`measureText`, `getImageData`) are separate host calls.
//   * `paint_node` blits the surface pixmap into the frame for on-screen
//     `<canvas>` nodes (see main.rs).
//
// Everything runs on the single JS/paint thread, so the surface registry
// is a `thread_local!` — no locking, and `paint` + host fns see the same
// store.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::Value;
use tiny_skia::{
    BlendMode, Color, FillRule, GradientStop, LinearGradient, Mask, Paint, PathBuilder,
    Pixmap, Point, PremultipliedColorU8, RadialGradient, Rect, Shader, SpreadMode, Stroke,
    StrokeDash, Transform,
};

use carbon_text_renderer::TextEngine;

thread_local! {
    static SURFACES: RefCell<HashMap<u32, Canvas2d>> = RefCell::new(HashMap::new());
}

/// A solid color (0xAARRGGBB) or a gradient. Patterns aren't modelled yet.
#[derive(Clone)]
enum Style {
    Color(u32),
    Gradient(Gradient),
}

#[derive(Clone)]
struct Gradient {
    /// true = linear (x0,y0,x1,y1), false = radial (x0,y0,r0,x1,y1,r1)
    linear: bool,
    coords: [f32; 6],
    stops: Vec<(f32, u32)>,
}

#[derive(Clone)]
struct State {
    transform: Transform,
    fill: Style,
    stroke: Style,
    line_width: f32,
    global_alpha: f32,
    font_px: f32,
    font_mono: bool,
    text_align: u8,    // 0 start/left, 1 center, 2 right/end
    text_baseline: u8, // 0 alphabetic, 1 top, 2 middle, 3 bottom, 4 hanging
    line_cap: u8,      // 0 butt, 1 round, 2 square
    line_join: u8,     // 0 miter, 1 round, 2 bevel
    line_dash: Vec<f32>,
    line_dash_offset: f32,
    blend: BlendMode,
    clip: Option<Mask>,
    /// Axis-aligned rectangular clip in device space (x0, y0, x1, y1). The
    /// common case — `ctx.rect(); ctx.clip()` — is tracked here as cheap
    /// bounds instead of a full-canvas `Mask`. xterm wraps every glyph in a
    /// per-cell rect clip; building a megapixel mask each time cost seconds
    /// per terminal redraw. Draw ops clamp to this; `clip` (the mask) is only
    /// populated for genuinely non-rectangular clips.
    clip_rect: Option<(f32, f32, f32, f32)>,
}

impl Default for State {
    fn default() -> Self {
        State {
            transform: Transform::identity(),
            fill: Style::Color(0xFF_000000),
            stroke: Style::Color(0xFF_000000),
            line_width: 1.0,
            global_alpha: 1.0,
            font_px: 10.0,
            font_mono: false,
            text_align: 0,
            text_baseline: 0,
            line_cap: 0,
            line_join: 0,
            line_dash: Vec::new(),
            line_dash_offset: 0.0,
            blend: BlendMode::SourceOver,
            clip: None,
            clip_rect: None,
        }
    }
}

#[derive(Clone, Copy)]
enum PathOp {
    Move(f32, f32),
    Line(f32, f32),
    Cubic(f32, f32, f32, f32, f32, f32),
    Close,
}

pub struct Canvas2d {
    pub pixmap: Pixmap,
    pub width: u32,
    pub height: u32,
    state: State,
    stack: Vec<State>,
    /// Current path, stored already in device space (canvas semantics:
    /// points are transformed by the CTM when added, fill/stroke don't
    /// re-transform).
    path: Vec<PathOp>,
    cur: Point,
    start: Point,
    has_cur: bool,
}

impl Canvas2d {
    fn new(w: u32, h: u32) -> Option<Canvas2d> {
        let pixmap = Pixmap::new(w.max(1), h.max(1))?;
        Some(Canvas2d {
            pixmap,
            width: w.max(1),
            height: h.max(1),
            state: State::default(),
            stack: Vec::new(),
            path: Vec::new(),
            cur: Point::zero(),
            start: Point::zero(),
            has_cur: false,
        })
    }
}

// ── Public API used by host fns + paint ──────────────────────────────────

/// Create (or replace) a surface for `id` at the given size. Idempotent
/// when the size already matches.
pub fn create(id: u32, w: u32, h: u32) {
    SURFACES.with(|s| {
        let mut m = s.borrow_mut();
        match m.get(&id) {
            Some(c) if c.width == w.max(1) && c.height == h.max(1) => {}
            _ => {
                if let Some(c) = Canvas2d::new(w, h) {
                    m.insert(id, c);
                }
            }
        }
    });
}

/// Resize a surface. Canvas spec: setting width/height clears the bitmap
/// AND resets the context state to defaults.
pub fn resize(id: u32, w: u32, h: u32) {
    SURFACES.with(|s| {
        let mut m = s.borrow_mut();
        if let Some(c) = Canvas2d::new(w, h) {
            m.insert(id, c);
        }
    });
}

pub fn destroy(id: u32) {
    SURFACES.with(|s| {
        s.borrow_mut().remove(&id);
    });
}

pub fn exists(id: u32) -> bool {
    SURFACES.with(|s| s.borrow().contains_key(&id))
}

/// Sum of glyph advances for `text` at `px` (mono or proportional).
/// Pure font metric — no surface needed.
pub fn measure_text(te: &mut TextEngine, text: &str, px: f32, mono: bool) -> f32 {
    te.measure_styled_mono(text, px, 0.0, mono).0
}

/// Read straight (un-premultiplied) RGBA8 pixels from a sub-rect. Returns
/// `w*h*4` bytes, row-major, zero-filled outside the surface.
pub fn get_pixels(id: u32, x: i32, y: i32, w: u32, h: u32) -> Vec<u8> {
    SURFACES.with(|s| {
        let m = s.borrow();
        let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
        let Some(c) = m.get(&id) else { return out };
        let pw = c.pixmap.width() as i32;
        let ph = c.pixmap.height() as i32;
        let data = c.pixmap.pixels();
        for row in 0..h as i32 {
            let sy = y + row;
            if sy < 0 || sy >= ph {
                continue;
            }
            for col in 0..w as i32 {
                let sx = x + col;
                if sx < 0 || sx >= pw {
                    continue;
                }
                let p = data[(sy * pw + sx) as usize];
                let a = p.alpha();
                // Un-premultiply.
                let (r, g, b) = if a == 0 {
                    (0, 0, 0)
                } else {
                    (
                        ((p.red() as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8,
                        ((p.green() as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8,
                        ((p.blue() as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8,
                    )
                };
                let o = ((row * w as i32 + col) * 4) as usize;
                out[o] = r;
                out[o + 1] = g;
                out[o + 2] = b;
                out[o + 3] = a;
            }
        }
        out
    })
}

/// Write straight RGBA8 pixels into the surface. `src` is `src_w*src_h*4`
/// bytes. Implements the full `putImageData(data, dx, dy, dirtyX, dirtyY,
/// dirtyW, dirtyH)` contract: only the dirty sub-rect of `src` is copied,
/// and source pixel (sx,sy) lands at dest (dx+sx, dy+sy). The 3-arg form
/// passes dirty=(0,0,src_w,src_h). Overwrites (no compositing/globalAlpha).
///
/// Honouring the dirty rect is essential for xterm's canvas glyph atlas:
/// it packs each glyph by `putImageData`-ing ONLY the glyph's tight box
/// into the slot. Copying the whole image (ignoring the dirty rect) made
/// each glyph overwrite its neighbours → garbled, wrong glyphs.
#[allow(clippy::too_many_arguments)]
pub fn put_pixels(
    id: u32, src: &[u8], src_w: u32, src_h: u32, dx: i32, dy: i32,
    dirty_x: i32, dirty_y: i32, dirty_w: i32, dirty_h: i32,
) {
    SURFACES.with(|s| {
        let mut m = s.borrow_mut();
        let Some(c) = m.get_mut(&id) else { return };
        let pw = c.pixmap.width() as i32;
        let ph = c.pixmap.height() as i32;
        let sw = src_w as i32;
        let sh = src_h as i32;
        // Clamp the dirty rect to the source bounds.
        let x0 = dirty_x.max(0);
        let y0 = dirty_y.max(0);
        let x1 = (dirty_x + dirty_w).min(sw);
        let y1 = (dirty_y + dirty_h).min(sh);
        let data = c.pixmap.pixels_mut();
        for sy in y0..y1 {
            let py = dy + sy;
            if py < 0 || py >= ph {
                continue;
            }
            for sx in x0..x1 {
                let px = dx + sx;
                if px < 0 || px >= pw {
                    continue;
                }
                let o = ((sy * sw + sx) * 4) as usize;
                if o + 3 >= src.len() {
                    continue;
                }
                let r = src[o];
                let g = src[o + 1];
                let b = src[o + 2];
                let a = src[o + 3];
                // Store premultiplied.
                let rp = (r as u16 * a as u16 / 255) as u8;
                let gp = (g as u16 * a as u16 / 255) as u8;
                let bp = (b as u16 * a as u16 / 255) as u8;
                if let Some(p) = PremultipliedColorU8::from_rgba(rp, gp, bp, a) {
                    data[(py * pw + px) as usize] = p;
                }
            }
        }
    });
}

/// Blit a surface's pixmap into the frame `dst` at the layout box.
///
/// The overwhelmingly common case (xterm.js's canvas renderer, chart libs,
/// any `<canvas>` sized to its CSS box) is a 1:1 blit — the surface pixels
/// map straight onto the destination with no scaling. tiny-skia's
/// `draw_pixmap` always pushes every destination pixel through a transform +
/// sampler even at identity scale, so a full-screen terminal layer costs
/// ~15ms regardless of how little actually changed. With three stacked
/// xterm layers (text / selection / cursor) that was ~50ms/frame, and the
/// selection+cursor layers are usually entirely transparent.
///
/// So for the 1:1 case we do a straight SourceOver composite that skips
/// fully-transparent source pixels: empty overlay layers become a cheap
/// linear scan, and the text layer is a tight per-pixel copy with no
/// resampling math. Only genuine scaling falls back to `draw_pixmap`.
pub fn blit_into(id: u32, dst: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, scale: f32) {
    SURFACES.with(|s| {
        let m = s.borrow();
        let Some(c) = m.get(&id) else { return };
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        // The layout box (x,y,w,h) is in LOGICAL px; `dst` is the PHYSICAL
        // HiDPI buffer. Target the physical rect so the terminal lands at
        // the right place/size. A dpr-aware canvas backing store (width ==
        // w*scale) then blits 1:1 and crisp; a logical one is upscaled.
        let px = x * scale;
        let py = y * scale;
        let pw = w * scale;
        let ph = h * scale;
        let cw = c.width as f32;
        let ch = c.height as f32;
        // 1:1 fast path: physical target matches the surface (within half a
        // pixel) — no scaling.
        if (pw - cw).abs() < 0.5 && (ph - ch).abs() < 0.5 {
            blit_pixmap_over(dst, &c.pixmap, px.round() as i32, py.round() as i32);
            return;
        }
        // Scaled fallback (surface resolution != physical box).
        let sx = pw / cw;
        let sy = ph / ch;
        let ts = Transform::from_row(sx, 0.0, 0.0, sy, px, py);
        let paint = tiny_skia::PixmapPaint::default();
        dst.draw_pixmap(0, 0, c.pixmap.as_ref(), &paint, ts, None);
    });
}

/// Straight SourceOver composite of an entire source pixmap into `dst` at
/// integer (dx,dy). Fully-transparent source pixels are skipped and fully
/// opaque ones are copied verbatim, so the only real arithmetic happens on
/// genuinely translucent edges. Column span is clamped to the destination
/// once per row rather than branching per pixel.
fn blit_pixmap_over(dst: &mut Pixmap, src: &Pixmap, dx: i32, dy: i32) {
    let sw = src.width() as i32;
    let sh = src.height() as i32;
    let dw = dst.width() as i32;
    let dh = dst.height() as i32;
    let col0 = (-dx).max(0);
    let col1 = sw.min(dw - dx);
    if col1 <= col0 {
        return;
    }
    let src_px = src.pixels();
    let dst_px = dst.pixels_mut();
    for row in 0..sh {
        let dyy = dy + row;
        if dyy < 0 || dyy >= dh {
            continue;
        }
        let src_row = (row * sw) as usize;
        let dst_row = (dyy * dw) as usize;
        for col in col0..col1 {
            let s = src_px[src_row + col as usize];
            let sa = s.alpha() as u32;
            if sa == 0 {
                continue;
            }
            let di = dst_row + (dx + col) as usize;
            if sa == 255 {
                dst_px[di] = s;
                continue;
            }
            let d = dst_px[di];
            let inv = 255 - sa;
            let nr = s.red() as u32 + (d.red() as u32 * inv) / 255;
            let ng = s.green() as u32 + (d.green() as u32 * inv) / 255;
            let nb = s.blue() as u32 + (d.blue() as u32 * inv) / 255;
            let na = sa + (d.alpha() as u32 * inv) / 255;
            if let Some(p) =
                PremultipliedColorU8::from_rgba(nr as u8, ng as u8, nb as u8, na as u8)
            {
                dst_px[di] = p;
            }
        }
    }
}

/// Replay a JSON command list onto surface `id`. Commands keep ctx state
/// across calls. `te` supplies glyph rasterization for fillText.
pub fn flush(id: u32, json: &str, te: &mut TextEngine) {
    let perf = std::env::var_os("CARBON_PERF").is_some();
    let t0 = std::time::Instant::now();
    let cmds: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return,
    };
    let Some(arr) = cmds.as_array() else { return };
    let parse_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let n = arr.len();

    // Take the surface OUT so drawImage can borrow the registry to read
    // other surfaces without an aliasing borrow.
    let mut c = match SURFACES.with(|s| s.borrow_mut().remove(&id)) {
        Some(c) => c,
        None => return,
    };

    let t1 = std::time::Instant::now();
    let mut op_times: std::collections::HashMap<&str, (u32, f64)> = std::collections::HashMap::new();
    for cmd in arr {
        let Some(op) = cmd.as_array() else { continue };
        if op.is_empty() {
            continue;
        }
        let name = op[0].as_str().unwrap_or("");
        if perf {
            let ct = std::time::Instant::now();
            replay_one(&mut c, name, op, te);
            let e = op_times.entry(name).or_insert((0, 0.0));
            e.0 += 1;
            e.1 += ct.elapsed().as_secs_f64() * 1000.0;
        } else {
            replay_one(&mut c, name, op, te);
        }
    }
    let replay_ms = t1.elapsed().as_secs_f64() * 1000.0;

    SURFACES.with(|s| {
        s.borrow_mut().insert(id, c);
    });

    if perf && (parse_ms + replay_ms) > 2.0 {
        let mut tops: Vec<(&str, (u32, f64))> = op_times.into_iter().collect();
        tops.sort_by(|a, b| b.1 .1.partial_cmp(&a.1 .1).unwrap_or(std::cmp::Ordering::Equal));
        let summary: String = tops
            .iter()
            .take(4)
            .map(|(name, (cnt, ms))| format!("{name}×{cnt}={ms:.0}ms"))
            .collect::<Vec<_>>()
            .join(" ");
        eprintln!(
            "[perf]   canvas2d flush id={id} cmds={n} json_kb={:.0} parse={parse_ms:.1}ms replay={replay_ms:.1}ms [{summary}]",
            json.len() as f64 / 1024.0
        );
    }
}

// ── command helpers ───────────────────────────────────────────────────────

#[inline]
fn num(op: &[Value], i: usize) -> f32 {
    op.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32
}

#[inline]
fn map_pt(t: &Transform, x: f32, y: f32) -> Point {
    let mut p = [Point::from_xy(x, y)];
    t.map_points(&mut p);
    p[0]
}

fn build_path(ops: &[PathOp]) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    for op in ops {
        match *op {
            PathOp::Move(x, y) => pb.move_to(x, y),
            PathOp::Line(x, y) => pb.line_to(x, y),
            PathOp::Cubic(a, b, cc, d, e, f) => pb.cubic_to(a, b, cc, d, e, f),
            PathOp::Close => pb.close(),
        }
    }
    pb.finish()
}

/// Append cubic-bezier approximations of an elliptical arc (canvas
/// `arc`/`ellipse` semantics) to `out`, in device space via `t`.
fn arc_ops(
    out: &mut Vec<PathOp>,
    t: &Transform,
    has_cur: &mut bool,
    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    rotation: f32,
    mut a0: f32,
    mut a1: f32,
    ccw: bool,
) {
    use std::f32::consts::PI;
    // Normalise sweep direction.
    if !ccw && a1 < a0 {
        a1 += 2.0 * PI * ((a0 - a1) / (2.0 * PI)).ceil().max(1.0);
    }
    if ccw && a1 > a0 {
        a0 += 2.0 * PI * ((a1 - a0) / (2.0 * PI)).ceil().max(1.0);
    }
    let total = (a1 - a0).abs();
    let n = ((total / (PI / 2.0)).ceil() as usize).max(1);
    let delta = (a1 - a0) / n as f32;
    let (sinr, cosr) = rotation.sin_cos();
    let pt = |ang: f32| -> (f32, f32) {
        let xe = rx * ang.cos();
        let ye = ry * ang.sin();
        (cx + xe * cosr - ye * sinr, cy + xe * sinr + ye * cosr)
    };
    // Start point.
    let (sx, sy) = pt(a0);
    let sp = map_pt(t, sx, sy);
    if *has_cur {
        out.push(PathOp::Line(sp.x, sp.y));
    } else {
        out.push(PathOp::Move(sp.x, sp.y));
        *has_cur = true;
    }
    let k = 4.0 / 3.0 * (delta / 4.0).tan();
    let mut ang = a0;
    for _ in 0..n {
        let next = ang + delta;
        let (x0, y0) = pt(ang);
        let (x1, y1) = pt(next);
        // Tangents.
        let (dx0, dy0) = (-rx * ang.sin(), ry * ang.cos());
        let (dx1, dy1) = (-rx * next.sin(), ry * next.cos());
        let rot = |dx: f32, dy: f32| (dx * cosr - dy * sinr, dx * sinr + dy * cosr);
        let (tdx0, tdy0) = rot(dx0, dy0);
        let (tdx1, tdy1) = rot(dx1, dy1);
        let c1 = map_pt(t, x0 + k * tdx0, y0 + k * tdy0);
        let c2 = map_pt(t, x1 - k * tdx1, y1 - k * tdy1);
        let e = map_pt(t, x1, y1);
        out.push(PathOp::Cubic(c1.x, c1.y, c2.x, c2.y, e.x, e.y));
        ang = next;
    }
}

fn style_to_shader(style: &Style, alpha: f32) -> Option<Shader<'static>> {
    match style {
        Style::Color(argb) => {
            let a = ((argb >> 24) & 0xFF) as f32 / 255.0 * alpha;
            Some(Shader::SolidColor(Color::from_rgba(
                ((argb >> 16) & 0xFF) as f32 / 255.0,
                ((argb >> 8) & 0xFF) as f32 / 255.0,
                (argb & 0xFF) as f32 / 255.0,
                a.clamp(0.0, 1.0),
            )?))
        }
        Style::Gradient(g) => {
            let mut stops = Vec::with_capacity(g.stops.len());
            for (off, argb) in &g.stops {
                let a = ((argb >> 24) & 0xFF) as f32 / 255.0 * alpha;
                let col = Color::from_rgba(
                    ((argb >> 16) & 0xFF) as f32 / 255.0,
                    ((argb >> 8) & 0xFF) as f32 / 255.0,
                    (argb & 0xFF) as f32 / 255.0,
                    a.clamp(0.0, 1.0),
                )?;
                stops.push(GradientStop::new(off.clamp(0.0, 1.0), col));
            }
            if stops.is_empty() {
                return None;
            }
            if g.linear {
                LinearGradient::new(
                    Point::from_xy(g.coords[0], g.coords[1]),
                    Point::from_xy(g.coords[2], g.coords[3]),
                    stops,
                    SpreadMode::Pad,
                    Transform::identity(),
                )
            } else {
                RadialGradient::new(
                    Point::from_xy(g.coords[0], g.coords[1]),
                    Point::from_xy(g.coords[3], g.coords[4]),
                    g.coords[5].max(0.01),
                    stops,
                    SpreadMode::Pad,
                    Transform::identity(),
                )
            }
        }
    }
}

fn parse_style(op: &[Value], i: usize) -> Option<Style> {
    let v = op.get(i)?;
    if let Some(s) = v.as_str() {
        return Some(Style::Color(
            crate::css_parse::parse_color_str(s).unwrap_or(0xFF_000000),
        ));
    }
    // Gradient: ["fsg", linear(bool), [c0..c5], [[off,"color"],...]]
    None
}

fn replay_one(c: &mut Canvas2d, name: &str, op: &[Value], te: &mut TextEngine) {
    match name {
        "sv" => c.stack.push(c.state.clone()),
        "rs" => {
            if let Some(s) = c.stack.pop() {
                c.state = s;
            }
        }
        // transforms
        "t" => {
            c.state.transform = Transform::from_row(
                num(op, 1), num(op, 2), num(op, 3), num(op, 4), num(op, 5), num(op, 6),
            );
        }
        "tf" => {
            let m = Transform::from_row(
                num(op, 1), num(op, 2), num(op, 3), num(op, 4), num(op, 5), num(op, 6),
            );
            c.state.transform = c.state.transform.pre_concat(m);
        }
        "tr" => {
            c.state.transform = c.state.transform.pre_concat(Transform::from_translate(num(op, 1), num(op, 2)));
        }
        "sc" => {
            c.state.transform = c.state.transform.pre_concat(Transform::from_scale(num(op, 1), num(op, 2)));
        }
        "ro" => {
            c.state.transform = c.state.transform.pre_concat(Transform::from_rotate(num(op, 1).to_degrees()));
        }
        "rt" => c.state.transform = Transform::identity(),
        // styles
        "ga" => c.state.global_alpha = num(op, 1).clamp(0.0, 1.0),
        "fs" => {
            if let Some(s) = parse_style(op, 1) {
                c.state.fill = s;
            }
        }
        "ss" => {
            if let Some(s) = parse_style(op, 1) {
                c.state.stroke = s;
            }
        }
        "fsg" | "ssg" => {
            let linear = op.get(1).and_then(|v| v.as_bool()).unwrap_or(true);
            let mut coords = [0.0f32; 6];
            if let Some(cs) = op.get(2).and_then(|v| v.as_array()) {
                for (i, v) in cs.iter().take(6).enumerate() {
                    coords[i] = v.as_f64().unwrap_or(0.0) as f32;
                }
            }
            let mut stops = Vec::new();
            if let Some(ss) = op.get(3).and_then(|v| v.as_array()) {
                for s in ss {
                    if let Some(pair) = s.as_array() {
                        let off = pair.get(0).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                        let col = pair
                            .get(1)
                            .and_then(|v| v.as_str())
                            .and_then(crate::css_parse::parse_color_str)
                            .unwrap_or(0xFF_000000);
                        stops.push((off, col));
                    }
                }
            }
            let g = Style::Gradient(Gradient { linear, coords, stops });
            if name == "fsg" {
                c.state.fill = g;
            } else {
                c.state.stroke = g;
            }
        }
        "lw" => c.state.line_width = num(op, 1).max(0.0),
        "lc" => c.state.line_cap = num(op, 1) as u8,
        "lj" => c.state.line_join = num(op, 1) as u8,
        "ld" => {
            c.state.line_dash.clear();
            if let Some(a) = op.get(1).and_then(|v| v.as_array()) {
                for v in a {
                    c.state.line_dash.push(v.as_f64().unwrap_or(0.0) as f32);
                }
            }
        }
        "ldo" => c.state.line_dash_offset = num(op, 1),
        "fo" => {
            c.state.font_px = num(op, 1).max(1.0);
            c.state.font_mono = op.get(2).and_then(|v| v.as_bool()).unwrap_or(false);
        }
        "ta" => c.state.text_align = num(op, 1) as u8,
        "tb" => c.state.text_baseline = num(op, 1) as u8,
        "gco" => {
            c.state.blend = match op.get(1).and_then(|v| v.as_str()).unwrap_or("source-over") {
                "source-over" => BlendMode::SourceOver,
                "source-atop" => BlendMode::SourceAtop,
                "source-in" => BlendMode::SourceIn,
                "source-out" => BlendMode::SourceOut,
                "destination-over" => BlendMode::DestinationOver,
                "destination-atop" => BlendMode::DestinationAtop,
                "destination-in" => BlendMode::DestinationIn,
                "destination-out" => BlendMode::DestinationOut,
                "lighter" => BlendMode::Plus,
                "copy" => BlendMode::Source,
                "xor" => BlendMode::Xor,
                "multiply" => BlendMode::Multiply,
                "screen" => BlendMode::Screen,
                _ => BlendMode::SourceOver,
            };
        }
        // rects
        "clr" => clear_rect(c, num(op, 1), num(op, 2), num(op, 3), num(op, 4)),
        "fr" => fill_rect(c, num(op, 1), num(op, 2), num(op, 3), num(op, 4)),
        "sr" => stroke_rect(c, num(op, 1), num(op, 2), num(op, 3), num(op, 4)),
        // path building (record device-space points)
        "bp" => {
            c.path.clear();
            c.has_cur = false;
        }
        "cp" => {
            c.path.push(PathOp::Close);
            c.has_cur = false;
        }
        "mt" => {
            let p = map_pt(&c.state.transform, num(op, 1), num(op, 2));
            c.path.push(PathOp::Move(p.x, p.y));
            c.cur = p;
            c.start = p;
            c.has_cur = true;
        }
        "lt" => {
            let p = map_pt(&c.state.transform, num(op, 1), num(op, 2));
            if !c.has_cur {
                c.path.push(PathOp::Move(p.x, p.y));
                c.has_cur = true;
                c.start = p;
            } else {
                c.path.push(PathOp::Line(p.x, p.y));
            }
            c.cur = p;
        }
        "bc" => {
            let t = &c.state.transform;
            let c1 = map_pt(t, num(op, 1), num(op, 2));
            let c2 = map_pt(t, num(op, 3), num(op, 4));
            let e = map_pt(t, num(op, 5), num(op, 6));
            c.path.push(PathOp::Cubic(c1.x, c1.y, c2.x, c2.y, e.x, e.y));
            c.cur = e;
        }
        "qc" => {
            // Quadratic → cubic.
            let t = &c.state.transform;
            let q = map_pt(t, num(op, 1), num(op, 2));
            let e = map_pt(t, num(op, 3), num(op, 4));
            let s = c.cur;
            let c1 = Point::from_xy(s.x + 2.0 / 3.0 * (q.x - s.x), s.y + 2.0 / 3.0 * (q.y - s.y));
            let c2 = Point::from_xy(e.x + 2.0 / 3.0 * (q.x - e.x), e.y + 2.0 / 3.0 * (q.y - e.y));
            c.path.push(PathOp::Cubic(c1.x, c1.y, c2.x, c2.y, e.x, e.y));
            c.cur = e;
        }
        "ar" => {
            let mut hc = c.has_cur;
            arc_ops(
                &mut c.path, &c.state.transform, &mut hc,
                num(op, 1), num(op, 2), num(op, 3), num(op, 3), 0.0,
                num(op, 4), num(op, 5),
                op.get(6).and_then(|v| v.as_bool()).unwrap_or(false),
            );
            c.has_cur = hc;
        }
        "ae" => {
            let mut hc = c.has_cur;
            arc_ops(
                &mut c.path, &c.state.transform, &mut hc,
                num(op, 1), num(op, 2), num(op, 3), num(op, 4), num(op, 5),
                num(op, 6), num(op, 7),
                op.get(8).and_then(|v| v.as_bool()).unwrap_or(false),
            );
            c.has_cur = hc;
        }
        "re" => {
            // rect: subpath of 4 corners (device space).
            let t = &c.state.transform;
            let (x, y, w, h) = (num(op, 1), num(op, 2), num(op, 3), num(op, 4));
            let p0 = map_pt(t, x, y);
            let p1 = map_pt(t, x + w, y);
            let p2 = map_pt(t, x + w, y + h);
            let p3 = map_pt(t, x, y + h);
            c.path.push(PathOp::Move(p0.x, p0.y));
            c.path.push(PathOp::Line(p1.x, p1.y));
            c.path.push(PathOp::Line(p2.x, p2.y));
            c.path.push(PathOp::Line(p3.x, p3.y));
            c.path.push(PathOp::Close);
            c.cur = p0;
            c.has_cur = false;
        }
        "fl" => do_fill(c, op.get(1).and_then(|v| v.as_str()) == Some("evenodd")),
        "sk" => do_stroke(c),
        "cl" => do_clip(c, op.get(1).and_then(|v| v.as_str()) == Some("evenodd")),
        "ft" => fill_text(c, te, op, false),
        "st" => fill_text(c, te, op, true),
        "di" => draw_image(c, op),
        _ => {}
    }
}

/// drawImage from another canvas surface. Arg forms (after src id):
///   3-arg: dx dy                      (natural size)
///   5-arg: dx dy dw dh                (scaled)
///   9-arg: sx sy sw sh dx dy dw dh    (sub-rect, scaled)
fn draw_image(c: &mut Canvas2d, op: &[Value]) {
    let src_id = op.get(1).and_then(|v| v.as_f64()).unwrap_or(-1.0) as i64;
    if src_id < 0 {
        return;
    }
    // Source dimensions WITHOUT cloning the surface. The previous version
    // did `pixmap.clone()` here — copying the entire glyph atlas (megabytes)
    // on every single drawImage. xterm blits ~1600 glyphs/redraw, so that was
    // gigabytes of memcpy per frame. `flush` removed the destination surface
    // from the registry before replay, so we can borrow the source directly
    // (below) with no aliasing borrow and no copy.
    let dims = SURFACES.with(|s| {
        s.borrow()
            .get(&(src_id as u32))
            .map(|sc| (sc.pixmap.width() as f32, sc.pixmap.height() as f32))
    });
    let Some((sw_full, sh_full)) = dims else { return };

    // Decode the argument variant by count.
    let n = op.len();
    let (sx, sy, sw, sh, dx, dy, dw, dh) = if n >= 10 {
        (num(op, 2), num(op, 3), num(op, 4), num(op, 5), num(op, 6), num(op, 7), num(op, 8), num(op, 9))
    } else if n >= 6 {
        (0.0, 0.0, sw_full, sh_full, num(op, 2), num(op, 3), num(op, 4), num(op, 5))
    } else {
        (0.0, 0.0, sw_full, sh_full, num(op, 2), num(op, 3), sw_full, sh_full)
    };
    if sw <= 0.0 || sh <= 0.0 || dw <= 0.0 || dh <= 0.0 {
        return;
    }

    // Effective destination scale, folding in an axis-aligned CTM (canvas
    // renderers blit glyphs under an identity/translate transform).
    let ctm = &c.state.transform;
    let eff_dw = dw * ctm.sx;
    let eff_dh = dh * ctm.sy;
    let dst = map_pt(ctm, dx, dy);
    // 1:1 (no scaling) — what xterm does for every atlas glyph. Crisp integer
    // sub-rect copy; otherwise a bounded nearest-neighbour resample.
    let one_to_one =
        axis_aligned(ctm) && (eff_dw - sw).abs() < 0.5 && (eff_dh - sh).abs() < 0.5;

    SURFACES.with(|s| {
        let store = s.borrow();
        let Some(src) = store.get(&(src_id as u32)) else { return };
        let src_pm = &src.pixmap;
        if one_to_one {
            blit_subrect(
                c,
                src_pm,
                sx.round() as i32,
                sy.round() as i32,
                sw.round().max(1.0) as i32,
                sh.round().max(1.0) as i32,
                dst.x.round() as i32,
                dst.y.round() as i32,
            );
        } else {
            blit_scaled(c, src_pm, sx, sy, sw, sh, dst.x, dst.y, eff_dw, eff_dh);
        }
    });
}

/// Nearest-neighbour scaled blit of `src`'s sub-rect (sx,sy,sw,sh) into the
/// destination rect (dx,dy,dw,dh) on `c`'s surface, SourceOver, honouring
/// globalAlpha and an active rectangular/path clip mask. Loops only over the
/// (clamped) destination pixels.
#[allow(clippy::too_many_arguments)]
fn blit_scaled(
    c: &mut Canvas2d,
    src: &Pixmap,
    sx: f32, sy: f32, sw: f32, sh: f32,
    dx: f32, dy: f32, dw: f32, dh: f32,
) {
    if dw <= 0.0 || dh <= 0.0 || sw <= 0.0 || sh <= 0.0 {
        return;
    }
    let spw = src.width() as i32;
    let sph = src.height() as i32;
    let cw = c.pixmap.width() as i32;
    let ch = c.pixmap.height() as i32;
    // Destination bounds, clamped to the surface AND any active rect clip.
    let (rcx0, rcy0, rcx1, rcy1) = match c.state.clip_rect {
        Some((x0, y0, x1, y1)) => (x0, y0, x1, y1),
        None => (0.0, 0.0, cw as f32, ch as f32),
    };
    let dx0 = dx.floor().max(0.0).max(rcx0.floor()) as i32;
    let dy0 = dy.floor().max(0.0).max(rcy0.floor()) as i32;
    let dx1 = (dx + dw).ceil().min(cw as f32).min(rcx1.ceil()) as i32;
    let dy1 = (dy + dh).ceil().min(ch as f32).min(rcy1.ceil()) as i32;
    if dx1 <= dx0 || dy1 <= dy0 {
        return;
    }
    let u_step = sw / dw;
    let v_step = sh / dh;
    let alpha = c.state.global_alpha.clamp(0.0, 1.0);
    let alpha_u = (alpha * 255.0) as u32;
    // Disjoint field borrows: read the clip mask while mutating the pixmap.
    let clip = c.state.clip.as_ref();
    let clip_data = clip.map(|m| m.data());
    let src_px = src.pixels();
    let dst_px = c.pixmap.pixels_mut();
    for dyy in dy0..dy1 {
        let v = sy + (dyy as f32 + 0.5 - dy) * v_step;
        let svy = v.floor() as i32;
        if svy < 0 || svy >= sph {
            continue;
        }
        let src_row = (svy * spw) as usize;
        let dst_row = (dyy * cw) as usize;
        for dxx in dx0..dx1 {
            let u = sx + (dxx as f32 + 0.5 - dx) * u_step;
            let sux = u.floor() as i32;
            if sux < 0 || sux >= spw {
                continue;
            }
            let s = src_px[src_row + sux as usize];
            let mut sa = s.alpha() as u32;
            if sa == 0 {
                continue;
            }
            let mut sr = s.red() as u32;
            let mut sg = s.green() as u32;
            let mut sb = s.blue() as u32;
            if alpha < 1.0 {
                sr = sr * alpha_u / 255;
                sg = sg * alpha_u / 255;
                sb = sb * alpha_u / 255;
                sa = sa * alpha_u / 255;
            }
            let di = dst_row + dxx as usize;
            if let Some(cd) = clip_data {
                let cov = cd[di] as u32;
                if cov == 0 {
                    continue;
                }
                if cov < 255 {
                    sr = sr * cov / 255;
                    sg = sg * cov / 255;
                    sb = sb * cov / 255;
                    sa = sa * cov / 255;
                }
            }
            let d = dst_px[di];
            let inv = 255 - sa;
            let nr = sr + d.red() as u32 * inv / 255;
            let ng = sg + d.green() as u32 * inv / 255;
            let nb = sb + d.blue() as u32 * inv / 255;
            let na = sa + d.alpha() as u32 * inv / 255;
            if let Some(p) =
                PremultipliedColorU8::from_rgba(nr as u8, ng as u8, nb as u8, na as u8)
            {
                dst_px[di] = p;
            }
        }
    }
}

/// Exact 1:1 alpha-composite of a source sub-rect into the destination
/// surface at integer coordinates. tiny-skia `draw_pixmap` would resample;
/// for crisp glyph blits we want a straight per-pixel SourceOver copy.
fn blit_subrect(
    c: &mut Canvas2d,
    src: &Pixmap,
    sx: i32, sy: i32, w: i32, h: i32,
    dx: i32, dy: i32,
) {
    let sw = src.width() as i32;
    let sh = src.height() as i32;
    let dw = c.pixmap.width() as i32;
    let dh = c.pixmap.height() as i32;
    let alpha = c.state.global_alpha.clamp(0.0, 1.0);
    // Active clip (rectangular bounds and/or non-rect mask). Read before the
    // mutable pixmap borrow; both are disjoint fields of `c`.
    let (cl_x0, cl_y0, cl_x1, cl_y1) = match c.state.clip_rect {
        Some((x0, y0, x1, y1)) => (x0.round() as i32, y0.round() as i32, x1.round() as i32, y1.round() as i32),
        None => (i32::MIN, i32::MIN, i32::MAX, i32::MAX),
    };
    let clip_data = c.state.clip.as_ref().map(|m| m.data());
    let src_px = src.pixels();
    let dst_px = c.pixmap.pixels_mut();
    for row in 0..h {
        let syy = sy + row;
        let dyy = dy + row;
        if syy < 0 || syy >= sh || dyy < 0 || dyy >= dh { continue; }
        if dyy < cl_y0 || dyy >= cl_y1 { continue; }
        for col in 0..w {
            let sxx = sx + col;
            let dxx = dx + col;
            if sxx < 0 || sxx >= sw || dxx < 0 || dxx >= dw { continue; }
            if dxx < cl_x0 || dxx >= cl_x1 { continue; }
            let s = src_px[(syy * sw + sxx) as usize];
            let mut sa = s.alpha() as u32;
            if sa == 0 { continue; }
            let mut sr = s.red() as u32;
            let mut sg = s.green() as u32;
            let mut sb = s.blue() as u32;
            if alpha < 1.0 {
                let a = (alpha * 255.0) as u32;
                sr = sr * a / 255; sg = sg * a / 255; sb = sb * a / 255; sa = sa * a / 255;
            }
            let di = (dyy * dw + dxx) as usize;
            if let Some(md) = clip_data {
                let cov = md[di] as u32;
                if cov == 0 { continue; }
                if cov < 255 { sr = sr * cov / 255; sg = sg * cov / 255; sb = sb * cov / 255; sa = sa * cov / 255; }
            }
            let d = dst_px[di];
            let inv = 255 - sa;
            let nr = sr + (d.red() as u32 * inv) / 255;
            let ng = sg + (d.green() as u32 * inv) / 255;
            let nb = sb + (d.blue() as u32 * inv) / 255;
            let na = sa + (d.alpha() as u32 * inv) / 255;
            if let Some(p) = PremultipliedColorU8::from_rgba(nr as u8, ng as u8, nb as u8, na as u8) {
                dst_px[di] = p;
            }
        }
    }
}

fn rect_path_device(c: &Canvas2d, x: f32, y: f32, w: f32, h: f32) -> Option<tiny_skia::Path> {
    let t = &c.state.transform;
    let p0 = map_pt(t, x, y);
    let p1 = map_pt(t, x + w, y);
    let p2 = map_pt(t, x + w, y + h);
    let p3 = map_pt(t, x, y + h);
    let mut pb = PathBuilder::new();
    pb.move_to(p0.x, p0.y);
    pb.line_to(p1.x, p1.y);
    pb.line_to(p2.x, p2.y);
    pb.line_to(p3.x, p3.y);
    pb.close();
    pb.finish()
}

fn axis_aligned(t: &Transform) -> bool {
    t.kx.abs() < 1e-4 && t.ky.abs() < 1e-4
}

fn fill_rect(c: &mut Canvas2d, x: f32, y: f32, w: f32, h: f32) {
    if w == 0.0 || h == 0.0 {
        return;
    }
    let Some(shader) = style_to_shader(&c.state.fill, c.state.global_alpha) else { return };
    let mut paint = Paint::default();
    paint.shader = shader;
    paint.blend_mode = c.state.blend;
    if axis_aligned(&c.state.transform) {
        // Fast crisp path for the common case. A rectangular clip is applied
        // by intersecting bounds (cheap); an explicit non-rect mask is passed
        // through to tiny-skia.
        let p0 = map_pt(&c.state.transform, x, y);
        let p1 = map_pt(&c.state.transform, x + w, y + h);
        let mut rx0 = p0.x.min(p1.x);
        let mut ry0 = p0.y.min(p1.y);
        let mut rx1 = p0.x.max(p1.x);
        let mut ry1 = p0.y.max(p1.y);
        if let Some((cx0, cy0, cx1, cy1)) = c.state.clip_rect {
            rx0 = rx0.max(cx0);
            ry0 = ry0.max(cy0);
            rx1 = rx1.min(cx1);
            ry1 = ry1.min(cy1);
        }
        if rx1 > rx0 && ry1 > ry0 {
            if let Some(rect) = Rect::from_xywh(rx0, ry0, (rx1 - rx0).max(0.0001), (ry1 - ry0).max(0.0001)) {
                c.pixmap.fill_rect(rect, &paint, Transform::identity(), c.state.clip.as_ref());
            }
        }
    } else if let Some(path) = rect_path_device(c, x, y, w, h) {
        paint.anti_alias = true;
        let mask = clip_mask(c);
        c.pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), mask.as_ref());
    }
}

fn clear_rect(c: &mut Canvas2d, x: f32, y: f32, w: f32, h: f32) {
    if w == 0.0 || h == 0.0 {
        return;
    }
    // canvas `clearRect` resets pixels to fully transparent. tiny-skia's
    // fill with a 0-alpha paint is a no-op (it skips fully-transparent
    // fills), and BlendMode::Clear with a 0-alpha paint is likewise
    // optimised away — which left scratch/atlas canvases never cleared, so
    // xterm's glyph cache accumulated overlapping ink into garbage. For the
    // common axis-aligned case we therefore zero the pixels directly.
    if axis_aligned(&c.state.transform) {
        let p0 = map_pt(&c.state.transform, x, y);
        let p1 = map_pt(&c.state.transform, x + w, y + h);
        let pw = c.pixmap.width() as i32;
        let ph = c.pixmap.height() as i32;
        // clearRect honours the clipping region (canvas spec), so clamp to any
        // active rectangular clip as well as the surface bounds.
        let (clx0, cly0, clx1, cly1) = match c.state.clip_rect {
            Some((a, b, cc, d)) => (a, b, cc, d),
            None => (0.0, 0.0, pw as f32, ph as f32),
        };
        let x0 = p0.x.min(p1.x).floor().max(0.0).max(clx0.floor()) as i32;
        let y0 = p0.y.min(p1.y).floor().max(0.0).max(cly0.floor()) as i32;
        let x1 = p0.x.max(p1.x).ceil().min(pw as f32).min(clx1.ceil()) as i32;
        let y1 = p0.y.max(p1.y).ceil().min(ph as f32).min(cly1.ceil()) as i32;
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let transparent = PremultipliedColorU8::from_rgba(0, 0, 0, 0).unwrap();
        let data = c.pixmap.pixels_mut();
        for py in y0..y1 {
            let row = py as usize * pw as usize;
            for px in x0..x1 {
                data[row + px as usize] = transparent;
            }
        }
        return;
    }
    // Rotated/skewed transform: fall back to a Clear-blend path fill with a
    // non-zero-alpha paint so tiny-skia doesn't optimise it away.
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.blend_mode = BlendMode::Clear;
    if let Some(path) = rect_path_device(c, x, y, w, h) {
        let mask = clip_mask(c);
        c.pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), mask.as_ref());
    }
}

fn stroke_rect(c: &mut Canvas2d, x: f32, y: f32, w: f32, h: f32) {
    let Some(path) = rect_path_device(c, x, y, w, h) else { return };
    stroke_path(c, &path);
}

fn do_fill(c: &mut Canvas2d, even_odd: bool) {
    let Some(path) = build_path(&c.path) else { return };
    let Some(shader) = style_to_shader(&c.state.fill, c.state.global_alpha) else { return };
    let mut paint = Paint::default();
    paint.shader = shader;
    paint.blend_mode = c.state.blend;
    paint.anti_alias = true;
    let rule = if even_odd { FillRule::EvenOdd } else { FillRule::Winding };
    let mask = clip_mask(c);
    c.pixmap.fill_path(&path, &paint, rule, Transform::identity(), mask.as_ref());
}

fn do_stroke(c: &mut Canvas2d) {
    let Some(path) = build_path(&c.path) else { return };
    stroke_path(c, &path);
}

fn stroke_path(c: &mut Canvas2d, path: &tiny_skia::Path) {
    let Some(shader) = style_to_shader(&c.state.stroke, c.state.global_alpha) else { return };
    let mut paint = Paint::default();
    paint.shader = shader;
    paint.blend_mode = c.state.blend;
    paint.anti_alias = true;
    // Approx CTM scale for line width (canvas scales stroke by CTM).
    let sx = (c.state.transform.sx.powi(2) + c.state.transform.ky.powi(2)).sqrt();
    let sy = (c.state.transform.sy.powi(2) + c.state.transform.kx.powi(2)).sqrt();
    let scale = ((sx + sy) * 0.5).max(0.0001);
    let mut stroke = Stroke {
        width: (c.state.line_width * scale).max(0.01),
        line_cap: match c.state.line_cap {
            1 => tiny_skia::LineCap::Round,
            2 => tiny_skia::LineCap::Square,
            _ => tiny_skia::LineCap::Butt,
        },
        line_join: match c.state.line_join {
            1 => tiny_skia::LineJoin::Round,
            2 => tiny_skia::LineJoin::Bevel,
            _ => tiny_skia::LineJoin::Miter,
        },
        ..Stroke::default()
    };
    if !c.state.line_dash.is_empty() {
        let dashes: Vec<f32> = c.state.line_dash.iter().map(|d| (d * scale).max(0.01)).collect();
        stroke.dash = StrokeDash::new(dashes, c.state.line_dash_offset * scale);
    }
    let mask = clip_mask(c);
    c.pixmap
        .stroke_path(path, &paint, &stroke, Transform::identity(), mask.as_ref());
}

/// If `ops` describe a single axis-aligned rectangle (device space), return
/// its bounds (x0,y0,x1,y1). xterm clips every glyph to its cell with exactly
/// this shape; keeping it off the Mask path is the whole point of `clip_rect`.
fn path_as_rect(ops: &[PathOp]) -> Option<(f32, f32, f32, f32)> {
    let mut pts: Vec<(f32, f32)> = Vec::with_capacity(5);
    for op in ops {
        match *op {
            PathOp::Move(x, y) | PathOp::Line(x, y) => pts.push((x, y)),
            PathOp::Close => {}
            PathOp::Cubic(..) => return None,
        }
    }
    if pts.len() == 5 && pts[0] == pts[4] {
        pts.pop();
    }
    if pts.len() != 4 {
        return None;
    }
    let x0 = pts.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
    let x1 = pts.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max);
    let y0 = pts.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
    let y1 = pts.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max);
    if x1 - x0 < 0.01 || y1 - y0 < 0.01 {
        return None;
    }
    // Every vertex must lie on a bbox corner (i.e. it's axis-aligned).
    for &(x, y) in &pts {
        let on_x = (x - x0).abs() < 0.01 || (x - x1).abs() < 0.01;
        let on_y = (y - y0).abs() < 0.01 || (y - y1).abs() < 0.01;
        if !(on_x && on_y) {
            return None;
        }
    }
    Some((x0, y0, x1, y1))
}

/// Materialise the active clip as a tiny-skia Mask for path/text ops (which
/// can't take rect bounds directly). Returns the explicit mask if one exists,
/// else builds one from the rectangular clip, else None. These ops are rare
/// in the terminal hot path, so the per-call mask cost here is acceptable.
fn clip_mask(c: &Canvas2d) -> Option<Mask> {
    if let Some(m) = &c.state.clip {
        return Some(m.clone());
    }
    let (x0, y0, x1, y1) = c.state.clip_rect?;
    let mut m = Mask::new(c.pixmap.width(), c.pixmap.height())?;
    let r = Rect::from_xywh(x0, y0, (x1 - x0).max(0.01), (y1 - y0).max(0.01))?;
    let mut pb = PathBuilder::new();
    pb.push_rect(r);
    let p = pb.finish()?;
    m.fill_path(&p, FillRule::Winding, true, Transform::identity());
    Some(m)
}

fn do_clip(c: &mut Canvas2d, even_odd: bool) {
    // Fast path: a rectangular clip with no active non-rect mask is tracked as
    // cheap bounds, not a megapixel Mask (the terminal's per-cell clip).
    if c.state.clip.is_none() {
        if let Some(r) = path_as_rect(&c.path) {
            c.state.clip_rect = Some(match c.state.clip_rect {
                Some((x0, y0, x1, y1)) => (x0.max(r.0), y0.max(r.1), x1.min(r.2), y1.min(r.3)),
                None => r,
            });
            return;
        }
    }
    // Non-rectangular (or refining an existing mask): build/intersect a Mask,
    // seeded from any active rect clip so the bound isn't lost.
    let Some(path) = build_path(&c.path) else { return };
    let rule = if even_odd { FillRule::EvenOdd } else { FillRule::Winding };
    let mut mask = match &c.state.clip {
        Some(m) => m.clone(),
        None => match Mask::new(c.pixmap.width(), c.pixmap.height()) {
            Some(mut m) => {
                let seed = c
                    .state
                    .clip_rect
                    .and_then(|(x0, y0, x1, y1)| {
                        Rect::from_xywh(x0, y0, (x1 - x0).max(0.01), (y1 - y0).max(0.01))
                    })
                    .or_else(|| {
                        Rect::from_xywh(0.0, 0.0, c.pixmap.width() as f32, c.pixmap.height() as f32)
                    });
                if let Some(r) = seed {
                    let mut pb = PathBuilder::new();
                    pb.push_rect(r);
                    if let Some(p) = pb.finish() {
                        m.fill_path(&p, FillRule::Winding, true, Transform::identity());
                    }
                }
                m
            }
            None => return,
        },
    };
    mask.intersect_path(&path, rule, true, Transform::identity());
    c.state.clip = Some(mask);
}

fn fill_text(c: &mut Canvas2d, te: &mut TextEngine, op: &[Value], _stroke: bool) {
    let text = op.get(1).and_then(|v| v.as_str()).unwrap_or("");
    if text.is_empty() {
        return;
    }
    let x = num(op, 2);
    let y = num(op, 3);
    // Color from fillStyle (solid only for text).
    let argb = match &c.state.fill {
        Style::Color(a) => *a,
        Style::Gradient(g) => g.stops.first().map(|s| s.1).unwrap_or(0xFF_000000),
    };
    // Apply global alpha to the text color.
    let base_a = ((argb >> 24) & 0xFF) as f32 / 255.0 * c.state.global_alpha;
    let color = (((base_a * 255.0) as u32) << 24) | (argb & 0x00FF_FFFF);

    let px = c.state.font_px;
    let mono = c.state.font_mono;
    let (tw, _th) = te.measure_styled_mono(text, px, 0.0, mono);
    // Horizontal align.
    let ax = match c.state.text_align {
        1 => x - tw / 2.0,
        2 => x - tw,
        _ => x,
    };
    // Vertical: TextEngine draws from the top of the line box; canvas y is
    // the baseline (alphabetic) by default. Convert via ascent.
    let (ascent, descent) = te.ascent_descent(px).unwrap_or((px * 0.8, px * 0.2));
    let top = match c.state.text_baseline {
        1 => y,                            // top
        4 => y,                            // hanging ≈ top
        2 => y - (ascent + descent) / 2.0, // middle
        3 => y - (ascent + descent),       // bottom
        _ => y - ascent,                   // alphabetic baseline
    };
    // Map origin through the CTM (translate-correct; ignores rotation of
    // glyph shapes — a documented subset limitation).
    let p = map_pt(&c.state.transform, ax, top);
    // Clip band: if a rect clip is active, bound the text to its top/bottom;
    // otherwise unbounded.
    let (clip_top, clip_bottom) = match c.state.clip_rect {
        Some((_, y0, _, y1)) => (y0, y1),
        None => (f32::NEG_INFINITY, f32::INFINITY),
    };
    te.draw_text_styled_mono(
        &mut c.pixmap, text, p.x, p.y, px, color,
        clip_top, clip_bottom, 0.0, mono,
    );
}
