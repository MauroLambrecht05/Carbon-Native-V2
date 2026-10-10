// svg.rs — SVG primitive painter for carbon-mini.
//
// Walks the scene-graph subtree under an `<svg>` node and renders each
// `<path>` / `<line>` / `<circle>` / `<rect>` / `<polyline>` / `<polygon>`
// using tiny-skia. The viewBox attribute defines a logical coordinate
// space; we scale + translate it to fit the layout box of the parent svg.
//
// Inheritance: stroke / fill / stroke-width / stroke-linecap /
// stroke-linejoin set on the parent `<svg>` cascade to children that
// don't override them. `currentColor` resolves to the inherited text
// color (set via React `color` style on the svg or any ancestor) — same
// semantics React/HTML give it.
//
// Path-data subset supported: M m L l H h V v C c S s Q q T t Z z. Arc
// commands (A/a) are approximated as a straight line — lucide and most
// modern icon packs avoid arcs in favor of cubics, so this rarely
// surfaces in practice.

use std::{cell::RefCell, collections::HashMap, rc::Rc};
use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Mask, Paint, Path, PathBuilder, Pixmap, PixmapPaint,
    Stroke, Transform,
};

use crate::scene::{NodeKind, Scene};

thread_local! {
    /// Inline SVGs are immutable between React prop updates. Caching the
    /// rasterized result prevents animated non-SVG UI (cursor/pulse/etc.) from
    /// reparsing every icon on every repaint.
    static SVG_RASTER_CACHE: RefCell<HashMap<String, Rc<Pixmap>>> = RefCell::new(HashMap::new());
}

