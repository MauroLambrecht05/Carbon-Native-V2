// Lazy-loaded text engine: fontdue + a font-stack with per-glyph fallback.
//
// Font resolution at startup:
//   1. <project_dir>/assets/font.ttf  (registered as fonts[0] if present)
//   2. <project_dir>/font.ttf         (registered as fonts[0] if (1) absent)
//   3. embedded Roboto-Latin subset   (registered last as a coverage backstop)
//
// At runtime, apps can call the JS host import `__cm_load_font(path)` to
// PREPEND additional TTFs to the stack. The first font in the stack that
// has a glyph for a given codepoint wins. This lets an app pair (e.g.)
// Cascadia for braille/box-drawing with Hack Nerd for PUA icons without
// having to ship a single all-coverage TTF.
//
// Metrics (ascent / descent / line-height) come from the PRIMARY font
// (fonts[0]) for consistency — switching fonts mid-line on metrics
// would jitter baselines.
//
// Glyphs are rasterized lazily and cached by (codepoint, px, font_idx).

use fontdue::{Font, FontSettings};
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use tiny_skia::{Pixmap, PremultipliedColorU8};

/// Inter static weights — the default UI font stack. Inter is what most
/// shadcn/tailwind apps (terax included) declare, and shipping real 400/
/// 500/600/700 faces gives true weight rendering instead of a synthetic
/// faux-bold double-draw. Latin coverage; ~325 KB raw, ~215 KB each
/// lz4-compressed (see `embedded_font!` below) — decompressed once, into a
/// process-wide cache, the first time any TextEngine needs the default
/// stack (`ensure_loaded`), not per-instance and not at startup.
///
/// lz4, not a stronger codec: `lz4_flex` is already linked (carbon-snapshot
/// uses it for the heap-snapshot arena), so reusing it here costs zero
/// additional binary weight — the tradeoff is a more modest ratio (~66%)
/// than zstd/brotli would give, in exchange for not adding a second
/// decompressor crate just for this.
macro_rules! embedded_font {
    ($name:ident, $path:literal) => {
        fn $name() -> &'static [u8] {
            static CACHE: OnceLock<Vec<u8>> = OnceLock::new();
            CACHE.get_or_init(|| {
                const COMPRESSED: &[u8] = include_bytes!($path);
                lz4_flex::block::decompress_size_prepended(COMPRESSED)
                    .expect("embedded font decompress")
            })
        }
    };
}

embedded_font!(inter_regular, "assets/Inter-Regular.ttf.lz4");
embedded_font!(inter_medium, "assets/Inter-Medium.ttf.lz4");
embedded_font!(inter_semibold, "assets/Inter-SemiBold.ttf.lz4");
embedded_font!(inter_bold, "assets/Inter-Bold.ttf.lz4");
// Coverage backstop (~37 KB raw Roboto Latin subset) for the rare glyph
// outside Inter's cmap. Lowest priority in the stack.
embedded_font!(fallback_font_bytes, "assets/Roboto-Regular-Latin.ttf.lz4");

pub struct TextEngine {
    /// Font stack — per-glyph fallback chain filtered by (mono-class,
    /// weight, glyph coverage). Index 0 drives line metrics.
    fonts: Vec<Font>,
    /// Parallel to `fonts`: the nominal weight (100–900) of each face.
    /// Drives weight-aware face selection so `font-semibold` picks the
    /// real SemiBold cut rather than faking it. Runtime-loaded and user
    /// fonts default to 400.
    weights: Vec<u16>,
    /// Bytes pending load (user-supplied via try_load_user_font); turned
    /// into fontdue::Font on first font lookup.
    pending_user_bytes: Vec<Vec<u8>>,
    /// True once the embedded default has been appended to `fonts`.
    default_loaded: bool,
    /// Set by `preload()`: a background thread decompressing + parsing the
    /// embedded default stack (5 fontdue::Font parses, ~100ms measured —
    /// real CPU work, not I/O, so overlapping it with JS-runtime init is a
    /// genuine wall-clock win, not just hidden latency). `ensure_loaded`
    /// joins it transparently the first time any font is actually needed
    /// (typically during the first layout pass, well after JS init has
    /// already been running for a while) — by then the join is often a
    /// no-op. Falls back to loading synchronously, right there, if
    /// `ensure_loaded` is ever reached without `preload()` having run first.
    default_fonts_handle: Option<std::thread::JoinHandle<Vec<(Font, u16)>>>,
    /// Parallel to `fonts`: true if the font at this index is monospace
    /// (advance of 'i' ≈ advance of 'M'). Lets text honor CSS font-family
    /// intent (sans vs mono) instead of blindly using the first font in the
    /// stack. Rebuilt whenever `fonts` changes (len mismatch).
    mono_flags: Vec<bool>,
    /// Parallel to `fonts`: the family name this face was registered under,
    /// if any (via `load_font_bytes_named`/`load_font_path_named` — what the
    /// fonts plugin's `loadFont(path, family)` JS hook calls into through the
    /// plugin ABI). `None` for the embedded defaults and anything loaded
    /// through the older, anonymous `load_font_bytes`/`load_font_path`.
    /// This is what lets `font-family: "Poppins"` in CSS/JSX actually select
    /// a specific loaded face by name — see `font_for_char_named`.
    family_names: Vec<Option<String>>,
    /// glyph cache: (codepoint, px, font_idx) -> (metrics, alpha bitmap)
    cache: HashMap<(u32, u32, u32), CachedGlyph>,
    /// Horizontal clip band (LOGICAL px) applied to glyph blits. Set by the
    /// paint loop before drawing a node's text so content inside an
    /// `overflow:hidden` container is clipped to the container's box on the
    /// X axis (the Y axis is handled via clip_top/clip_bottom). Default is
    /// unbounded. Multiplied by `scale` at blit time.
    pub x_clip: (f32, f32),
    /// Requested font weight for the NEXT draw call. Set by the paint loop
    /// (from the node's inherited/own font-weight) before each text blit so
    /// `draw_text_*` selects the matching face. Measurement ignores this
    /// (always weight-400 metrics) so layout stays weight-stable.
    pub cur_weight: u16,
    /// Requested font-family (the raw CSS value, e.g. `"Poppins", sans-serif`)
    /// for the NEXT draw/measure call. Mirrors `cur_weight`, but — unlike
    /// it — measurement does NOT ignore this: a named font can have
    /// different glyph metrics than the fallback stack, so layout and paint
    /// must agree on which face they're using or the measured box won't
    /// match what gets rendered. `None` means "no family requested", which
    /// falls straight through to the existing weight/mono/coverage search
    /// in `font_for_char`.
    pub cur_family: Option<String>,
    /// Device-pixel scale (HiDPI). Layout + measurement run in LOGICAL px;
    /// the paint loop sets this to the monitor scale factor so the single
    /// glyph-blit leaf (`draw_text_styled_mono`) rasterizes and positions
    /// at PHYSICAL resolution — crisp text on a HiDPI display. Default 1.0.
    pub scale: f32,
}

