// Scene graph + Taffy layout integration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use taffy::{prelude::*, MinMax, NodeId as TaffyNodeId, Overflow};

/// Length value: pixels (`Length(20.0)`) or percent of container
/// (`Percent(1.0)` = 100%). Mirrors taffy's Dimension/LengthPercentage
/// without leaking taffy types into the public scene-graph schema.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Len {
    Length(f32),
    Percent(f32),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PaintProps {
    /// 0xAARRGGBB. None = no fill.
    pub background: Option<u32>,
    /// 0xAARRGGBB.
    pub color: Option<u32>,
    pub font_size: Option<f32>,
    pub border_radius: f32,
    /// CSS (draft) `corner-shape`. `None` = the existing circular-arc
    /// corners (unaffected — this is purely additive). `Some(n)` = a
    /// superellipse of exponent `n` instead ("squircle" = a fixed
    /// n=4). Applies everywhere `border_radius` already does: the
    /// background fill, border stroke, box-shadow, and outline.
    pub corner_shape: Option<f32>,
    /// CSS `opacity` [0,1]. None = fully opaque (1.0). Applies to the node
    /// AND its whole subtree as a group (the paint loop composites the
    /// subtree to an offscreen layer and blits it at this alpha), matching
    /// how browsers treat `opacity` — distinct from a color's own alpha.
    pub opacity: Option<f32>,
    pub text: Option<String>,
    /// GPU canvas surface id (Phase 1). Set by `__cm_set_prop(id, "canvas_id", "<n>")`
    /// from the JS-side <canvas> intrinsic. The paint loop reads this and blits
    /// the corresponding wgpu surface's pixels into the tiny-skia pixmap.
    pub canvas_id: Option<u32>,
    /// `display`: flex (default) | grid | none. Block/inline aren't
    /// meaningful in carbon-mini's scene model; "block" maps to flex
    /// column for compatibility.
    pub display: Option<String>,
    /// flex direction: row|column
    pub flex_direction: Option<String>,
    /// flex wrap: nowrap|wrap|wrap-reverse
    pub flex_wrap: Option<String>,
    /// justifyContent / alignItems shorthand strings (CSS-like)
    pub justify_content: Option<String>,
    pub align_items: Option<String>,
    /// `justify-items` / `align-items` for CSS grid items (independent
    /// of flexbox align-items). The shorthand `place-items` sets both.
    pub justify_items: Option<String>,
    pub align_items_grid: Option<String>,
    /// `justify-content` / `align-content` for grid containers (track
    /// distribution). `place-content` sets both.
    pub align_content: Option<String>,
    /// Grid template tracks. CSS strings: "1fr", "auto", "100px",
    /// "repeat(3, minmax(0, 1fr))". Parsed at style-build time.
    pub grid_template_columns: Option<String>,
    pub grid_template_rows: Option<String>,
    /// Grid item placement. "span 2", "1 / 3", "auto", "1 / -1".
    pub grid_column: Option<String>,
    pub grid_row: Option<String>,
    /// Grid auto-flow direction: row | column | row dense | column dense.
    pub grid_auto_flow: Option<String>,
    /// Per-item justify/align overrides. `place-self` shorthand sets
    /// both (`justify-self` + `align-self`).
    pub justify_self: Option<String>,
    pub align_self: Option<String>,
    pub padding: Option<f32>,
    pub padding_x: Option<f32>,
    pub padding_y: Option<f32>,
    /// Per-side padding overrides. CSS-shorthand fallback chain:
    /// padding_left.or(padding_x).or(padding).unwrap_or(0). Same for the
    /// other three sides. React's `style={{ paddingLeft: 12 }}` lands here.
    pub padding_left: Option<f32>,
    pub padding_right: Option<f32>,
    pub padding_top: Option<f32>,
    pub padding_bottom: Option<f32>,
    /// Per-side margins (outer spacing). Fed to Taffy so `mx-1.5` / `ml-2` /
    /// `mt-auto` actually push siblings apart — e.g. the file-explorer header
    /// icon's `mx-1.5` gap. `Auto` (from margin:auto) enables flex centering.
    #[serde(default)]
    pub margin_left: Option<Len>,
    #[serde(default)]
    pub margin_right: Option<Len>,
    #[serde(default)]
    pub margin_top: Option<Len>,
    #[serde(default)]
    pub margin_bottom: Option<Len>,
    pub gap: Option<f32>,
    /// Bold-ish faux weight. <500 = regular, >=500 = faux-bold (drawn twice
    /// with a 1px x-offset to thicken). Set via `style={{ fontWeight: 'bold' }}`
    /// or numeric weight. None = use the document default (regular).
    pub font_weight: Option<u32>,
    /// CSS `text-align`. Accepted: "left" (default) | "center" | "right".
    /// Currently applied to `<text>` nodes only — block-level alignment
    /// via flex is independent.
    pub text_align: Option<String>,
    /// CSS `white-space`. Accepted: "normal" (default — wraps if a width
    /// is set, else single-line) | "nowrap" (always single-line,
    /// regardless of width) | "pre" (preserve literal `\n` line breaks,
    /// never word-wrap). Affects both the Taffy measure pass (so the
    /// layout box doesn't grow tall from wrapping that paint won't do)
    /// and the paint pass.
    pub white_space: Option<String>,
    /// CSS `text-overflow`. Accepted: "clip" (default) | "ellipsis" —
    /// truncates single-line text to the node's layout width with a
    /// trailing "…" instead of overflowing. Forces single-line behavior
    /// like `white-space: nowrap` while set.
    pub text_overflow: Option<String>,
    /// CSS `text-decoration`. Accepted: "underline" | "line-through" |
    /// "none". Painted as a 1-2 px line at the appropriate baseline.
    pub text_decoration: Option<String>,
    /// CSS `font-style`. Accepted: "italic" | "oblique" (both render
    /// identically — a synthetic shear; there are no real italic font
    /// files loaded, only upright weights). Like `text_align` and
    /// `text_decoration`, this is an OWN-value-only prop: it doesn't
    /// inherit down the tree the way real CSS `font-style` does — a
    /// `<text>` child needs it set directly, same existing limitation
    /// those two props already have.
    pub font_style: Option<String>,
    /// CSS `line-height`. Number (unitless multiplier) or px length.
    /// Applied to multi-line text wrapping. None = font default
    /// (currently 1.2× font-size).
    pub line_height: Option<f32>,
    /// CSS `letter-spacing` in px. Inserted between glyphs at paint
    /// time. None = no extra spacing.
    pub letter_spacing: Option<f32>,
    /// CSS `font-family`. carbon-mini currently honours one bit of
    /// information: whether the family resolves to monospace. If the
    /// declared family contains any of {"mono", "Mono", "Consolas",
    /// "Menlo", "Courier", "JetBrains"}, glyphs paint with a fixed
    /// advance (M-width) so columns align — necessary for terminal
    /// and code-editor grids. Otherwise the font's intrinsic
    /// proportional advance is used. We don't currently support
    /// loading a separate monospace font file; users can supply
    /// `<project>/assets/font.ttf` as a monospace TTF if they want
    /// glyph shapes to match.
    pub font_family: Option<String>,
    /// Inline styled text runs. When set, the paint path renders
    /// these instead of `text` — each run can have its own color,
    /// weight, and background. Used by terminal emulators (one span
    /// per ANSI-styled segment of a line) and code editors (one span
    /// per syntax token). The parent node's font-size, line-height,
    /// letter-spacing, and font-family apply to all spans.
    #[serde(default)]
    pub spans: Option<Vec<TextSpan>>,
    /// Single-line `border` width — applied as a uniform stroke of
    /// `border_color` around the node's box, drawn AFTER background and
    /// BEFORE children. Set via `style={{ borderWidth: 1 }}`.
    pub border_width: f32,
    pub border_color: Option<u32>,
    /// Per-side border widths. `None` falls back to `border_width` (the
    /// uniform value). Set via `border-t` / `border-b` / `borderTopWidth`
    /// etc. — how shadcn/terax draw hairline top/bottom separators.
    #[serde(default)]
    pub border_top_width: Option<f32>,
    #[serde(default)]
    pub border_right_width: Option<f32>,
    #[serde(default)]
    pub border_bottom_width: Option<f32>,
    #[serde(default)]
    pub border_left_width: Option<f32>,
    /// CSS `outline-width` — a stroke drawn OUTSIDE the border edge
    /// (offset by `outline_offset`), unlike border which sits ON the
    /// box edge. Doesn't contribute to layout size, matching CSS.
    pub outline_width: f32,
    /// `outline-color`. None = currentColor (falls back to the node's
    /// effective text color, like `border_color` does).
    pub outline_color: Option<u32>,
    /// `outline-offset` — gap between the border edge and the outline,
    /// in px. May be negative (outline drawn inside the border edge).
    pub outline_offset: f32,
    /// Sizing — accepts both `100` (px) and `"50%"` (percent of parent).
    pub width: Option<Len>,
    pub height: Option<Len>,
    pub min_width: Option<Len>,
    pub max_width: Option<Len>,
    pub min_height: Option<Len>,
    pub max_height: Option<Len>,
    /// CSS `aspect-ratio` as width/height (e.g. `16/9` → 1.777...).
    /// Resolved by Taffy: when only one of width/height is definite,
    /// the other is derived from this ratio.
    pub aspect_ratio: Option<f32>,
    /// Flex item sizing. flex-grow / flex-shrink default to 0 / 1.
    /// flex-basis defaults to auto (None).
    pub flex_grow: Option<f32>,
    pub flex_shrink: Option<f32>,
    pub flex_basis: Option<Len>,
    /// JS click handler id present in the JS-side map (we don't store the fn here).
    pub clickable: bool,
    /// Element acts as an OS drag handle — mouse-press anywhere on it
    /// (or its descendants, unless the descendant is interactive) calls
    /// `window.drag_window()`. Marked by `data-tauri-drag-region` or
    /// `data-carbon-drag-region` (kept compatible with Tauri apps being
    /// ported). The hit-test treats drag regions as "transparent" to
    /// other clickables — children handle clicks first; only empty area
    /// of the drag region itself initiates a drag.
    pub drag_region: bool,
    /// Hover-state overrides — applied when the cursor is over this
    /// node (only nodes with `clickable=true` participate in hover hit
    /// testing). None = no override; falls back to the base prop.
    pub background_hover: Option<u32>,
    pub color_hover: Option<u32>,
    /// Focus-state overrides — applied when this node holds keyboard
    /// focus (`scene.focused == Some(id)`). Real focus tracking
    /// currently only ever reaches `Input`/`Textarea` nodes (see
    /// `Scene::focusable_inputs`), so these are no-ops on anything
    /// else — a `<button>` can't become focused yet, so its
    /// `focus:`-derived styles never trigger. That's a real, narrower
    /// gap than these fields themselves (tracked separately: general
    /// keyboard focus/Tab-order for non-input clickables), not
    /// something to paper over here by substituting hover.
    pub background_focus: Option<u32>,
    pub color_focus: Option<u32>,
    /// `overflow-y: scroll` — the node becomes a scrollport. Mouse wheel
    /// events over this node update its scroll offset; children get
    /// translated up by that offset and clipped to the node's box.
    pub overflow_y: bool,
    /// Auto edge-fade on a scrollport signaling more content is
    /// scrollable above/below — the Notion/Radix-ScrollArea pattern,
    /// promoted from an app-level manual overlay to an engine primitive.
    /// Only paints when the node also has a solid `background` (the
    /// fade blends TOWARD that color; there's nothing correct to fade
    /// toward otherwise). No-op on nodes without `overflow_y`.
    pub scroll_shadow: bool,
    /// CSS `scrollbar-color: <thumb> <track>`. None = the engine's
    /// default translucent-white thumb/track.
    pub scrollbar_thumb_color: Option<u32>,
    pub scrollbar_track_color: Option<u32>,
    /// CSS `scrollbar-width`. None = the default 4px bar. `Some(0.0)`
    /// (from the `none` keyword) hides the bar entirely while leaving
    /// the scrollport itself still scrollable.
    pub scrollbar_width: Option<f32>,
    /// CSS `scroll-snap-type` on a scrollport. `"mandatory"` or
    /// `"proximity"` (the axis token is dropped — this engine only has
    /// a y scroll model, so it's always the y axis). `None` = no
    /// snapping. See `Scene::scroll_snap_target`'s doc comment for how
    /// each strictness level is approximated without a real
    /// gesture/momentum model.
    pub scroll_snap_type: Option<String>,
    /// CSS `scroll-snap-align` on a scrollable child. `"start"` |
    /// `"center"` | `"end"` — which edge of the child aligns to the
    /// matching edge of its scrollport when snapped.
    pub scroll_snap_align: Option<String>,
    /// Path to an image to paint inside this node's layout box. The path
    /// is resolved against the project_dir at paint time and decoded
    /// once via tiny_skia::Pixmap::load_png. Stretched to cover the box.
    pub background_image: Option<String>,
    /// How to fit the background_image in the box: "cover" (default —
    /// fills, may crop) or "stretch" (stretches both axes independently).
    pub background_size: Option<String>,
    /// CSS `background-image: url(a), url(b), ...` — 2+ comma-separated
    /// layers. First-listed paints ON TOP (CSS ordering), so paint walks
    /// this in reverse. Populated ONLY when 2+ layers are present;
    /// single-layer values keep going through `background_image` above
    /// unchanged (that's also what the `src` attribute path writes to).
    #[serde(default)]
    pub background_layers: Vec<String>,
    /// Per-layer `background-size`, aligned by index with
    /// `background_layers`. Shorter than it → the last entry repeats;
    /// empty → "cover" for every layer. Kept independent of
    /// `background_layers` (rather than zipped together at parse time)
    /// because `background-image` and `background-size` arrive as two
    /// separate `set_prop` calls in unspecified order.
    #[serde(default)]
    pub background_layer_sizes: Vec<String>,
    /// CSS-style cursor name. Recognized values: default | pointer | hand |
    /// text | ibeam | crosshair | not-allowed | wait | progress | grab |
    /// grabbing | col-resize | row-resize. None + clickable = pointer
    /// (matches what a real browser does for buttons / links).
    pub cursor: Option<String>,
    /// `<input>` / `<textarea>` placeholder, painted in `text_faint`
    /// when the value is empty. Mirrors HTML's `placeholder` attribute.
    pub placeholder: Option<String>,

    // ── SVG ─────────────────────────────────────────────────────────
    // Set by `__cm_set_prop` from React JSX attrs. The SVG paint path
    // in main.rs reads these to render lucide-react and similar icon
    // libraries natively (no carbon-mini-specific shim).
    /// `viewBox="x y w h"` on `<svg>`. Defines the coordinate space
    /// children are positioned in. None = no transform (1:1).
    pub svg_view_box: Option<[f32; 4]>,
    /// `<path d="...">` data string. SVG path mini-language: M/L/H/V/C/Z
    /// (and lowercase relative variants).
    pub svg_d: Option<String>,
    /// `<svg stroke="...">` / `<path stroke="...">`. None = inherit
    /// from parent's `color` (which lucide-react sets to `currentColor`
    /// by default — meaning "use the current text color").
    pub svg_stroke: Option<u32>,
    /// True when `stroke="currentColor"` was specified — the paint
    /// path falls back to the inherited text color.
    pub svg_stroke_inherit: bool,
    /// `fill="..."`. None = no fill. Special value "none" disables fill.
    pub svg_fill: Option<u32>,
    pub svg_fill_inherit: bool,
    pub svg_fill_none: bool,
    /// `stroke-width="N"`. Default 1.
    pub svg_stroke_width: f32,
    /// `stroke-linecap="butt|round|square"`.
    pub svg_stroke_linecap: Option<String>,
    /// `stroke-linejoin="miter|round|bevel"`.
    pub svg_stroke_linejoin: Option<String>,
    /// `<line>` endpoints.
    pub svg_x1: f32,
    pub svg_y1: f32,
    pub svg_x2: f32,
    pub svg_y2: f32,
    /// `<circle>` center + radius.
    pub svg_cx: f32,
    pub svg_cy: f32,
    pub svg_r: f32,
    /// `<rect>` SVG-coord position (separate from the layout x/y; only
    /// used when the rect lives inside an `<svg>` viewbox).
    pub svg_rect_x: f32,
    pub svg_rect_y: f32,
    pub svg_rect_w: f32,
    pub svg_rect_h: f32,
    pub svg_rect_rx: f32,
    /// `<polyline>` / `<polygon>` `points="x,y x,y ..."`.
    pub svg_points: Option<String>,

    // ── Absolute positioning + z-index ───────────────────────────────
    /// CSS `position`. "static" (default — flex flow), "absolute" or
    /// "fixed" (both treated as absolute against the nearest positioned
    /// ancestor / viewport; we currently don't model "relative" as a
    /// positioning context, so `fixed` ≈ "viewport absolute"). When
    /// absolute, the node is taken out of flex layout and positioned
    /// via top/right/bottom/left.
    pub position: Option<String>,
    pub top: Option<Len>,
    pub right: Option<Len>,
    pub bottom: Option<Len>,
    pub left: Option<Len>,
    /// CSS `z-index`. Affects paint order ONLY — siblings are painted
    /// in ascending z-index (stable within the same z). None = treat
    /// as 0. Unrelated to absolute positioning per se — non-positioned
    /// items can use z-index too in our model.
    pub z_index: Option<i32>,

    // ── Rendering primitives ────────────────────────────────────────
    /// CSS `background: linear-gradient(...)` / `radial-gradient(...)`.
    /// When set, takes precedence over `background` (solid color).
    pub background_gradient: Option<GradientDef>,
    /// CSS `box-shadow`. Multiple shadows allowed (comma-separated in
    /// CSS). Outset shadows are painted BEFORE the box bg so they sit
    /// behind; inset shadows are painted AFTER so they sit on top.
    /// Order within each kind preserves declaration order.
    #[serde(default)]
    pub box_shadow: Vec<BoxShadow>,
    /// CSS `text-shadow`. Same declaration-order/stacking convention as
    /// `box_shadow`. Applies to plain `text` content only (not `spans`).
    #[serde(default)]
    pub text_shadow: Vec<TextShadow>,
    /// CSS `filter: blur(...) drop-shadow(...)`. Applied to the node +
    /// its whole painted subtree as a group (same offscreen-layer
    /// technique as `opacity`) — set means at least one recognized
    /// filter function was present.
    #[serde(default)]
    pub filter: Option<FilterList>,
    /// CSS `mix-blend-mode`. Applies to the node + its whole painted
    /// subtree as a group (same offscreen-layer technique as `opacity`
    /// and `filter`), blended against whatever's already been painted
    /// behind it. Stores the raw CSS keyword; the paint side maps it to
    /// a `tiny_skia::BlendMode` (they correspond almost 1:1). `None` /
    /// `"normal"` / an unrecognized keyword all mean normal compositing.
    pub mix_blend_mode: Option<String>,
    /// CSS `transform: translate(...) rotate(...) scale(...)`. Applied
    /// to fill operations (and SVG path content) for this node and its
    /// descendants. Text content stays axis-aligned — a known
    /// limitation; covers ~80% of "rotate this icon", "scale on hover"
    /// use cases without a text-engine refactor.
    pub transform: Option<TransformList>,
    /// Tailwind `translate-x-*` / `translate-y-*` (emitted as dedicated props
    /// rather than folded into `transform`, since they're separate classes).
    /// `(value, is_percent)`: percent resolves against the element's own
    /// width (x) / height (y) at paint time. Composed onto `transform` in the
    /// paint pass — this is what centers Radix overlays (`-translate-x-1/2`).
    pub translate_x: Option<(f32, bool)>,
    pub translate_y: Option<(f32, bool)>,
    /// CSS `clip-path: inset(...) | circle(...) | ellipse(...) | polygon(...)`.
    /// Currently applies to the background fill + background image only
    /// (text/children paint without clipping). Common avatar / card use
    /// cases work; full subtree clipping is deferred.
    pub clip_path: Option<ClipPath>,
}

