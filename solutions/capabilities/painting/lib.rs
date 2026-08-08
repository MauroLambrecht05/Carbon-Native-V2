// The tiny-skia paint dispatch — walks the scene graph Taffy laid out and
// issues draw calls. Promoted out of carbon-mini's main.rs (where it lived
// as an inline `mod paint { ... }`) into its own crate.
#[cfg(feature = "gpu")]
use carbon_gpu_canvas::gpu;
// Module-level aliases too (not just the specific items above) — svg.rs and
// canvas2d.rs reach these as `crate::scene::` / `crate::css_parse::`
// (fully-qualified, unchanged from when they lived in carbon-mini directly).
pub(crate) use carbon_layout::scene;
pub(crate) use carbon_layout::css_parse;
use carbon_layout::scene::{NodeKind, Scene};
use carbon_text_renderer as text;
use carbon_text_renderer::TextEngine;
// ── Layout ──────────────────────────────────────────────────────────────────
//
//   domain/          blur — a box-blur kernel over a pixel buffer. It imports
//                    nothing, from this crate or any other: pure arithmetic.
//   infrastructure/  canvas2d and svg — both drive tiny-skia to put pixels in
//                    a Pixmap, and both would be replaced together if the
//                    rasterizer changed.
//
// This file, the crate root, is the paint dispatch: it walks the scene graph
// from carbon-layout and decides what each node type draws.
//
// `#[path]` keeps the module names, so nothing downstream changed.
#[path = "domain/blur.rs"]
mod blur;
// pub: carbon-mini's main.rs calls carbon_paint::canvas2d:: directly for
// the <canvas> 2D context host imports (create/resize/destroy/flush/...),
// not just through this crate's own paint dispatch.
#[path = "infrastructure/canvas2d.rs"]
pub mod canvas2d;
#[path = "infrastructure/svg.rs"]
mod svg;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

/// Profiling — optional frame zone markers. Duplicated from carbon-mini's
/// main.rs (identical body) rather than shared, since it's a two-line
/// macro_rules! with no dependency of its own — not worth a shared crate.
#[cfg(feature = "profiling")]
macro_rules! prof_zone {
    ($name:expr) => {
        if std::env::var_os("CARBON_MINI_PROFILING").is_some() {
            eprintln!("[prof-zone-start] {}", $name);
        }
    };
}
#[cfg(not(feature = "profiling"))]
macro_rules! prof_zone {
    ($name:expr) => {};
}

fn debug_color_for_id(id: u32) -> (u8, u8, u8) {
    let hash = id.wrapping_mul(2_654_435_761);
    let hue = (hash % 360) as f32 / 360.0;
    hsv_to_rgb(hue, 0.7, 0.9)
}

/// Convert HSV (each in 0..1) to 8-bit RGB. Standard formulation —
/// only used by `debug_color_for_id`, no perf concerns.
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> (u8, u8, u8) {
    let c = v * s;
    let h6 = h * 6.0;
    let x = c * (1.0 - ((h6 % 2.0) - 1.0).abs());
    let m = v - c;
    let (r1, g1, b1) = if h6 < 1.0 {
        (c, x, 0.0)
    } else if h6 < 2.0 {
        (x, c, 0.0)
    } else if h6 < 3.0 {
        (0.0, c, x)
    } else if h6 < 4.0 {
        (0.0, x, c)
    } else if h6 < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    (
        ((r1 + m) * 255.0).clamp(0.0, 255.0) as u8,
        ((g1 + m) * 255.0).clamp(0.0, 255.0) as u8,
        ((b1 + m) * 255.0).clamp(0.0, 255.0) as u8,
    )
}

// [svg, shadow, canvas, text] accumulated ms per frame (CARBON_PERF).
thread_local! {
    pub static PAINT_PERF: RefCell<[f64; 4]> = const { RefCell::new([0.0; 4]) };
}
#[inline]
fn perf_add(slot: usize, t: std::time::Instant) {
    PAINT_PERF.with(|p| p.borrow_mut()[slot] += t.elapsed().as_secs_f64() * 1000.0);
}
use std::time::Instant;
pub use tiny_skia::Pixmap;
use tiny_skia::{Color, FillRule, Paint, PathBuilder, PixmapPaint, Rect, Transform};

// Per-thread cache of decoded background images. Each entry maps a
// logical path (as written in CSS / inline style) to the decoded
// Pixmap; None means "we tried and failed" — we cache failures too
// so a missing file doesn't re-disk-poll every frame.
thread_local! {
    static IMAGE_CACHE: RefCell<HashMap<String, Option<Pixmap>>> =
        RefCell::new(HashMap::new());
    // The project directory, set once at paint setup so the cache
    // can resolve relative paths from CSS without us threading the
    // PathBuf through every paint signature.
    static PROJECT_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Set the project directory used to resolve background-image paths.
/// Call once at startup; the runtime treats project_dir as immutable
/// for the lifetime of the process.
pub fn set_project_dir(p: PathBuf) {
    PROJECT_DIR.with(|cell| *cell.borrow_mut() = Some(p));
}

thread_local! {
    static ASYNC_IMAGE_RESOLVER: RefCell<Option<Box<dyn Fn(&str) -> Option<Pixmap>>>> =
        const { RefCell::new(None) };
}

/// Wires up http(s)/data: URL image resolution (async_image.rs). Paint
/// can't depend on async_image directly — it needs `UserEvent` and the
/// `#[path]`-included `native::net`, both only available inside the
/// backend binary crate (carbon-mini), which would make this a circular
/// crate dependency. The binary calls this once at startup with its own
/// `async_image::get`; paint calls back through the hook instead of
/// reaching into carbon-mini's own code.
pub fn set_async_image_resolver(f: impl Fn(&str) -> Option<Pixmap> + 'static) {
    ASYNC_IMAGE_RESOLVER.with(|cell| *cell.borrow_mut() = Some(Box::new(f)));
}

/// Look up the decoded pixmap for `path`. Tries (in order):
///   1. http:// or https:// prefix → async_image fetch + decode
///      (returns None on first call until the background fetch
///      finishes; a RequestPaint event fires on completion so the
///      next frame picks up the populated cache).
///   2. as-is (allows absolute paths)
///   3. <project_dir>/path
/// Returns None and caches None on any decode failure.
fn get_image(path: &str) -> Option<Pixmap> {
    // URL path: completely separate cache + decode in async_image.rs.
    // We do NOT touch IMAGE_CACHE for these — that one only holds
    // synchronously-decoded local files.
    // `data:` URLs go through the same module — they're handled
    // synchronously in async_image::get (SVG via resvg, raster via
    // base64+image-crate decoder).
    if path.starts_with("http://")
        || path.starts_with("https://")
        || path.starts_with("data:")
    {
        return ASYNC_IMAGE_RESOLVER.with(|cell| {
            cell.borrow().as_ref().and_then(|f| f(path))
        });
    }
    IMAGE_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(entry) = cache.get(path) {
            return entry.clone();
        }
        let abs_try = std::path::Path::new(path).to_path_buf();
        let candidates: Vec<PathBuf> = PROJECT_DIR.with(|cell| {
            let pd = cell.borrow();
            let mut v = vec![abs_try.clone()];
            if let Some(d) = pd.as_ref() {
                v.push(d.join(path));
            }
            v
        });
        let decoded = candidates
            .into_iter()
            .find_map(|p| Pixmap::load_png(&p).ok());
        cache.insert(path.to_string(), decoded.clone());
        decoded
    })
}

/// Emit fine-grained sub-step timings inside paint when env var set.
/// Same env gate as outer timing_log.
fn psub(label: &str, t: Instant) {
    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!("[carbon-mini-timing] phase=paint_{label} elapsed_ms={ms:.2}");
    }
}

/// Caller-owned, frame-reusable pixmap. Lifted out of `paint::paint` so
/// the main loop can hand the same RGBA8 buffer to the plugin
/// `before_paint` hook (canvas plugins blit GPU readbacks here) before
/// the rasterizer paints UI on top.
///
/// Re-allocates only when the window size changes.
pub struct Canvas {
    pub pixmap: Pixmap,
}

impl Canvas {
    pub fn new(w: u32, h: u32) -> Option<Self> {
        Some(Self { pixmap: Pixmap::new(w.max(1), h.max(1))? })
    }

    /// Resize if dimensions changed; otherwise reuse the existing
    /// allocation.
    pub fn ensure_size(&mut self, w: u32, h: u32) -> bool {
        let w = w.max(1);
        let h = h.max(1);
        if self.pixmap.width() == w && self.pixmap.height() == h {
            return true;
        }
        match Pixmap::new(w, h) {
            Some(p) => { self.pixmap = p; true }
            None => false,
        }
    }

    pub fn width(&self) -> u32 { self.pixmap.width() }
    pub fn height(&self) -> u32 { self.pixmap.height() }
    pub fn stride_bytes(&self) -> u32 { self.pixmap.width() * 4 }

    /// Mutable view over the raw RGBA8 (premultiplied) bytes. Format
    /// matches what `carbon_plugin_before_paint` expects.
    pub fn as_bytes_mut(&mut self) -> &mut [u8] {
        self.pixmap.data_mut()
    }

    /// Reset the pixmap to opaque white at the start of each frame.
    pub fn clear_white(&mut self) {
        self.pixmap.fill(Color::from_rgba8(255, 255, 255, 255));
    }
}