/// Paint the SVG subtree rooted at `svg_id` into `pixmap`. The svg's layout
/// box is `(box_x, box_y, box_w, box_h)`; viewBox (if any) is scaled into
/// this rectangle. `inherited_color` is the surrounding text color — used
/// to resolve `stroke="currentColor"` / `fill="currentColor"`.
pub fn paint_svg_tree(
    pixmap: &mut Pixmap,
    scene: &Scene,
    svg_id: u32,
    box_x: f32,
    box_y: f32,
    box_w: f32,
    box_h: f32,
    inherited_color: u32,
    parent_transform: Transform,
    clip_mask: Option<&Mask>,
) {
    // Full SVG first: preserve browser-grade constructs such as gradients,
    // clip paths, filters, ellipses, opacity and element transforms. The old
    // primitive renderer below remains a dependable fallback for malformed or
    // unsupported documents.
    if paint_svg_document(
        pixmap,
        scene,
        svg_id,
        box_x,
        box_y,
        box_w,
        box_h,
        inherited_color,
        parent_transform,
        clip_mask,
    ) {
        return;
    }

    let svg = match scene.nodes.get(&svg_id) {
        Some(n) => n,
        None => return,
    };
    let view_box = svg
        .props
        .svg_view_box
        .unwrap_or([0.0, 0.0, box_w.max(1.0), box_h.max(1.0)]);
    let scale_x = box_w / view_box[2].max(0.001);
    let scale_y = box_h / view_box[3].max(0.001);
    let off_x = box_x - view_box[0] * scale_x;
    let off_y = box_y - view_box[1] * scale_y;

    // Resolve <svg>-level defaults that cascade to children.
    let svg_color = if svg.props.svg_stroke_inherit {
        Some(inherited_color)
    } else {
        svg.props.svg_stroke
    };
    let svg_fill = if svg.props.svg_fill_inherit {
        Some(inherited_color)
    } else if svg.props.svg_fill_none {
        None
    } else {
        svg.props.svg_fill
    };
    let svg_stroke_width = if svg.props.svg_stroke_width > 0.0 {
        svg.props.svg_stroke_width
    } else {
        1.0
    };
    let svg_linecap = svg.props.svg_stroke_linecap.as_deref();
    let svg_linejoin = svg.props.svg_stroke_linejoin.as_deref();

    for &child_id in &svg.children {
        paint_svg_node(
            pixmap,
            scene,
            child_id,
            scale_x,
            scale_y,
            off_x,
            off_y,
            svg_color,
            svg_fill,
            svg_stroke_width,
            svg_linecap,
            svg_linejoin,
            inherited_color,
            parent_transform,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_svg_document(
    pixmap: &mut Pixmap,
    scene: &Scene,
    svg_id: u32,
    box_x: f32,
    box_y: f32,
    box_w: f32,
    box_h: f32,
    inherited_color: u32,
    parent_transform: Transform,
    clip_mask: Option<&Mask>,
) -> bool {
    if box_w <= 0.0 || box_h <= 0.0 {
        return true;
    }
    let Some(root) = scene.nodes.get(&svg_id) else {
        return false;
    };

    // Rasterize at the SVG coordinate resolution (up to 512 px) rather than
    // at a tiny 16/20/30 px layout size. This keeps icons crisp on HiDPI while
    // still bounding filters and large imported viewBoxes.
    let intrinsic = root.props.svg_view_box.map(|v| (v[2], v[3]));
    let (mut render_w, mut render_h) = intrinsic.unwrap_or((box_w, box_h));
    render_w = render_w.abs().max(box_w).max(1.0);
    render_h = render_h.abs().max(box_h).max(1.0);
    let cap_scale = (512.0 / render_w.max(render_h)).min(1.0);
    let out_w = (render_w * cap_scale).ceil().max(1.0) as u32;
    let out_h = (render_h * cap_scale).ceil().max(1.0) as u32;

    let mut xml = String::with_capacity(2048);
    write_svg_node(
        scene,
        svg_id,
        &mut xml,
        Some((out_w, out_h, inherited_color)),
    );
    let rendered = SVG_RASTER_CACHE.with(|cache| {
        if let Some(pixmap) = cache.borrow().get(&xml).cloned() {
            return Some(pixmap);
        }
        let tree = usvg::Tree::from_str(&xml, &usvg::Options::default()).ok()?;
        let mut rendered = Pixmap::new(out_w, out_h)?;
        let tree_size = tree.size();
        let raster_transform = Transform::from_scale(
            out_w as f32 / tree_size.width().max(0.001),
            out_h as f32 / tree_size.height().max(0.001),
        );
        resvg::render(&tree, raster_transform, &mut rendered.as_mut());
        let rendered = Rc::new(rendered);
        let mut cache = cache.borrow_mut();
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(xml.clone(), rendered.clone());
        Some(rendered)
    });
    let Some(rendered) = rendered else {
        return false;
    };

    let transform = Transform::from_scale(box_w / out_w as f32, box_h / out_h as f32)
        .post_translate(box_x, box_y)
        .post_concat(parent_transform);
    let mut paint = PixmapPaint::default();
    paint.quality = tiny_skia::FilterQuality::Bilinear;
    pixmap.draw_pixmap(
        0,
        0,
        rendered.as_ref().as_ref(),
        &paint,
        transform,
        clip_mask,
    );
    true
}

fn write_svg_node(scene: &Scene, id: u32, xml: &mut String, root: Option<(u32, u32, u32)>) {
    let Some(node) = scene.nodes.get(&id) else {
        return;
    };
    let tag = if root.is_some() {
        "svg"
    } else {
        node.tag.as_str()
    };
    xml.push('<');
    xml.push_str(tag);

    if let Some((width, height, inherited_color)) = root {
        xml.push_str(" xmlns=\"http://www.w3.org/2000/svg\"");
        xml.push_str(" xmlns:xlink=\"http://www.w3.org/1999/xlink\"");
        xml.push_str(&format!(" width=\"{width}\" height=\"{height}\""));
        if !node.props.svg_attributes.contains_key("color") {
            xml.push_str(&format!(" color=\"{}\"", argb_to_hex(inherited_color)));
        }
    }

    for (name, value) in &node.props.svg_attributes {
        if root.is_some() && matches!(name.as_str(), "width" | "height" | "xmlns") {
            continue;
        }
        xml.push(' ');
        xml.push_str(name);
        xml.push_str("=\"");
        escape_xml(value, xml);
        xml.push('"');
    }

    if node.children.is_empty() && node.props.text.as_deref().unwrap_or("").is_empty() {
        xml.push_str("/>");
        return;
    }
    xml.push('>');
    if let Some(text) = &node.props.text {
        escape_xml(text, xml);
    }
    for &child in &node.children {
        write_svg_node(scene, child, xml, None);
    }
    xml.push_str("</");
    xml.push_str(tag);
    xml.push('>');
}

fn escape_xml(value: &str, out: &mut String) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
}

fn argb_to_hex(argb: u32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        (argb >> 16) & 0xff,
        (argb >> 8) & 0xff,
        argb & 0xff
    )
}

#[allow(clippy::too_many_arguments)]
fn paint_svg_node(
    pixmap: &mut Pixmap,
    scene: &Scene,
    id: u32,
    scale_x: f32,
    scale_y: f32,
    off_x: f32,
    off_y: f32,
    parent_stroke: Option<u32>,
    parent_fill: Option<u32>,
    parent_stroke_width: f32,
    parent_linecap: Option<&str>,
    parent_linejoin: Option<&str>,
    inherited_color: u32,
    parent_transform: Transform,
) {
    let node = match scene.nodes.get(&id) {
        Some(n) => n,
        None => return,
    };

    // Resolve stroke for this node (own override > parent default).
    let stroke = if node.props.svg_stroke_inherit {
        Some(inherited_color)
    } else if node.props.svg_stroke.is_some() {
        node.props.svg_stroke
    } else {
        parent_stroke
    };
    // Fill: own override > parent default. "fill=none" explicitly disables.
    let fill = if node.props.svg_fill_none {
        None
    } else if node.props.svg_fill_inherit {
        Some(inherited_color)
    } else if node.props.svg_fill.is_some() {
        node.props.svg_fill
    } else {
        parent_fill
    };
    let stroke_width = if node.props.svg_stroke_width > 0.0 {
        node.props.svg_stroke_width
    } else {
        parent_stroke_width
    };
    let linecap_str = node.props.svg_stroke_linecap.as_deref().or(parent_linecap);
    let linejoin_str = node
        .props
        .svg_stroke_linejoin
        .as_deref()
        .or(parent_linejoin);

    let path = match node.kind {
        NodeKind::SvgPath => node
            .props
            .svg_d
            .as_ref()
            .and_then(|d| parse_path(d, scale_x, scale_y, off_x, off_y)),
        NodeKind::SvgLine => {
            let mut pb = PathBuilder::new();
            pb.move_to(
                off_x + node.props.svg_x1 * scale_x,
                off_y + node.props.svg_y1 * scale_y,
            );
            pb.line_to(
                off_x + node.props.svg_x2 * scale_x,
                off_y + node.props.svg_y2 * scale_y,
            );
            pb.finish()
        }
        NodeKind::SvgCircle => {
            let cx = off_x + node.props.svg_cx * scale_x;
            let cy = off_y + node.props.svg_cy * scale_y;
            let r = node.props.svg_r * scale_x.min(scale_y);
            PathBuilder::from_circle(cx, cy, r)
        }
        NodeKind::SvgRect => {
            let rx = off_x + node.props.svg_rect_x * scale_x;
            let ry = off_y + node.props.svg_rect_y * scale_y;
            let rw = node.props.svg_rect_w.max(0.0) * scale_x;
            let rh = node.props.svg_rect_h.max(0.0) * scale_y;
            if rw > 0.0 && rh > 0.0 {
                tiny_skia::Rect::from_xywh(rx, ry, rw, rh).map(PathBuilder::from_rect)
            } else {
                None
            }
        }
        NodeKind::SvgPolyline | NodeKind::SvgPolygon => {
            let mut pb = PathBuilder::new();
            if let Some(s) = &node.props.svg_points {
                let nums: Vec<f32> = s
                    .split(|c: char| c.is_ascii_whitespace() || c == ',')
                    .filter_map(|p| p.parse::<f32>().ok())
                    .collect();
                let mut started = false;
                for chunk in nums.chunks_exact(2) {
                    let x = off_x + chunk[0] * scale_x;
                    let y = off_y + chunk[1] * scale_y;
                    if !started {
                        pb.move_to(x, y);
                        started = true;
                    } else {
                        pb.line_to(x, y);
                    }
                }
                if matches!(node.kind, NodeKind::SvgPolygon) {
                    pb.close();
                }
            }
            pb.finish()
        }
        // Anything else inside an <svg> — group, defs, etc — recurse into
        // its children with the same coordinate space. Lucide doesn't use
        // these, but other icon libraries might wrap paths in groups.
        _ => {
            for &child_id in &node.children {
                paint_svg_node(
                    pixmap,
                    scene,
                    child_id,
                    scale_x,
                    scale_y,
                    off_x,
                    off_y,
                    stroke,
                    fill,
                    stroke_width,
                    linecap_str,
                    linejoin_str,
                    inherited_color,
                    parent_transform,
                );
            }
            return;
        }
    };

    let path = match path {
        Some(p) => p,
        None => return,
    };

    // Fill first (under stroke).
    if let Some(fc) = fill {
        let mut paint = Paint::default();
        paint.set_color(argb_to_color(fc));
        paint.anti_alias = true;
        pixmap.fill_path(&path, &paint, FillRule::Winding, parent_transform, None);
    }

    // Stroke on top.
    if let Some(sc) = stroke {
        if stroke_width > 0.0 {
            let mut paint = Paint::default();
            paint.set_color(argb_to_color(sc));
            paint.anti_alias = true;
            let line_cap = match linecap_str {
                Some("round") => LineCap::Round,
                Some("square") => LineCap::Square,
                _ => LineCap::Butt,
            };
            let line_join = match linejoin_str {
                Some("round") => LineJoin::Round,
                Some("bevel") => LineJoin::Bevel,
                _ => LineJoin::Miter,
            };
            let avg_scale = (scale_x + scale_y) * 0.5;
            let stroke = Stroke {
                width: (stroke_width * avg_scale).max(0.5),
                miter_limit: 4.0,
                line_cap,
                line_join,
                dash: None,
            };
            pixmap.stroke_path(&path, &paint, &stroke, parent_transform, None);
        }
    }
}

fn argb_to_color(argb: u32) -> Color {
    let a = ((argb >> 24) & 0xFF) as u8;
    let r = ((argb >> 16) & 0xFF) as u8;
    let g = ((argb >> 8) & 0xFF) as u8;
    let b = (argb & 0xFF) as u8;
    Color::from_rgba8(r, g, b, a)
}

// ─── Path-data parser ─────────────────────────────────────────────────────

#[derive(Debug)]
enum Tok {
    Cmd(u8),
    Num(f32),
}

fn tokenize(d: &str) -> Vec<Tok> {
    let bytes = d.as_bytes();
    let mut out = Vec::with_capacity(d.len() / 4);
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_whitespace() || c == b',' {
            i += 1;
            continue;
        }
        if c.is_ascii_alphabetic() {
            out.push(Tok::Cmd(c));
            i += 1;
            continue;
        }
        // Number — optional sign, digits, optional decimal, optional exponent.
        let start = i;
        if c == b'-' || c == b'+' {
            i += 1;
        }
        let mut saw_digit = false;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            saw_digit = true;
        }
        if i < bytes.len() && bytes[i] == b'.' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
                saw_digit = true;
            }
        }
        if saw_digit && i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
            i += 1;
            if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
                i += 1;
            }
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
        }
        if saw_digit {
            if let Ok(s) = std::str::from_utf8(&bytes[start..i]) {
                if let Ok(n) = s.parse::<f32>() {
                    out.push(Tok::Num(n));
                }
            }
        } else {
            // Garbage byte we can't classify — skip it.
            i += 1;
        }
    }
    out
}