// ─── Rendering primitive types ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradientStopDef {
    /// 0.0 - 1.0
    pub offset: f32,
    /// 0xAARRGGBB
    pub color: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GradientShape {
    /// CSS angle in degrees. 0° = "to top", 90° = "to right" (CSS convention).
    Linear { angle_deg: f32 },
    /// Center as fraction (0.0..1.0). Always elliptical-to-box-size.
    Radial { cx: f32, cy: f32 },
    /// `conic-gradient(from <angle> at <cx> <cy>, ...)`. Same angle
    /// convention as `Linear` (0° = up, clockwise) and same center
    /// convention as `Radial`. No native tiny-skia shader for this —
    /// the paint side samples the stop list per pixel by hand instead
    /// of building a `Shader`.
    Conic { angle_deg: f32, cx: f32, cy: f32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradientDef {
    pub shape: GradientShape,
    pub stops: Vec<GradientStopDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoxShadow {
    pub offset_x: f32,
    pub offset_y: f32,
    pub blur: f32,
    pub spread: f32,
    /// 0xAARRGGBB
    pub color: u32,
    /// CSS `inset` shadow — painted INSIDE the box (drawn AFTER the bg
    /// fill) instead of behind it (drawn BEFORE).
    pub inset: bool,
}

/// CSS `text-shadow` entry. Same fields as `BoxShadow` minus `spread`
/// and `inset` (text-shadow doesn't have either).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextShadow {
    pub offset_x: f32,
    pub offset_y: f32,
    pub blur: f32,
    /// 0xAARRGGBB
    pub color: u32,
}

/// One `filter` function. Unrecognized functions (brightness, contrast,
/// saturate, ...) are dropped at parse time rather than represented here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FilterOp {
    /// `blur(<length>)` — Gaussian blur, std-dev == the given px length.
    Blur(f32),
    /// `drop-shadow(<x> <y> [<blur>] [<color>])` — blurs the alpha
    /// silhouette of the filtered subtree (not a box shape, unlike
    /// `box-shadow`) and composites it behind the original.
    DropShadow {
        offset_x: f32,
        offset_y: f32,
        blur: f32,
        /// 0xAARRGGBB
        color: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FilterList(pub Vec<FilterOp>);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TransformOp {
    /// `x`/`y` are px unless the matching `_pct` flag is set, in which case
    /// they're a percentage (0..100) resolved at paint time against the
    /// element's own width (x) / height (y) — CSS `translate(-50%, -50%)`
    /// semantics, which is how Radix centers every dialog/dropdown/tooltip.
    Translate {
        x: f32,
        y: f32,
        #[serde(default)]
        x_pct: bool,
        #[serde(default)]
        y_pct: bool,
    },
    /// Radians.
    Rotate {
        rad: f32,
    },
    Scale {
        x: f32,
        y: f32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TransformList(pub Vec<TransformOp>);

/// One styled inline run. The parent node owns the geometry; spans
/// only carry per-run text + style overrides.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TextSpan {
    /// The literal text content of this run.
    #[serde(default)]
    pub text: String,
    /// 0xAARRGGBB. None = inherit from the parent node's color prop.
    #[serde(default)]
    pub color: Option<u32>,
    /// Faux-bold threshold matches the rest of the engine: >=500 paints
    /// twice with a 1px x-offset.
    #[serde(default)]
    pub weight: Option<u32>,
    /// 0xAARRGGBB. None = no background. Painted as a rect behind the
    /// run's measured width — used by terminals for reverse-video and
    /// by editors for "selection inside a token".
    #[serde(default)]
    pub background: Option<u32>,
    /// Per-run `font-style: italic`, same synthetic-shear rendering as
    /// the node-level `font_style` prop.
    #[serde(default)]
    pub italic: bool,
}

/// CSS `clip-path` shape. Coordinates are stored in `Len` so we can
/// resolve px-vs-% at paint time against the actual box dimensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClipPath {
    /// inset(top right bottom left) with optional rounded corners.
    Inset {
        top: Len,
        right: Len,
        bottom: Len,
        left: Len,
        /// Corner radius — applied uniformly to all four corners.
        /// CSS allows per-corner via `round Atop Bright ...`; we
        /// currently support the single-value form only.
        radius: Len,
    },
    /// circle(r at cx cy). Defaults: cx=cy=50%, r="closest-side".
    /// We store r as Len with a sentinel `Len::Percent(NaN)` meaning
    /// "closest-side"; the paint path resolves it.
    Circle { cx: Len, cy: Len, r: Len },
    /// ellipse(rx ry at cx cy). Same conventions as circle.
    Ellipse { cx: Len, cy: Len, rx: Len, ry: Len },
    /// polygon(x1 y1, x2 y2, ...). Each Len is resolved at paint time
    /// — % is relative to the box width (for x) or height (for y).
    Polygon(Vec<(Len, Len)>),
}

#[derive(Debug, Clone)]
pub enum NodeKind {
    View,
    Text,
    Button,
    /// GPU-backed offscreen surface. The actual pixels live in the
    /// global registry in `gpu.rs`; here we just store the id via
    /// `props.canvas_id` and a layout-box width/height. Paint phase
    /// reads back the surface and blits it.
    Canvas,
    /// `<svg>` root — has width/height for layout, viewBox for child
    /// coordinate space. Children (Path/Line/Circle/Rect/Polyline/
    /// Polygon) are rendered by the SVG paint path; they don't appear
    /// in the Taffy tree.
    Svg,
    /// `<path d="..." />` — geometry from SVG path data.
    SvgPath,
    /// `<line x1=.. y1=.. x2=.. y2=.. />`.
    SvgLine,
    /// `<circle cx=.. cy=.. r=.. />`.
    SvgCircle,
    /// `<rect x=.. y=.. width=.. height=.. rx=.. />`.
    SvgRect,
    /// `<polyline points="x,y x,y ..." />` — open path.
    SvgPolyline,
    /// `<polygon points="x,y ..." />` — closed path.
    SvgPolygon,
    /// `<input>` — single-line text input. Receives keyboard events when
    /// focused, owns its caret + selection state, dispatches change
    /// notifications back to JS via `__cm_dispatch_input(id, value)`.
    Input,
    /// `<textarea>` — multi-line text input. Same machinery as Input
    /// plus up/down arrow handling for cross-line caret movement.
    Textarea,
}

/// Per-input editing state. Lives separate from PaintProps because it
/// changes on every keystroke — keeping it out of the Node struct means
/// Solid/React reconciliation that overwrites props doesn't clobber the
/// caret position.
#[derive(Debug, Clone, Default)]
pub struct InputState {
    /// Byte offset of the caret in `props.text`.
    pub caret: usize,
    /// Anchor of the active selection. Equal to `caret` when nothing
    /// is selected. The visible selection range is
    /// `min(caret, sel_anchor) .. max(caret, sel_anchor)`.
    pub sel_anchor: usize,
    /// Undo stack: snapshots taken BEFORE each mutating edit. Ctrl+Z pops
    /// the top, restores text + caret + anchor, and pushes the current
    /// state onto the redo stack. Capped to keep memory bounded — see
    /// UNDO_LIMIT in the impl.
    pub undo: Vec<InputSnapshot>,
    /// Redo stack: filled by undo, drained by redo. Cleared on any new
    /// edit (matches the "linear undo" model every text editor uses).
    pub redo: Vec<InputSnapshot>,
}

/// One point-in-time view of an input — full text plus caret + anchor.
/// Stored on the undo / redo stacks. Snapshot text is owned (cloned at
/// push time) so subsequent edits to `props.text` don't corrupt history.
#[derive(Debug, Clone)]
pub struct InputSnapshot {
    pub text: String,
    pub caret: usize,
    pub sel_anchor: usize,
}

#[derive(Debug, Clone)]
pub struct Node {
    pub id: u32,
    pub tag: String,
    pub kind: NodeKind,
    pub props: PaintProps,
    pub children: Vec<u32>,
    pub computed_layout: Option<taffy::Layout>,
    pub taffy_id: Option<TaffyNodeId>,
}

/// Per-Taffy-node context for the layout pass. Leaf text nodes carry a
/// (text, font_size) pair so the measure function can wrap them to the
/// available width. Non-text nodes get None.
#[derive(Debug, Clone, Default)]
pub struct NodeCtx {
    pub text: Option<(String, f32)>,
    /// Whether this text leaf should be measured with a monospace font
    /// (font-mono, inherited). Must match the paint side so the layout box
    /// fits what gets rendered.
    pub prefer_mono: bool,
    /// The font-family STRING (own value, else inherited), set on the text
    /// engine before measuring so a plugin-loaded named font's real glyph
    /// widths are what layout sizes against — must match the paint side
    /// (painting/lib.rs's `effective_family`) or the measured box won't
    /// match what gets rendered.
    pub family: Option<String>,
    /// True when `white-space: nowrap` or `text-overflow: ellipsis` is
    /// in effect — the measure callback returns single-line height
    /// regardless of the available width, matching what paint actually
    /// renders (a truncated/overflowing single line, never a wrapped
    /// stack). Must mirror the paint-side decision in painting/lib.rs or
    /// the layout box won't match what gets drawn into it.
    pub force_nowrap: bool,
}

pub struct Scene {
    pub nodes: HashMap<u32, Node>,
    pub root: u32,
    pub taffy: TaffyTree<NodeCtx>,
    pub dirty: bool,
    /// True when the current Taffy layout is up to date for `last_layout_size`.
    /// Distinct from `dirty` (which gates REPAINT and is only cleared by the
    /// paint pass): `layout_valid` gates the expensive Taffy REBUILD. Without
    /// it, every `__cm_layout_box` query between paints (getBoundingClientRect,
    /// offsetWidth, …) re-ran a full-tree layout because `dirty` stays set
    /// until paint — which made interaction-heavy apps (xterm + FitAddon +
    /// ResizeObserver hammering measurements) crawl. Set false on any
    /// structural/style mutation; set true after a rebuild.
    pub layout_valid: bool,
    /// Per-node scroll offset (y only for now). Persists across layout
    /// recomputes so wheel-scrolled views stay where the user left them.
    pub scroll_offsets: HashMap<u32, f32>,
    /// Currently-hovered clickable node id. Updated by the runtime on
    /// MouseMoved events; paint reads this to swap in *_hover props.
    pub hovered: Option<u32>,
    /// Currently-focused node id (typically an `<input>` or `<textarea>`).
    /// Receives keyboard events; paint draws a caret/selection.
    pub focused: Option<u32>,
    /// Per-input editing state. Cleared when the input is removed.
    pub inputs: HashMap<u32, InputState>,
    /// Layout-debug overlay flag. When true, paint draws a colored
    /// outline + tinted fill over every node — like Chrome DevTools'
    /// element inspector. Toggled by Ctrl+Space at the runtime level.
    pub debug_layout: bool,
    /// (width, height) the last successful Taffy compute_layout was run
    /// against. Used by the dirty-gate fast-path: if the scene isn't
    /// structurally dirty AND the viewport hasn't changed, layout is
    /// reused as-is (the cached `computed_layout` on each node stays
    /// valid). On window resize this differs from the new (w, h) and
    /// forces a real layout pass.
    pub last_layout_size: Option<(f32, f32)>,
    /// Paint-only damage flag. Set by changes that don't affect layout
    /// (scroll offset, hover state, focus blink) so the paint loop knows
    /// to repaint without forcing a full Taffy rebuild. Cleared after
    /// each successful paint pass alongside `dirty`.
    pub repaint_dirty: bool,
    /// Bounding rectangle in window coords of the region that needs to
    /// be repainted this frame. None = full window (default for any
    /// structural change). Some((x, y, w, h)) = scoped damage; the paint
    /// loop skips clear_white and paint() culls nodes outside this rect.
    /// Set by `set_scroll_y` to the scrolled container's box; can be
    /// extended later for hover-only and focus-only damage too.
    pub dirty_rect: Option<(f32, f32, f32, f32)>,
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}

impl Scene {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            root: 0,
            taffy: TaffyTree::new(),
            dirty: true,
            layout_valid: false,
            scroll_offsets: HashMap::new(),
            hovered: None,
            focused: None,
            inputs: HashMap::new(),
            debug_layout: std::env::var_os("CARBON_MINI_DEBUG_LAYOUT").is_some(),
            last_layout_size: None,
            repaint_dirty: false,
            dirty_rect: None,
        }
    }

    /// Walk from root to `target`, summing every ancestor's location to
    /// produce the target's absolute (window-coord) bounding box. Returns
    /// None if any ancestor lacks a computed layout. Cheap because trees
    /// are shallow (chat-app depths peak around 12).
    pub fn absolute_box(&self, target: u32) -> Option<(f32, f32, f32, f32)> {
        fn walk(s: &Scene, id: u32, target: u32, ox: f32, oy: f32) -> Option<(f32, f32, f32, f32)> {
            let n = s.nodes.get(&id)?;
            let layout = n.computed_layout?;
            let x = ox + layout.location.x;
            let y = oy + layout.location.y;
            if id == target {
                return Some((x, y, layout.size.width, layout.size.height));
            }
            for &c in &n.children {
                if let Some(b) = walk(s, c, target, x, y) {
                    return Some(b);
                }
            }
            None
        }
        walk(self, self.root, target, 0.0, 0.0)
    }

    /// Ancestor chain for `target`, DEEPEST-FIRST (`target` itself, then its
    /// parent, ..., ending at `root`). Empty if `target` isn't in the tree.
    /// `Node` has no parent pointer — children-only, same shape
    /// `create_node`/`insert_node` already build — so this walks down from
    /// the root once, recording the path taken, and returns it reversed the
    /// moment `target` is found. O(n) worst case, same cost class as
    /// `dump_tree`'s full scan; callers are event dispatch (bubbling one
    /// click) and `scroll_into_view` (once per call), neither a per-frame
    /// hot path.
    pub fn ancestor_chain(&self, target: u32) -> Vec<u32> {
        fn walk(nodes: &HashMap<u32, Node>, id: u32, target: u32, path: &mut Vec<u32>) -> bool {
            path.push(id);
            if id == target {
                return true;
            }
            if let Some(n) = nodes.get(&id) {
                for &cid in &n.children {
                    if walk(nodes, cid, target, path) {
                        return true;
                    }
                }
            }
            path.pop();
            false
        }
        let mut path = Vec::new();
        if self.root != 0 && walk(&self.nodes, self.root, target, &mut path) {
            path.reverse();
            path
        } else {
            Vec::new()
        }
    }

    /// Scroll the nearest scrollable ancestor of `id` (walking up via
    /// `ancestor_chain`) just enough to bring `id`'s box into that
    /// ancestor's visible band — the native side of `ref.current.scrollIntoView()`.
    /// No smooth animation, no block/inline alignment options: own-value
    /// only, the same simplification this engine already accepts for
    /// scroll-snap and sticky. A no-op if `id` has no scrollable ancestor or
    /// is already visible. Only the nearest scrollport is considered — an
    /// ancestor scrollport further up isn't adjusted, matching the
    /// direct-parent-only simplification `sticky`/`absolute` already make.
    pub fn scroll_into_view(&mut self, id: u32) {
        let chain = self.ancestor_chain(id);
        let scrollport = chain.iter().skip(1).find(|&&aid| {
            self.nodes
                .get(&aid)
                .map(|n| n.props.overflow_y)
                .unwrap_or(false)
        });
        let Some(&scrollport) = scrollport else {
            return;
        };
        let (Some((_, target_y, _, target_h)), Some((_, port_y, _, port_h))) =
            (self.absolute_box(id), self.absolute_box(scrollport))
        else {
            return;
        };
        // absolute_box is scroll-independent (reads raw taffy layout), so
        // both boxes are already in the same unscrolled content space —
        // target's offset within the scrollport's own content is just the
        // difference of the two.
        let rel_y = target_y - port_y;
        let cur = self.scroll_y(scrollport);
        let new_scroll = if rel_y < cur {
            rel_y
        } else if rel_y + target_h > cur + port_h {
            rel_y + target_h - port_h
        } else {
            return; // already visible
        };
        self.set_scroll_y(scrollport, new_scroll);
    }

    /// Expand `dirty_rect` to cover the given window-coord rect. Used by
    /// scroll / hover / focus paths to communicate damage scope to the
    /// paint loop without overpainting the entire window.
    pub fn add_damage(&mut self, x: f32, y: f32, w: f32, h: f32) {
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        self.dirty_rect = match self.dirty_rect {
            None => Some((x, y, w, h)),
            Some((dx, dy, dw, dh)) => {
                let l = dx.min(x);
                let t = dy.min(y);
                let r = (dx + dw).max(x + w);
                let b = (dy + dh).max(y + h);
                Some((l, t, r - l, b - t))
            }
        };
    }

    /// Walk the tree depth-first from `root` and return every Input /
    /// Textarea id in DOM order. Used for Tab focus traversal — matches
    /// browser-style "next focusable element" semantics.
    pub fn focusable_inputs(&self) -> Vec<u32> {
        let mut out = Vec::new();
        self.collect_focusable(self.root, &mut out);
        out
    }

    fn collect_focusable(&self, id: u32, out: &mut Vec<u32>) {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return,
        };
        if matches!(n.kind, NodeKind::Input | NodeKind::Textarea) {
            out.push(id);
        }
        for &c in &n.children {
            self.collect_focusable(c, out);
        }
    }

    /// Drop every node + the Taffy tree so a fresh bundle re-eval can
    /// rebuild the scene from scratch. Used by --dev HMR. Cheap: a few
    /// hundred HashMap drops + a TaffyTree alloc, both well under a ms.
    pub fn reset_for_hmr(&mut self) {
        self.nodes.clear();
        self.root = 0;
        self.taffy = TaffyTree::new();
        self.dirty = true;
        self.layout_valid = false;
        self.scroll_offsets.clear();
        self.hovered = None;
        self.focused = None;
        self.inputs.clear();
        self.last_layout_size = None;
        self.repaint_dirty = true;
        self.dirty_rect = None;
    }

    // ─── Input editing helpers ──────────────────────────────────────────
    //
    // All operate on `props.text` of the input node and the InputState
    // entry in `self.inputs`. Each mutator marks the scene dirty so the
    // event-loop knows to repaint.

    pub fn input_state_mut(&mut self, id: u32) -> &mut InputState {
        self.inputs.entry(id).or_default()
    }

    pub fn input_state(&self, id: u32) -> Option<&InputState> {
        self.inputs.get(&id)
    }

    /// Snapshot the input's current text + caret + anchor onto its undo
    /// stack, drop the redo stack (linear-history model). Called at the top
    /// of every mutating editor op so Ctrl+Z restores the pre-op state.
    /// Coalesces consecutive identical states to keep the stack tight.
    fn push_undo_snapshot(&mut self, id: u32) {
        let text = match self.nodes.get(&id).and_then(|n| n.props.text.clone()) {
            Some(t) => t,
            None => return,
        };
        let st = self.inputs.entry(id).or_default();
        if let Some(top) = st.undo.last() {
            if top.text == text && top.caret == st.caret && top.sel_anchor == st.sel_anchor {
                return;
            }
        }
        const UNDO_LIMIT: usize = 200;
        if st.undo.len() >= UNDO_LIMIT {
            st.undo.remove(0);
        }
        st.undo.push(InputSnapshot {
            text,
            caret: st.caret,
            sel_anchor: st.sel_anchor,
        });
        st.redo.clear();
    }

    /// Restore the previous snapshot from the undo stack and push the
    /// current state onto the redo stack. Returns the post-undo text so
    /// the caller can dispatch onChange to React.
    pub fn input_undo(&mut self, id: u32) -> Option<String> {
        let prev = {
            let st = self.inputs.get_mut(&id)?;
            st.undo.pop()?
        };
        let cur_text = self
            .nodes
            .get(&id)
            .and_then(|n| n.props.text.clone())
            .unwrap_or_default();
        let (cur_caret, cur_anchor) = self
            .inputs
            .get(&id)
            .map(|s| (s.caret, s.sel_anchor))
            .unwrap_or((0, 0));
        if let Some(st) = self.inputs.get_mut(&id) {
            st.redo.push(InputSnapshot {
                text: cur_text,
                caret: cur_caret,
                sel_anchor: cur_anchor,
            });
            st.caret = prev.caret.min(prev.text.len());
            st.sel_anchor = prev.sel_anchor.min(prev.text.len());
        }
        if let Some(n) = self.nodes.get_mut(&id) {
            n.props.text = Some(prev.text.clone());
        }
        self.dirty = true;
        self.layout_valid = false;
        Some(prev.text)
    }

    /// Symmetric inverse of `input_undo`: pop redo, push current onto undo.
    pub fn input_redo(&mut self, id: u32) -> Option<String> {
        let next = {
            let st = self.inputs.get_mut(&id)?;
            st.redo.pop()?
        };
        let cur_text = self
            .nodes
            .get(&id)
            .and_then(|n| n.props.text.clone())
            .unwrap_or_default();
        let (cur_caret, cur_anchor) = self
            .inputs
            .get(&id)
            .map(|s| (s.caret, s.sel_anchor))
            .unwrap_or((0, 0));
        if let Some(st) = self.inputs.get_mut(&id) {
            st.undo.push(InputSnapshot {
                text: cur_text,
                caret: cur_caret,
                sel_anchor: cur_anchor,
            });
            st.caret = next.caret.min(next.text.len());
            st.sel_anchor = next.sel_anchor.min(next.text.len());
        }
        if let Some(n) = self.nodes.get_mut(&id) {
            n.props.text = Some(next.text.clone());
        }
        self.dirty = true;
        self.layout_valid = false;
        Some(next.text)
    }

    /// Replace selection (or just-after-caret position) with `s`.
    /// Returns the new text so the caller can dispatch onChange.
    pub fn input_insert_str(&mut self, id: u32, s: &str) -> Option<String> {
        self.push_undo_snapshot(id);
        let n = self.nodes.get_mut(&id)?;
        let text = n.props.text.clone().unwrap_or_default();
        let st = self.inputs.entry(id).or_default();
        let (start, end) = sel_range(text.len(), st);
        let mut out = String::with_capacity(text.len() + s.len());
        out.push_str(&text[..start]);
        out.push_str(s);
        out.push_str(&text[end..]);
        let new_caret = start + s.len();
        n.props.text = Some(out.clone());
        st.caret = new_caret;
        st.sel_anchor = new_caret;
        self.dirty = true;
        self.layout_valid = false;
        Some(out)
    }

    /// Backspace: delete the character before the caret, or the active
    /// selection if there is one.
    pub fn input_backspace(&mut self, id: u32) -> Option<String> {
        self.push_undo_snapshot(id);
        let n = self.nodes.get_mut(&id)?;
        let text = n.props.text.clone().unwrap_or_default();
        let st = self.inputs.entry(id).or_default();
        let (start, end) = sel_range(text.len(), st);
        let (new_text, new_caret) = if start == end {
            if start == 0 {
                return Some(text);
            }
            let prev = prev_char_boundary(&text, start);
            let mut out = String::with_capacity(text.len());
            out.push_str(&text[..prev]);
            out.push_str(&text[start..]);
            (out, prev)
        } else {
            let mut out = String::with_capacity(text.len());
            out.push_str(&text[..start]);
            out.push_str(&text[end..]);
            (out, start)
        };
        n.props.text = Some(new_text.clone());
        st.caret = new_caret;
        st.sel_anchor = new_caret;
        self.dirty = true;
        self.layout_valid = false;
        Some(new_text)
    }

    /// Delete: forward delete — like backspace but at + 1.
    pub fn input_delete(&mut self, id: u32) -> Option<String> {
        self.push_undo_snapshot(id);
        let n = self.nodes.get_mut(&id)?;
        let text = n.props.text.clone().unwrap_or_default();
        let st = self.inputs.entry(id).or_default();
        let (start, end) = sel_range(text.len(), st);
        let (new_text, new_caret) = if start == end {
            if start >= text.len() {
                return Some(text);
            }
            let next = next_char_boundary(&text, start);
            let mut out = String::with_capacity(text.len());
            out.push_str(&text[..start]);
            out.push_str(&text[next..]);
            (out, start)
        } else {
            let mut out = String::with_capacity(text.len());
            out.push_str(&text[..start]);
            out.push_str(&text[end..]);
            (out, start)
        };
        n.props.text = Some(new_text.clone());
        st.caret = new_caret;
        st.sel_anchor = new_caret;
        self.dirty = true;
        self.layout_valid = false;
        Some(new_text)
    }

    /// Move caret. `extend` keeps the current sel_anchor (selection grows);
    /// otherwise the anchor follows the caret (no selection).
    pub fn input_move_caret(&mut self, id: u32, dir: CaretMove, extend: bool) {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return,
        };
        let text_len = n.props.text.as_deref().map(|s| s.len()).unwrap_or(0);
        let text = n.props.text.clone().unwrap_or_default();
        let st = self.inputs.entry(id).or_default();
        let new_caret = match dir {
            CaretMove::Left => prev_char_boundary(&text, st.caret),
            CaretMove::Right => next_char_boundary(&text, st.caret),
            CaretMove::Home => 0,
            CaretMove::End => text_len,
        };
        st.caret = new_caret;
        if !extend {
            st.sel_anchor = new_caret;
        }
        self.dirty = true;
        self.layout_valid = false;
    }

    /// Select the entire text content.
    pub fn input_select_all(&mut self, id: u32) {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return,
        };
        let text_len = n.props.text.as_deref().map(|s| s.len()).unwrap_or(0);
        let st = self.inputs.entry(id).or_default();
        st.sel_anchor = 0;
        st.caret = text_len;
        self.dirty = true;
        self.layout_valid = false;
    }

    /// Select the word that contains the byte offset `at`. A "word" here is
    /// a run of word characters (alphanumeric + underscore) bounded by
    /// non-word characters or string ends — the OS-standard double-click
    /// selection behavior.
    pub fn input_select_word(&mut self, id: u32, at: usize) {
        let text = match self.nodes.get(&id).and_then(|n| n.props.text.clone()) {
            Some(t) => t,
            None => return,
        };
        let bytes = text.as_bytes();
        let len = bytes.len();
        if len == 0 {
            return;
        }
        let at = at.min(len);
        let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        // If the click landed past the end or on whitespace, prefer the
        // word immediately to the LEFT of the caret (matches OS behavior
        // when double-clicking just after the last char of a word).
        let mut probe = at;
        if (probe == len || (probe < len && !is_word(bytes[probe])))
            && probe > 0
            && is_word(bytes[probe - 1])
        {
            probe -= 1;
        }
        if probe >= len || !is_word(bytes[probe]) {
            return;
        }
        let mut start = probe;
        while start > 0 && is_word(bytes[start - 1]) {
            start -= 1;
        }
        let mut end = probe + 1;
        while end < len && is_word(bytes[end]) {
            end += 1;
        }
        let st = self.inputs.entry(id).or_default();
        st.sel_anchor = start;
        st.caret = end;
        self.dirty = true;
        self.layout_valid = false;
    }

    /// Set caret + anchor to a specific byte offset (used by mouse-click
    /// hit-test results).
    pub fn input_set_caret(&mut self, id: u32, byte_offset: usize, extend: bool) {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return,
        };
        let text_len = n.props.text.as_deref().map(|s| s.len()).unwrap_or(0);
        let off = byte_offset.min(text_len);
        let st = self.inputs.entry(id).or_default();
        st.caret = off;
        if !extend {
            st.sel_anchor = off;
        }
        self.dirty = true;
        self.layout_valid = false;
    }

    /// Copy the currently-selected substring out of `id`'s text. Returns
    /// the empty string if nothing is selected.
    pub fn input_selected_text(&self, id: u32) -> String {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return String::new(),
        };
        let text = match &n.props.text {
            Some(s) => s,
            None => return String::new(),
        };
        let st = match self.inputs.get(&id) {
            Some(s) => s,
            None => return String::new(),
        };
        let (start, end) = sel_range(text.len(), st);
        if start == end {
            return String::new();
        }
        text[start..end].to_string()
    }

    /// Hit-test: find the byte offset within the input's text that
    /// corresponds to a click at (x, y) in BOX-LOCAL coords. Uses the
    /// soft-wrap-aware visual lines so clicks on word-wrapped text land
    /// on the right character.
    pub fn input_caret_from_xy(
        &self,
        id: u32,
        x: f32,
        y: f32,
        te: &mut crate::text::TextEngine,
    ) -> usize {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return 0,
        };
        let text = match &n.props.text {
            Some(s) => s.clone(),
            None => return 0,
        };
        let pad_left = n
            .props
            .padding_left
            .or(n.props.padding_x)
            .or(n.props.padding)
            .unwrap_or(0.0);
        let pad_top = n
            .props
            .padding_top
            .or(n.props.padding_y)
            .or(n.props.padding)
            .unwrap_or(0.0);
        let fs = n.props.font_size.unwrap_or(14.0);
        let line_h = fs * 1.2;
        let is_textarea = matches!(n.kind, NodeKind::Textarea);
        let max_width = if is_textarea {
            self.editor_inner_width(id)
        } else {
            0.0
        };
        // Own value only, matching `fs` above (n.props.font_size.unwrap_or)
        // — this hit-test helper doesn't walk the ancestor chain either;
        // real inheritance is the paint/layout passes' job.
        te.cur_family = n.props.font_family.clone();
        let visual_lines = self.editor_visual_lines(&text, fs, max_width, te);
        let local_x = (x - pad_left).max(0.0);
        let local_y = (y - pad_top).max(0.0);
        let line_idx = if is_textarea {
            ((local_y / line_h.max(1.0)).floor() as usize).min(visual_lines.len().saturating_sub(1))
        } else {
            0
        };
        let (line_start, line_end) = visual_lines
            .get(line_idx)
            .copied()
            .unwrap_or((text.len(), text.len()));
        let line_text = &text[line_start..line_end];
        let mut acc = 0.0_f32;
        let mut byte_off = 0usize;
        for ch in line_text.chars() {
            let (cw, _) = te.measure(&ch.to_string(), fs);
            if local_x < acc + cw * 0.5 {
                return line_start + byte_off;
            }
            acc += cw;
            byte_off += ch.len_utf8();
        }
        line_start + line_text.len()
    }

    /// Convert a byte offset in the input's text into (line_idx, col_byte).
    pub fn caret_to_line_col(&self, id: u32, caret: usize) -> (usize, usize) {
        let text = self
            .nodes
            .get(&id)
            .and_then(|n| n.props.text.as_deref())
            .unwrap_or("");
        let caret = caret.min(text.len());
        let mut line = 0usize;
        let mut col_start = 0usize;
        for (i, ch) in text.char_indices() {
            if i >= caret {
                break;
            }
            if ch == '\n' {
                line += 1;
                col_start = i + 1;
            }
        }
        (line, caret - col_start)
    }

    /// Inverse of [`caret_to_line_col`]. Clamps line_idx and col to bounds.
    pub fn line_col_to_caret(&self, id: u32, line_idx: usize, col_byte: usize) -> usize {
        let text = self
            .nodes
            .get(&id)
            .and_then(|n| n.props.text.as_deref())
            .unwrap_or("");
        let mut current_line = 0usize;
        let mut line_start = 0usize;
        for (i, ch) in text.char_indices() {
            if current_line == line_idx {
                break;
            }
            if ch == '\n' {
                line_start = i + 1;
                current_line += 1;
            }
        }
        if current_line < line_idx {
            return text.len();
        }
        let line_end = text[line_start..]
            .find('\n')
            .map(|p| line_start + p)
            .unwrap_or(text.len());
        (line_start + col_byte).min(line_end)
    }

    /// Compute the visual-line byte ranges for an editor's text. Each
    /// entry is `(byte_start, byte_end)` into the full text. Honors `\n`
    /// as a hard break and word-wraps logical lines that exceed
    /// `max_width`. Always returns at least one entry (even for empty
    /// text — that's a single zero-width line at offset 0). For
    /// `<input>` (single-line) or when `max_width <= 0`, only `\n`
    /// breaks are considered.
    pub fn editor_visual_lines(
        &self,
        text: &str,
        fs: f32,
        max_width: f32,
        te: &mut crate::text::TextEngine,
    ) -> Vec<(usize, usize)> {
        if text.is_empty() {
            return vec![(0, 0)];
        }
        let mut out = Vec::new();
        let mut logical_byte_start = 0usize;
        let space_w = te.measure(" ", fs).0;
        for logical_line in text.split('\n') {
            let logical_byte_end = logical_byte_start + logical_line.len();
            if max_width <= 0.0 || logical_line.is_empty() {
                out.push((logical_byte_start, logical_byte_end));
            } else {
                let (single_w, _) = te.measure(logical_line, fs);
                if single_w <= max_width {
                    out.push((logical_byte_start, logical_byte_end));
                } else {
                    // Word-wrap this logical line — walk word by word,
                    // emit a new visual line whenever the next word
                    // would overflow. `leading_w` counts the actual
                    // spaces between the previous word's end and the
                    // current word's start (not the byte distance from
                    // `sub_start`, which would over-count once words
                    // have been packed onto the line).
                    let bytes = logical_line.as_bytes();
                    let mut sub_start = 0usize; // relative to logical_line
                    let mut i = 0usize;
                    let mut current_w = 0.0_f32;
                    let mut prev_word_end: Option<usize> = None;
                    while i < logical_line.len() {
                        while i < logical_line.len() && bytes[i] == b' ' {
                            i += 1;
                        }
                        let word_start = i;
                        while i < logical_line.len() && bytes[i] != b' ' {
                            i += 1;
                        }
                        if word_start == i {
                            break;
                        }
                        let word = &logical_line[word_start..i];
                        let word_w = te.measure(word, fs).0;
                        let leading_w = match prev_word_end {
                            Some(p) if word_start > p && word_start > sub_start => {
                                (word_start - p) as f32 * space_w
                            }
                            _ => 0.0,
                        };
                        if current_w + leading_w + word_w > max_width && word_start > sub_start {
                            out.push((
                                logical_byte_start + sub_start,
                                logical_byte_start + word_start,
                            ));
                            sub_start = word_start;
                            current_w = word_w;
                        } else {
                            current_w += leading_w + word_w;
                        }
                        prev_word_end = Some(i);
                    }
                    out.push((logical_byte_start + sub_start, logical_byte_end));
                }
            }
            logical_byte_start = logical_byte_end + 1;
        }
        if out.is_empty() {
            out.push((0, 0));
        }
        out
    }

    /// Inner content width of an editor node (its layout box minus
    /// padding). Returns 0 if the node has no computed layout yet.
    pub fn editor_inner_width(&self, id: u32) -> f32 {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return 0.0,
        };
        let layout = match n.computed_layout {
            Some(l) => l,
            None => return 0.0,
        };
        let pad_left = n
            .props
            .padding_left
            .or(n.props.padding_x)
            .or(n.props.padding)
            .unwrap_or(0.0);
        let pad_right = n
            .props
            .padding_right
            .or(n.props.padding_x)
            .or(n.props.padding)
            .unwrap_or(0.0);
        (layout.size.width - pad_left - pad_right).max(0.0)
    }

    /// Find the visual-line index that contains a given caret byte
    /// offset, plus the column byte offset within that visual line.
    /// Used by caret painting and arrow-key vertical movement.
    pub fn caret_to_visual_line_col(
        visual_lines: &[(usize, usize)],
        caret: usize,
    ) -> (usize, usize) {
        for (i, (s, e)) in visual_lines.iter().enumerate() {
            if caret >= *s && caret <= *e {
                return (i, caret - s);
            }
        }
        // Past end — return last visual line at its end.
        if let Some((s, e)) = visual_lines.last() {
            (visual_lines.len() - 1, e - s)
        } else {
            (0, 0)
        }
    }

    /// Convert a (visual_line_idx, col_byte) pair back to a caret byte
    /// offset. Clamps line and col to bounds.
    pub fn visual_line_col_to_caret(
        visual_lines: &[(usize, usize)],
        line_idx: usize,
        col_byte: usize,
    ) -> usize {
        if visual_lines.is_empty() {
            return 0;
        }
        let line_idx = line_idx.min(visual_lines.len() - 1);
        let (s, e) = visual_lines[line_idx];
        (s + col_byte).min(e)
    }

    /// Move the caret one visual line up/down in a textarea, preserving
    /// the column position (clamped to the new line's length). Operates
    /// in VISUAL line space (so soft-wrapped lines count) — pass the
    /// editor's inner width so we can compute wrapping the same way the
    /// paint path does.
    pub fn input_move_caret_vertical(
        &mut self,
        id: u32,
        up: bool,
        extend: bool,
        max_width: f32,
        te: &mut crate::text::TextEngine,
    ) {
        let (text, fs, family) = {
            let n = match self.nodes.get(&id) {
                Some(n) => n,
                None => return,
            };
            (
                n.props.text.clone().unwrap_or_default(),
                n.props.font_size.unwrap_or(14.0),
                n.props.font_family.clone(),
            )
        };
        te.cur_family = family;
        let visual_lines = self.editor_visual_lines(&text, fs, max_width, te);
        let caret = self.input_state(id).map(|s| s.caret).unwrap_or(0);
        let (vidx, col) = Self::caret_to_visual_line_col(&visual_lines, caret);
        let new_vidx = if up {
            if vidx == 0 {
                0
            } else {
                vidx - 1
            }
        } else {
            (vidx + 1).min(visual_lines.len().saturating_sub(1))
        };
        let new_caret = Self::visual_line_col_to_caret(&visual_lines, new_vidx, col);
        let st = self.inputs.entry(id).or_default();
        st.caret = new_caret;
        if !extend {
            st.sel_anchor = new_caret;
        }
        self.dirty = true;
        self.layout_valid = false;
    }

    pub fn create_node(&mut self, id: u32, tag: &str, mut props: PaintProps) {
        let kind = match tag {
            "text" => NodeKind::Text,
            "button" => NodeKind::Button,
            "canvas" => NodeKind::Canvas,
            "svg" => NodeKind::Svg,
            "path" => NodeKind::SvgPath,
            "line" => NodeKind::SvgLine,
            "circle" => NodeKind::SvgCircle,
            "rect" => NodeKind::SvgRect,
            "polyline" => NodeKind::SvgPolyline,
            "polygon" => NodeKind::SvgPolygon,
            "input" => NodeKind::Input,
            "textarea" => NodeKind::Textarea,
            _ => NodeKind::View,
        };
        // Input / Textarea defaults: clickable so the runtime's hit-test
        // dispatches focus + caret-position on press, and an I-beam cursor
        // so the OS pointer matches what users expect over a text field.
        if matches!(kind, NodeKind::Input | NodeKind::Textarea) {
            props.clickable = true;
            if props.cursor.is_none() {
                props.cursor = Some("text".to_string());
            }
        }
        // Button default: clickable. Radix's `<DropdownMenuTrigger asChild>`
        // / `<Slot>` etc. clone the underlying <button> and inject an
        // onClick at render time in a way that doesn't always reach our
        // applyProps onClick branch — leaving the button non-clickable and
        // un-hit-testable. Defaulting clickable=true on every <button>
        // lets the hit-test always find it; the JS-side dispatch then
        // calls __cm_dispatch_click → whatever click handler React /
        // Radix has registered.
        if matches!(kind, NodeKind::Button) {
            props.clickable = true;
        }
        let node = Node {
            id,
            tag: tag.to_string(),
            kind,
            props,
            children: Vec::new(),
            computed_layout: None,
            taffy_id: None,
        };
        self.nodes.insert(id, node);
        self.dirty = true;
        self.layout_valid = false;
    }

    pub fn set_text(&mut self, id: u32, text: String) {
        if let Some(n) = self.nodes.get_mut(&id) {
            n.props.text = Some(text);
            self.dirty = true;
            self.layout_valid = false;
        }
    }

    /// Reset all PAINT-related props on a node to their defaults. Used
    /// by the React reconciler before commitUpdate re-applies the
    /// current frame's className-resolved styles — without this, stale
    /// conditional styles (state variants, hover, etc.) from a previous
    /// state would persist and pollute the new render.
    ///
    /// Preserves: tag, kind, parent/child relationships, text content.
    /// Resets: every visual style + the click/hover behavior flags
    /// (those will be re-set by the same commit pass if still in effect).
    pub fn reset_paint_props(&mut self, id: u32) {
        if let Some(n) = self.nodes.get_mut(&id) {
            // Preserve text and tag, drop the rest of PaintProps.
            let preserved_text = n.props.text.clone();
            // Inputs / textareas need their kind-specific defaults (the
            // ones `create_node` sets) restored too — otherwise the
            // reconciler's commitUpdate pass wipes `clickable` on every
            // re-render and the next click on the input is ignored by
            // hit_test. Reproducible: focus input → type a char → React
            // re-renders with new value → reset_paint_props clears
            // clickable → second click misses.
            let kind = n.kind.clone();
            n.props = PaintProps::default();
            n.props.text = preserved_text;
            if matches!(kind, NodeKind::Input | NodeKind::Textarea) {
                n.props.clickable = true;
                n.props.cursor = Some("text".to_string());
            }
            // Same rationale as create_node: keep buttons clickable across
            // commitUpdate re-renders so Radix-cloned buttons don't go dark
            // after their first hit. See create_node comment.
            if matches!(kind, NodeKind::Button) {
                n.props.clickable = true;
            }
            self.dirty = true;
            self.layout_valid = false;
        }
    }

    pub fn set_prop(&mut self, id: u32, key: &str, value_json: &str) {
        let v: serde_json::Value = match serde_json::from_str(value_json) {
            Ok(v) => v,
            Err(_) => serde_json::Value::String(value_json.to_string()),
        };
        if let Some(n) = self.nodes.get_mut(&id) {
            match key {
                "background" => {
                    // Detect `linear-gradient(...)` / `radial-gradient(...)`
                    // before falling through to solid-color parsing. The
                    // two outputs are mutually exclusive — setting one
                    // clears the other so toggling between gradient and
                    // solid in the same prop works.
                    let raw = v.as_str().unwrap_or("");
                    let trimmed = raw.trim_start();
                    if trimmed.starts_with("linear-gradient(") {
                        n.props.background_gradient =
                            crate::css_parse::parse_linear_gradient(trimmed);
                        n.props.background = None;
                    } else if trimmed.starts_with("radial-gradient(") {
                        n.props.background_gradient =
                            crate::css_parse::parse_radial_gradient(trimmed);
                        n.props.background = None;
                    } else if trimmed.starts_with("conic-gradient(") {
                        n.props.background_gradient =
                            crate::css_parse::parse_conic_gradient(trimmed);
                        n.props.background = None;
                    } else {
                        n.props.background = parse_color(&v);
                        n.props.background_gradient = None;
                    }
                }
                "box-shadow" | "box_shadow" | "boxShadow" => {
                    let raw = v.as_str().unwrap_or("");
                    if raw.trim().is_empty() || raw.trim() == "none" {
                        n.props.box_shadow.clear();
                    } else {
                        n.props.box_shadow = crate::css_parse::parse_box_shadow(raw);
                    }
                }
                "transform" => {
                    let raw = v.as_str().unwrap_or("");
                    if raw.trim().is_empty() || raw.trim() == "none" {
                        n.props.transform = None;
                    } else {
                        n.props.transform = crate::css_parse::parse_transform(raw);
                    }
                }
                "clip-path" | "clip_path" | "clipPath" => {
                    let raw = v.as_str().unwrap_or("");
                    n.props.clip_path = crate::css_parse::parse_clip_path(raw);
                }
                "position" => {
                    n.props.position = v.as_str().map(|s| s.to_string());
                }
                "top" => {
                    n.props.top = parse_len(&v);
                }
                "right" => {
                    n.props.right = parse_len(&v);
                }
                "bottom" => {
                    n.props.bottom = parse_len(&v);
                }
                "left" => {
                    n.props.left = parse_len(&v);
                }
                // Logical inset properties, aliased to their physical
                // LTR equivalent. No bidi/RTL model exists in this
                // engine (no `direction` prop, no mirrored layout) — so
                // "inline-start" always means "left", same as it would
                // in an LTR document. An RTL app gets the wrong edge
                // rather than the right one turned around; there's no
                // way to do better without a real direction concept.
                "inset-inline-start" | "inset_inline_start" | "insetInlineStart" => {
                    n.props.left = parse_len(&v);
                }
                "inset-inline-end" | "inset_inline_end" | "insetInlineEnd" => {
                    n.props.right = parse_len(&v);
                }
                "inset-block-start" | "inset_block_start" | "insetBlockStart" => {
                    n.props.top = parse_len(&v);
                }
                "inset-block-end" | "inset_block_end" | "insetBlockEnd" => {
                    n.props.bottom = parse_len(&v);
                }
                "z-index" | "z_index" | "zIndex" => {
                    n.props.z_index = parse_f32(&v)
                        .map(|f| f.round() as i32)
                        .or_else(|| v.as_i64().map(|i| i as i32));
                }
                "color" => n.props.color = parse_color(&v),
                "background-hover" | "background_hover" | "backgroundHover" => {
                    n.props.background_hover = parse_color(&v);
                }
                "color-hover" | "color_hover" | "colorHover" => {
                    n.props.color_hover = parse_color(&v);
                }
                "background-focus" | "background_focus" | "backgroundFocus" => {
                    n.props.background_focus = parse_color(&v);
                }
                "color-focus" | "color_focus" | "colorFocus" => {
                    n.props.color_focus = parse_color(&v);
                }
                "font_size" | "fontSize" | "font-size" => n.props.font_size = parse_f32(&v),
                "border_radius" | "borderRadius" | "border-radius" => {
                    n.props.border_radius = parse_f32(&v).unwrap_or(0.0);
                }
                "corner-shape" | "corner_shape" | "cornerShape" => {
                    n.props.corner_shape =
                        v.as_str().and_then(crate::css_parse::parse_corner_shape);
                }
                "opacity" => {
                    // Accept a unitless number (CSS opacity) or a string.
                    // Clamp to [0,1]; treat 1.0 as "no opacity layer" (None)
                    // so the common fully-opaque case pays nothing in paint.
                    let o = parse_f32(&v).unwrap_or(1.0).clamp(0.0, 1.0);
                    n.props.opacity = if o >= 0.999 { None } else { Some(o) };
                }
                // Tailwind translate-x/translate-y (see PaintProps.translate_x).
                // Value may be "-50%" (percent, resolved against own size) or
                // a px length like "10" / "10px".
                "translateX" | "translate_x" => {
                    n.props.translate_x = parse_translate_prop(&v);
                }
                "translateY" | "translate_y" => {
                    n.props.translate_y = parse_translate_prop(&v);
                }
                "text" => n.props.text = v.as_str().map(|s| s.to_string()),
                "display" => {
                    n.props.display = v.as_str().map(|s| s.to_string());
                }
                "flex_direction" | "flexDirection" | "flex-direction" => {
                    n.props.flex_direction = v.as_str().map(|s| s.to_string());
                }
                "justify_content" | "justifyContent" | "justify-content" => {
                    n.props.justify_content = v.as_str().map(|s| s.to_string());
                }
                "align_items" | "alignItems" | "align-items" => {
                    n.props.align_items = v.as_str().map(|s| s.to_string());
                }
                // CSS Grid container props ────────────────────────────
                "grid-template-columns" | "grid_template_columns" | "gridTemplateColumns" => {
                    n.props.grid_template_columns = v.as_str().map(|s| s.to_string());
                }
                "grid-template-rows" | "grid_template_rows" | "gridTemplateRows" => {
                    n.props.grid_template_rows = v.as_str().map(|s| s.to_string());
                }
                "grid-auto-flow" | "grid_auto_flow" | "gridAutoFlow" => {
                    n.props.grid_auto_flow = v.as_str().map(|s| s.to_string());
                }
                "justify-items" | "justify_items" | "justifyItems" => {
                    n.props.justify_items = v.as_str().map(|s| s.to_string());
                }
                "align-content" | "align_content" | "alignContent" => {
                    n.props.align_content = v.as_str().map(|s| s.to_string());
                }
                // `place-items: X` is shorthand for align-items + justify-items
                // (single-value form). Two-value form ("center stretch")
                // splits on whitespace.
                "place-items" | "place_items" | "placeItems" => {
                    if let Some(s) = v.as_str() {
                        let mut parts = s.split_whitespace();
                        let a = parts.next().unwrap_or("center").to_string();
                        let j = parts
                            .next()
                            .map(|x| x.to_string())
                            .unwrap_or_else(|| a.clone());
                        n.props.align_items_grid = Some(a);
                        n.props.justify_items = Some(j);
                    }
                }
                // `place-content: X` → align-content + justify-content.
                "place-content" | "place_content" | "placeContent" => {
                    if let Some(s) = v.as_str() {
                        let mut parts = s.split_whitespace();
                        let a = parts.next().unwrap_or("center").to_string();
                        let j = parts
                            .next()
                            .map(|x| x.to_string())
                            .unwrap_or_else(|| a.clone());
                        n.props.align_content = Some(a);
                        n.props.justify_content = Some(j);
                    }
                }
                // Grid item placement ───────────────────────────────────
                "grid-column" | "grid_column" | "gridColumn" => {
                    n.props.grid_column = v.as_str().map(|s| s.to_string());
                }
                "grid-row" | "grid_row" | "gridRow" => {
                    n.props.grid_row = v.as_str().map(|s| s.to_string());
                }
                "justify-self" | "justify_self" | "justifySelf" => {
                    n.props.justify_self = v.as_str().map(|s| s.to_string());
                }
                "align-self" | "align_self" | "alignSelf" => {
                    n.props.align_self = v.as_str().map(|s| s.to_string());
                }
                "place-self" | "place_self" | "placeSelf" => {
                    if let Some(s) = v.as_str() {
                        let mut parts = s.split_whitespace();
                        let a = parts.next().unwrap_or("auto").to_string();
                        let j = parts
                            .next()
                            .map(|x| x.to_string())
                            .unwrap_or_else(|| a.clone());
                        n.props.align_self = Some(a);
                        n.props.justify_self = Some(j);
                    }
                }
                "padding" => n.props.padding = parse_f32(&v),
                "paddingX" | "padding_x" | "padding-x" => n.props.padding_x = parse_f32(&v),
                "paddingY" | "padding_y" | "padding-y" => n.props.padding_y = parse_f32(&v),
                "paddingLeft" | "padding_left" | "padding-left" => {
                    n.props.padding_left = parse_f32(&v)
                }
                "paddingRight" | "padding_right" | "padding-right" => {
                    n.props.padding_right = parse_f32(&v)
                }
                "paddingTop" | "padding_top" | "padding-top" => n.props.padding_top = parse_f32(&v),
                "paddingBottom" | "padding_bottom" | "padding-bottom" => {
                    n.props.padding_bottom = parse_f32(&v)
                }
                // Logical padding, LTR-aliased — see the inset-inline-*
                // comment above for why there's no real bidi mapping.
                "padding-inline" | "padding_inline" | "paddingInline" => {
                    let p = parse_f32(&v);
                    n.props.padding_left = p;
                    n.props.padding_right = p;
                }
                "padding-inline-start" | "padding_inline_start" | "paddingInlineStart" => {
                    n.props.padding_left = parse_f32(&v);
                }
                "padding-inline-end" | "padding_inline_end" | "paddingInlineEnd" => {
                    n.props.padding_right = parse_f32(&v);
                }
                "padding-block" | "padding_block" | "paddingBlock" => {
                    let p = parse_f32(&v);
                    n.props.padding_top = p;
                    n.props.padding_bottom = p;
                }
                "padding-block-start" | "padding_block_start" | "paddingBlockStart" => {
                    n.props.padding_top = parse_f32(&v);
                }
                "padding-block-end" | "padding_block_end" | "paddingBlockEnd" => {
                    n.props.padding_bottom = parse_f32(&v);
                }
                "margin" => {
                    let m = parse_len(&v);
                    n.props.margin_left = m;
                    n.props.margin_right = m;
                    n.props.margin_top = m;
                    n.props.margin_bottom = m;
                }
                "marginX" | "margin_x" | "margin-x" => {
                    let m = parse_len(&v);
                    n.props.margin_left = m;
                    n.props.margin_right = m;
                }
                "marginY" | "margin_y" | "margin-y" => {
                    let m = parse_len(&v);
                    n.props.margin_top = m;
                    n.props.margin_bottom = m;
                }
                "marginLeft" | "margin_left" | "margin-left" => n.props.margin_left = parse_len(&v),
                "marginRight" | "margin_right" | "margin-right" => {
                    n.props.margin_right = parse_len(&v)
                }
                "marginTop" | "margin_top" | "margin-top" => n.props.margin_top = parse_len(&v),
                "marginBottom" | "margin_bottom" | "margin-bottom" => {
                    n.props.margin_bottom = parse_len(&v)
                }
                // Logical margin, LTR-aliased — see inset-inline-*.
                "margin-inline" | "margin_inline" | "marginInline" => {
                    let m = parse_len(&v);
                    n.props.margin_left = m;
                    n.props.margin_right = m;
                }
                "margin-inline-start" | "margin_inline_start" | "marginInlineStart" => {
                    n.props.margin_left = parse_len(&v);
                }
                "margin-inline-end" | "margin_inline_end" | "marginInlineEnd" => {
                    n.props.margin_right = parse_len(&v);
                }
                "margin-block" | "margin_block" | "marginBlock" => {
                    let m = parse_len(&v);
                    n.props.margin_top = m;
                    n.props.margin_bottom = m;
                }
                "margin-block-start" | "margin_block_start" | "marginBlockStart" => {
                    n.props.margin_top = parse_len(&v);
                }
                "margin-block-end" | "margin_block_end" | "marginBlockEnd" => {
                    n.props.margin_bottom = parse_len(&v);
                }
                "fontWeight" | "font_weight" | "font-weight" => {
                    // Accept "bold" | "normal" | "lighter" | numeric 100-900.
                    if let Some(s) = v.as_str() {
                        n.props.font_weight = match s {
                            "bold" | "bolder" => Some(700),
                            "normal" => Some(400),
                            "lighter" => Some(300),
                            _ => s.parse::<u32>().ok(),
                        };
                    } else {
                        n.props.font_weight = parse_f32(&v).map(|f| f as u32);
                    }
                }
                "textAlign" | "text_align" | "text-align" => {
                    n.props.text_align = v.as_str().map(|s| s.to_string());
                }
                "fontStyle" | "font_style" | "font-style" => {
                    n.props.font_style = v
                        .as_str()
                        .and_then(|s| matches!(s, "italic" | "oblique").then(|| s.to_string()));
                }
                "whiteSpace" | "white_space" | "white-space" => {
                    n.props.white_space = v.as_str().map(|s| s.to_string());
                }
                "textOverflow" | "text_overflow" | "text-overflow" => {
                    n.props.text_overflow = v.as_str().map(|s| s.to_string());
                }
                "text-shadow" | "text_shadow" | "textShadow" => {
                    let raw = v.as_str().unwrap_or("");
                    if raw.trim().is_empty() || raw.trim() == "none" {
                        n.props.text_shadow.clear();
                    } else {
                        n.props.text_shadow = crate::css_parse::parse_text_shadow(raw);
                    }
                }
                "filter" => {
                    let raw = v.as_str().unwrap_or("");
                    n.props.filter = crate::css_parse::parse_filter(raw);
                }
                "mix-blend-mode" | "mix_blend_mode" | "mixBlendMode" => {
                    n.props.mix_blend_mode = v.as_str().and_then(|s| {
                        let s = s.trim();
                        if s.is_empty() || s == "normal" {
                            None
                        } else {
                            Some(s.to_string())
                        }
                    });
                }
                "textDecoration"
                | "text_decoration"
                | "text-decoration"
                | "textDecorationLine"
                | "text-decoration-line" => {
                    n.props.text_decoration = v.as_str().map(|s| s.to_string());
                }
                "lineHeight" | "line_height" | "line-height" => {
                    // CSS line-height accepts both unitless multipliers
                    // (1.5) and px lengths (24px). We store the resolved
                    // px value at paint time using the node's font-size,
                    // so for unitless we store the multiplier prefixed
                    // by a sentinel — easier to just keep both forms in
                    // f32: values <= 4 are treated as multipliers,
                    // values > 4 as px. Real-world multipliers are
                    // always in [0.8, 3.0]; px line-heights in the
                    // single digits are vanishingly rare.
                    n.props.line_height = parse_f32(&v);
                }
                "letterSpacing" | "letter_spacing" | "letter-spacing" => {
                    n.props.letter_spacing = parse_f32(&v);
                }
                "fontFamily" | "font_family" | "font-family" => {
                    n.props.font_family = v.as_str().map(|s| s.to_string());
                }
                "spans" => {
                    // Spans arrive as a JSON array of {text, color, weight,
                    // background}. We parse defensively — malformed entries
                    // just drop their offending fields rather than failing
                    // the whole set. `null` clears the spans entirely.
                    if v.is_null() {
                        n.props.spans = None;
                    } else if let Some(arr) = v.as_array() {
                        let mut out = Vec::with_capacity(arr.len());
                        for item in arr {
                            let text = item
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string();
                            let color =
                                parse_color(item.get("color").unwrap_or(&serde_json::Value::Null));
                            let weight = item
                                .get("weight")
                                .and_then(|w| w.as_u64())
                                .map(|w| w as u32);
                            let background = parse_color(
                                item.get("background").unwrap_or(&serde_json::Value::Null),
                            );
                            let italic = item
                                .get("italic")
                                .and_then(|b| b.as_bool())
                                .unwrap_or(false);
                            out.push(TextSpan {
                                text,
                                color,
                                weight,
                                background,
                                italic,
                            });
                        }
                        n.props.spans = Some(out);
                    }
                }
                "borderWidth" | "border_width" | "border-width" => {
                    n.props.border_width = parse_f32(&v).unwrap_or(0.0);
                }
                "borderColor" | "border_color" | "border-color" => {
                    n.props.border_color = parse_color(&v);
                }
                "borderTopWidth" | "border_top_width" | "border-top-width" => {
                    n.props.border_top_width = parse_f32(&v);
                }
                "borderRightWidth" | "border_right_width" | "border-right-width" => {
                    n.props.border_right_width = parse_f32(&v);
                }
                "borderBottomWidth" | "border_bottom_width" | "border-bottom-width" => {
                    n.props.border_bottom_width = parse_f32(&v);
                }
                "borderLeftWidth" | "border_left_width" | "border-left-width" => {
                    n.props.border_left_width = parse_f32(&v);
                }
                "outlineWidth" | "outline_width" | "outline-width" => {
                    n.props.outline_width = parse_f32(&v).unwrap_or(0.0);
                }
                "outlineColor" | "outline_color" | "outline-color" => {
                    n.props.outline_color = parse_color(&v);
                }
                "outlineOffset" | "outline_offset" | "outline-offset" => {
                    n.props.outline_offset = parse_f32(&v).unwrap_or(0.0);
                }
                "gap" => n.props.gap = parse_f32(&v),
                "width" => n.props.width = parse_len(&v),
                "height" => n.props.height = parse_len(&v),
                "minWidth" | "min_width" | "min-width" => n.props.min_width = parse_len(&v),
                "maxWidth" | "max_width" | "max-width" => n.props.max_width = parse_len(&v),
                "minHeight" | "min_height" | "min-height" => n.props.min_height = parse_len(&v),
                "maxHeight" | "max_height" | "max-height" => n.props.max_height = parse_len(&v),
                "aspect-ratio" | "aspect_ratio" | "aspectRatio" => {
                    // Accepts a CSS string ("16/9", "1.5", "auto") or a
                    // bare JSON number (aspectRatio: 1.5 in inline style).
                    n.props.aspect_ratio = match v.as_str() {
                        Some(s) => crate::css_parse::parse_aspect_ratio(s),
                        None => parse_f32(&v),
                    };
                }
                "flexGrow" | "flex_grow" | "flex-grow" => n.props.flex_grow = parse_f32(&v),
                "flexShrink" | "flex_shrink" | "flex-shrink" => n.props.flex_shrink = parse_f32(&v),
                "flexBasis" | "flex_basis" | "flex-basis" => n.props.flex_basis = parse_len(&v),
                "flexWrap" | "flex_wrap" | "flex-wrap" => {
                    n.props.flex_wrap = v.as_str().map(|s| s.to_string());
                }
                "clickable" | "onClick" => n.props.clickable = true,
                // Drag region: any of these prop names (data-* attribute
                // bridged through applyProps, or the bare "drag-region"
                // key) opt this node in as an OS drag handle.
                "drag-region"
                | "drag_region"
                | "dragRegion"
                | "data-tauri-drag-region"
                | "data-carbon-drag-region" => {
                    // Accept any truthy value: "true", "", null-equivalent.
                    n.props.drag_region = match &v {
                        serde_json::Value::Bool(b) => *b,
                        serde_json::Value::String(s) => s != "false",
                        serde_json::Value::Null => false,
                        _ => true,
                    };
                }
                "background-image" | "background_image" | "backgroundImage" | "bg-image" => {
                    if let Some(s) = v.as_str() {
                        let layers = crate::css_parse::parse_bg_image_layers(s);
                        if layers.len() >= 2 {
                            // Multi-layer: goes through background_layers;
                            // clear the single-image slot so both paths
                            // don't paint at once on a later single->multi
                            // or multi->single re-render.
                            n.props.background_layers = layers;
                            n.props.background_image = None;
                        } else {
                            n.props.background_layers.clear();
                            if let Some(first) = layers.into_iter().next() {
                                n.props.background_image = Some(first);
                            }
                        }
                    }
                }
                // <img src="..."> — the React reconciler forwards the src
                // attribute through the generic prop path. Route it through
                // the same decode+paint machinery as CSS background-image
                // (async_image::get handles data:image/svg+xml via resvg,
                // data: raster, and http(s) URLs). Default the fit to
                // "contain" — an <img>'s natural rendering preserves aspect
                // ratio inside its box, unlike background-image's "cover"
                // default which would crop icons/logos.
                "src" => {
                    if let Some(s) = v.as_str() {
                        let s = s.trim();
                        if !s.is_empty() {
                            n.props.background_image = Some(s.to_string());
                            if n.props.background_size.is_none() {
                                n.props.background_size = Some("contain".to_string());
                            }
                        } else {
                            // src cleared (e.g. React set it to "") — drop the image.
                            n.props.background_image = None;
                        }
                    }
                }
                "background-size" | "background_size" | "backgroundSize" => {
                    n.props.background_size = v.as_str().map(|s| s.to_string());
                    if let Some(s) = v.as_str() {
                        n.props.background_layer_sizes =
                            s.split(',').map(|t| t.trim().to_string()).collect();
                    }
                }
                "cursor" => {
                    n.props.cursor = v.as_str().map(|s| s.to_string());
                }
                "placeholder" => {
                    n.props.placeholder = v.as_str().map(|s| s.to_string());
                }
                "value" => {
                    // <input value="..."> — same channel as set_text but
                    // via the prop bag, so React re-renders that swap
                    // value continue to land here.
                    if let Some(s) = v.as_str() {
                        n.props.text = Some(s.to_string());
                    }
                }
                // ── SVG ────────────────────────────────────────────────
                "viewBox" | "view_box" | "viewbox" => {
                    if let Some(s) = v.as_str() {
                        let parts: Vec<f32> = s
                            .split(|c: char| c.is_ascii_whitespace() || c == ',')
                            .filter_map(|p| p.parse::<f32>().ok())
                            .collect();
                        if parts.len() == 4 {
                            n.props.svg_view_box = Some([parts[0], parts[1], parts[2], parts[3]]);
                        }
                    }
                }
                "d" => {
                    n.props.svg_d = v.as_str().map(|s| s.to_string());
                }
                "stroke" => {
                    if let Some(s) = v.as_str() {
                        if s == "currentColor" || s == "currentcolor" {
                            n.props.svg_stroke_inherit = true;
                            n.props.svg_stroke = None;
                        } else if s == "none" {
                            n.props.svg_stroke = None;
                            n.props.svg_stroke_inherit = false;
                        } else {
                            n.props.svg_stroke = parse_color(&v);
                            n.props.svg_stroke_inherit = false;
                        }
                    } else {
                        n.props.svg_stroke = parse_color(&v);
                    }
                }
                "fill" => {
                    if let Some(s) = v.as_str() {
                        if s == "currentColor" || s == "currentcolor" {
                            n.props.svg_fill_inherit = true;
                            n.props.svg_fill_none = false;
                            n.props.svg_fill = None;
                        } else if s == "none" {
                            n.props.svg_fill_none = true;
                            n.props.svg_fill_inherit = false;
                            n.props.svg_fill = None;
                        } else {
                            n.props.svg_fill = parse_color(&v);
                            n.props.svg_fill_inherit = false;
                            n.props.svg_fill_none = false;
                        }
                    } else {
                        n.props.svg_fill = parse_color(&v);
                    }
                }
                "strokeWidth" | "stroke_width" | "stroke-width" => {
                    n.props.svg_stroke_width = parse_f32(&v).unwrap_or(1.0);
                }
                "strokeLinecap" | "stroke_linecap" | "stroke-linecap" => {
                    n.props.svg_stroke_linecap = v.as_str().map(|s| s.to_string());
                }
                "strokeLinejoin" | "stroke_linejoin" | "stroke-linejoin" => {
                    n.props.svg_stroke_linejoin = v.as_str().map(|s| s.to_string());
                }
                "x1" => n.props.svg_x1 = parse_f32(&v).unwrap_or(0.0),
                "y1" => n.props.svg_y1 = parse_f32(&v).unwrap_or(0.0),
                "x2" => n.props.svg_x2 = parse_f32(&v).unwrap_or(0.0),
                "y2" => n.props.svg_y2 = parse_f32(&v).unwrap_or(0.0),
                "cx" => n.props.svg_cx = parse_f32(&v).unwrap_or(0.0),
                "cy" => n.props.svg_cy = parse_f32(&v).unwrap_or(0.0),
                "r" => n.props.svg_r = parse_f32(&v).unwrap_or(0.0),
                "rx" => n.props.svg_rect_rx = parse_f32(&v).unwrap_or(0.0),
                "points" => {
                    n.props.svg_points = v.as_str().map(|s| s.to_string());
                }
                "overflow-y" | "overflow_y" | "overflowY" | "overflow" => {
                    // Treat any non-empty string except "hidden"/"visible"
                    // as scroll. `overflow: scroll` and `overflow: auto`
                    // both turn the node into a scrollport.
                    if let Some(s) = v.as_str() {
                        let s = s.trim();
                        n.props.overflow_y = matches!(s, "scroll" | "auto" | "true" | "1");
                    } else if v.as_bool() == Some(true) {
                        n.props.overflow_y = true;
                    }
                }
                "scroll-shadow" | "scroll_shadow" | "scrollShadow" => {
                    n.props.scroll_shadow = match &v {
                        serde_json::Value::Bool(b) => *b,
                        serde_json::Value::String(s) => matches!(s.as_str(), "true" | "auto" | "1"),
                        _ => false,
                    };
                }
                "scroll-snap-type" | "scroll_snap_type" | "scrollSnapType" => {
                    n.props.scroll_snap_type = v.as_str().and_then(|s| {
                        if s.contains("mandatory") {
                            Some("mandatory".to_string())
                        } else if s.contains("proximity") {
                            Some("proximity".to_string())
                        } else {
                            None
                        }
                    });
                }
                "scroll-snap-align" | "scroll_snap_align" | "scrollSnapAlign" => {
                    n.props.scroll_snap_align = v.as_str().and_then(|s| {
                        let s = s.trim();
                        matches!(s, "start" | "center" | "end").then(|| s.to_string())
                    });
                }
                "scrollbar-color" | "scrollbar_color" | "scrollbarColor" => {
                    if let Some(s) = v.as_str() {
                        let mut parts = s.split_whitespace();
                        n.props.scrollbar_thumb_color =
                            parts.next().and_then(crate::css_parse::parse_color_str);
                        n.props.scrollbar_track_color =
                            parts.next().and_then(crate::css_parse::parse_color_str);
                    }
                }
                "scrollbar-width" | "scrollbar_width" | "scrollbarWidth" => {
                    n.props.scrollbar_width = match v.as_str() {
                        Some("none") => Some(0.0),
                        Some("thin") => Some(2.0),
                        Some("auto") => None,
                        Some(_) => None,
                        None => parse_f32(&v),
                    };
                }
                // Set by the JS <canvas> intrinsic. Stored as integer id
                // pointing into gpu::registry().
                "canvas_id" | "canvasId" => {
                    n.props.canvas_id = parse_f32(&v).map(|f| f as u32);
                }
                _ => {}
            }
            self.dirty = true;
            self.layout_valid = false;
        }
    }

    pub fn insert_node(&mut self, parent_id: u32, child_id: u32, before: Option<u32>) {
        // Reparent semantics: detach the child from EVERY current parent
        // before re-inserting. The DOM `appendChild`/`insertBefore` of an
        // already-attached node MOVES it; without this a node moved between
        // two different parents (e.g. a terminal host swapped between the
        // offscreen recycler and a visible pane) would end up listed under
        // both parents. We don't drop the node itself — only its parent
        // links — so the move is non-destructive.
        for n in self.nodes.values_mut() {
            n.children.retain(|&c| c != child_id);
        }
        if let Some(parent) = self.nodes.get_mut(&parent_id) {
            match before {
                Some(b) => {
                    if let Some(i) = parent.children.iter().position(|&c| c == b) {
                        parent.children.insert(i, child_id);
                    } else {
                        parent.children.push(child_id);
                    }
                }
                None => parent.children.push(child_id),
            }
            self.dirty = true;
            self.layout_valid = false;
        }
    }

    /// Removes `id` AND its whole descendant subtree.
    ///
    /// A host reconciler's removeChild (react-reconciler's
    /// commitDeletionEffectsOnFiber, specifically) only calls this once, for
    /// the topmost host node of whatever got deleted — removing every
    /// descendant individually would be redundant once the parent is gone,
    /// and every mainstream host config (react-dom included) is written
    /// expecting the host to take the whole subtree with one call. This used
    /// to remove only `id` itself, leaving every descendant behind: still in
    /// `self.nodes`, still carrying its old `clickable` flag and cached
    /// layout, just unreachable from `root` (hit_test/paint both walk the
    /// tree from there, so an orphaned node stops rendering and stops being
    /// hit-testable) — invisible, but never freed. React Fast Refresh's own
    /// remount-on-signature-change path (see runtime/render.ts) hits this on
    /// most edits, not a rare case: react-refresh/babel's signature hash
    /// includes literal source text, so even changing a useState's initial
    /// value produces a "family changed" remount. Confirmed directly:
    /// several edits in a row left a growing set of dead node ids sitting in
    /// `self.nodes` forever, one leaked subtree per reload.
    pub fn remove_node(&mut self, id: u32) {
        let mut to_remove = Vec::new();
        let mut stack = vec![id];
        while let Some(current) = stack.pop() {
            to_remove.push(current);
            if let Some(n) = self.nodes.get(&current) {
                stack.extend(n.children.iter().copied());
            }
        }

        for n in self.nodes.values_mut() {
            n.children.retain(|&c| c != id);
        }
        for rid in &to_remove {
            self.nodes.remove(rid);
            self.inputs.remove(rid);
            if self.focused == Some(*rid) {
                self.focused = None;
            }
            if self.hovered == Some(*rid) {
                self.hovered = None;
            }
        }
        self.dirty = true;
        self.layout_valid = false;
    }

    pub fn set_root(&mut self, id: u32) {
        self.root = id;
        self.dirty = true;
        self.layout_valid = false;
    }

    /// Total height of a scrollport's content: max(child.location.y +
    /// child.size.height) over its direct children. Padding-y on the
    /// node is counted by adding it to the child y baseline (Taffy
    /// already includes it in child positions). Returns 0 if the node
    /// or its children have no computed layout yet.
    pub fn content_height(&self, id: u32) -> f32 {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return 0.0,
        };
        let mut max_bottom = 0.0_f32;
        for &cid in &n.children {
            if let Some(c) = self.nodes.get(&cid) {
                if let Some(layout) = c.computed_layout {
                    let bottom = layout.location.y + layout.size.height;
                    if bottom > max_bottom {
                        max_bottom = bottom;
                    }
                }
            }
        }
        // Add bottom padding so we can scroll to see the last row in full.
        let pad_bottom = n.props.padding_y.or(n.props.padding).unwrap_or(0.0);
        max_bottom + pad_bottom
    }

    /// `scroll-snap-type`/`scroll-snap-align` support. Given a
    /// scrollport `id` already clamped to `raw` and its `viewport_h`,
    /// returns the y offset to actually land on: `None` means "don't
    /// snap, use `raw` as-is" (no `scroll_snap_type`, no snap-aligned
    /// children, or — in `proximity` mode — nothing close enough).
    ///
    /// Trade-off, stated plainly: real CSS scroll-snap resolves once a
    /// scroll GESTURE settles (after momentum decays), which needs a
    /// timer and a notion of "the user stopped scrolling" — this
    /// engine's wheel handling is a flat per-event `set_scroll_y` call
    /// with no gesture/momentum model to hook a debounce into. So this
    /// resolves a snap target on EVERY call instead: `mandatory` always
    /// jumps to the nearest snap point (works well for discrete
    /// mouse-wheel notches and reads as "wheel = advance one item",
    /// which plenty of real carousels do on purpose; a continuous
    /// trackpad gesture will feel stepped rather than fluid-then-settle);
    /// `proximity` only jumps when `raw` already landed within
    /// `PROXIMITY_PX` of a snap point, otherwise scroll stays exactly
    /// where the gesture put it.
    fn scroll_snap_target(
        &self,
        id: u32,
        raw: f32,
        viewport_h: f32,
        max_offset: f32,
    ) -> Option<f32> {
        const PROXIMITY_PX: f32 = 48.0;
        let n = self.nodes.get(&id)?;
        let strictness = n.props.scroll_snap_type.as_deref()?;
        let mut best: Option<f32> = None;
        for &cid in &n.children {
            let c = match self.nodes.get(&cid) {
                Some(c) => c,
                None => continue,
            };
            let align = match c.props.scroll_snap_align.as_deref() {
                Some(a) => a,
                None => continue,
            };
            let layout = match c.computed_layout {
                Some(l) => l,
                None => continue,
            };
            let candidate = match align {
                "start" => layout.location.y,
                "end" => layout.location.y + layout.size.height - viewport_h,
                _ => layout.location.y + layout.size.height * 0.5 - viewport_h * 0.5, // "center"
            }
            .clamp(0.0, max_offset);
            if best
                .map(|b: f32| (candidate - raw).abs() < (b - raw).abs())
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
        let best = best?;
        if strictness == "proximity" && (best - raw).abs() > PROXIMITY_PX {
            return None;
        }
        Some(best)
    }

    /// Update the y scroll offset for a scrollable node, clamped to
    /// `[0, max(0, content_height - viewport_height)]`, then snapped
    /// per `scroll_snap_target` if the node has `scroll-snap-type` set.
    /// Returns the final value so the caller can detect saturation.
    pub fn set_scroll_y(&mut self, id: u32, raw: f32) -> f32 {
        let n = match self.nodes.get(&id) {
            Some(n) => n,
            None => return 0.0,
        };
        if !n.props.overflow_y {
            return 0.0;
        }
        let viewport_h = n.computed_layout.map(|l| l.size.height).unwrap_or(0.0);
        let content_h = self.content_height(id);
        let max_offset = (content_h - viewport_h).max(0.0);
        let clamped = raw.clamp(0.0, max_offset);
        let clamped = self
            .scroll_snap_target(id, clamped, viewport_h, max_offset)
            .unwrap_or(clamped);
        self.scroll_offsets.insert(id, clamped);
        // Full repaint on scroll. The scoped-damage path erases only the
        // scroll container's bounding box and relies on per-node cull
        // to avoid double-paint elsewhere — but children with their own
        // transforms (SVG <path>) leave streaks because the cull works
        // off the unscrolled layout box and the in-rect clear doesn't
        // reach pixels their paint touches. Forcing dirty=true picks
        // the "full clear + paint" branch which is artifact-free.
        // Optimization can come back when the cull/clip math is tight.
        self.dirty = true;
        self.layout_valid = false;
        self.repaint_dirty = true;
        self.dirty_rect = None;
        clamped
    }

    /// Current y scroll offset for a node (0 if not set).
    pub fn scroll_y(&self, id: u32) -> f32 {
        self.scroll_offsets.get(&id).copied().unwrap_or(0.0)
    }

    /// Build a fresh taffy tree from the current node graph and compute layout
    /// at the given window size. Stores computed layouts back on each node.
    pub fn compute_layout(&mut self, w: f32, h: f32, te: &mut crate::text::TextEngine) {
        if self.nodes.is_empty() || self.root == 0 || !self.nodes.contains_key(&self.root) {
            return;
        }
        // Skip the layout pass when nothing structural has changed AND the
        // viewport size matches the size we last laid out for. Scroll-only
        // repaints (the common case during scroll) hit this fast path —
        // dirty stays false because `set_scroll_y` doesn't touch it. Resize,
        // create_node, set_prop, hover changes, etc. all set dirty=true and
        // fall through to the real Taffy rebuild below.
        // Rebuild only when the layout is actually stale for this size. This
        // is keyed on `layout_valid`, NOT `dirty`: `dirty` stays set until the
        // next paint, so keying on it re-ran the full Taffy rebuild on every
        // getBoundingClientRect/offsetWidth query in between.
        if self.layout_valid && self.last_layout_size == Some((w, h)) {
            return;
        }
        let _perf_t0 = std::time::Instant::now();
        let _perf_n = self.nodes.len();
        self.last_layout_size = Some((w, h));
        self.layout_valid = true;
        self.taffy = TaffyTree::new();
        for n in self.nodes.values_mut() {
            n.taffy_id = None;
        }
        let root_taffy = self.build_taffy(self.root, te);
        if let Some(tid) = root_taffy {
            // Force the implicit root container to fill the window. Without
            // this, Taffy sizes the root to its content (because the root
            // has no explicit size in PaintProps), and any child that says
            // `height: 100%` resolves to 100% of an auto-height parent —
            // which collapses to the content height. Result: white space
            // below the painted content.
            if let Ok(mut style) = self.taffy.style(tid).cloned() {
                style.size = Size {
                    width: Dimension::Length(w),
                    height: Dimension::Length(h),
                };
                let _ = self.taffy.set_style(tid, style);
            }
            // Layout pass with a measure callback for text leaves. Taffy
            // calls back per-leaf with the available width it's offering
            // and we return the wrapped (width, height) — that's how
            // multi-line text gets a real layout box.
            //
            // Crucial: Taffy makes 3 different kinds of width queries —
            //   AvailableSpace::Definite(w)  -> "wrap to this width"
            //   AvailableSpace::MinContent   -> "smallest you can be?"
            //   AvailableSpace::MaxContent   -> "biggest you want to be?"
            // For wrappable text, MinContent = longest word, MaxContent =
            // single-line width. Returning the wrong answer makes flex
            // layouts collapse children to weird widths (e.g. wrapping
            // every word onto its own line because Taffy thinks
            // MinContent == MaxContent == single-line full width).
            let _ = self.taffy.compute_layout_with_measure(
                tid,
                Size {
                    width: AvailableSpace::Definite(w),
                    height: AvailableSpace::Definite(h),
                },
                |known_dims, available_space, _node_id, ctx, style| {
                    let ctx = match ctx {
                        Some(c) => c,
                        None => {
                            return Size {
                                width: known_dims.width.unwrap_or(0.0),
                                height: known_dims.height.unwrap_or(0.0),
                            };
                        }
                    };
                    let (text, fs) = match &ctx.text {
                        Some(t) => t,
                        None => {
                            return Size {
                                width: known_dims.width.unwrap_or(0.0),
                                height: known_dims.height.unwrap_or(0.0),
                            };
                        }
                    };
                    let pm = ctx.prefer_mono;
                    // Must match the paint side (painting/lib.rs sets the
                    // same field from the same effective font-family) or a
                    // named font's real glyph widths would size the box
                    // wrong relative to what actually gets painted into it.
                    te.cur_family = ctx.family.clone();
                    // `white-space: nowrap` / `text-overflow: ellipsis` —
                    // paint never wraps this leaf (it truncates or
                    // overflows instead), so the layout box must stay
                    // single-line tall regardless of the available width.
                    // Must mirror the paint-side decision (painting/lib.rs)
                    // or the box wouldn't fit what's actually drawn.
                    if ctx.force_nowrap {
                        let (single_w, line_h) = te.measure_mono(text, *fs, pm);
                        return Size {
                            width: known_dims.width.unwrap_or(single_w),
                            height: known_dims.height.unwrap_or(line_h),
                        };
                    }
                    // Honor a pinned width before anything else.
                    if let Some(pw) = known_dims.width {
                        let (_, mh) = te.measure_wrapped_pm(text, *fs, pw, pm);
                        return Size {
                            width: pw,
                            height: known_dims.height.unwrap_or(mh),
                        };
                    }
                    let (single_w, line_h) = te.measure_mono(text, *fs, pm);
                    // If style pins width or min_width to a Length, the
                    // user wanted no-wrap behavior. Treat min-content =
                    // max-content = single line so Taffy's flex shrink
                    // never collapses the leaf below its single-line width.
                    // Without this, the measure callback returns
                    // longest_word for MinContent — which the flex
                    // algorithm uses as the shrink floor and propagates
                    // back as the final size, producing the broken
                    // "every word on its own line" Stats row.
                    let nowrap = matches!(style.size.width, Dimension::Length(_))
                        || matches!(style.min_size.width, Dimension::Length(_));
                    let measured = match available_space.width {
                        AvailableSpace::Definite(w) => {
                            let (mw, mh) = te.measure_wrapped_pm(text, *fs, w, pm);
                            (mw, mh)
                        }
                        AvailableSpace::MinContent => {
                            if nowrap {
                                (single_w, line_h)
                            } else {
                                // Wrappable text: smallest stable width is
                                // the longest single word.
                                let lw = te.longest_word_width_pm(text, *fs, pm);
                                (lw, line_h)
                            }
                        }
                        AvailableSpace::MaxContent => {
                            // Biggest natural width: unwrapped single line.
                            (single_w, line_h)
                        }
                    };
                    Size {
                        width: measured.0,
                        height: known_dims.height.unwrap_or(measured.1),
                    }
                },
            );
            self.collect_layouts(self.root);
        }
        if std::env::var_os("CARBON_PERF").is_some() {
            let ms = _perf_t0.elapsed().as_secs_f64() * 1000.0;
            if ms > 2.0 {
                eprintln!("[perf] taffy rebuild: {ms:.1}ms for {_perf_n} nodes");
            }
        }
        // NOTE: do NOT clear self.dirty here. compute_layout can be
        // called from JS queries like __cm_layout_box (DOM shim's
        // getBoundingClientRect / scrollHeight / offsetWidth), which
        // run BEFORE the paint pass. If we cleared dirty here, the
        // paint loop's "skip if !dirty" early-out would kick in and
        // the frame would never reach the screen. The PAINT pass
        // clears dirty after a successful paint (main.rs:2318).
    }

    fn build_taffy(&mut self, id: u32, te: &mut crate::text::TextEngine) -> Option<TaffyNodeId> {
        // Inherited-font-size root: 14px is the CSS default. Overridden
        // as we recurse into children that set their own font-size.
        // The root node itself is not a root-child.
        self.build_taffy_inherited(id, 14.0, false, None, te, false)
    }

    #[allow(clippy::too_many_arguments)]
    fn build_taffy_inherited(
        &mut self,
        id: u32,
        inherited_font_size: f32,
        inherited_mono: bool,
        inherited_family: Option<String>,
        te: &mut crate::text::TextEngine,
        is_root_child: bool,
    ) -> Option<TaffyNodeId> {
        // SVG primitive children (<path>, <line>, <circle>, <rect>,
        // <polyline>, <polygon>) live in the scene tree but DON'T
        // participate in Taffy layout — they're painted by svg.rs
        // using viewBox-driven coordinates. Skip them here.
        {
            let n = self.nodes.get(&id)?;
            if matches!(
                n.kind,
                NodeKind::SvgPath
                    | NodeKind::SvgLine
                    | NodeKind::SvgCircle
                    | NodeKind::SvgRect
                    | NodeKind::SvgPolyline
                    | NodeKind::SvgPolygon
            ) {
                return None;
            }
        }
        let (
            children_ids,
            style,
            ctx,
            child_font_size,
            user_width,
            is_svg,
            child_mono,
            child_family,
        ) = {
            let n = self.nodes.get(&id)?;
            let is_text = matches!(n.kind, NodeKind::Text);
            let is_svg = matches!(n.kind, NodeKind::Svg);
            let is_input = matches!(n.kind, NodeKind::Input);
            let is_textarea = matches!(n.kind, NodeKind::Textarea);
            // The font-size that applies to this node and its descendants:
            // own value if set, otherwise inherited. Used both for the
            // measure callback (so layout sees the right line height) and
            // as the new inherited value for child recursion.
            let effective_fs = n.props.font_size.unwrap_or(inherited_font_size);
            // font-family intent inherits like font-size (own value wins,
            // else inherit). Mirrors the paint side so the measured box
            // matches the rendered glyphs for font-mono subtrees.
            let effective_mono = n
                .props
                .font_family
                .as_deref()
                .map(crate::text::TextEngine::family_is_mono)
                .unwrap_or(inherited_mono);
            // The font-family STRING itself, same inheritance rule. See
            // NodeCtx::family's doc comment for why this has to match the
            // paint side exactly.
            let effective_family = n
                .props
                .font_family
                .clone()
                .or_else(|| inherited_family.clone());
            // Text nodes with content carry their text + effective
            // font-size into the measure callback. Wrapper elements with
            // a child text node don't have own .text — they go through
            // the container path and contribute their font-size to the
            // child via inheritance.
            let ctx = if is_text {
                if let Some(t) = &n.props.text {
                    let force_nowrap = matches!(n.props.white_space.as_deref(), Some("nowrap"))
                        || matches!(n.props.text_overflow.as_deref(), Some("ellipsis"));
                    NodeCtx {
                        text: Some((t.clone(), effective_fs)),
                        prefer_mono: effective_mono,
                        family: effective_family.clone(),
                        force_nowrap,
                    }
                } else {
                    NodeCtx::default()
                }
            } else {
                NodeCtx::default()
            };
            // Pass is_text so text leaves get their measured single-line
            // size pinned in style.size — without this, Taffy's flex
            // algorithm shrinks text in row containers down to longest-word
            // width, producing the broken metadata row where each `<text>`
            // wrapped at every space even with abundant horizontal space.
            // cur_family is a field on TextEngine (mirroring cur_weight),
            // not a parameter — set it once here so every measurement below
            // for this node (props_to_style_with_inherited's own
            // measure_mono call, and editor_visual_lines further down) picks
            // up the right face without threading a new parameter through
            // both.
            te.cur_family = effective_family.clone();
            let mut style =
                props_to_style_with_inherited(&n.props, is_text, te, effective_fs, effective_mono);
            // Document-root children behave like a browser <body>'s block
            // children: they keep their own heights and do NOT flex-shrink to
            // make room for an overflowing sibling. The scene root is a
            // flex-column (so a single h-screen app fills the window), but
            // when a second body-level subtree appears — e.g. a Radix portal
            // or an xterm terminal mounted onto document.body — a default
            // flex-shrink:1 would squeeze the real app down to its min-content
            // height (the bug that left terax's UI a 166px strip with white
            // below). flex-grow still works, so apps that fill via `flex-1`
            // instead of `h-screen` are unaffected. Explicit author
            // flex-shrink is still honored.
            if is_root_child && n.props.flex_shrink.is_none() {
                style.flex_shrink = 0.0;
            }
            // Input / Textarea have no children and no measure callback,
            // so without an explicit height Taffy collapses them to just
            // padding. Pin a content-based intrinsic height so the layout
            // box matches what we paint:
            //   - single-line <input>: line_h + vertical padding
            //   - <textarea>: count actual visual (soft-wrapped) lines so the
            //     box GROWS with content. Notion-style: no internal scrollbar,
            //     the textarea expands and the parent scroller handles overflow.
            //     Min 1 line so an empty textarea still renders. Falls back to
            //     a single-line height when wrap-width is unknown.
            if (is_input || is_textarea) && n.props.height.is_none() {
                let line_h = effective_fs * 1.2;
                let pad = n.props.padding.unwrap_or(0.0);
                let pad_y = n.props.padding_y.unwrap_or(pad);
                let pad_top = n.props.padding_top.unwrap_or(pad_y);
                let pad_bottom = n.props.padding_bottom.unwrap_or(pad_y);
                let pad_x = n.props.padding_x.unwrap_or(pad);
                let pad_left = n.props.padding_left.unwrap_or(pad_x);
                let pad_right = n.props.padding_right.unwrap_or(pad_x);
                let lines = if is_textarea {
                    let text = n.props.text.clone().unwrap_or_default();
                    // Only auto-grow when width is a fixed Length — percent
                    // widths don't resolve until layout runs, by which time
                    // we'd have to re-layout to honor the new height. Falls
                    // back to single-line height in that case (rare).
                    let inner_w = match n.props.width {
                        Some(Len::Length(w)) => (w - pad_left - pad_right).max(0.0),
                        _ => 0.0,
                    };
                    let visual = self.editor_visual_lines(&text, effective_fs, inner_w, te);
                    (visual.len() as f32).max(1.0)
                } else {
                    1.0
                };
                style.size.height = Dimension::Length(line_h * lines + pad_top + pad_bottom);
            }
            // User explicitly set width on this text leaf? Then they want
            // wrap-to-fit behavior — keep the measure callback so Taffy
            // can call it to compute height for the given width. Without
            // explicit width, switch to a callback-less leaf with size
            // pinned by props_to_style — Taffy disregards style.size on
            // leaves WITH a measure callback, which was the root cause of
            // every "single-line text wrapped to two lines" bug we kept
            // chasing.
            let user_width = n.props.width.is_some();
            (
                n.children.clone(),
                style,
                ctx,
                effective_fs,
                user_width,
                is_svg,
                effective_mono,
                effective_family,
            )
        };

        // For <svg>: skip recursing into children entirely. svg.rs walks
        // the scene tree directly when painting; Taffy only needs to
        // know the svg's outer box size from style.size.
        if is_svg {
            let tid = self.taffy.new_leaf(style).ok()?;
            if let Some(n) = self.nodes.get_mut(&id) {
                n.taffy_id = Some(tid);
            }
            return Some(tid);
        }

        let mut child_taffy_ids = Vec::with_capacity(children_ids.len());
        let children_are_root_children = id == self.root;
        for cid in &children_ids {
            if let Some(t) = self.build_taffy_inherited(
                *cid,
                child_font_size,
                child_mono,
                child_family.clone(),
                te,
                children_are_root_children,
            ) {
                child_taffy_ids.push(t);
            }
        }

        // Text leaves with content become Taffy leaves. Two flavors:
        //   * user-width text: use new_leaf_with_context so the measure
        //     callback can wrap inside the user's width and report the
        //     actual rendered height back.
        //   * no-user-width text: use new_leaf — props_to_style has
        //     already pinned size.width = Length(measured) and
        //     size.height = Length(line_h). No measure callback means
        //     Taffy CAN'T re-query and shrink the leaf. This is the
        //     definitive fix for sidebar items / titles / property
        //     values that were wrapping under flex pressure.
        // Containers — including text *wrapper* elements that hold a
        // child text leaf — use new_with_children with no context.
        let tid = if ctx.text.is_some() && child_taffy_ids.is_empty() {
            if user_width {
                self.taffy.new_leaf_with_context(style, ctx).ok()?
            } else {
                self.taffy.new_leaf(style).ok()?
            }
        } else {
            self.taffy.new_with_children(style, &child_taffy_ids).ok()?
        };
        if let Some(n) = self.nodes.get_mut(&id) {
            n.taffy_id = Some(tid);
        }
        Some(tid)
    }

    fn collect_layouts(&mut self, id: u32) {
        let (tid, children) = match self.nodes.get(&id) {
            Some(n) => (n.taffy_id, n.children.clone()),
            None => return,
        };
        if let Some(tid) = tid {
            if let Ok(layout) = self.taffy.layout(tid) {
                if let Some(n) = self.nodes.get_mut(&id) {
                    n.computed_layout = Some(*layout);
                }
            }
        }
        for c in children {
            self.collect_layouts(c);
        }
    }

    /// `position: sticky` support, shared by every tree-walking pass that
    /// positions children (paint, hit_test, drag-region hit-test, scroll
    /// hit-test) so all of them agree on where a sticky element actually
    /// sits. Given the y-origin a child would normally be painted/tested
    /// at (`child_oy`, already scroll-shifted if the parent scrolls) plus
    /// the parent's own screen-y and height, returns the origin to
    /// actually use: unchanged, UNLESS the child is `position: sticky`
    /// with a `top` inset AND its natural position (`child_oy +
    /// child.computed_layout.location.y`) would sit above
    /// `parent_y + top` — in which case it's shifted down just enough to
    /// pin the child there instead.
    ///
    /// This is the one approximation this engine makes for sticky:
    /// relative to the DIRECT parent only (no positioned-ancestor chain
    /// walk), same simplification `absolute`/`fixed` already make — see
    /// `PaintProps::position`'s doc comment. Safe to call unconditionally
    /// for every child (sticky or not, scrolling parent or not): a
    /// non-sticky child, or one whose natural position is already below
    /// the threshold, gets `child_oy` back unchanged.
    pub fn sticky_oy(&self, child_id: u32, child_oy: f32, parent_y: f32, parent_h: f32) -> f32 {
        let child = match self.nodes.get(&child_id) {
            Some(c) => c,
            None => return child_oy,
        };
        if child.props.position.as_deref() != Some("sticky") {
            return child_oy;
        }
        let (Some(top), Some(layout)) = (child.props.top, child.computed_layout) else {
            return child_oy;
        };
        let natural = child_oy + layout.location.y;
        let threshold = parent_y + resolve_len(top, parent_h);
        if natural < threshold {
            child_oy + (threshold - natural)
        } else {
            child_oy
        }
    }

    /// Hit test: return the deepest clickable node id under (x, y), if any.
    pub fn hit_test(&self, x: f32, y: f32) -> Option<u32> {
        self.hit_test_recurse(self.root, x, y, 0.0, 0.0)
    }

    fn hit_test_recurse(&self, id: u32, x: f32, y: f32, ox: f32, oy: f32) -> Option<u32> {
        let n = self.nodes.get(&id)?;
        let layout = n.computed_layout?;
        let mut nx = ox + layout.location.x;
        let mut ny = oy + layout.location.y;
        let nw = layout.size.width;
        let nh = layout.size.height;
        // Apply the node's CSS transform *translate* so the hit box matches
        // where paint actually draws it (paint composes the same translate into
        // node_transform). Without this, a transform-positioned overlay — a
        // Radix dropdown/select/popover at `transform: translate(0, 571px)` —
        // is hit-tested at its pre-transform layout box (usually 0,0): clicks
        // fall THROUGH the visible menu to whatever sits at that layout
        // position (the file tree), and the menu's own items never get the
        // press. Only translate is modelled here (scale/rotate hit-testing is a
        // rarer, deeper case); the delta propagates to children via the origin.
        let mut tdx = 0.0f32;
        let mut tdy = 0.0f32;
        if let Some(tlist) = &n.props.transform {
            for op in &tlist.0 {
                if let TransformOp::Translate {
                    x: tx,
                    y: ty,
                    x_pct,
                    y_pct,
                } = op
                {
                    tdx += if *x_pct { *tx * 0.01 * nw } else { *tx };
                    tdy += if *y_pct { *ty * 0.01 * nh } else { *ty };
                }
            }
        }
        if let Some((vx, px)) = n.props.translate_x {
            tdx += if px { vx * 0.01 * nw } else { vx };
        }
        if let Some((vy, py)) = n.props.translate_y {
            tdy += if py { vy * 0.01 * nh } else { vy };
        }
        nx += tdx;
        ny += tdy;
        if x < nx || y < ny || x > nx + nw || y > ny + nh {
            return None;
        }
        // Descend into children — if this node is a scrollport, shift the
        // child origin up by the current scroll offset so a click hits the
        // visually-correct child.
        let scroll_y = if n.props.overflow_y {
            self.scroll_y(id)
        } else {
            0.0
        };
        for &c in n.children.iter().rev() {
            let child_oy = self.sticky_oy(c, ny - scroll_y, ny, nh);
            if let Some(hit) = self.hit_test_recurse(c, x, y, nx, child_oy) {
                return Some(hit);
            }
        }
        if n.props.clickable {
            Some(id)
        } else {
            None
        }
    }

    /// Drag-region hit test — walks the tree at (x, y) and returns the
    /// nearest ancestor with `drag_region: true`, OR None if the point
    /// is over a clickable descendant (interactive elements take
    /// priority — buttons inside a draggable header still click).
    pub fn hit_test_drag_region(&self, x: f32, y: f32) -> Option<u32> {
        // First check clickable hit — if a button/input is under the
        // cursor, do NOT drag (return None so the normal click path
        // runs instead).
        if self.hit_test(x, y).is_some() {
            return None;
        }
        self.drag_region_recurse(self.root, x, y, 0.0, 0.0, None)
    }

    fn drag_region_recurse(
        &self,
        id: u32,
        x: f32,
        y: f32,
        ox: f32,
        oy: f32,
        current_region: Option<u32>,
    ) -> Option<u32> {
        let n = self.nodes.get(&id)?;
        let layout = n.computed_layout?;
        let nx = ox + layout.location.x;
        let ny = oy + layout.location.y;
        let nw = layout.size.width;
        let nh = layout.size.height;
        if x < nx || y < ny || x > nx + nw || y > ny + nh {
            return None;
        }
        let region = if n.props.drag_region {
            Some(id)
        } else {
            current_region
        };
        let scroll_y = if n.props.overflow_y {
            self.scroll_y(id)
        } else {
            0.0
        };
        for &c in n.children.iter().rev() {
            let child_oy = self.sticky_oy(c, ny - scroll_y, ny, nh);
            if let Some(hit) = self.drag_region_recurse(c, x, y, nx, child_oy, region) {
                return Some(hit);
            }
        }
        // Empty area inside this node — return the innermost drag region
        // we've passed through so far (if any).
        region
    }

    /// Return the deepest scrollport at (x, y) — used to route mouse-wheel
    /// events. Walks the tree like hit_test but returns the bottommost
    /// node with overflow_y=true regardless of clickable.
    pub fn hit_test_scrollable(&self, x: f32, y: f32) -> Option<u32> {
        self.hit_test_scrollable_recurse(self.root, x, y, 0.0, 0.0)
    }

    fn hit_test_scrollable_recurse(
        &self,
        id: u32,
        x: f32,
        y: f32,
        ox: f32,
        oy: f32,
    ) -> Option<u32> {
        let n = self.nodes.get(&id)?;
        let layout = n.computed_layout?;
        let nx = ox + layout.location.x;
        let ny = oy + layout.location.y;
        let nw = layout.size.width;
        let nh = layout.size.height;
        if x < nx || y < ny || x > nx + nw || y > ny + nh {
            return None;
        }
        let scroll_y = if n.props.overflow_y {
            self.scroll_y(id)
        } else {
            0.0
        };
        for &c in n.children.iter().rev() {
            let child_oy = self.sticky_oy(c, ny - scroll_y, ny, nh);
            if let Some(hit) = self.hit_test_scrollable_recurse(c, x, y, nx, child_oy) {
                return Some(hit);
            }
        }
        if n.props.overflow_y {
            Some(id)
        } else {
            None
        }
    }
}