/// Paint the scene into the caller-owned `pixmap`, then convert to the
/// softbuffer XRGB layout in `buffer`.
///
/// The caller owns the Pixmap so it can be handed to plugin
/// `before_paint` hooks (which write GPU readbacks into it) before this
/// rasterizes UI on top. After this returns, the pixmap holds the final
/// composited frame in RGBA8 premultiplied; we then convert to XRGB.
pub fn paint(
    scene: &Scene,
    pixmap: &mut Pixmap,
    buffer: &mut [u32],
    w: u32,
    h: u32,
    scale: f32,
    text_engine: &mut TextEngine,
) {
    prof_zone!("frame_paint");
    let pt0 = Instant::now();
    psub("pixmap_provided", pt0);
    let _perf = std::env::var_os("CARBON_PERF").is_some();
    let _perf_nodes = Instant::now();

    {
        prof_zone!("paint_nodes");
        // Initial inheritance: black text 14px is the CSS default. User
        // CSS that sets `color` on .app (or any ancestor of a <text>)
        // overrides this for everything inside.
        // Initial clip is the full pixmap; scrollports narrow it as we
        // descend.
        let pix_h = pixmap.height() as f32;
        let pix_w = pixmap.width() as f32;
        // HiDPI: layout + all paint_node coordinates are LOGICAL px. The
        // root transform scales geometry to the PHYSICAL buffer, and the
        // text engine scales its glyph blits (the one primitive that
        // bypasses the transform). Clips are logical too — pixmap size /
        // scale gives the logical viewport.
        let scale = scale.max(0.1);
        text_engine.scale = scale;
        paint_node(
            scene,
            scene.root,
            0.0,
            0.0,
            0xFF_000000,
            14.0,
            false, // root inherits proportional (sans) intent
            400,   // root inherits normal font-weight
            0.0,
            pix_h / scale,
            0.0,
            pix_w / scale,
            Transform::from_scale(scale, scale),
            pixmap,
            text_engine,
            false,
        );
    }
    psub("nodes_painted", pt0);
    if _perf {
        let ms = _perf_nodes.elapsed().as_secs_f64() * 1000.0;
        if ms > 2.0 {
            let acc = PAINT_PERF.with(|p| *p.borrow());
            eprintln!("[perf]   paint_nodes: {ms:.1}ms (svg={:.1} canvas={:.1} other={:.1})",
                acc[0], acc[2], ms - acc[0] - acc[2]);
        }
        PAINT_PERF.with(|p| *p.borrow_mut() = [0.0; 4]);
    }
    let _perf_rgba = Instant::now();

    // Convert RGBA premultiplied -> 0x00RRGGBB.
    {
        prof_zone!("rgba_convert");
        let pixels = pixmap.data();
        let n = (w as usize) * (h as usize);
        for i in 0..n {
            let r = pixels[i * 4] as u32;
            let g = pixels[i * 4 + 1] as u32;
            let b = pixels[i * 4 + 2] as u32;
            buffer[i] = (r << 16) | (g << 8) | b;
        }
    }
    psub("rgba_converted", pt0);
    if _perf {
        let ms = _perf_rgba.elapsed().as_secs_f64() * 1000.0;
        if ms > 2.0 { eprintln!("[perf]   rgba_convert: {ms:.1}ms"); }
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_node(
    scene: &Scene,
    id: u32,
    parent_x: f32,
    parent_y: f32,
    inherited_color: u32,
    inherited_font_size: f32,
    inherited_mono: bool,
    inherited_weight: u16,
    clip_top: f32,
    clip_bottom: f32,
    clip_left: f32,
    clip_right: f32,
    parent_transform: Transform,
    pixmap: &mut Pixmap,
    text_engine: &mut TextEngine,
    // When false and the node has `opacity < 1`, the node + its whole
    // subtree are composited into an offscreen layer and blitted back at
    // that alpha (correct CSS group-opacity). The internal re-entry sets
    // this true to paint the subtree normally into the layer.
    ignore_opacity: bool,
) {
    let node = match scene.nodes.get(&id) {
        Some(n) => n,
        None => return,
    };
    let layout = match node.computed_layout {
        Some(l) => l,
        None => return,
    };

    // ── CSS opacity (group) ────────────────────────────────────────────
    // Render this node + subtree into a transparent full-frame layer, then
    // blit that layer at `op` alpha. This matches browsers (opacity applies
    // to the element as a group, not per-child) and correctly handles a
    // translucent container over other content. Gated so the default
    // opaque case (the overwhelming majority of nodes) costs nothing.
    if !ignore_opacity {
        if let Some(op) = node.props.opacity {
            if let Some(mut layer) = Pixmap::new(pixmap.width(), pixmap.height()) {
                paint_node(
                    scene, id, parent_x, parent_y, inherited_color,
                    inherited_font_size, inherited_mono, inherited_weight,
                    clip_top, clip_bottom,
                    clip_left, clip_right, parent_transform, &mut layer,
                    text_engine, true,
                );
                let mut pp = PixmapPaint::default();
                pp.opacity = op.clamp(0.0, 1.0);
                pixmap.draw_pixmap(0, 0, layer.as_ref(), &pp, Transform::identity(), None);
            }
            return;
        }
    }
    let x = parent_x + layout.location.x;
    let y = parent_y + layout.location.y;
    let w = layout.size.width;
    let h = layout.size.height;

    // Skip nodes whose box is fully outside the current clip — they're
    // scrolled out of view and don't contribute pixels. For partially
    // visible nodes we paint normally and rely on per-primitive clip.
    if y + h < clip_top || y > clip_bottom {
        return;
    }
    // Same on the X axis — `overflow:hidden` containers narrow the
    // horizontal clip so descendants (e.g. long file-explorer item
    // labels) are clipped to the panel instead of bleeding across the
    // window on top of other panes.
    if x + w < clip_left || x > clip_right {
        return;
    }
    // Glyph blits for this node's own text are clipped to the inherited
    // horizontal band. (Text is painted before children, which re-set
    // this for their own subtrees.)
    text_engine.x_clip = (clip_left, clip_right);
    // Damage-rect cull: if the scene has an active damage rect (set by
    // scroll / hover / focus changes), skip nodes whose box doesn't
    // intersect it. The pixmap retains the previous frame's content
    // outside the damage rect, so culled nodes' previous pixels
    // survive untouched.
    //
    // BUT the cull compares the node's LAYOUT box, which only equals its
    // painted (screen) box when nothing in the chain is transformed. A
    // `position: fixed` + `transform: translate(...)` overlay (Radix
    // menus / popovers / selects / tooltips) lays out at its inset origin
    // — usually (0,0) — yet paints hundreds of px away via the transform.
    // Culling it against the layout box drops it whenever a scoped
    // repaint's damage rect covers its SCREEN region but not its layout
    // box: the dropdown paints once, a later scoped frame erases those
    // pixels, and the cull skips repainting them — "the menu opens but
    // never shows". Skip the cull for any node that is itself transformed
    // or lives inside a transformed subtree (its accumulated
    // parent_transform carries a non-zero translate); overlays are cheap
    // and few, so always repainting them is fine.
    let in_transformed_subtree = parent_transform.tx != 0.0
        || parent_transform.ty != 0.0
        || node.props.transform.is_some()
        || node.props.translate_x.is_some()
        || node.props.translate_y.is_some();
    if !in_transformed_subtree {
        if let Some((dx, dy, dw, dh)) = scene.dirty_rect {
            if x + w < dx || x > dx + dw || y + h < dy || y > dy + dh {
                return;
            }
        }
    }

    // Compose CSS `transform` ops + Tailwind translate-x/-y around the
    // node's center, then pre-concat onto the parent's accumulated
    // transform. Applied to bg/border/bg-image/SVG/children boxes AND —
    // via the text_shift below — to glyph blits, so text now tracks the
    // transform (enables Radix modal centering `-translate-x/y-1/2` and
    // the search-icon `-translate-y-1/2`, previously disabled because
    // text stayed behind).
    let tw_tx = node.props.translate_x;
    let tw_ty = node.props.translate_y;
    let has_transform = node.props.transform.is_some() || tw_tx.is_some() || tw_ty.is_some();
    let node_transform = if has_transform {
        let cx = x + w * 0.5;
        let cy = y + h * 0.5;
        let mut t = Transform::from_translate(-cx, -cy);
        if let Some(tlist) = &node.props.transform {
            for op in &tlist.0 {
                t = match op {
                    crate::scene::TransformOp::Translate { x: tx, y: ty, x_pct, y_pct } => {
                        // Percentage translate resolves against the element's
                        // own box (CSS spec): translateX(-50%) = -0.5 * width.
                        let rx = if *x_pct { *tx * 0.01 * w } else { *tx };
                        let ry = if *y_pct { *ty * 0.01 * h } else { *ty };
                        t.post_concat(Transform::from_translate(rx, ry))
                    }
                    crate::scene::TransformOp::Rotate { rad } => {
                        t.post_concat(Transform::from_rotate(rad.to_degrees()))
                    }
                    crate::scene::TransformOp::Scale { x: sx, y: sy } => {
                        t.post_concat(Transform::from_scale(*sx, *sy))
                    }
                };
            }
        }
        // Tailwind translate-x/-y utilities (`-translate-x-1/2`, etc.),
        // stored as (value, is_percent). Percent resolves against the
        // element's own box, matching CSS `translate`.
        if tw_tx.is_some() || tw_ty.is_some() {
            let (vx, px) = tw_tx.unwrap_or((0.0, false));
            let (vy, py) = tw_ty.unwrap_or((0.0, false));
            let rx = if px { vx * 0.01 * w } else { vx };
            let ry = if py { vy * 0.01 * h } else { vy };
            t = t.post_concat(Transform::from_translate(rx, ry));
        }
        t = t.post_concat(Transform::from_translate(cx, cy));
        parent_transform.pre_concat(t)
    } else {
        parent_transform
    };

    // Text-follows-transform. Glyph blits bypass node_transform (they go
    // through text_engine.scale for HiDPI instead), so a CSS/motion
    // transform would move the node's boxes — background, border, the
    // Kbd badge — while leaving the label behind. That's exactly what
    // made framer-motion buttons (`initial={{ y: -15 }}`) render their
    // text ~15 px off the box. Re-derive where node_transform maps the
    // node's origin and shift every text draw below by that delta (in
    // LOGICAL px, since text_engine re-applies scale). Exact for
    // translate — the common motion case — and origin-correct for
    // scale/rotate (individual glyphs still aren't rotated, a deeper
    // follow-up). Zero for the untransformed majority (pure DPI scale
    // leaves tx/ty at 0), so no cost on the common path.
    let paint_scale = text_engine.scale.max(1e-4);
    let nt = node_transform;
    let text_shift_x = (nt.sx * x + nt.kx * y + nt.tx) / paint_scale - x;
    let text_shift_y = (nt.ky * x + nt.sy * y + nt.ty) / paint_scale - y;

    // CSS-style inheritance for `color` and `font-size`. See earlier
    // comment — wrapper-vs-text-node split makes this necessary.
    // When this node is the currently-hovered clickable, *_hover
    // overrides win over the base prop.
    let is_hovered = scene.hovered == Some(id);
    let own_color = if is_hovered {
        node.props.color_hover.or(node.props.color)
    } else {
        node.props.color
    };
    let effective_color = own_color.unwrap_or(inherited_color);
    let effective_font_size = node.props.font_size.unwrap_or(inherited_font_size);
    // font-weight inherits like color/font-size: a node's own weight
    // wins, else the parent's. Used to pick the real Inter face (no
    // more faux-bold double-draw).
    let effective_weight = node
        .props
        .font_weight
        .map(|w| w.clamp(1, 1000) as u16)
        .unwrap_or(inherited_weight);
    // font-family intent inherits like font-size/color: a node's own
    // font-family (sans vs mono) wins; otherwise inherit the parent's.
    // Used to pick a proportional vs monospace font for text below.
    let effective_mono = node
        .props
        .font_family
        .as_deref()
        .map(crate::text::TextEngine::family_is_mono)
        .unwrap_or(inherited_mono);

    // Box-shadow — outset shadows painted FIRST (behind everything
    // for this node), one per entry in declaration order so the
    // first listed shadow sits on top of subsequent ones in the
    // stack. Inset shadows are handled in a SECOND pass after the
    // background fill so they overlay it (see further down). The
    // blur is a real Gaussian (see `crate::blur`).
    for shadow in node.props.box_shadow.iter().rev() {
        if shadow.inset { continue; }
        let blur_r = shadow.blur.round().max(0.0) as u32;
        let pad = (blur_r as f32) * 2.0 + 4.0; // headroom for blur to bleed
        let sw = (w + shadow.spread * 2.0 + pad * 2.0).max(1.0).ceil() as u32;
        let sh = (h + shadow.spread * 2.0 + pad * 2.0).max(1.0).ceil() as u32;
        if let Some(mut tmp) = tiny_skia::Pixmap::new(sw, sh) {
            let sa = ((shadow.color >> 24) & 0xFF) as u8;
            let sr = ((shadow.color >> 16) & 0xFF) as u8;
            let sg = ((shadow.color >> 8) & 0xFF) as u8;
            let sb = (shadow.color & 0xFF) as u8;
            let mut sp = Paint::default();
            sp.set_color_rgba8(sr, sg, sb, sa);
            sp.anti_alias = node.props.border_radius > 0.0;
            let rect_x = pad;
            let rect_y = pad;
            let rect_w = w + shadow.spread * 2.0;
            let rect_h = h + shadow.spread * 2.0;
            let rr = (node.props.border_radius + shadow.spread.max(0.0)).max(0.0);
            if rr > 0.0 {
                if let Some(path) = rounded_rect_path(rect_x, rect_y, rect_w, rect_h, rr) {
                    tmp.fill_path(&path, &sp, FillRule::Winding, Transform::identity(), None);
                }
            } else if let Some(rect) = Rect::from_xywh(rect_x, rect_y, rect_w.max(0.001), rect_h.max(0.001)) {
                tmp.fill_rect(rect, &sp, Transform::identity(), None);
            }
            crate::blur::box_blur(&mut tmp, blur_r);
            let dst_x = (x - shadow.spread - pad + shadow.offset_x).round() as i32;
            let dst_y = (y - shadow.spread - pad + shadow.offset_y).round() as i32;
            let pp = PixmapPaint::default();
            // node_transform carries the HiDPI root scale (+ any CSS
            // transform); it positions dst_x/dst_y and scales the tmp
            // to physical px.
            pixmap.draw_pixmap(dst_x, dst_y, tmp.as_ref(), &pp, node_transform, None);
        }
    }

    // Background — clip the fill rect against the visible y band so
    // scrolled-out portions don't paint over the nav.
    let bg_color = if is_hovered {
        node.props.background_hover.or(node.props.background)
    } else {
        node.props.background
    };
    // Gradient takes precedence over solid color when set.
    let bg_gradient = node.props.background_gradient.as_ref();

    // Clip-path support: when set, paint the bg colour/gradient +
    // bg image into a temp pixmap, mask it to the clip shape via
    // BlendMode::DestinationIn, then blit at the node's origin.
    // Skips the regular bg paths via `clip_handled`. Doesn't clip
    // text or children — those still paint full-size (a known
    // limitation; users wanting full-subtree clipping should pair
    // clip-path with overflow:hidden on a wrapping view).
    let clip_path_def = node.props.clip_path.as_ref();
    let clip_handled = if let Some(cp) = clip_path_def {
        paint_clipped_background(
            pixmap,
            cp,
            x,
            y,
            w,
            h,
            bg_color,
            bg_gradient,
            node.props.background_image.as_deref(),
            node.props.background_size.as_deref(),
            node_transform,
        )
    } else {
        false
    };

    if !clip_handled && (bg_gradient.is_some() || bg_color.is_some()) {
        let mut paint = Paint::default();
        if let Some(g) = bg_gradient {
            // Build a tiny-skia gradient shader fitted to the node's
            // box. Linear: CSS-convention angle (0° = up, clockwise);
            // endpoints sit on the gradient line at the projection
            // of the box's bounding diagonal. Radial: ellipse fitted
            // to the box, "farthest-corner" radius.
            use tiny_skia::{Color, GradientStop, LinearGradient, Point, RadialGradient, SpreadMode};
            let stops: Vec<GradientStop> = g.stops.iter().map(|s| {
                let a = ((s.color >> 24) & 0xFF) as u8;
                let r = ((s.color >> 16) & 0xFF) as u8;
                let gg = ((s.color >> 8) & 0xFF) as u8;
                let b = (s.color & 0xFF) as u8;
                GradientStop::new(s.offset, Color::from_rgba8(r, gg, b, a))
            }).collect();
            let shader = match &g.shape {
                crate::scene::GradientShape::Linear { angle_deg } => {
                    let rad = angle_deg.to_radians();
                    // CSS: 0° = up. Direction vector (sin θ, -cos θ).
                    let dx = rad.sin();
                    let dy = -rad.cos();
                    let cx = x + w * 0.5;
                    let cy = y + h * 0.5;
                    // Gradient line length: w·|sin θ| + h·|cos θ|.
                    let len = (w * dx.abs() + h * dy.abs()).max(0.01);
                    let half = len * 0.5;
                    let start = Point::from_xy(cx - dx * half, cy - dy * half);
                    let end = Point::from_xy(cx + dx * half, cy + dy * half);
                    LinearGradient::new(start, end, stops, SpreadMode::Pad, Transform::identity())
                }
                crate::scene::GradientShape::Radial { cx: rcx, cy: rcy } => {
                    let cx = x + rcx * w;
                    let cy = y + rcy * h;
                    let dx = (rcx.max(1.0 - rcx)) * w;
                    let dy = (rcy.max(1.0 - rcy)) * h;
                    let radius = (dx * dx + dy * dy).sqrt().max(0.01);
                    RadialGradient::new(
                        Point::from_xy(cx, cy),
                        Point::from_xy(cx, cy),
                        radius,
                        stops,
                        SpreadMode::Pad,
                        Transform::identity(),
                    )
                }
            };
            if let Some(sh) = shader { paint.shader = sh; }
            paint.anti_alias = true;
        } else if let Some(bg) = bg_color {
            let a = ((bg >> 24) & 0xFF) as u8;
            let r = ((bg >> 16) & 0xFF) as u8;
            let gg = ((bg >> 8) & 0xFF) as u8;
            let b = (bg & 0xFF) as u8;
            paint.set_color_rgba8(r, gg, b, a);
            paint.anti_alias = node.props.border_radius > 0.0;
        }

        let clipped_top = y.max(clip_top);
        let clipped_bottom = (y + h).min(clip_bottom);
        let ch = (clipped_bottom - clipped_top).max(0.0);

        // Damage-rect clip: when scoped damage is active, every fill
        // gets clamped to the intersection of (its rect, damage_rect).
        // Without this, a node like the root whose box covers the
        // entire window would happily fill its background over the
        // whole pixmap, erasing the previous frame's content for
        // everything outside the scrolled region. Rounded paths fall
        // back to a clipped axis-aligned fill when not fully inside
        // the damage rect — we can't cheaply clip a path to an
        // arbitrary rect without a Mask, and the rounded corners are
        // gone in the clipped band anyway.
        let clip_dmg = |rx: f32, ry: f32, rw: f32, rh: f32| -> Option<(f32, f32, f32, f32)> {
            if let Some((dx, dy, dw, dh)) = scene.dirty_rect {
                let l = rx.max(dx);
                let t = ry.max(dy);
                let r2 = (rx + rw).min(dx + dw);
                let b2 = (ry + rh).min(dy + dh);
                if l >= r2 || t >= b2 { return None; }
                Some((l, t, r2 - l, b2 - t))
            } else {
                Some((rx, ry, rw, rh))
            }
        };

        if node.props.border_radius > 0.0 {
            let rr = node.props.border_radius;
            let fully_inside_clip = y >= clip_top && y + h <= clip_bottom;
            let fully_inside_damage = if let Some((dx, dy, dw, dh)) = scene.dirty_rect {
                x >= dx && y >= dy && x + w <= dx + dw && y + h <= dy + dh
            } else {
                true
            };
            if fully_inside_clip && fully_inside_damage {
                if let Some(path) = rounded_rect_path(x, y, w, h, rr) {
                    pixmap.fill_path(
                        &path,
                        &paint,
                        FillRule::Winding,
                        node_transform,
                        None,
                    );
                }
            } else if ch > 0.0 {
                paint.anti_alias = false;
                if let Some((fx, fy, fw, fh)) = clip_dmg(x, clipped_top, w, ch) {
                    if let Some(rect) = Rect::from_xywh(fx, fy, fw.max(0.001), fh.max(0.001)) {
                        pixmap.fill_rect(rect, &paint, node_transform, None);
                    }
                }
            }
        } else if ch > 0.0 {
            if let Some((fx, fy, fw, fh)) = clip_dmg(x, clipped_top, w, ch) {
                if let Some(rect) = Rect::from_xywh(fx, fy, fw.max(0.001), fh.max(0.001)) {
                    pixmap.fill_rect(rect, &paint, node_transform, None);
                }
            }
        }
    }

    // Background image — paint after the fill color so it sits on top.
    // "cover" (default): scale uniformly so the image fills the box,
    // possibly cropping. "stretch": scale x and y independently.
    // Skipped when clip-path already handled the bg pass.
    if !clip_handled {
    if let Some(bg_path) = node.props.background_image.as_ref() {
        if let Some(img) = get_image(bg_path) {
            if w > 0.0 && h > 0.0 && img.width() > 0 && img.height() > 0 {
                let iw = img.width() as f32;
                let ih = img.height() as f32;
                let mode = node
                    .props
                    .background_size
                    .as_deref()
                    .unwrap_or("cover");
                let (sx, sy, ox, oy) = if mode == "stretch" {
                    (w / iw, h / ih, 0.0_f32, 0.0_f32)
                } else if mode == "contain" {
                    // contain: scale DOWN so both axes <= box, then center.
                    // This is the <img> default (set in scene.rs's "src"
                    // arm) — preserves aspect ratio and never crops, which
                    // is what icons/logos need.
                    let s = (w / iw).min(h / ih);
                    let dw = iw * s;
                    let dh = ih * s;
                    (s, s, (w - dw) * 0.5, (h - dh) * 0.5)
                } else {
                    // cover: scale up so both axes >= box, then center
                    let s = (w / iw).max(h / ih);
                    let dw = iw * s;
                    let dh = ih * s;
                    (s, s, (w - dw) * 0.5, (h - dh) * 0.5)
                };
                // Compose the bg-image positioning transform with the
                // node's CSS transform so a rotated/scaled view
                // carries its background image with it.
                let transform = Transform::from_scale(sx, sy)
                    .post_translate(x + ox, y + oy)
                    .post_concat(node_transform);
                // Bilinear filter — without this tiny-skia falls back
                // to nearest-neighbor and the scaled background looks
                // visibly pixelated against the original PNG. Bicubic
                // would be sharper still but ~2× the per-pixel cost
                // and we redraw on every frame the scene is dirty.
                let mut pp = PixmapPaint::default();
                pp.quality = tiny_skia::FilterQuality::Bilinear;
                pixmap.draw_pixmap(0, 0, img.as_ref(), &pp, transform, None);
            }
        }
    }
    } // end if !clip_handled

    // Box-shadow — INSET pass. These paint on top of the
    // background but underneath text/children/border, the way CSS
    // specifies them. Algorithm:
    //   1. Fill a temp pixmap (box size) entirely with shadow colour.
    //   2. Punch out the inner shape (offset opposite to the shadow
    //      direction, shrunk by `spread`) using BlendMode::DestinationOut
    //      — this leaves a "donut" of colour around the cutout.
    //   3. Gaussian blur the donut.
    //   4. Clip the blurred temp to the box's outer rounded-rect shape
    //      via BlendMode::DestinationIn so blur bleed stays inside.
    //   5. Blit at the node's (x, y).
    // The blur math matches the outset path so colour intensity is
    // consistent between inset/outset on the same node.
    if !node.props.box_shadow.is_empty() && w > 0.0 && h > 0.0 {
        use tiny_skia::BlendMode;
        for shadow in node.props.box_shadow.iter().rev() {
            if !shadow.inset { continue; }
            let iw = w.ceil() as u32;
            let ih = h.ceil() as u32;
            if iw == 0 || ih == 0 { continue; }
            if let Some(mut tmp) = tiny_skia::Pixmap::new(iw, ih) {
                let sa = ((shadow.color >> 24) & 0xFF) as u8;
                let sr = ((shadow.color >> 16) & 0xFF) as u8;
                let sg = ((shadow.color >> 8) & 0xFF) as u8;
                let sb = (shadow.color & 0xFF) as u8;

                // 1. Fill the temp with shadow colour using the box's
                //    own rounded-rect shape — that way the donut's
                //    OUTER edge already follows the corner curve and
                //    we don't need a separate clip step for the outer
                //    boundary later.
                let mut sp = Paint::default();
                sp.set_color_rgba8(sr, sg, sb, sa);
                sp.anti_alias = node.props.border_radius > 0.0;
                let outer_rr = node.props.border_radius.max(0.0);
                if outer_rr > 0.0 {
                    if let Some(path) = rounded_rect_path(0.0, 0.0, w, h, outer_rr) {
                        tmp.fill_path(&path, &sp, FillRule::Winding, Transform::identity(), None);
                    }
                } else if let Some(rect) = Rect::from_xywh(0.0, 0.0, w.max(0.001), h.max(0.001)) {
                    tmp.fill_rect(rect, &sp, Transform::identity(), None);
                }

                // 2. Punch a hole at the offset+shrunken inner shape.
                //    CSS: positive offset_x means the shadow falls on
                //    the LEFT inside (light from the right), so the
                //    cutout is shifted in the SAME direction as the
                //    shadow offset.
                let cut_x = shadow.offset_x + shadow.spread;
                let cut_y = shadow.offset_y + shadow.spread;
                let cut_w = w - 2.0 * shadow.spread;
                let cut_h = h - 2.0 * shadow.spread;
                if cut_w > 0.0 && cut_h > 0.0 {
                    let inner_rr = (outer_rr - shadow.spread).max(0.0);
                    let mut cp = Paint::default();
                    cp.set_color_rgba8(255, 255, 255, 255);
                    cp.blend_mode = BlendMode::DestinationOut;
                    cp.anti_alias = inner_rr > 0.0;
                    if inner_rr > 0.0 {
                        if let Some(path) = rounded_rect_path(cut_x, cut_y, cut_w, cut_h, inner_rr) {
                            tmp.fill_path(&path, &cp, FillRule::Winding, Transform::identity(), None);
                        }
                    } else if let Some(rect) = Rect::from_xywh(
                        cut_x,
                        cut_y,
                        cut_w.max(0.001),
                        cut_h.max(0.001),
                    ) {
                        tmp.fill_rect(rect, &cp, Transform::identity(), None);
                    }
                }

                // 3. Blur.
                let blur_r = shadow.blur.round().max(0.0) as u32;
                crate::blur::box_blur(&mut tmp, blur_r);

                // 4. Clip blur bleed to the outer rounded-rect shape.
                //    DestinationIn means dst.alpha *= src.alpha, so
                //    filling the rounded rect with opaque white
                //    preserves alpha inside the path and zeroes it
                //    outside.
                if outer_rr > 0.0 {
                    let mut mp = Paint::default();
                    mp.set_color_rgba8(255, 255, 255, 255);
                    mp.blend_mode = BlendMode::DestinationIn;
                    mp.anti_alias = true;
                    // Fill the rounded rect — pixels inside stay,
                    // pixels outside get zeroed.
                    if let Some(path) = rounded_rect_path(0.0, 0.0, w, h, outer_rr) {
                        tmp.fill_path(&path, &mp, FillRule::Winding, Transform::identity(), None);
                    }
                }

                // 5. Blit onto the destination at the node's position.
                let pp = PixmapPaint::default();
                pixmap.draw_pixmap(
                    x.round() as i32,
                    y.round() as i32,
                    tmp.as_ref(),
                    &pp,
                    node_transform,
                    None,
                );
            }
        }
    }

    // ── CSS borders ────────────────────────────────────────────────────
    // Painted after the background/background-image + inset shadow and
    // before content (SVG / text / children), matching CSS paint order.
    // Per-side widths fall back to the uniform `border_width`; the colour
    // defaults to currentColor (the inherited text colour) when unset,
    // just like CSS. This is what gives buttons / inputs / the Kbd badge
    // their outline and draws hairline top/bottom separators.
    {
        let bw = node.props.border_width;
        let bt = node.props.border_top_width.unwrap_or(bw);
        let br_w = node.props.border_right_width.unwrap_or(bw);
        let bb = node.props.border_bottom_width.unwrap_or(bw);
        let bl = node.props.border_left_width.unwrap_or(bw);
        if (bt > 0.0 || br_w > 0.0 || bb > 0.0 || bl > 0.0) && w > 0.0 && h > 0.0 {
            let bc = node.props.border_color.unwrap_or(effective_color);
            let a = ((bc >> 24) & 0xFF) as u8;
            // Fully-transparent border (e.g. shadcn's `border-transparent`
            // reset) → paint nothing but keep the reserved layout space,
            // matching the browser. This is what stops every ghost Button
            // from drawing a stray outline.
            if a != 0 {
                let r = ((bc >> 16) & 0xFF) as u8;
                let g = ((bc >> 8) & 0xFF) as u8;
                let b = (bc & 0xFF) as u8;
                let mut bp = Paint::default();
                bp.set_color_rgba8(r, g, b, a);
                let rr = node.props.border_radius;
                let uniform = bt == br_w && br_w == bb && bb == bl && bt > 0.0;
                if uniform && rr > 0.0 {
                    // Rounded uniform border → stroke the rounded-rect path
                    // so corners follow the curve. Inset the centerline by
                    // half the width so the stroke's outer edge sits on the
                    // box edge (CSS border-box).
                    bp.anti_alias = true;
                    if let Some(path) = rounded_rect_path(
                        x + bt * 0.5,
                        y + bt * 0.5,
                        (w - bt).max(0.001),
                        (h - bt).max(0.001),
                        (rr - bt * 0.5).max(0.0),
                    ) {
                        let mut stroke = tiny_skia::Stroke::default();
                        stroke.width = bt;
                        pixmap.stroke_path(&path, &bp, &stroke, node_transform, None);
                    }
                } else {
                    // Per-side (or square) border → inset rects, one per
                    // side, each clipped to the visible scroll band on Y.
                    // Anti-alias single-side hairlines (border-t/b/l/r used
                    // as separators): at fractional device positions (HiDPI,
                    // sub-pixel layout) a non-AA'd fill snaps a translucent
                    // hairline to full coverage on one pixel row, so a
                    // white@10% divider paints crisp and reads brighter than
                    // Chromium's sub-pixel-AA'd hairline (the "borders too
                    // white" divergence). AA spreads it faithfully. We keep
                    // AA OFF for multi-side square borders so the four rects
                    // don't leave faint AA seams at the corners.
                    let side_count = (bt > 0.0) as u8 + (bb > 0.0) as u8
                        + (bl > 0.0) as u8 + (br_w > 0.0) as u8;
                    bp.anti_alias = side_count == 1;
                    let mut side = |rx: f32, ry: f32, rw: f32, rh: f32, pm: &mut Pixmap| {
                        if rw <= 0.0 || rh <= 0.0 { return; }
                        let t = ry.max(clip_top);
                        let bo = (ry + rh).min(clip_bottom);
                        if bo <= t { return; }
                        if let Some(rect) = Rect::from_xywh(rx, t, rw.max(0.001), (bo - t).max(0.001)) {
                            pm.fill_rect(rect, &bp, node_transform, None);
                        }
                    };
                    if bt > 0.0 { side(x, y, w, bt, pixmap); }
                    if bb > 0.0 { side(x, y + h - bb, w, bb, pixmap); }
                    if bl > 0.0 { side(x, y, bl, h, pixmap); }
                    if br_w > 0.0 { side(x + w - br_w, y, br_w, h, pixmap); }
                }
            }
        }
    }

    // SVG — paint the entire subtree via the dedicated SVG path,
    // then skip normal child traversal (children are scene-level
    // <path>/<line>/etc. which the SVG painter handles directly).
    if let NodeKind::Svg = node.kind {
        let _svgt = std::time::Instant::now();
        crate::svg::paint_svg_tree(
            pixmap,
            scene,
            id,
            x,
            y,
            w,
            h,
            effective_color,
            node_transform,
        );
        perf_add(0, _svgt);
        return;
    }

    // Styled inline spans take precedence over plain `text`. Each
    // span paints at the running pen-x with its own color (and
    // optional background rect behind it). Wrapping isn't applied
    // to spans in v1 — callers are expected to lay out lines by
    // emitting separate text nodes (one per line for terminals /
    // editors). letter-spacing + mono advance still apply uniformly.
    if let NodeKind::Text = node.kind {
        if let Some(spans) = node.props.spans.as_ref() {
            let lh_prop = node.props.line_height;
            let letter_spacing = node.props.letter_spacing.unwrap_or(0.0);
            let is_mono = effective_mono;
            let line_h = text_engine.resolve_line_height(effective_font_size, lh_prop);
            // Skip the whole node if its single-line band is out
            // of the scroll clip. (Spans are single-line per the
            // contract above.)
            if y + line_h >= clip_top && y <= clip_bottom {
                let mut pen_x = x;
                for span in spans {
                    if span.text.is_empty() { continue; }
                    let (sw, _sh) = text_engine.measure_styled_mono(
                        &span.text,
                        effective_font_size,
                        letter_spacing,
                        is_mono,
                    );
                    if let Some(bg) = span.background {
                        let a = ((bg >> 24) & 0xFF) as u8;
                        let r = ((bg >> 16) & 0xFF) as u8;
                        let g = ((bg >> 8) & 0xFF) as u8;
                        let b = (bg & 0xFF) as u8;
                        let mut bp = Paint::default();
                        bp.set_color_rgba8(r, g, b, a);
                        if let Some(rect) = Rect::from_xywh(
                            pen_x,
                            y,
                            sw.max(0.001),
                            line_h.max(0.001),
                        ) {
                            pixmap.fill_rect(rect, &bp, node_transform, None);
                        }
                    }
                    let span_color = span.color.unwrap_or(effective_color);
                    // Per-span weight → real Inter face (terminals emit
                    // bold cells as spans with weight >= 500).
                    text_engine.cur_weight =
                        span.weight.map(|w| w.clamp(1, 1000) as u16).unwrap_or(effective_weight);
                    text_engine.draw_text_styled_mono(
                        pixmap,
                        &span.text,
                        pen_x + text_shift_x,
                        y + text_shift_y,
                        effective_font_size,
                        span_color,
                        clip_top,
                        clip_bottom,
                        letter_spacing,
                        is_mono,
                    );
                    pen_x += sw;
                }
            }
            return;
        }
    }

    // Text — wrapped + clipped per glyph-row by the text engine.
    if let NodeKind::Text = node.kind {
        if let Some(text) = &node.props.text {
            // Paint-level wrap policy: only wrap when the user
            // explicitly set a width on the text. `width=None` means
            // "single-line, never wrap", regardless of what Taffy
            // computed for the layout box. This is the belt to the
            // suspenders — even if Taffy gives the leaf a narrower
            // box than its content (due to flex shrink quirks I
            // can't track down), the renderer will still paint the
            // full single-line text. Worst case: text overflows
            // the box rightward, which is a minor visual issue
            // compared to the broken word-wrap stacking we'd see
            // otherwise.
            let paint_max_width = if node.props.width.is_some() {
                w
            } else {
                0.0
            };
            // text-align: shift the paint origin so the rendered
            // glyphs sit center / right inside the box. Only fires
            // when the text fits on a single line (paint_max_width
            // == 0 OR the unwrapped measure fits) — multi-line
            // alignment would need per-line offsets in the text
            // engine, which is a larger refactor.
            let align = node.props.text_align.as_deref().unwrap_or("left");
            let lh_prop = node.props.line_height;
            let letter_spacing = node.props.letter_spacing.unwrap_or(0.0);
            let is_mono = effective_mono;
            let mut x_off = 0.0_f32;
            if align != "left" && w > 0.0 {
                let (tw, _th) = text_engine.measure_styled_mono(
                    text,
                    effective_font_size,
                    letter_spacing,
                    is_mono,
                );
                if tw < w {
                    x_off = match align {
                        "center" => (w - tw) * 0.5,
                        "right" | "end" => w - tw,
                        _ => 0.0,
                    };
                }
            }
            // Real weight via the Inter face stack (Regular → Bold).
            text_engine.cur_weight = effective_weight;
            text_engine.draw_text_wrapped_clipped_styled_mono(
                pixmap,
                text,
                x + x_off + text_shift_x,
                y + text_shift_y,
                effective_font_size,
                effective_color,
                paint_max_width,
                clip_top,
                clip_bottom,
                lh_prop,
                letter_spacing,
                is_mono,
            );
            // text-decoration: paint an underline or strikethrough
            // band across the measured text width. We measure
            // single-line; multi-line decoration needs per-line
            // bands which we'd need to thread through text.rs.
            if let Some(deco) = node.props.text_decoration.as_deref() {
                if deco != "none" && !deco.is_empty() {
                    let (tw, _th) = text_engine.measure_styled_mono(
                        text,
                        effective_font_size,
                        letter_spacing,
                        is_mono,
                    );
                    let line_thickness = (effective_font_size / 14.0).max(1.0);
                    let line_y = match deco {
                        "underline" => y + effective_font_size * 1.02,
                        "line-through" | "strikethrough" => y + effective_font_size * 0.55,
                        "overline" => y + 1.0,
                        _ => return, // unknown decoration — no-op
                    };
                    let dr = effective_color;
                    let a = ((dr >> 24) & 0xFF) as u8;
                    let r = ((dr >> 16) & 0xFF) as u8;
                    let g = ((dr >> 8) & 0xFF) as u8;
                    let b = (dr & 0xFF) as u8;
                    let mut dp = Paint::default();
                    dp.set_color_rgba8(r, g, b, a);
                    if let Some(rect) = Rect::from_xywh(
                        x + x_off,
                        line_y,
                        tw.max(0.001),
                        line_thickness,
                    ) {
                        pixmap.fill_rect(rect, &dp, node_transform, None);
                    }
                }
            }
        }
    }

    // Input / Textarea — text + caret + selection on top of the
    // already-painted background. Uses scene::editor_visual_lines so
    // soft-wrap, paint, caret, and click hit-test all see the same
    // visual layout.
    if matches!(node.kind, NodeKind::Input | NodeKind::Textarea) {
        let pad_left = node
            .props
            .padding_left
            .or(node.props.padding_x)
            .or(node.props.padding)
            .unwrap_or(8.0);
        // For inputs, CSS defaults to vertically-centered text — not
        // top-aligned with a fixed padding. When the consumer hasn't
        // set an explicit padding-top, compute the offset that
        // centers a single line of font_size text inside the
        // node's box. For textareas (multi-line) we still need a
        // top inset so wrapped lines don't crowd the top edge.
        let is_textarea = matches!(node.kind, NodeKind::Textarea);
        let pad_top = if is_textarea {
            node.props
                .padding_top
                .or(node.props.padding_y)
                .or(node.props.padding)
                .unwrap_or(6.0)
        } else {
            // Single-line <input>: always vertically-center the full
            // line box (ascent + |descent| + line_gap, == fontdue's
            // new_line_size, == CSS "normal" line-height) inside the
            // input box, ignoring user-set padding-top. Browsers do
            // the same — declared padding-y contributes to height but
            // the text rendering re-centers. Without this override,
            // shadcn's `py-1` baked into the Input base class anchors
            // the text 4px from the top and the descent slot pushes
            // visible glyphs asymmetrically upward.
            let line_box = text_engine
                .line_box(effective_font_size)
                .unwrap_or(effective_font_size * 1.2);
            ((h - line_box).max(0.0)) * 0.5
        };
        let pad_right = node
            .props
            .padding_right
            .or(node.props.padding_x)
            .or(node.props.padding)
            .unwrap_or(8.0);
        let value = node.props.text.clone().unwrap_or_default();
        let placeholder = node.props.placeholder.clone().unwrap_or_default();
        let text_x = x + pad_left;
        let text_y = y + pad_top;
        // Tighter than 1.3 — Roboto already has generous internal
        // leading; 1.2 reads as "comfortable" without feeling spread
        // out (which 1.3 did at small font sizes).
        let line_h = effective_font_size * 1.2;

        let display_color = if value.is_empty() && !placeholder.is_empty() {
            0xff9b9a96
        } else {
            effective_color
        };
        let display_text = if value.is_empty() {
            placeholder
        } else {
            value.clone()
        };

        let max_width = if is_textarea {
            (w - pad_left - pad_right).max(0.0)
        } else {
            0.0
        };
        let visual_lines = scene.editor_visual_lines(
            &display_text,
            effective_font_size,
            max_width,
            text_engine,
        );
        // Same visual lines computed from the actual `value` (not
        // placeholder) for caret + selection math.
        let caret_visual_lines = scene.editor_visual_lines(
            &value,
            effective_font_size,
            max_width,
            text_engine,
        );

        // Selection background per visual line, BEFORE text.
        if scene.focused == Some(id) {
            if let Some(st) = scene.input_state(id) {
                let sel_start = st.caret.min(st.sel_anchor).min(value.len());
                let sel_end = st.caret.max(st.sel_anchor).min(value.len());
                if sel_end > sel_start {
                    let mut sel_paint = tiny_skia::Paint::default();
                    sel_paint.set_color_rgba8(0x35, 0x82, 0xf2, 0x55);
                    sel_paint.anti_alias = false;
                    for (i, (line_start, line_end)) in caret_visual_lines.iter().enumerate() {
                        let s = sel_start.max(*line_start);
                        let e = sel_end.min(*line_end);
                        if e <= s {
                            continue;
                        }
                        let line_text = &value[*line_start..*line_end];
                        let pre =
                            &line_text[..(s - line_start).min(line_text.len())];
                        let in_sel = &line_text[(s - line_start).min(line_text.len())
                            ..(e - line_start).min(line_text.len())];
                        let (bw, _) = text_engine.measure(pre, effective_font_size);
                        let (sw, _) = text_engine.measure(in_sel, effective_font_size);
                        let row_y = text_y + (i as f32) * line_h;
                        if let Some(rect) = tiny_skia::Rect::from_xywh(
                            text_x + bw,
                            row_y,
                            sw.max(2.0),
                            line_h * 0.95,
                        ) {
                            pixmap.fill_rect(
                                rect,
                                &sel_paint,
                                node_transform,
                                None,
                            );
                        }
                    }
                }
            }
        }

        // Paint each visual line at its own y. Pass max_width=0 to
        // the text engine because we've already done the wrap math
        // ourselves — any further wrapping in the engine would
        // double-up and overlap rows.
        if !display_text.is_empty() {
            text_engine.cur_weight = effective_weight;
            for (i, (s, e)) in visual_lines.iter().enumerate() {
                let line_text = &display_text[*s..*e];
                if line_text.is_empty() {
                    continue;
                }
                let row_y = text_y + (i as f32) * line_h;
                text_engine.draw_text_wrapped_clipped(
                    pixmap,
                    line_text,
                    text_x + text_shift_x,
                    row_y + text_shift_y,
                    effective_font_size,
                    display_color,
                    0.0,
                    clip_top,
                    clip_bottom,
                );
            }
        }

        // Caret — uses caret_visual_lines (the actual value, not
        // placeholder) so the caret position matches the editing
        // model even when the placeholder is what's painted.
        if scene.focused == Some(id) {
            if let Some(st) = scene.input_state(id) {
                let caret = st.caret.min(value.len());
                let (vidx, col) = Scene::caret_to_visual_line_col(
                    &caret_visual_lines,
                    caret,
                );
                let (line_start, _) = caret_visual_lines
                    .get(vidx)
                    .copied()
                    .unwrap_or((0, 0));
                let pre_caret = &value[line_start..(line_start + col).min(value.len())];
                let (cw, _) = text_engine.measure(pre_caret, effective_font_size);
                let caret_x = text_x + cw;
                let caret_y = text_y + (vidx as f32) * line_h;
                let mut caret_paint = tiny_skia::Paint::default();
                let (cr, cg, cb) = (
                    ((effective_color >> 16) & 0xff) as u8,
                    ((effective_color >> 8) & 0xff) as u8,
                    (effective_color & 0xff) as u8,
                );
                caret_paint.set_color_rgba8(cr, cg, cb, 0xff);
                caret_paint.anti_alias = false;
                if let Some(rect) = Rect::from_xywh(
                    caret_x,
                    caret_y,
                    1.5,
                    line_h,
                ) {
                    pixmap.fill_rect(rect, &caret_paint, node_transform, None);
                }
            }
        }
    }

    // CPU 2D canvas: blit the surface pixmap (keyed by node id) into
    // the frame at this node's layout box. The surface is drawn into
    // by `__cm_canvas2d_flush` from the JS-side CanvasRenderingContext2D.
    if let NodeKind::Canvas = node.kind {
        let _cvt = std::time::Instant::now();
        // HiDPI: node_transform.sx is the effective root scale; the
        // canvas box is logical, so blit_into targets the physical
        // rect. A dpr-aware canvas (backing store sized × dpr) blits
        // 1:1 and crisp; a logical one is upscaled.
        crate::canvas2d::blit_into(id, pixmap, x, y, w, h, node_transform.sx.max(0.01));
        perf_add(2, _cvt);
    }

    // GPU canvas: read back from the offscreen wgpu texture and
    // blit into the pixmap at our layout box. Skipped if the node
    // never registered a canvas_id (lazy <canvas> not yet mounted).
    // DISABLED: Phase 1A removes GPU feature to eliminate 2.5 MB wgpu dependency.
    #[cfg(feature = "gpu")]
    if let NodeKind::Canvas = node.kind {
        if let Some(canvas_id) = node.props.canvas_id {
            let pt_canvas = Instant::now();
            if let Some((cw, ch, rgba)) = gpu::read_surface_pixels(canvas_id) {
                blit_rgba(pixmap, &rgba, cw, ch, x, y, w, h);
                if std::env::var_os("CARBON_MINI_TIMING").is_some() {
                    let ms = pt_canvas.elapsed().as_secs_f64() * 1000.0;
                    eprintln!(
                        "[carbon-mini-timing] phase=canvas_blit id={canvas_id} elapsed_ms={ms:.2}"
                    );
                }
            }
        }
    }

    // Children: when this node is a scrollport, narrow the clip band
    // to its visible area and translate child coordinates up by the
    // current scroll offset so out-of-view content doesn't leak.
    //
    // Exception: a scrollport inside a transformed subtree (e.g. a Radix
    // dropdown/select positioned via `transform: translate(...)`, which is
    // `overflow-y-auto`). The clip band is tracked in LAYOUT space, but the
    // content is painted at the TRANSFORMED screen position and the text
    // engine clips glyphs at their shifted y — so narrowing to the layout
    // box clips the whole (screen-shifted) menu body away and the dropdown
    // opens but shows nothing. Keep the inherited clip for these; overlays
    // are small and rarely need to actually scroll.
    let (child_clip_top, child_clip_bottom, child_oy) = if node.props.overflow_y {
        if in_transformed_subtree {
            (clip_top, clip_bottom, y - scene.scroll_y(id))
        } else {
            (clip_top.max(y), clip_bottom.min(y + h), y - scene.scroll_y(id))
        }
    } else {
        (clip_top, clip_bottom, y)
    };
    // An `overflow` container also clips its children horizontally to its
    // own box. `overflow_x` alone isn't separately modelled — any node
    // that establishes a scroll/clip context (overflow_y is set for
    // overflow / overflow-x / overflow-y) narrows the X band too. Same
    // transform exception as the vertical band above.
    let (child_clip_left, child_clip_right) = if node.props.overflow_y && !in_transformed_subtree {
        (clip_left.max(x), clip_right.min(x + w))
    } else {
        (clip_left, clip_right)
    };
    // Paint children in z-index order. Ascending: lowest first
    // (painted underneath), highest last (painted on top). Within
    // the same z, declaration order wins (stable sort). When no
    // child has a non-default z-index — the common case — skip
    // the sort entirely so the cost of z-index is zero on flows
    // that don't use it.
    let needs_z_sort = node.children.iter().any(|cid| {
        scene
            .nodes
            .get(cid)
            .and_then(|n| n.props.z_index)
            .map(|z| z != 0)
            .unwrap_or(false)
    });
    let mut child_order: Vec<u32>;
    let children_slice: &[u32] = if needs_z_sort {
        child_order = node.children.clone();
        child_order.sort_by_key(|cid| {
            scene.nodes.get(cid).and_then(|n| n.props.z_index).unwrap_or(0)
        });
        &child_order[..]
    } else {
        &node.children[..]
    };
    for &cid in children_slice {
        paint_node(
            scene,
            cid,
            x,
            child_oy,
            effective_color,
            effective_font_size,
            effective_mono,
            effective_weight,
            child_clip_top,
            child_clip_bottom,
            child_clip_left,
            child_clip_right,
            node_transform,
            pixmap,
            text_engine,
            false,
        );
    }

    // Layout debug overlay — Chrome-DevTools-style colored outline +
    // tinted fill over every node's box, toggled by Ctrl+Space. Hue
    // is hashed from the node id (Knuth's golden-ratio multiplier)
    // so each box gets a distinct color. Painted AFTER children so
    // every box's outline stays visible above its inner content.
    if scene.debug_layout && w > 0.0 && h > 0.0 {
        let (r, g, b) = debug_color_for_id(id);
        // Tinted fill — very translucent so the painted UI is still
        // legible, but the box edges read at a glance.
        let mut fill_paint = Paint::default();
        fill_paint.set_color_rgba8(r, g, b, 0x16);
        fill_paint.anti_alias = false;
        if let Some(rect) = Rect::from_xywh(x, y, w, h) {
            pixmap.fill_rect(rect, &fill_paint, node_transform, None);
        }
        // 1 px solid border on each side.
        let mut border_paint = Paint::default();
        border_paint.set_color_rgba8(r, g, b, 0xcc);
        border_paint.anti_alias = false;
        if let Some(rect) = Rect::from_xywh(x, y, w, 1.0) {
            pixmap.fill_rect(rect, &border_paint, node_transform, None);
        }
        if let Some(rect) = Rect::from_xywh(x, y + h - 1.0, w, 1.0) {
            pixmap.fill_rect(rect, &border_paint, node_transform, None);
        }
        if let Some(rect) = Rect::from_xywh(x, y, 1.0, h) {
            pixmap.fill_rect(rect, &border_paint, node_transform, None);
        }
        if let Some(rect) = Rect::from_xywh(x + w - 1.0, y, 1.0, h) {
            pixmap.fill_rect(rect, &border_paint, node_transform, None);
        }
    }

    // Scrollbar — paint after children so it sits on top. Only draw
    // when content actually overflows; otherwise the scrollport is
    // visually identical to a non-scrollable view.
    if node.props.overflow_y {
        let content_h = scene.content_height(id);
        if content_h > h && h > 0.0 {
            let scroll_y = scene.scroll_y(id);
            let max_scroll = (content_h - h).max(1.0);
            let thumb_min = 24.0_f32;
            let thumb_h = ((h * h) / content_h).max(thumb_min).min(h);
            let thumb_y = y + (scroll_y / max_scroll) * (h - thumb_h);
            let bar_w = 4.0_f32;
            let bar_x = x + w - bar_w - 4.0; // 4px gutter from right edge

            // Track (subtle, almost-invisible).
            let mut track_paint = Paint::default();
            track_paint.set_color_rgba8(0xff, 0xff, 0xff, 0x10);
            track_paint.anti_alias = true;
            if let Some(rect) = Rect::from_xywh(bar_x, y + 4.0, bar_w, (h - 8.0).max(1.0)) {
                pixmap.fill_rect(rect, &track_paint, node_transform, None);
            }

            // Thumb (more visible).
            let mut thumb_paint = Paint::default();
            thumb_paint.set_color_rgba8(0xff, 0xff, 0xff, 0x60);
            thumb_paint.anti_alias = true;
            if let Some(path) = rounded_rect_path(bar_x, thumb_y, bar_w, thumb_h, bar_w / 2.0) {
                pixmap.fill_path(
                    &path,
                    &thumb_paint,
                    FillRule::Winding,
                    node_transform,
                    None,
                );
            }
        }
    }
}

/// Blit RGBA8 pixels from a GPU readback into a tiny-skia pixmap at
/// `(dst_x, dst_y)` with size `(dst_w, dst_h)`. Currently 1:1 — if
/// the canvas's GPU resolution doesn't match the layout box, we
/// clip rather than scale (Phase 2 will likely upgrade this to
/// nearest/bilinear sampling on the CPU side, but for now matching
/// width/height is the simplest correct path).
///
/// tiny-skia uses RGBA premultiplied; wgpu hands us straight RGBA.
/// For Phase 1 we accept that non-opaque canvas pixels won't blend
/// perfectly through the existing path. Most canvases are opaque
/// (clear with alpha=1.0), so this is fine for the demo.
fn blit_rgba(
    pixmap: &mut Pixmap,
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_x: f32,
    dst_y: f32,
    dst_w: f32,
    dst_h: f32,
) {
    let pw = pixmap.width();
    let ph = pixmap.height();
    let dx = dst_x.round().max(0.0) as u32;
    let dy = dst_y.round().max(0.0) as u32;
    // Clip blit width/height to whichever is smaller of (canvas
    // texture size, layout box size, framebuffer remaining).
    let blit_w = (src_w.min(dst_w.round().max(0.0) as u32))
        .min(pw.saturating_sub(dx));
    let blit_h = (src_h.min(dst_h.round().max(0.0) as u32))
        .min(ph.saturating_sub(dy));
    if blit_w == 0 || blit_h == 0 {
        return;
    }
    let dst = pixmap.pixels_mut();
    for row in 0..blit_h {
        let src_off = (row as usize) * (src_w as usize) * 4;
        let src_row = &src[src_off..src_off + (blit_w as usize) * 4];
        for col in 0..blit_w {
            let s = (col as usize) * 4;
            let r = src_row[s];
            let g = src_row[s + 1];
            let b = src_row[s + 2];
            let a = src_row[s + 3];
            // tiny-skia stores premultiplied RGBA. wgpu hands us
            // straight (non-premultiplied) RGBA. Premultiply here.
            let r_p = ((r as u16 * a as u16 + 127) / 255) as u8;
            let g_p = ((g as u16 * a as u16 + 127) / 255) as u8;
            let b_p = ((b as u16 * a as u16 + 127) / 255) as u8;
            let pixel = tiny_skia::PremultipliedColorU8::from_rgba(r_p, g_p, b_p, a)
                .unwrap_or_else(|| {
                    tiny_skia::PremultipliedColorU8::from_rgba(0, 0, 0, 255).unwrap()
                });
            let dst_idx = (dy + row) as usize * pw as usize + (dx + col) as usize;
            if dst_idx < dst.len() {
                dst[dst_idx] = pixel;
            }
        }
    }
}

fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    pb.finish()
}

fn resolve_len_x(l: crate::scene::Len, w: f32) -> f32 {
    match l {
        crate::scene::Len::Length(v) => v,
        crate::scene::Len::Percent(p) => p / 100.0 * w,
    }
}
fn resolve_len_y(l: crate::scene::Len, h: f32) -> f32 {
    match l {
        crate::scene::Len::Length(v) => v,
        crate::scene::Len::Percent(p) => p / 100.0 * h,
    }
}

/// Paint a node's background (colour/gradient + image) into a
/// temp pixmap, clip it to the given clip-path shape via
/// BlendMode::DestinationIn, then blit at (box_x, box_y). Returns
/// true when the temp pixmap was allocated and blitted; false on
/// degenerate input. The caller skips the regular bg blocks when
/// this returns true.
pub(crate) fn paint_clipped_background(
    pixmap: &mut Pixmap,
    cp: &crate::scene::ClipPath,
    box_x: f32,
    box_y: f32,
    w: f32,
    h: f32,
    bg_color: Option<u32>,
    bg_gradient: Option<&crate::scene::GradientDef>,
    bg_image_path: Option<&str>,
    bg_size_mode: Option<&str>,
    dest_transform: Transform,
) -> bool {
    if w <= 0.0 || h <= 0.0 { return false; }
    // No bg to paint → no work to do; let downstream paths handle
    // any text/children (which we don't clip in v1 anyway).
    if bg_color.is_none() && bg_gradient.is_none() && bg_image_path.is_none() {
        return false;
    }
    let iw = w.ceil() as u32;
    let ih = h.ceil() as u32;
    if iw == 0 || ih == 0 { return false; }
    let mut tmp = match Pixmap::new(iw, ih) { Some(p) => p, None => return false };

    // Background colour / gradient — painted at (0, 0, w, h) in
    // temp-pixmap coords. Border-radius isn't honoured here since
    // clip-path replaces it for our purposes.
    if let Some(g) = bg_gradient {
        use tiny_skia::{Color, GradientStop, LinearGradient, Point, RadialGradient, SpreadMode};
        let stops: Vec<GradientStop> = g.stops.iter().map(|s| {
            let a = ((s.color >> 24) & 0xFF) as u8;
            let r = ((s.color >> 16) & 0xFF) as u8;
            let gg = ((s.color >> 8) & 0xFF) as u8;
            let b = (s.color & 0xFF) as u8;
            GradientStop::new(s.offset, Color::from_rgba8(r, gg, b, a))
        }).collect();
        let shader = match &g.shape {
            crate::scene::GradientShape::Linear { angle_deg } => {
                let rad = angle_deg.to_radians();
                let dx = rad.sin();
                let dy = -rad.cos();
                let cx = w * 0.5;
                let cy = h * 0.5;
                let len = (w * dx.abs() + h * dy.abs()).max(0.01);
                let half = len * 0.5;
                let start = Point::from_xy(cx - dx * half, cy - dy * half);
                let end = Point::from_xy(cx + dx * half, cy + dy * half);
                LinearGradient::new(start, end, stops, SpreadMode::Pad, Transform::identity())
            }
            crate::scene::GradientShape::Radial { cx: rcx, cy: rcy } => {
                let cx = rcx * w;
                let cy = rcy * h;
                let dx = (rcx.max(1.0 - rcx)) * w;
                let dy = (rcy.max(1.0 - rcy)) * h;
                let radius = (dx * dx + dy * dy).sqrt().max(0.01);
                RadialGradient::new(
                    Point::from_xy(cx, cy),
                    Point::from_xy(cx, cy),
                    radius,
                    stops,
                    SpreadMode::Pad,
                    Transform::identity(),
                )
            }
        };
        let mut bp = Paint::default();
        if let Some(sh) = shader { bp.shader = sh; }
        bp.anti_alias = true;
        if let Some(rect) = Rect::from_xywh(0.0, 0.0, w.max(0.001), h.max(0.001)) {
            tmp.fill_rect(rect, &bp, Transform::identity(), None);
        }
    } else if let Some(bg) = bg_color {
        let a = ((bg >> 24) & 0xFF) as u8;
        let r = ((bg >> 16) & 0xFF) as u8;
        let g2 = ((bg >> 8) & 0xFF) as u8;
        let b = (bg & 0xFF) as u8;
        let mut bp = Paint::default();
        bp.set_color_rgba8(r, g2, b, a);
        bp.anti_alias = false;
        if let Some(rect) = Rect::from_xywh(0.0, 0.0, w.max(0.001), h.max(0.001)) {
            tmp.fill_rect(rect, &bp, Transform::identity(), None);
        }
    }

    // Background image — scaled per cover/stretch, drawn at (0, 0)
    // in temp coords. URL loading flows through get_image like the
    // non-clipped path.
    if let Some(bg_path) = bg_image_path {
        if let Some(img) = get_image(bg_path) {
            if img.width() > 0 && img.height() > 0 {
                let i_w = img.width() as f32;
                let i_h = img.height() as f32;
                let mode = bg_size_mode.unwrap_or("cover");
                let (sx, sy, ox, oy) = if mode == "stretch" {
                    (w / i_w, h / i_h, 0.0_f32, 0.0_f32)
                } else if mode == "contain" {
                    let s = (w / i_w).min(h / i_h);
                    let dw = i_w * s;
                    let dh = i_h * s;
                    (s, s, (w - dw) * 0.5, (h - dh) * 0.5)
                } else {
                    let s = (w / i_w).max(h / i_h);
                    let dw = i_w * s;
                    let dh = i_h * s;
                    (s, s, (w - dw) * 0.5, (h - dh) * 0.5)
                };
                let img_transform = Transform::from_scale(sx, sy).post_translate(ox, oy);
                let mut pp = PixmapPaint::default();
                pp.quality = tiny_skia::FilterQuality::Bilinear;
                tmp.draw_pixmap(0, 0, img.as_ref(), &pp, img_transform, None);
            }
        }
    }

    // Apply the clip — DestinationIn with the shape filled white
    // keeps alpha where the path is and zeroes it elsewhere.
    if let Some(path) = build_clip_path(cp, w, h) {
        use tiny_skia::BlendMode;
        let mut cpaint = Paint::default();
        cpaint.set_color_rgba8(255, 255, 255, 255);
        cpaint.blend_mode = BlendMode::DestinationIn;
        cpaint.anti_alias = true;
        tmp.fill_path(&path, &cpaint, FillRule::Winding, Transform::identity(), None);
    } else {
        // Couldn't build the clip path (degenerate input) — bail
        // and let the regular bg pass handle it.
        return false;
    }

    // Blit to dest. Transform composes with the node's own CSS
    // transform so a rotated/scaled clipped view stays consistent.
    let pp = PixmapPaint::default();
    let blit_transform = dest_transform;
    pixmap.draw_pixmap(
        box_x.round() as i32,
        box_y.round() as i32,
        tmp.as_ref(),
        &pp,
        blit_transform,
        None,
    );
    true
}

/// Build a tiny-skia Path for a CSS clip-path, relative to box
/// origin (0, 0) and sized to (w, h). The caller positions the
/// resulting path via the destination transform.
pub(crate) fn build_clip_path(
    cp: &crate::scene::ClipPath,
    w: f32,
    h: f32,
) -> Option<tiny_skia::Path> {
    use crate::scene::ClipPath;
    let mut pb = PathBuilder::new();
    match cp {
        ClipPath::Inset { top, right, bottom, left, radius } => {
            let t = resolve_len_y(*top, h);
            let r = resolve_len_x(*right, w);
            let b = resolve_len_y(*bottom, h);
            let l = resolve_len_x(*left, w);
            let rect_x = l;
            let rect_y = t;
            let rect_w = (w - l - r).max(0.0);
            let rect_h = (h - t - b).max(0.0);
            let rr = resolve_len_x(*radius, w.min(h)).max(0.0);
            if rect_w <= 0.0 || rect_h <= 0.0 { return None; }
            return rounded_rect_path(rect_x, rect_y, rect_w, rect_h, rr);
        }
        ClipPath::Circle { cx, cy, r } => {
            let cxp = resolve_len_x(*cx, w);
            let cyp = resolve_len_y(*cy, h);
            // CSS spec: circle's `r` % is relative to
            // sqrt(w² + h²) / sqrt(2). We approximate with the
            // shorter side which matches the common avatar use
            // case (square box → identical to the spec).
            let rp = resolve_len_x(*r, w.min(h));
            if rp <= 0.0 { return None; }
            // Approximate circle with four cubic Béziers.
            let k = rp * 0.5522847498307936;
            pb.move_to(cxp - rp, cyp);
            pb.cubic_to(cxp - rp, cyp - k, cxp - k, cyp - rp, cxp, cyp - rp);
            pb.cubic_to(cxp + k, cyp - rp, cxp + rp, cyp - k, cxp + rp, cyp);
            pb.cubic_to(cxp + rp, cyp + k, cxp + k, cyp + rp, cxp, cyp + rp);
            pb.cubic_to(cxp - k, cyp + rp, cxp - rp, cyp + k, cxp - rp, cyp);
            pb.close();
        }
        ClipPath::Ellipse { cx, cy, rx, ry } => {
            let cxp = resolve_len_x(*cx, w);
            let cyp = resolve_len_y(*cy, h);
            let rxp = resolve_len_x(*rx, w);
            let ryp = resolve_len_y(*ry, h);
            if rxp <= 0.0 || ryp <= 0.0 { return None; }
            let kx = rxp * 0.5522847498307936;
            let ky = ryp * 0.5522847498307936;
            pb.move_to(cxp - rxp, cyp);
            pb.cubic_to(cxp - rxp, cyp - ky, cxp - kx, cyp - ryp, cxp, cyp - ryp);
            pb.cubic_to(cxp + kx, cyp - ryp, cxp + rxp, cyp - ky, cxp + rxp, cyp);
            pb.cubic_to(cxp + rxp, cyp + ky, cxp + kx, cyp + ryp, cxp, cyp + ryp);
            pb.cubic_to(cxp - kx, cyp + ryp, cxp - rxp, cyp + ky, cxp - rxp, cyp);
            pb.close();
        }
        ClipPath::Polygon(points) => {
            if points.len() < 3 { return None; }
            let (fx, fy) = points[0];
            pb.move_to(resolve_len_x(fx, w), resolve_len_y(fy, h));
            for (px, py) in points.iter().skip(1) {
                pb.line_to(resolve_len_x(*px, w), resolve_len_y(*py, h));
            }
            pb.close();
        }
    }
    pb.finish()
}