fn peek_num(toks: &[Tok], i: usize) -> Option<f32> {
    match toks.get(i)? {
        Tok::Num(n) => Some(*n),
        _ => None,
    }
}

fn peek_pair(toks: &[Tok], i: usize) -> Option<(f32, f32)> {
    let a = peek_num(toks, i)?;
    let b = peek_num(toks, i + 1)?;
    Some((a, b))
}

/// Parse SVG path-data into a tiny-skia path, with the (scale, offset)
/// transform applied so the result is in pixmap coordinates. Returns None
/// if the path produces no operations (empty `d`, only invalid commands).
pub fn parse_path(d: &str, scale_x: f32, scale_y: f32, off_x: f32, off_y: f32) -> Option<Path> {
    let toks = tokenize(d);
    if toks.is_empty() {
        return None;
    }
    let mut pb = PathBuilder::new();
    let mut cx = 0.0_f32;
    let mut cy = 0.0_f32;
    let mut start_x = 0.0_f32;
    let mut start_y = 0.0_f32;
    let mut last_cmd: u8 = 0;
    let mut last_cubic_ctrl: Option<(f32, f32)> = None;
    let mut last_quad_ctrl: Option<(f32, f32)> = None;
    let to_screen = |sx: f32, sy: f32| (off_x + sx * scale_x, off_y + sy * scale_y);

    let mut i = 0;
    while i < toks.len() {
        let cmd = match toks[i] {
            Tok::Cmd(c) => {
                i += 1;
                c
            }
            Tok::Num(_) => {
                // Implicit repetition of the previous command.
                if last_cmd == 0 {
                    i += 1;
                    continue;
                }
                last_cmd
            }
        };

        match cmd {
            b'M' | b'm' => {
                if let Some((mut x, mut y)) = peek_pair(&toks, i) {
                    i += 2;
                    if cmd == b'm' {
                        x += cx;
                        y += cy;
                    }
                    let (sx, sy) = to_screen(x, y);
                    pb.move_to(sx, sy);
                    cx = x;
                    cy = y;
                    start_x = x;
                    start_y = y;
                }
                // Subsequent number-pairs after M are implicit L (or l).
                let implicit_line = if cmd == b'M' { b'L' } else { b'l' };
                while let Some((mut x, mut y)) = peek_pair(&toks, i) {
                    i += 2;
                    if implicit_line == b'l' {
                        x += cx;
                        y += cy;
                    }
                    let (sx, sy) = to_screen(x, y);
                    pb.line_to(sx, sy);
                    cx = x;
                    cy = y;
                }
                last_cmd = implicit_line;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
                continue;
            }
            b'L' | b'l' => {
                while let Some((mut x, mut y)) = peek_pair(&toks, i) {
                    i += 2;
                    if cmd == b'l' {
                        x += cx;
                        y += cy;
                    }
                    let (sx, sy) = to_screen(x, y);
                    pb.line_to(sx, sy);
                    cx = x;
                    cy = y;
                }
                last_cmd = cmd;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
                continue;
            }
            b'H' | b'h' => {
                while let Some(mut x) = peek_num(&toks, i) {
                    i += 1;
                    if cmd == b'h' {
                        x += cx;
                    }
                    let (sx, sy) = to_screen(x, cy);
                    pb.line_to(sx, sy);
                    cx = x;
                }
                last_cmd = cmd;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
                continue;
            }
            b'V' | b'v' => {
                while let Some(mut y) = peek_num(&toks, i) {
                    i += 1;
                    if cmd == b'v' {
                        y += cy;
                    }
                    let (sx, sy) = to_screen(cx, y);
                    pb.line_to(sx, sy);
                    cy = y;
                }
                last_cmd = cmd;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
                continue;
            }
            b'C' | b'c' => {
                loop {
                    let p1 = match peek_pair(&toks, i) {
                        Some(p) => p,
                        None => break,
                    };
                    let p2 = match peek_pair(&toks, i + 2) {
                        Some(p) => p,
                        None => break,
                    };
                    let p = match peek_pair(&toks, i + 4) {
                        Some(p) => p,
                        None => break,
                    };
                    i += 6;
                    let (mut x1, mut y1) = p1;
                    let (mut x2, mut y2) = p2;
                    let (mut x, mut y) = p;
                    if cmd == b'c' {
                        x1 += cx;
                        y1 += cy;
                        x2 += cx;
                        y2 += cy;
                        x += cx;
                        y += cy;
                    }
                    let (sx1, sy1) = to_screen(x1, y1);
                    let (sx2, sy2) = to_screen(x2, y2);
                    let (sx, sy) = to_screen(x, y);
                    pb.cubic_to(sx1, sy1, sx2, sy2, sx, sy);
                    last_cubic_ctrl = Some((x2, y2));
                    cx = x;
                    cy = y;
                }
                last_cmd = cmd;
                last_quad_ctrl = None;
                continue;
            }
            b'S' | b's' => {
                // Smooth cubic — first control point is reflection of last.
                loop {
                    let p2 = match peek_pair(&toks, i) {
                        Some(p) => p,
                        None => break,
                    };
                    let p = match peek_pair(&toks, i + 2) {
                        Some(p) => p,
                        None => break,
                    };
                    i += 4;
                    let (mut x2, mut y2) = p2;
                    let (mut x, mut y) = p;
                    if cmd == b's' {
                        x2 += cx;
                        y2 += cy;
                        x += cx;
                        y += cy;
                    }
                    let (rx, ry) = match last_cubic_ctrl {
                        Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                        None => (cx, cy),
                    };
                    let (sx1, sy1) = to_screen(rx, ry);
                    let (sx2, sy2) = to_screen(x2, y2);
                    let (sx, sy) = to_screen(x, y);
                    pb.cubic_to(sx1, sy1, sx2, sy2, sx, sy);
                    last_cubic_ctrl = Some((x2, y2));
                    cx = x;
                    cy = y;
                }
                last_cmd = cmd;
                last_quad_ctrl = None;
                continue;
            }
            b'Q' | b'q' => {
                loop {
                    let p1 = match peek_pair(&toks, i) {
                        Some(p) => p,
                        None => break,
                    };
                    let p = match peek_pair(&toks, i + 2) {
                        Some(p) => p,
                        None => break,
                    };
                    i += 4;
                    let (mut x1, mut y1) = p1;
                    let (mut x, mut y) = p;
                    if cmd == b'q' {
                        x1 += cx;
                        y1 += cy;
                        x += cx;
                        y += cy;
                    }
                    let (sx1, sy1) = to_screen(x1, y1);
                    let (sx, sy) = to_screen(x, y);
                    pb.quad_to(sx1, sy1, sx, sy);
                    last_quad_ctrl = Some((x1, y1));
                    cx = x;
                    cy = y;
                }
                last_cmd = cmd;
                last_cubic_ctrl = None;
                continue;
            }
            b'T' | b't' => {
                // Smooth quadratic.
                loop {
                    let p = match peek_pair(&toks, i) {
                        Some(p) => p,
                        None => break,
                    };
                    i += 2;
                    let (mut x, mut y) = p;
                    if cmd == b't' {
                        x += cx;
                        y += cy;
                    }
                    let (rx, ry) = match last_quad_ctrl {
                        Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                        None => (cx, cy),
                    };
                    let (sx1, sy1) = to_screen(rx, ry);
                    let (sx, sy) = to_screen(x, y);
                    pb.quad_to(sx1, sy1, sx, sy);
                    last_quad_ctrl = Some((rx, ry));
                    cx = x;
                    cy = y;
                }
                last_cmd = cmd;
                last_cubic_ctrl = None;
                continue;
            }
            b'A' | b'a' => {
                // Arc — we don't implement the elliptical-arc math. Skip
                // its 7 args and emit a straight line to the endpoint so
                // the path doesn't fall apart.
                let arc_start = i;
                while let (Some(_), Some(_), Some(_), Some(_), Some(_), Some(p)) = (
                    peek_num(&toks, i),
                    peek_num(&toks, i + 1),
                    peek_num(&toks, i + 2),
                    peek_num(&toks, i + 3),
                    peek_num(&toks, i + 4),
                    peek_pair(&toks, i + 5),
                ) {
                    i += 7;
                    let (mut x, mut y) = p;
                    if cmd == b'a' {
                        x += cx;
                        y += cy;
                    }
                    let (sx, sy) = to_screen(x, y);
                    pb.line_to(sx, sy);
                    cx = x;
                    cy = y;
                }
                // SVG permits compact arc flags to run into the endpoint
                // (for example `0 0022 12.017`). The generic tokenizer
                // collapses `0022` to one number, leaving fewer than seven
                // tokens. Previously that consumed nothing and the implicit
                // command loop spun forever. Consume the numeric run and use
                // its final pair as the approximated line endpoint.
                if i == arc_start {
                    let mut end = i;
                    while peek_num(&toks, end).is_some() {
                        end += 1;
                    }
                    if end >= i + 2 {
                        let mut x = peek_num(&toks, end - 2).unwrap_or(cx);
                        let mut y = peek_num(&toks, end - 1).unwrap_or(cy);
                        if cmd == b'a' {
                            x += cx;
                            y += cy;
                        }
                        let (sx, sy) = to_screen(x, y);
                        pb.line_to(sx, sy);
                        cx = x;
                        cy = y;
                    }
                    // Always make progress, even for malformed arc data.
                    i = end.max(i + 1).min(toks.len());
                }
                last_cmd = cmd;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
                continue;
            }
            b'Z' | b'z' => {
                pb.close();
                cx = start_x;
                cy = start_y;
                last_cmd = cmd;
                continue;
            }
            _ => {
                // Unknown / unsupported command — skip its leading number
                // arguments to recover the parser.
                while peek_num(&toks, i).is_some() {
                    i += 1;
                }
                last_cmd = cmd;
                continue;
            }
        }
    }

    pb.finish()
}