/// Direction values for `Scene::input_move_caret`.
#[derive(Debug, Clone, Copy)]
pub enum CaretMove {
    Left,
    Right,
    Home,
    End,
}

fn sel_range(text_len: usize, st: &InputState) -> (usize, usize) {
    let a = st.caret.min(st.sel_anchor).min(text_len);
    let b = st.caret.max(st.sel_anchor).min(text_len);
    (a, b)
}

fn prev_char_boundary(s: &str, mut i: usize) -> usize {
    if i == 0 {
        return 0;
    }
    i -= 1;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn next_char_boundary(s: &str, mut i: usize) -> usize {
    let len = s.len();
    if i >= len {
        return len;
    }
    i += 1;
    while i < len && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Parse a JSON color value into 0xAARRGGBB. String values go through
/// `css_parse::parse_color_str` — hex (3/6/8-digit) + `rgb()`/`rgba()`/
/// `hsl()`/`hsla()`/named colors/`transparent`. Every color-typed prop
/// in this file's `set_prop` (background, color, the hover/focus
/// variants, border-color, outline-color, SVG fill/stroke) funnels
/// through here, so this one function used to be the whole bug: it was
/// hex-only (hand-rolled, predating `css_parse.rs`), while box-shadow/
/// gradients/scrollbar-color already used the fuller parser. Anything
/// using ONLY Tailwind-class-derived colors never noticed — the
/// Tailwind pipeline's own opacity modifiers (`bg-black/50`) compile to
/// 8-digit hex at build time, never emit `rgba()` — but a literal
/// `rgba(...)`/`hsl(...)` fill on an SVG icon (or any inline `style`)
/// silently failed to parse and painted nothing. Confirmed and fixed
/// from a real repro: an icon set using `fill="rgba(...)"` rendered
/// completely invisible.
fn parse_color(v: &serde_json::Value) -> Option<u32> {
    if let Some(s) = v.as_str() {
        crate::css_parse::parse_color_str(s)
    } else {
        v.as_u64().map(|n| n as u32)
    }
}

fn parse_f32(v: &serde_json::Value) -> Option<f32> {
    if let Some(f) = v.as_f64() {
        Some(f as f32)
    } else if let Some(s) = v.as_str() {
        // Accept "10" and "10px" — strip a trailing px unit.
        let s = s.trim();
        let stripped = s.strip_suffix("px").unwrap_or(s);
        stripped.parse::<f32>().ok()
    } else {
        None
    }
}

/// Parse a Tailwind translate value into `(value, is_percent)`. A `%` suffix
/// (e.g. "-50%") resolves against the element's own size at paint time; px /
/// unitless is an absolute offset. Returns None for unparseable input.
fn parse_translate_prop(v: &serde_json::Value) -> Option<(f32, bool)> {
    if let Some(f) = v.as_f64() {
        return Some((f as f32, false));
    }
    let s = v.as_str()?.trim();
    if let Some(p) = s.strip_suffix('%') {
        return p.trim().parse::<f32>().ok().map(|n| (n, true));
    }
    let stripped = s.strip_suffix("px").unwrap_or(s);
    stripped.parse::<f32>().ok().map(|n| (n, false))
}

/// Parse a width/height/flex-basis value. Accepts:
///   - Number (px):       42        -> Length(42)
///   - String px:         "42"      -> Length(42)
///   - String px suffix:  "42px"    -> Length(42)
///   - Percent:           "50%"     -> Percent(0.5)
///   - "100%" full:       "100%"    -> Percent(1.0)
fn parse_len(v: &serde_json::Value) -> Option<Len> {
    if let Some(f) = v.as_f64() {
        return Some(Len::Length(f as f32));
    }
    if let Some(s) = v.as_str() {
        let s = s.trim();
        if let Some(pct) = s.strip_suffix('%') {
            if let Ok(p) = pct.trim().parse::<f32>() {
                return Some(Len::Percent(p / 100.0));
            }
        }
        // CSS calc(): handle the small subset Tailwind emits — single
        // operand or two operands with `+`/`-`. Examples we see:
        //   calc(100% - 1px)
        //   calc(100% + 8px)
        //   calc(50% - 1rem)
        //   calc(8px + 4px)
        // We resolve to `Percent` if both sides are percent-or-blank, or
        // collapse to the percent operand (≈the dominant size) when one
        // side is percent and the other a small px. That matches what
        // Tauri/Chromium produces visually for the common
        // `calc(100% - 1px)` pattern used as "fill the parent minus a
        // hairline" — taffy doesn't model calc, but Percent(1.0) is
        // visually indistinguishable here.
        if let Some(inner) = s.strip_prefix("calc(").and_then(|r| r.strip_suffix(')')) {
            return parse_calc(inner);
        }
        let stripped = s.strip_suffix("px").unwrap_or(s);
        if let Ok(n) = stripped.parse::<f32>() {
            return Some(Len::Length(n));
        }
    }
    None
}

fn parse_calc(expr: &str) -> Option<Len> {
    let expr = expr.trim();
    // Split on the FIRST top-level `+` / `-`. Nested calc() inside isn't
    // supported here — Tailwind doesn't emit it for the patterns we see.
    let mut depth = 0i32;
    let bytes = expr.as_bytes();
    for i in 0..bytes.len() {
        let c = bytes[i] as char;
        if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
        } else if depth == 0 && (c == '+' || c == '-') && i > 0 {
            // Tailwind escapes the `-` to a hyphen surrounded by spaces
            // (`100% - 1px`) but bare `100%-1px` (no spaces) also shows
            // up in the underscore-encoded form. Either way we split at
            // the first non-leading operator at depth 0.
            let prev = bytes[i - 1] as char;
            // Don't treat the leading `-` of a unary number as operator.
            if prev != '*' && prev != '/' && prev != '(' {
                let left = expr[..i].trim();
                let right = expr[i + 1..].trim();
                let left_v = parse_calc_operand(left);
                let right_v = parse_calc_operand(right);
                let sign: f32 = if c == '+' { 1.0 } else { -1.0 };
                // Both percent → combine (clamp to 0..=100)
                if let (Some(CalcOp::Percent(a)), Some(CalcOp::Percent(b))) = (&left_v, &right_v) {
                    let p = (a + sign * b).max(0.0);
                    return Some(Len::Percent(p));
                }
                // Both length → combine
                if let (Some(CalcOp::Length(a)), Some(CalcOp::Length(b))) = (&left_v, &right_v) {
                    return Some(Len::Length(a + sign * b));
                }
                // Mixed percent + small length → take the percent.
                // taffy can't subtract a length from a percent, but in
                // practice these "−1px" deltas are decorative and the
                // parent-relative percent is the visually correct anchor.
                if let Some(CalcOp::Percent(p)) = left_v {
                    return Some(Len::Percent(p));
                }
                if let Some(CalcOp::Percent(p)) = right_v {
                    return Some(Len::Percent(p));
                }
                return None;
            }
        }
    }
    // No operator at top level — single operand.
    match parse_calc_operand(expr) {
        Some(CalcOp::Percent(p)) => Some(Len::Percent(p)),
        Some(CalcOp::Length(l)) => Some(Len::Length(l)),
        None => None,
    }
}

enum CalcOp {
    Percent(f32),
    Length(f32),
}

fn parse_calc_operand(s: &str) -> Option<CalcOp> {
    let s = s.trim();
    if let Some(p) = s
        .strip_suffix('%')
        .and_then(|n| n.trim().parse::<f32>().ok())
    {
        return Some(CalcOp::Percent(p / 100.0));
    }
    if let Some(px) = s
        .strip_suffix("px")
        .and_then(|n| n.trim().parse::<f32>().ok())
    {
        return Some(CalcOp::Length(px));
    }
    if let Some(rem) = s
        .strip_suffix("rem")
        .and_then(|n| n.trim().parse::<f32>().ok())
    {
        return Some(CalcOp::Length(rem * 16.0)); // 1rem = 16px
    }
    if let Ok(n) = s.parse::<f32>() {
        return Some(CalcOp::Length(n));
    }
    None
}

/// Convert our `Len` enum into Taffy's `Dimension` (used for size,
/// min-size, max-size, flex-basis).
fn len_to_dim(l: Len) -> Dimension {
    match l {
        Len::Length(px) => Dimension::Length(px),
        Len::Percent(p) => Dimension::Percent(p),
    }
}

/// Resolve a `Len` to a concrete px value against `against` (its
/// percent basis). Used where a raw f32 is needed outside Taffy's own
/// style resolution — e.g. `position: sticky`'s scroll-time threshold.
pub fn resolve_len(l: Len, against: f32) -> f32 {
    match l {
        Len::Length(px) => px,
        Len::Percent(p) => p / 100.0 * against,
    }
}

// ─── CSS Grid value parsers ──────────────────────────────────────────────

fn parse_align(s: &str) -> AlignItems {
    match s {
        "center" => AlignItems::Center,
        "start" | "flex-start" => AlignItems::Start,
        "end" | "flex-end" => AlignItems::End,
        "stretch" => AlignItems::Stretch,
        "baseline" => AlignItems::Baseline,
        _ => AlignItems::Stretch,
    }
}

fn parse_align_opt(s: &str) -> Option<AlignItems> {
    match s {
        "auto" => None,
        "center" => Some(AlignItems::Center),
        "start" | "flex-start" => Some(AlignItems::Start),
        "end" | "flex-end" => Some(AlignItems::End),
        "stretch" => Some(AlignItems::Stretch),
        "baseline" => Some(AlignItems::Baseline),
        _ => None,
    }
}

fn parse_content(s: &str) -> AlignContent {
    match s {
        "center" => AlignContent::Center,
        "start" | "flex-start" => AlignContent::Start,
        "end" | "flex-end" => AlignContent::End,
        "stretch" => AlignContent::Stretch,
        "space-between" => AlignContent::SpaceBetween,
        "space-around" => AlignContent::SpaceAround,
        "space-evenly" => AlignContent::SpaceEvenly,
        _ => AlignContent::Stretch,
    }
}

fn parse_grid_auto_flow(s: &str) -> GridAutoFlow {
    match s.trim() {
        "row" => GridAutoFlow::Row,
        "column" => GridAutoFlow::Column,
        "row dense" | "dense row" | "dense" => GridAutoFlow::RowDense,
        "column dense" | "dense column" => GridAutoFlow::ColumnDense,
        _ => GridAutoFlow::Row,
    }
}

/// Parse a single track sizing function: a `Dimension`-like value with
/// support for `fr` units, `auto`, `min-content`, `max-content`,
/// `minmax(...)`, and the bracket-delimited percent/length forms.
fn parse_track_sizing(tok: &str) -> NonRepeatedTrackSizingFunction {
    let s = tok.trim();
    // minmax(min, max) — recursively parse inner pieces.
    if let Some(rest) = s.strip_prefix("minmax(").and_then(|r| r.strip_suffix(')')) {
        let depth_split = split_top_level(rest, ',');
        if depth_split.len() == 2 {
            let min = parse_min_track(&depth_split[0]);
            let max = parse_max_track(&depth_split[1]);
            return MinMax { min, max };
        }
    }
    let min = parse_min_track(s);
    let max = parse_max_track(s);
    MinMax { min, max }
}

fn parse_min_track(tok: &str) -> MinTrackSizingFunction {
    let s = tok.trim();
    match s {
        "auto" => MinTrackSizingFunction::Auto,
        "min-content" => MinTrackSizingFunction::MinContent,
        "max-content" => MinTrackSizingFunction::MaxContent,
        _ => {
            if let Some(num_str) = s.strip_suffix("fr") {
                // fr is invalid as a minimum; CSS spec says treat fr as auto here.
                let _ = num_str.trim().parse::<f32>();
                return MinTrackSizingFunction::Auto;
            }
            if let Some(pct) = s
                .strip_suffix('%')
                .and_then(|n| n.trim().parse::<f32>().ok())
            {
                return MinTrackSizingFunction::Fixed(LengthPercentage::Percent(pct / 100.0));
            }
            let stripped = s.strip_suffix("px").unwrap_or(s);
            if let Ok(n) = stripped.trim().parse::<f32>() {
                return MinTrackSizingFunction::Fixed(LengthPercentage::Length(n));
            }
            MinTrackSizingFunction::Auto
        }
    }
}

fn parse_max_track(tok: &str) -> MaxTrackSizingFunction {
    let s = tok.trim();
    match s {
        "auto" => MaxTrackSizingFunction::Auto,
        "min-content" => MaxTrackSizingFunction::MinContent,
        "max-content" => MaxTrackSizingFunction::MaxContent,
        _ => {
            if let Some(num_str) = s.strip_suffix("fr") {
                if let Ok(n) = num_str.trim().parse::<f32>() {
                    return MaxTrackSizingFunction::Fraction(n);
                }
                return MaxTrackSizingFunction::Fraction(1.0);
            }
            if let Some(pct) = s
                .strip_suffix('%')
                .and_then(|n| n.trim().parse::<f32>().ok())
            {
                return MaxTrackSizingFunction::Fixed(LengthPercentage::Percent(pct / 100.0));
            }
            let stripped = s.strip_suffix("px").unwrap_or(s);
            if let Ok(n) = stripped.trim().parse::<f32>() {
                return MaxTrackSizingFunction::Fixed(LengthPercentage::Length(n));
            }
            MaxTrackSizingFunction::Auto
        }
    }
}

/// Parse a `grid-template-columns` / `-rows` value into Taffy's track
/// list. Supports literal tracks ("100px 1fr auto") and the
/// `repeat(N, <tracks>)` form Tailwind emits via `grid-cols-N`.
fn parse_track_list(s: &str) -> Vec<TrackSizingFunction> {
    let mut out = Vec::new();
    for tok in split_top_level(s, ' ') {
        let tok = tok.trim();
        if tok.is_empty() {
            continue;
        }
        if let Some(inner) = tok
            .strip_prefix("repeat(")
            .and_then(|r| r.strip_suffix(')'))
        {
            let parts = split_top_level(inner, ',');
            if parts.len() >= 2 {
                let count_str = parts[0].trim();
                let count = count_str.parse::<u16>().ok();
                // Rest of the tokens are the track list, space-separated.
                let track_str = parts[1..].join(",");
                let inner_tracks: Vec<NonRepeatedTrackSizingFunction> =
                    split_top_level(track_str.trim(), ' ')
                        .into_iter()
                        .filter(|t| !t.trim().is_empty())
                        .map(|t| parse_track_sizing(t.trim()))
                        .collect();
                if let Some(n) = count {
                    out.push(TrackSizingFunction::Repeat(
                        GridTrackRepetition::Count(n),
                        inner_tracks,
                    ));
                    continue;
                }
            }
        }
        out.push(TrackSizingFunction::Single(parse_track_sizing(tok)));
    }
    out
}

/// Parse a `grid-column` / `grid-row` value into a Taffy `Line<GridPlacement>`.
/// Supported forms: `auto`, `span N`, `N`, `N / M`, `N / span M`, `span N / M`.
fn parse_grid_line(s: &str) -> Line<GridPlacement> {
    let s = s.trim();
    let (start_str, end_str) = match s.split_once('/') {
        Some((a, b)) => (a.trim(), Some(b.trim())),
        None => (s, None),
    };
    let start = parse_grid_placement(start_str);
    let end = end_str
        .map(parse_grid_placement)
        .unwrap_or(GridPlacement::Auto);
    Line { start, end }
}

fn parse_grid_placement(s: &str) -> GridPlacement {
    let s = s.trim();
    if s == "auto" || s.is_empty() {
        return GridPlacement::Auto;
    }
    if let Some(rest) = s.strip_prefix("span ") {
        if let Ok(n) = rest.trim().parse::<u16>() {
            return GridPlacement::from_span(n);
        }
        return GridPlacement::from_span(1);
    }
    if let Ok(n) = s.parse::<i16>() {
        return GridPlacement::from_line_index(n);
    }
    GridPlacement::Auto
}

/// Split a string on `sep` but respect nested parentheses — used to
/// split `repeat(3, 1fr) 100px` on spaces without splitting the inside
/// of `repeat(...)`.
fn split_top_level(s: &str, sep: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for c in s.chars() {
        if c == '(' {
            depth += 1;
            cur.push(c);
            continue;
        }
        if c == ')' {
            depth -= 1;
            cur.push(c);
            continue;
        }
        if c == sep && depth == 0 {
            let t = cur.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
            cur.clear();
            continue;
        }
        cur.push(c);
    }
    let t = cur.trim();
    if !t.is_empty() {
        out.push(t.to_string());
    }
    out
}

/// Variant of `len_to_dim` for Taffy's inset (top/right/bottom/left),
/// which uses `LengthPercentageAuto` instead of `Dimension` so that
/// unset sides can stay Auto rather than collapsing to 0.
fn len_to_lpa(l: Len) -> LengthPercentageAuto {
    match l {
        Len::Length(px) => LengthPercentageAuto::Length(px),
        Len::Percent(p) => LengthPercentageAuto::Percent(p),
    }
}

/// Defaults wrapper over [`props_to_style_with_inherited`] — 14 px root font
/// size, no inherited context.
///
/// Every call site now threads real inherited values through, so nothing uses
/// this. Kept because it documents what the defaults are, and the comments at
/// lines 2220, 2265 and 3179 refer to "props_to_style" as the operation.
#[allow(dead_code)]
fn props_to_style(props: &PaintProps, is_text: bool, te: &mut crate::text::TextEngine) -> Style {
    props_to_style_with_inherited(props, is_text, te, 14.0, false)
}

fn props_to_style_with_inherited(
    props: &PaintProps,
    is_text: bool,
    te: &mut crate::text::TextEngine,
    inherited_font_size: f32,
    prefer_mono: bool,
) -> Style {
    let mut style = Style::default();
    // display: pick flex (default), grid, or none. "block"/"inline-block"
    // / "contents" don't have first-class scene support yet; treat them
    // as flex column so they at least lay out children.
    let display = props.display.as_deref().unwrap_or("flex");
    let is_grid = display == "grid" || display == "inline-grid";
    style.display = match display {
        "none" => Display::None,
        "grid" | "inline-grid" => Display::Grid,
        _ => Display::Flex,
    };
    if let Some(dir) = &props.flex_direction {
        style.flex_direction = match dir.as_str() {
            "row" => FlexDirection::Row,
            "row-reverse" => FlexDirection::RowReverse,
            "column" => FlexDirection::Column,
            "column-reverse" => FlexDirection::ColumnReverse,
            _ => FlexDirection::Row,
        };
    } else {
        // Direction default depends on whether the caller explicitly
        // requested flex layout or carbon-mini implicitly assumed it
        // (because there's no real block-flow path yet — div without a
        // `display` style still gets Display::Flex above so children
        // get measured).
        //
        // * Explicit `display: flex` / `inline-flex`: CSS spec — row.
        //   Tailwind's `flex items-center` expects this.
        // * No display specified at all: pretend the div is block flow
        //   by stacking children vertically (column). Most app code
        //   without `flex` was relying on this implicit behavior.
        let explicit_flex = matches!(props.display.as_deref(), Some("flex") | Some("inline-flex"),);
        style.flex_direction = if explicit_flex {
            FlexDirection::Row
        } else {
            FlexDirection::Column
        };
    }
    if let Some(w) = &props.flex_wrap {
        style.flex_wrap = match w.as_str() {
            "wrap" => FlexWrap::Wrap,
            "wrap-reverse" => FlexWrap::WrapReverse,
            _ => FlexWrap::NoWrap,
        };
    }
    if let Some(j) = &props.justify_content {
        style.justify_content = Some(match j.as_str() {
            "center" => JustifyContent::Center,
            "flex-end" | "end" => JustifyContent::End,
            "space-between" => JustifyContent::SpaceBetween,
            "space-around" => JustifyContent::SpaceAround,
            "space-evenly" => JustifyContent::SpaceEvenly,
            _ => JustifyContent::Start,
        });
    }
    if let Some(a) = &props.align_items {
        style.align_items = Some(match a.as_str() {
            "center" => AlignItems::Center,
            "flex-end" | "end" => AlignItems::End,
            "stretch" => AlignItems::Stretch,
            _ => AlignItems::Start,
        });
    }

    // ── CSS Grid — container ───────────────────────────────────────────
    if is_grid {
        // Grid containers can override align-items via the grid-specific
        // alias (place-items shorthand sets align_items_grid).
        if let Some(a) = &props.align_items_grid {
            style.align_items = Some(parse_align(a));
        }
        if let Some(j) = &props.justify_items {
            style.justify_items = Some(parse_align(j));
        }
        if let Some(ac) = &props.align_content {
            style.align_content = Some(parse_content(ac));
        }
        if let Some(s) = &props.grid_template_columns {
            style.grid_template_columns = parse_track_list(s);
        }
        if let Some(s) = &props.grid_template_rows {
            style.grid_template_rows = parse_track_list(s);
        }
        if let Some(s) = &props.grid_auto_flow {
            style.grid_auto_flow = parse_grid_auto_flow(s);
        }
    }
    // ── CSS Grid — child placement ─────────────────────────────────────
    // These apply on grid items regardless of the parent's display; if
    // the parent isn't grid, taffy ignores them.
    if let Some(s) = &props.grid_column {
        style.grid_column = parse_grid_line(s);
    }
    if let Some(s) = &props.grid_row {
        style.grid_row = parse_grid_line(s);
    }
    if let Some(a) = &props.align_self {
        if let Some(v) = parse_align_opt(a) {
            style.align_self = Some(v);
        }
    }
    if let Some(a) = &props.justify_self {
        if let Some(v) = parse_align_opt(a) {
            style.justify_self = Some(v);
        }
    }
    // CSS-shorthand fallback chain: per-side override beats x/y override
    // beats blanket padding. `padding: 0` on a parent doesn't accidentally
    // wipe out an explicit `padding-left: 12` set later — they're independent.
    let pad = props.padding.unwrap_or(0.0);
    let pad_x = props.padding_x.unwrap_or(pad);
    let pad_y = props.padding_y.unwrap_or(pad);
    let pad_left = props.padding_left.unwrap_or(pad_x);
    let pad_right = props.padding_right.unwrap_or(pad_x);
    let pad_top = props.padding_top.unwrap_or(pad_y);
    let pad_bottom = props.padding_bottom.unwrap_or(pad_y);
    style.padding = taffy::Rect {
        left: LengthPercentage::Length(pad_left),
        right: LengthPercentage::Length(pad_right),
        top: LengthPercentage::Length(pad_top),
        bottom: LengthPercentage::Length(pad_bottom),
    };
    // Margins — outer spacing that pushes siblings apart / centers via auto.
    // Only set sides that were specified so the Taffy default (0) holds
    // otherwise.
    if props.margin_left.is_some()
        || props.margin_right.is_some()
        || props.margin_top.is_some()
        || props.margin_bottom.is_some()
    {
        style.margin = taffy::Rect {
            left: props
                .margin_left
                .map(len_to_lpa)
                .unwrap_or(LengthPercentageAuto::Length(0.0)),
            right: props
                .margin_right
                .map(len_to_lpa)
                .unwrap_or(LengthPercentageAuto::Length(0.0)),
            top: props
                .margin_top
                .map(len_to_lpa)
                .unwrap_or(LengthPercentageAuto::Length(0.0)),
            bottom: props
                .margin_bottom
                .map(len_to_lpa)
                .unwrap_or(LengthPercentageAuto::Length(0.0)),
        };
    }
    if let Some(g) = props.gap {
        style.gap = Size {
            width: LengthPercentage::Length(g),
            height: LengthPercentage::Length(g),
        };
    }
    // Sizing: pixel + percent supported for width/height + min/max + basis.
    if let Some(w) = props.width {
        style.size.width = len_to_dim(w);
    }
    if let Some(h) = props.height {
        style.size.height = len_to_dim(h);
    }
    if let Some(mw) = props.min_width {
        style.min_size.width = len_to_dim(mw);
    }
    if let Some(mw) = props.max_width {
        style.max_size.width = len_to_dim(mw);
    }
    if let Some(mh) = props.min_height {
        style.min_size.height = len_to_dim(mh);
    }
    if let Some(mh) = props.max_height {
        style.max_size.height = len_to_dim(mh);
    }
    if let Some(ar) = props.aspect_ratio {
        style.aspect_ratio = Some(ar);
    }
    // Flex item sizing — defaults match the CSS spec (grow=0, shrink=1,
    // basis=auto). Only apply when set so we don't overwrite Taffy's
    // defaults with the same values.
    if let Some(g) = props.flex_grow {
        style.flex_grow = g;
    }
    if let Some(s) = props.flex_shrink {
        style.flex_shrink = s;
    }
    if let Some(b) = props.flex_basis {
        style.flex_basis = len_to_dim(b);
    }
    // Taffy needs to know when a node should let its content overflow.
    // Without this, a flex-grow child's height clamps to the container
    // and content_height == viewport_height (no overflow ever, no
    // scrollbar). Setting overflow.y = Scroll tells Taffy: lay children
    // out at their natural sizes regardless of my box height.
    if props.overflow_y {
        style.overflow.y = Overflow::Scroll;
    }
    // Position + inset. `absolute` and `fixed` both take the node out
    // of flex flow and place it via top/right/bottom/left. We don't
    // model a separate fixed-vs-absolute "positioned ancestor" concept
    // yet — both resolve against the nearest ancestor that has explicit
    // size, which in practice means the root.
    if let Some(pos) = props.position.as_deref() {
        if matches!(pos, "absolute" | "fixed") {
            style.position = Position::Absolute;
        }
    }
    style.inset = taffy::Rect {
        left: props
            .left
            .map(len_to_lpa)
            .unwrap_or(LengthPercentageAuto::Auto),
        right: props
            .right
            .map(len_to_lpa)
            .unwrap_or(LengthPercentageAuto::Auto),
        top: props
            .top
            .map(len_to_lpa)
            .unwrap_or(LengthPercentageAuto::Auto),
        bottom: props
            .bottom
            .map(len_to_lpa)
            .unwrap_or(LengthPercentageAuto::Auto),
    };
    if is_text {
        if let Some(text) = &props.text {
            let fs = props.font_size.unwrap_or(inherited_font_size);
            let (mw, mh) = te.measure_mono(text, fs, prefer_mono);
            if props.width.is_none() {
                // No user-set width — pin EVERYTHING to the measured
                // single-line size. The build_taffy path uses new_leaf
                // (no measure callback) for these so Taffy genuinely
                // can't query for wrapped sizes; the leaf is exactly
                // mw × mh. Paint draws the text into that fixed box at
                // single-line width — no wrap, ever.
                //
                // For user-width leaves the build_taffy path keeps the
                // measure callback and Taffy wraps to fit. We don't set
                // size here in that case; props_to_style runs above
                // already with the user's Length(width) on style.size.
                style.size.width = Dimension::Length(mw);
                style.size.height = Dimension::Length(mh);
                style.min_size.width = Dimension::Length(mw);
            }
            // Text leaves don't shrink in flex containers by default. CSS
            // ships `white-space: nowrap` semantics for inline text in flex
            // rows; without this default, Taffy's flex algorithm can collapse
            // a text leaf to its longest-word width even when space is
            // abundant. Users who want a wrappable text block (long
            // paragraph content in a fixed-width column) opt back in with
            // `style={{ flexShrink: 1 }}` — or set an explicit `width`,
            // which suppresses min_size.width above and lets the measure
            // callback wrap to that width.
            if props.flex_shrink.is_none() {
                style.flex_shrink = 0.0;
            }
        }
    }
    style
}