struct CachedGlyph {
    width: usize,
    height: usize,
    xmin: i32,
    ymin: i32,
    advance: f32,
    bitmap: Vec<u8>,
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            fonts: Vec::new(),
            weights: Vec::new(),
            pending_user_bytes: Vec::new(),
            default_loaded: false,
            default_fonts_handle: None,
            mono_flags: Vec::new(),
            family_names: Vec::new(),
            cache: HashMap::new(),
            x_clip: (f32::NEG_INFINITY, f32::INFINITY),
            cur_weight: 400,
            cur_family: None,
            scale: 1.0,
        }
    }

    /// Try to load a user-supplied font from <project_dir>/assets/font.ttf
    /// (or <project_dir>/font.ttf). Falls back silently if neither exists.
    /// Should be called before `preload`.
    pub fn try_load_user_font(&mut self, project_dir: &Path) {
        let candidates = [
            project_dir.join("assets").join("font.ttf"),
            project_dir.join("font.ttf"),
        ];
        for path in &candidates {
            if path.exists() {
                if let Ok(bytes) = std::fs::read(path) {
                    self.pending_user_bytes.push(bytes);
                    return;
                }
            }
        }
    }

    /// Load a font from raw TTF/OTF bytes and APPEND to the stack.
    /// Returns true on success. Subsequent glyph lookups consider this
    /// font BEFORE the embedded default (but after any previously-added
    /// fonts). Anonymous — not selectable by font-family name. Kept for the
    /// existing `__cm_load_font`/`__cm_load_font_bytes` JS globals; new
    /// callers (the fonts plugin) should use `load_font_bytes_named`.
    pub fn load_font_bytes(&mut self, bytes: Vec<u8>) -> bool {
        self.load_font_bytes_named(bytes, None, None)
    }

    /// Load a font from a file path and append to the stack. Returns
    /// true on success. Anonymous — see `load_font_bytes`.
    pub fn load_font_path(&mut self, path: &Path) -> bool {
        self.load_font_path_named(path, None, None)
    }

    /// Load a font from raw TTF/OTF bytes and APPEND to the stack, optionally
    /// registered under `family` so `font-family: "<family>"` can select it
    /// by name (see `font_for_char_named`) instead of only by weight/mono/
    /// coverage, and tagged with `weight` (1-1000, CSS font-weight scale;
    /// `None` defaults to 400 — Regular) so `font-bold`/`font-semibold` text
    /// in that family picks THIS face instead of silently falling back to
    /// Inter's matching weight. This is what the fonts plugin's
    /// `loadFont(path, family, weight)` JS hook calls into, through the
    /// plugin ABI's `load_font_bytes` field.
    pub fn load_font_bytes_named(
        &mut self,
        bytes: Vec<u8>,
        family: Option<String>,
        weight: Option<u16>,
    ) -> bool {
        // Make sure the embedded defaults are in first, then append. Face
        // selection filters by (mono-class, weight, coverage), so position
        // no longer matters — a runtime-loaded monospace font is still
        // chosen for mono text because it's the only mono-class face.
        self.ensure_loaded();
        match Font::from_bytes(bytes.as_slice(), FontSettings::default()) {
            Ok(font) => {
                self.fonts.push(font);
                self.weights.push(weight.unwrap_or(400).clamp(1, 1000));
                self.family_names.push(family);
                self.mono_flags.clear(); // force rebuild on next op
                true
            }
            Err(_) => false,
        }
    }

    /// Load a font from a file path and append to the stack, optionally
    /// named/weighted — see `load_font_bytes_named`.
    pub fn load_font_path_named(
        &mut self,
        path: &Path,
        family: Option<String>,
        weight: Option<u16>,
    ) -> bool {
        match std::fs::read(path) {
            Ok(bytes) => self.load_font_bytes_named(bytes, family, weight),
            Err(_) => false,
        }
    }

    /// Ensure pending bytes / the embedded default are turned into
    /// fontdue::Fonts. Idempotent — safe to call before every operation.
    fn ensure_loaded(&mut self) {
        // 1. Promote any user-supplied bytes (from try_load_user_font)
        //    that haven't been turned into Fonts yet. A user font.ttf is a
        //    single-weight override — tagged 400.
        let pending = std::mem::take(&mut self.pending_user_bytes);
        for bytes in pending {
            if let Ok(font) = Font::from_bytes(bytes.as_slice(), FontSettings::default()) {
                self.fonts.push(font);
                self.weights.push(400);
                self.family_names.push(None);
            }
        }
        // 2. Append the embedded Inter weight stack + Roboto backstop once —
        //    either by joining the background load `preload()` kicked off
        //    (the common case: JS runtime init has been running in the
        //    meantime, so this join is often already-finished/instant), or,
        //    if `preload()` was never called, by loading synchronously right
        //    here as a correctness fallback.
        if !self.default_loaded {
            let loaded = match self.default_fonts_handle.take() {
                Some(handle) => handle.join().unwrap_or_default(),
                None => {
                    let mut out = Vec::with_capacity(5);
                    for (bytes, weight) in [
                        (inter_regular(), 400u16),
                        (inter_medium(), 500),
                        (inter_semibold(), 600),
                        (inter_bold(), 700),
                        (fallback_font_bytes(), 400),
                    ] {
                        if let Ok(font) = Font::from_bytes(bytes, FontSettings::default()) {
                            out.push((font, weight));
                        }
                    }
                    out
                }
            };
            for (font, weight) in loaded {
                self.fonts.push(font);
                self.weights.push(weight);
                self.family_names.push(None);
            }
            self.default_loaded = true;
        }
        // 3. Keep the parallel metadata in sync. `weights`/`family_names`
        //    are pushed alongside every font above; pad defensively in case
        //    a path added a font without them. mono_flags rebuilds on len
        //    change — off the hot per-glyph path.
        while self.weights.len() < self.fonts.len() {
            self.weights.push(400);
        }
        while self.family_names.len() < self.fonts.len() {
            self.family_names.push(None);
        }
        if self.mono_flags.len() != self.fonts.len() {
            self.mono_flags = self
                .fonts
                .iter()
                .map(|f| {
                    let im = f.metrics('i', 64.0).advance_width;
                    let mm = f.metrics('M', 64.0).advance_width;
                    // True monospace fonts give every glyph the same advance.
                    (im - mm).abs() < 1.0
                })
                .collect();
        }
    }

    /// Get the primary font (index 0). Used for line metrics so all
    /// glyphs on a line sit on the same baseline regardless of which
    /// fallback font supplies them.
    fn primary(&mut self) -> Option<&Font> {
        self.ensure_loaded();
        self.fonts.first()
    }

    /// Return the (font, font_idx) that has a glyph for `ch`, honoring the
    /// caller's monospace/proportional intent. A `font-mono` element prefers
    /// a monospace font in the stack; everything else prefers a proportional
    /// one. Falls back to any font with the glyph, then to the primary (so we
    /// at least rasterize SOMETHING — typically .notdef).
    ///
    /// This is what stops sans UI text from rendering in the loaded monospace
    /// terminal font (and vice-versa): font selection used to be pure glyph-
    /// coverage fallback off a single priority stack, ignoring font-family.
    fn font_for_char(&mut self, ch: char, prefer_mono: bool, weight: u16) -> Option<(&Font, u32)> {
        self.ensure_loaded();
        if self.fonts.is_empty() {
            return None;
        }
        // Family-name-aware pass: if the caller requested a specific family
        // (`cur_family`, set by the paint/layout call sites from the node's
        // CSS font-family) and a loaded font was registered under a
        // matching name, prefer it over the generic coverage/weight search
        // below — this is what makes `font-family: "Poppins"` actually
        // select Poppins instead of being reduced to a mono/proportional
        // guess. Falls through to the general search below when the named
        // font doesn't cover `ch` (or nothing matched), so a custom font
        // missing e.g. an emoji still falls back gracefully.
        if let Some(idx) = self.font_for_char_named(ch, weight) {
            return Some((&self.fonts[idx], idx as u32));
        }
        // Pick, among the faces that actually have the glyph, the one whose
        // nominal weight is closest to `weight` — preferring the requested
        // class (mono vs proportional). Ties keep the earlier (higher-
        // priority) face. This turns `font-semibold` into the real SemiBold
        // cut instead of a synthetic thicken.
        let mut best_class: Option<(u16, usize)> = None; // (weight_dist, idx)
        let mut best_any: Option<(u16, usize)> = None;
        for (i, font) in self.fonts.iter().enumerate() {
            if font.lookup_glyph_index(ch) == 0 {
                continue;
            }
            let fw = self.weights.get(i).copied().unwrap_or(400) as i32;
            let dist = (fw - weight as i32).unsigned_abs() as u16;
            if best_any.map(|(bd, _)| dist < bd).unwrap_or(true) {
                best_any = Some((dist, i));
            }
            let is_mono = self.mono_flags.get(i).copied().unwrap_or(false);
            if is_mono == prefer_mono && best_class.map(|(bd, _)| dist < bd).unwrap_or(true) {
                best_class = Some((dist, i));
            }
        }
        let idx = best_class.or(best_any).map(|(_, i)| i).unwrap_or(0);
        Some((&self.fonts[idx], idx as u32))
    }

    /// Among fonts registered under a name matching `self.cur_family` (a raw
    /// CSS font-family value — possibly a comma-separated fallback chain,
    /// e.g. `"Poppins", sans-serif`), return the index of the one closest to
    /// `weight` that actually covers `ch`. `None` if no family was
    /// requested, nothing was registered under a matching name, or none of
    /// the matches cover this glyph — any of which falls through to the
    /// ordinary coverage/weight/mono search in `font_for_char`.
    ///
    /// Tries each family in the requested chain in order and stops at the
    /// first one with ANY registered face (matching CSS's own fallback
    /// semantics: `"Poppins", sans-serif` means "Poppins, and only if
    /// Poppins isn't available at all, fall back"), then picks the
    /// weight-closest face among that family's variants (so a plugin that
    /// loaded both "Poppins" 400 and "Poppins" 700 gets real bold, not a
    /// synthetic one).
    fn font_for_char_named(&self, ch: char, weight: u16) -> Option<usize> {
        let requested = self.cur_family.as_deref()?;
        for fam in requested.split(',') {
            let fam = normalize_family(fam);
            if fam.is_empty() {
                continue;
            }
            let mut best: Option<(u16, usize)> = None;
            for (i, name) in self.family_names.iter().enumerate() {
                let Some(name) = name else { continue };
                if normalize_family(name) != fam {
                    continue;
                }
                if self.fonts[i].lookup_glyph_index(ch) == 0 {
                    continue;
                }
                let fw = self.weights.get(i).copied().unwrap_or(400) as i32;
                let dist = (fw - weight as i32).unsigned_abs() as u16;
                if best.map(|(bd, _)| dist < bd).unwrap_or(true) {
                    best = Some((dist, i));
                }
            }
            if best.is_some() {
                return best.map(|(_, i)| i);
            }
            // Nothing under this family name covers `ch` — but if the name
            // itself is registered at all (just missing this glyph), stop
            // here rather than trying the next fallback in the chain, same
            // as the doc comment's CSS-semantics rationale above.
            if self
                .family_names
                .iter()
                .any(|n| n.as_deref().map(normalize_family).as_deref() == Some(fam.as_str()))
            {
                return None;
            }
        }
        None
    }

    /// Kick off the embedded default stack's decompress+parse on a
    /// background thread rather than paying it inline before first paint —
    /// see `default_fonts_handle`'s doc comment for why this is a real
    /// overlap win, not just a reordering. Idempotent.
    pub fn preload(&mut self) {
        if self.default_loaded || self.default_fonts_handle.is_some() {
            return;
        }
        self.default_fonts_handle = Some(std::thread::spawn(|| {
            let mut out = Vec::with_capacity(5);
            for (bytes, weight) in [
                (inter_regular(), 400u16),
                (inter_medium(), 500),
                (inter_semibold(), 600),
                (inter_bold(), 700),
                (fallback_font_bytes(), 400),
            ] {
                if let Ok(font) = Font::from_bytes(bytes, FontSettings::default()) {
                    out.push((font, weight));
                }
            }
            out
        }));
    }

    /// (ascent, descent_abs) at the given size, or None before any font
    /// is loaded. Drives vertical-centering math for inputs.
    pub fn ascent_descent(&mut self, font_size: f32) -> Option<(f32, f32)> {
        let f = self.primary()?;
        let m = f.horizontal_line_metrics(font_size)?;
        Some((m.ascent, m.descent.abs()))
    }

    /// Full line-box height at this size (ascent + |descent| + line_gap).
    pub fn line_box(&mut self, font_size: f32) -> Option<f32> {
        let f = self.primary()?;
        let m = f.horizontal_line_metrics(font_size)?;
        Some(m.new_line_size)
    }

    pub fn measure(&mut self, text: &str, font_size: f32) -> (f32, f32) {
        self.measure_styled(text, font_size, 0.0)
    }

    /// Like `measure` but honors mono/proportional intent so the layout box
    /// matches what the paint loop will render for `font-mono` elements.
    pub fn measure_mono(&mut self, text: &str, font_size: f32, prefer_mono: bool) -> (f32, f32) {
        self.measure_styled_mono(text, font_size, 0.0, prefer_mono)
    }

    pub fn measure_styled(
        &mut self,
        text: &str,
        font_size: f32,
        letter_spacing: f32,
    ) -> (f32, f32) {
        self.measure_styled_mono(text, font_size, letter_spacing, false)
    }

    pub fn measure_styled_mono(
        &mut self,
        text: &str,
        font_size: f32,
        letter_spacing: f32,
        is_mono: bool,
    ) -> (f32, f32) {
        let px = font_size;
        // Primary line-metric font.
        let _primary = match self.primary() {
            Some(f) => f,
            None => {
                return (
                    text.chars().count() as f32 * font_size * 0.55,
                    font_size * 1.3,
                );
            }
        };
        let mono_advance = if is_mono {
            // Pin to the MONO face's 'M' (not fonts[0], which is now the
            // proportional Inter-Regular — its 'M' is far wider and would
            // stretch every terminal cell).
            self.font_for_char('M', true, 400)
                .map(|(f, _)| f.metrics('M', px).advance_width)
                .unwrap_or(font_size * 0.6)
        } else {
            0.0
        };
        let mut w = 0.0_f32;
        let mut first = true;
        for ch in text.chars() {
            if !first {
                w += letter_spacing;
            }
            let adv = if is_mono {
                mono_advance
            } else {
                match self.font_for_char(ch, false, 400) {
                    Some((f, _)) => f.metrics(ch, px).advance_width,
                    None => font_size * 0.55,
                }
            };
            w += adv;
            first = false;
        }
        let metric = self
            .primary()
            .and_then(|f| f.horizontal_line_metrics(px))
            .map(|m| m.new_line_size)
            .unwrap_or(font_size * 1.25);
        let intrinsic_h = metric.min(font_size * 1.25);
        (w, intrinsic_h)
    }

    pub fn resolve_line_height(&mut self, font_size: f32, prop: Option<f32>) -> f32 {
        if let Some(v) = prop {
            if v <= 4.0 {
                return font_size * v;
            }
            return v;
        }
        let px = font_size;
        match self.primary() {
            Some(f) => f
                .horizontal_line_metrics(px)
                .map(|m| m.new_line_size)
                .unwrap_or(font_size * 1.3),
            None => font_size * 1.3,
        }
    }

    pub fn longest_word_width(&mut self, text: &str, font_size: f32) -> f32 {
        self.longest_word_width_pm(text, font_size, false)
    }

    pub fn longest_word_width_pm(&mut self, text: &str, font_size: f32, prefer_mono: bool) -> f32 {
        let px = font_size;
        if self.primary().is_none() {
            return text.chars().count() as f32 * font_size * 0.55;
        }
        let mut max = 0.0_f32;
        for word in text.split_ascii_whitespace() {
            let mut w = 0.0_f32;
            for ch in word.chars() {
                let adv = match self.font_for_char(ch, prefer_mono, 400) {
                    Some((f, _)) => f.metrics(ch, px).advance_width,
                    None => font_size * 0.55,
                };
                w += adv;
            }
            if w > max {
                max = w;
            }
        }
        max
    }

    pub fn wrap_lines(&mut self, text: &str, font_size: f32, max_width: f32) -> Vec<String> {
        self.wrap_lines_pm(text, font_size, max_width, false)
    }

    pub fn wrap_lines_pm(
        &mut self,
        text: &str,
        font_size: f32,
        max_width: f32,
        prefer_mono: bool,
    ) -> Vec<String> {
        if text.is_empty() {
            return vec![String::new()];
        }
        let px = font_size;
        if self.primary().is_none() {
            return vec![text.to_string()];
        }
        let space_w = self
            .font_for_char(' ', prefer_mono, 400)
            .map(|(f, _)| f.metrics(' ', px).advance_width)
            .unwrap_or(font_size * 0.3);

        let mut lines: Vec<String> = Vec::new();
        for paragraph in text.split('\n') {
            let mut current = String::new();
            let mut current_w = 0.0_f32;
            for word in paragraph.split_ascii_whitespace() {
                let mut word_w = 0.0_f32;
                for ch in word.chars() {
                    let adv = match self.font_for_char(ch, prefer_mono, 400) {
                        Some((f, _)) => f.metrics(ch, px).advance_width,
                        None => font_size * 0.55,
                    };
                    word_w += adv;
                }
                let with_space = if current.is_empty() {
                    word_w
                } else {
                    word_w + space_w
                };
                if current_w + with_space <= max_width || current.is_empty() {
                    if !current.is_empty() {
                        current.push(' ');
                        current_w += space_w;
                    }
                    current.push_str(word);
                    current_w += word_w;
                } else {
                    lines.push(std::mem::take(&mut current));
                    current.push_str(word);
                    current_w = word_w;
                }
            }
            lines.push(current);
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        lines
    }

    pub fn measure_wrapped(&mut self, text: &str, font_size: f32, max_width: f32) -> (f32, f32) {
        self.measure_wrapped_pm(text, font_size, max_width, false)
    }

    pub fn measure_wrapped_pm(
        &mut self,
        text: &str,
        font_size: f32,
        max_width: f32,
        prefer_mono: bool,
    ) -> (f32, f32) {
        let (single_w, line_h) = self.measure_styled_mono(text, font_size, 0.0, prefer_mono);
        if single_w <= max_width || max_width <= 0.0 {
            return (single_w, line_h);
        }
        let lines = self.wrap_lines_pm(text, font_size, max_width, prefer_mono);
        let mut max_w = 0.0_f32;
        for line in &lines {
            let (w, _) = self.measure_styled_mono(line, font_size, 0.0, prefer_mono);
            if w > max_w {
                max_w = w;
            }
        }
        (max_w, line_h * lines.len() as f32)
    }

    /// CSS `text-overflow: ellipsis` support. If `text` already fits
    /// within `max_width`, returns it unchanged. Otherwise trims it
    /// (whole chars only) and appends "…", growing the kept prefix as
    /// far as it fits alongside the ellipsis glyph. `max_width <= 0`
    /// means "unconstrained" — returned unchanged. O(n) measure calls
    /// for an n-char string; fine for UI-label-length text, the only
    /// case this is meant for.
    pub fn truncate_ellipsis_mono(
        &mut self,
        text: &str,
        font_size: f32,
        letter_spacing: f32,
        is_mono: bool,
        max_width: f32,
    ) -> String {
        if max_width <= 0.0 {
            return text.to_string();
        }
        let (full_w, _) = self.measure_styled_mono(text, font_size, letter_spacing, is_mono);
        if full_w <= max_width {
            return text.to_string();
        }
        let ellipsis_w = self
            .measure_styled_mono("\u{2026}", font_size, 0.0, is_mono)
            .0;
        if ellipsis_w > max_width {
            return String::new();
        }
        let budget = max_width - ellipsis_w;
        let mut acc = 0.0_f32;
        let mut end = 0usize;
        for (i, ch) in text.char_indices() {
            let mut cw = self
                .measure_styled_mono(&ch.to_string(), font_size, 0.0, is_mono)
                .0;
            if i > 0 {
                cw += letter_spacing;
            }
            if acc + cw > budget {
                break;
            }
            acc += cw;
            end = i + ch.len_utf8();
        }
        let mut out = text[..end].to_string();
        out.push('\u{2026}');
        out
    }

    pub fn draw_text_wrapped(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color_argb: u32,
        max_width: f32,
    ) {
        let (single_w, line_h) = self.measure(text, font_size);
        if single_w <= max_width || max_width <= 0.0 {
            self.draw_text(
                pixmap,
                text,
                x,
                y,
                font_size,
                color_argb,
                f32::NEG_INFINITY,
                f32::INFINITY,
            );
            return;
        }
        let lines = self.wrap_lines(text, font_size, max_width);
        for (i, line) in lines.iter().enumerate() {
            let ly = y + (i as f32) * line_h;
            self.draw_text(
                pixmap,
                line,
                x,
                ly,
                font_size,
                color_argb,
                f32::NEG_INFINITY,
                f32::INFINITY,
            );
        }
    }

    pub fn draw_text_wrapped_clipped(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color_argb: u32,
        max_width: f32,
        clip_top: f32,
        clip_bottom: f32,
    ) {
        self.draw_text_wrapped_clipped_styled(
            pixmap,
            text,
            x,
            y,
            font_size,
            color_argb,
            max_width,
            clip_top,
            clip_bottom,
            None,
            0.0,
        );
    }

    pub fn draw_text_wrapped_clipped_styled(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color_argb: u32,
        max_width: f32,
        clip_top: f32,
        clip_bottom: f32,
        line_height_prop: Option<f32>,
        letter_spacing: f32,
    ) {
        self.draw_text_wrapped_clipped_styled_mono(
            pixmap,
            text,
            x,
            y,
            font_size,
            color_argb,
            max_width,
            clip_top,
            clip_bottom,
            line_height_prop,
            letter_spacing,
            false,
            false,
        );
    }

    pub fn draw_text_wrapped_clipped_styled_mono(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color_argb: u32,
        max_width: f32,
        clip_top: f32,
        clip_bottom: f32,
        line_height_prop: Option<f32>,
        letter_spacing: f32,
        is_mono: bool,
        italic: bool,
    ) {
        let (single_w, intrinsic_h) =
            self.measure_styled_mono(text, font_size, letter_spacing, is_mono);
        let line_h = if line_height_prop.is_some() {
            self.resolve_line_height(font_size, line_height_prop)
        } else {
            intrinsic_h
        };
        let lines: Vec<String> = if single_w <= max_width || max_width <= 0.0 {
            vec![text.to_string()]
        } else {
            self.wrap_lines_pm(text, font_size, max_width, is_mono)
        };
        for (i, line) in lines.iter().enumerate() {
            let ly = y + (i as f32) * line_h;
            if ly + line_h < clip_top || ly > clip_bottom {
                continue;
            }
            self.draw_text_styled_mono(
                pixmap,
                line,
                x,
                ly,
                font_size,
                color_argb,
                clip_top,
                clip_bottom,
                letter_spacing,
                is_mono,
                italic,
            );
        }
    }

    pub fn draw_text(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color_argb: u32,
        clip_top: f32,
        clip_bottom: f32,
    ) {
        self.draw_text_styled(
            pixmap,
            text,
            x,
            y,
            font_size,
            color_argb,
            clip_top,
            clip_bottom,
            0.0,
        );
    }

    pub fn draw_text_styled(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color_argb: u32,
        clip_top: f32,
        clip_bottom: f32,
        letter_spacing: f32,
    ) {
        self.draw_text_styled_mono(
            pixmap,
            text,
            x,
            y,
            font_size,
            color_argb,
            clip_top,
            clip_bottom,
            letter_spacing,
            false,
            false,
        );
    }

    pub fn draw_text_styled_mono(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color_argb: u32,
        clip_top: f32,
        clip_bottom: f32,
        letter_spacing: f32,
        is_mono: bool,
        italic: bool,
    ) {
        // HiDPI: this is the single glyph-blit leaf every text path funnels
        // through, so scaling here (and nowhere else in text.rs) rasterizes
        // and positions at PHYSICAL resolution while all callers stay in
        // LOGICAL px. Measurement/wrap above is unaffected (it never reaches
        // here), so layout is scale-stable.
        let s = self.scale;
        let x = x * s;
        let y = y * s;
        let font_size = font_size * s;
        let letter_spacing = letter_spacing * s;
        let clip_top = clip_top * s;
        let clip_bottom = clip_bottom * s;
        let x_clip = (self.x_clip.0 * s, self.x_clip.1 * s);
        // Weight requested by the paint loop for this run — picks the real
        // Inter face (Regular/Medium/SemiBold/Bold).
        let weight = self.cur_weight;

        let px_int = (font_size.round() as u32).max(1);
        // Need at least one font.
        if self.primary().is_none() {
            return;
        }

        let a = ((color_argb >> 24) & 0xFF) as u8;
        let r = ((color_argb >> 16) & 0xFF) as u8;
        let g = ((color_argb >> 8) & 0xFF) as u8;
        let b = (color_argb & 0xFF) as u8;

        let ascent = self
            .primary()
            .and_then(|f| f.horizontal_line_metrics(font_size))
            .map(|m| m.ascent)
            .unwrap_or(font_size * 0.8);

        let pen_y = y + ascent;
        let mut pen_x = x;
        let mut first = true;
        // Mono advance — pin to primary's 'M'.
        let mono_advance = if is_mono {
            // Pin to the MONO face's 'M' (fonts[0] is now proportional
            // Inter-Regular — using it here widened every terminal cell).
            self.font_for_char('M', true, weight)
                .map(|(f, _)| f.metrics('M', font_size).advance_width)
                .unwrap_or(font_size * 0.6)
        } else {
            0.0
        };

        let pw = pixmap.width() as i32;
        let ph = pixmap.height() as i32;

        for ch in text.chars() {
            if !first {
                pen_x += letter_spacing;
            }
            first = false;
            // Choose the font that has this glyph, honoring mono/proportional
            // intent so sans text doesn't pick up the monospace terminal font.
            let (font_idx, advance) = {
                let res = self.font_for_char(ch, is_mono, weight);
                match res {
                    Some((f, idx)) => (idx, f.metrics(ch, font_size).advance_width),
                    None => continue,
                }
            };
            let cp = ch as u32;
            let key = (cp, px_int, font_idx);
            if let std::collections::hash_map::Entry::Vacant(e) = self.cache.entry(key) {
                let f = &self.fonts[font_idx as usize];
                let (metrics, bitmap) = f.rasterize(ch, font_size);
                e.insert(CachedGlyph {
                    width: metrics.width,
                    height: metrics.height,
                    xmin: metrics.xmin,
                    ymin: metrics.ymin,
                    advance: metrics.advance_width,
                    bitmap,
                });
            }
            let glyph = match self.cache.get(&key) {
                Some(g) => g,
                None => continue,
            };

            let cell_offset = if is_mono {
                (mono_advance - glyph.advance) * 0.5
            } else {
                0.0
            };
            let gx = (pen_x + cell_offset + glyph.xmin as f32).round() as i32;
            let gy = (pen_y - glyph.ymin as f32 - glyph.height as f32).round() as i32;

            blit_glyph(
                pixmap,
                gx,
                gy,
                glyph.width,
                glyph.height,
                &glyph.bitmap,
                r,
                g,
                b,
                a,
                pw,
                ph,
                clip_top as i32,
                clip_bottom as i32,
                x_clip.0,
                x_clip.1,
                italic,
            );

            pen_x += if is_mono { mono_advance } else { advance };
        }
    }

    /// TEMP DEBUG: per-glyph dump for diagnosing spacing. Returns the font
    /// count and, per char, the chosen font index, advance, side bearing,
    /// raster width, and running pen position.
    pub fn debug_probe(&mut self, text: &str, font_size: f32) -> String {
        self.ensure_loaded();
        let px = font_size;
        let mut out = format!("fonts={} text={:?}\n", self.fonts.len(), text);
        let mut pen = 0.0f32;
        for ch in text.chars() {
            let (idx, adv) = match self.font_for_char(ch, false, 400) {
                Some((f, i)) => (i, f.metrics(ch, px).advance_width),
                None => (999u32, 0.0f32),
            };
            let m = self.fonts.get(idx as usize).map(|f| f.metrics(ch, px));
            let (xmin, w) = m.map(|mm| (mm.xmin, mm.width)).unwrap_or((0, 0));
            out.push_str(&format!(
                "  {ch:?} idx={idx} adv={adv:.2} xmin={xmin} w={w} pen->{pen:.2}\n"
            ));
            pen += adv;
        }
        out.push_str(&format!("  total_w={pen:.2}\n"));
        out
    }

    pub fn family_is_mono(family: &str) -> bool {
        let lower = family.to_ascii_lowercase();
        lower.contains("mono")
            || lower.contains("courier")
            || lower.contains("consolas")
            || lower.contains("menlo")
            || lower.contains("jetbrains")
            || lower.contains("fira code")
            || lower.contains("source code")
            || lower.contains("ubuntu mono")
    }
}