#[cfg(test)]
mod tests {
    use super::{paint_svg_tree, parse_path};
    use crate::scene::{PaintProps, Scene};
    use tiny_skia::{Pixmap, Transform};

    #[test]
    fn compact_arc_flags_make_progress() {
        // GitHub's Octocat icon uses this valid compact SVG arc form. The
        // flags and endpoint begin without separators (`0022`).
        let path = "M12 2 A10.019 10.019 0 0022 12.017 C22 6.484 17.522 2 12 2z";
        assert!(parse_path(path, 1.0, 1.0, 0.0, 0.0).is_some());
    }

    #[test]
    fn full_svg_renders_gradient_clip_filter_and_ellipse_eyes() {
        let mut scene = Scene::new();
        for (id, tag) in [
            (1, "svg"),
            (2, "defs"),
            (3, "radialGradient"),
            (4, "stop"),
            (5, "stop"),
            (6, "filter"),
            (7, "feGaussianBlur"),
            (8, "clipPath"),
            (9, "circle"),
            (10, "circle"),
            (11, "g"),
            (12, "ellipse"),
            (13, "ellipse"),
            (14, "ellipse"),
        ] {
            scene.create_node(id, tag, PaintProps::default());
        }
        let mut set = |id, key, value: &str| scene.set_prop(id, key, value);
        set(1, "viewBox", "\"0 0 100 100\"");
        set(3, "id", "\"base\"");
        set(4, "offset", "\"0%\"");
        set(4, "stopColor", "\"#ffffff\"");
        set(5, "offset", "\"100%\"");
        set(5, "stopColor", "\"#80a090\"");
        set(6, "id", "\"blur\"");
        set(7, "stdDeviation", "\"2\"");
        set(8, "id", "\"body-clip\"");
        for id in [9, 10] {
            set(id, "cx", "50");
            set(id, "cy", "50");
            set(id, "r", "44");
        }
        set(9, "fill", "\"#ffffff\"");
        set(10, "fill", "\"url(#base)\"");
        set(11, "clipPath", "\"url(#body-clip)\"");
        set(12, "cx", "35");
        set(12, "cy", "25");
        set(12, "rx", "14");
        set(12, "ry", "8");
        set(12, "fill", "\"#ffffff\"");
        set(12, "opacity", "0.7");
        set(12, "filter", "\"url(#blur)\"");
        for (id, cx) in [(13, 35), (14, 65)] {
            set(id, "cx", &cx.to_string());
            set(id, "cy", "59");
            set(id, "rx", "7");
            set(id, "ry", "8");
            set(id, "fill", "\"#232b28\"");
            set(id, "transform", "\"translate(-1.5 -0.75)\"");
        }
        drop(set);
        for (parent, child) in [
            (1, 2),
            (2, 3),
            (3, 4),
            (3, 5),
            (2, 6),
            (6, 7),
            (2, 8),
            (8, 9),
            (1, 10),
            (1, 11),
            (11, 12),
            (1, 13),
            (1, 14),
        ] {
            scene.insert_node(parent, child, None);
        }

        let mut pixmap = Pixmap::new(100, 100).unwrap();
        paint_svg_tree(
            &mut pixmap,
            &scene,
            1,
            0.0,
            0.0,
            100.0,
            100.0,
            0xff_ffffff,
            Transform::identity(),
            None,
        );
        let body = pixmap.pixel(50, 50).unwrap();
        let eye = pixmap.pixel(34, 58).unwrap();
        let outside = pixmap.pixel(1, 1).unwrap();
        assert!(body.alpha() > 200 && body.green() > 100);
        assert!(eye.alpha() > 200 && eye.red() < 80 && eye.green() < 80);
        assert_eq!(outside.alpha(), 0);
    }
}