/// Normalizes one CSS font-family entry for name comparison: trims
/// surrounding whitespace and the quotes CSS allows around a family name
/// (`"Poppins"` / `'Poppins'` / `Poppins` all mean the same family), then
/// lowercases. Used by `font_for_char_named` to match a requested family
/// against `family_names`, which is populated the same way (whatever string
/// the fonts plugin's `loadFont(path, family)` call was given).
fn normalize_family(s: &str) -> String {
    s.trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .to_ascii_lowercase()
}

/// Coverage gamma LUT. fontdue hands back linear coverage; blending it
/// straight (as sRGB alpha) renders text thinner/lighter than a browser,
/// which gamma-corrects its text AA (stem darkening). Boosting mid-coverage
/// with a gamma > 1 fattens strokes so light-on-dark UI text reads with the
/// same weight as a DPI-aware webview. Computed once.
fn coverage_lut() -> &'static [u8; 256] {
    static LUT: std::sync::OnceLock<[u8; 256]> = std::sync::OnceLock::new();
    LUT.get_or_init(|| {
        let mut t = [0u8; 256];
        // gamma 1.35 ≈ the perceptual boost DirectWrite/Chromium apply for
        // grayscale AA; strong enough to match "fullness", mild enough not
        // to bloat small glyphs.
        let inv_gamma = 1.0 / 1.35_f32;
        for (i, slot) in t.iter_mut().enumerate() {
            let x = i as f32 / 255.0;
            *slot = (x.powf(inv_gamma) * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        t
    })
}

/// Synthetic-italic shear, in fractional px of x-shift per px of glyph
/// height — this engine has no real italic font files loaded (only
/// upright Inter/Roboto weights), so `font-style: italic` gets the same
/// treatment browsers give a missing italic face: an oblique shear of
/// the upright glyph, same idea as the existing faux-bold double-draw.
/// ~11°, applied per SCANLINE (not sub-pixel), so it staircases visibly
/// at large sizes — acceptable at the UI text sizes this is meant for.
const ITALIC_SHEAR: f32 = 0.2;

#[inline]
fn blit_glyph(
    pixmap: &mut Pixmap,
    dx: i32,
    dy: i32,
    gw: usize,
    gh: usize,
    bitmap: &[u8],
    r: u8,
    g: u8,
    b: u8,
    a: u8,
    pw: i32,
    ph: i32,
    clip_top: i32,
    clip_bottom: i32,
    clip_left: f32,
    clip_right: f32,
    italic: bool,
) {
    if gw == 0 || gh == 0 {
        return;
    }
    let cl = clip_left.floor() as i32;
    let cr = clip_right.ceil() as i32;
    let pixels = pixmap.pixels_mut();
    let pw_us = pw as usize;
    for row in 0..gh {
        let py = dy + row as i32;
        if py < 0 || py >= ph {
            continue;
        }
        if py < clip_top || py >= clip_bottom {
            continue;
        }
        // Top of the glyph (row 0) shifts furthest right, the baseline
        // row stays put — the standard oblique slant direction.
        let row_shear = if italic {
            (ITALIC_SHEAR * (gh as f32 - 1.0 - row as f32)).round() as i32
        } else {
            0
        };
        for col in 0..gw {
            let px = dx + row_shear + col as i32;
            if px < 0 || px >= pw {
                continue;
            }
            if px < cl || px >= cr {
                continue;
            }
            let cov = coverage_lut()[bitmap[row * gw + col] as usize];
            if cov == 0 {
                continue;
            }
            let alpha = (cov as u32 * a as u32) / 255;
            if alpha == 0 {
                continue;
            }
            let idx = py as usize * pw_us + px as usize;
            let sr = (r as u32 * alpha) / 255;
            let sg = (g as u32 * alpha) / 255;
            let sb = (b as u32 * alpha) / 255;
            let sa = alpha;
            let dst = pixels[idx];
            let dr = dst.red() as u32;
            let dg = dst.green() as u32;
            let db = dst.blue() as u32;
            let da = dst.alpha() as u32;
            let inv = 255 - sa;
            let nr = sr + (dr * inv) / 255;
            let ng = sg + (dg * inv) / 255;
            let nb = sb + (db * inv) / 255;
            let na = sa + (da * inv) / 255;
            if let Some(p) = PremultipliedColorU8::from_rgba(nr as u8, ng as u8, nb as u8, na as u8)
            {
                pixels[idx] = p;
            }
        }
    }
}

#[cfg(test)]
mod blit_glyph_tests {
    use super::*;

    /// A 1px-wide, fully-opaque vertical line, `height` px tall — makes
    /// the per-row shear trivial to read back: whichever column is lit
    /// in a given row IS that row's shear offset.
    fn vertical_line_bitmap(height: usize) -> Vec<u8> {
        vec![255u8; height]
    }

    fn opaque_col_at(pixmap: &Pixmap, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x as u32 >= pixmap.width() || y as u32 >= pixmap.height() {
            return false;
        }
        pixmap.pixels()[y as usize * pixmap.width() as usize + x as usize].alpha() > 0
    }

    #[test]
    fn upright_glyphs_land_in_the_same_column_on_every_row() {
        let mut pm = Pixmap::new(20, 20).unwrap();
        let bmp = vertical_line_bitmap(6);
        blit_glyph(
            &mut pm, 5, 0, 1, 6, &bmp, 255, 255, 255, 255, 20, 20, 0, 20, 0.0, 20.0, false,
        );
        for row in 0..6 {
            assert!(
                opaque_col_at(&pm, 5, row),
                "row {row} should be lit at col 5"
            );
        }
    }

    #[test]
    fn italic_glyphs_shear_more_at_the_top_row_than_the_bottom() {
        let mut pm = Pixmap::new(20, 20).unwrap();
        let bmp = vertical_line_bitmap(11); // shear(row 0) = round(0.2*10) = 2
        blit_glyph(
            &mut pm, 5, 0, 1, 11, &bmp, 255, 255, 255, 255, 20, 20, 0, 20, 0.0, 20.0, true,
        );
        // Top row: shifted right by 2.
        assert!(opaque_col_at(&pm, 7, 0));
        assert!(!opaque_col_at(&pm, 5, 0));
        // Bottom (baseline) row: unshifted.
        assert!(opaque_col_at(&pm, 5, 10));
        assert!(!opaque_col_at(&pm, 7, 10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_family_strips_quotes_whitespace_and_case() {
        assert_eq!(normalize_family("\"Poppins\""), "poppins");
        assert_eq!(normalize_family(" 'Poppins' "), "poppins");
        assert_eq!(normalize_family("POPPINS"), "poppins");
        assert_eq!(normalize_family("  sans-serif "), "sans-serif");
    }

    // Real font bytes (the embedded Roboto backstop), not synthetic data —
    // used as a stand-in "custom" font distinct from Inter so the test can
    // tell the two apart by which one actually got selected.

    #[test]
    fn a_named_font_is_selected_over_the_default_stack_when_family_matches() {
        let mut te = TextEngine::new();
        assert!(te.load_font_bytes_named(
            fallback_font_bytes().to_vec(),
            Some("MyCustomFont".to_string()),
            None
        ));
        let named_idx = te.fonts.len() - 1;
        assert_eq!(te.family_names[named_idx].as_deref(), Some("MyCustomFont"));

        // CSS-shaped chain with quotes + a generic fallback — normalize_family
        // must see through both.
        te.cur_family = Some("\"MyCustomFont\", sans-serif".to_string());
        let (_, idx) = te
            .font_for_char('A', false, 400)
            .expect("should resolve a font");
        assert_eq!(
            idx as usize, named_idx,
            "expected the named font, not the default Inter face"
        );
    }

    #[test]
    fn no_cur_family_uses_the_ordinary_coverage_search() {
        let mut te = TextEngine::new();
        te.preload(); // embeds Inter/Roboto; Inter-Regular lands at index 0
        assert!(te.cur_family.is_none());
        let (_, idx) = te
            .font_for_char('A', false, 400)
            .expect("should resolve a font");
        assert_eq!(
            idx, 0,
            "no family requested — should use the primary (Inter-Regular)"
        );
    }

    #[test]
    fn an_unmatched_family_falls_back_to_the_default_search_instead_of_returning_nothing() {
        let mut te = TextEngine::new();
        te.preload();
        te.cur_family = Some("NoSuchFontAnywhere".to_string());
        let (_, idx) = te
            .font_for_char('A', false, 400)
            .expect("should still resolve via fallback");
        assert_eq!(
            idx, 0,
            "no matching family — should fall back to Inter-Regular, not None"
        );
    }

    #[test]
    fn among_multiple_weights_of_the_same_family_the_closest_weight_wins() {
        let mut te = TextEngine::new();
        assert!(te.load_font_bytes_named(
            fallback_font_bytes().to_vec(),
            Some("Multi".to_string()),
            Some(400)
        ));
        let regular_idx = te.fonts.len() - 1;
        assert!(te.load_font_bytes_named(
            inter_bold().to_vec(),
            Some("Multi".to_string()),
            Some(700)
        ));
        let bold_idx = te.fonts.len() - 1;

        te.cur_family = Some("Multi".to_string());
        let (_, idx) = te
            .font_for_char('A', false, 700)
            .expect("should resolve a font");
        assert_eq!(
            idx as usize, bold_idx,
            "weight 700 should pick the bold variant of the named family"
        );

        let (_, idx) = te
            .font_for_char('A', false, 400)
            .expect("should resolve a font");
        assert_eq!(
            idx as usize, regular_idx,
            "weight 400 should pick the regular variant of the named family"
        );
    }
}
