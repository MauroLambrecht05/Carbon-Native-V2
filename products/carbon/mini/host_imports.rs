// The scene-graph host functions — the JS side of rendering.
//
// This is the larger half of the boundary contracts/runtime declares: 56 of the
// 139 `__cm_*` imports are registered here, and every one of them is called by
// the Solid and React renderers in interface/renderer.
//
// `install_carbon_event_dispatcher` sits with them because it is the same
// boundary in the other direction — it evaluates JavaScript that installs the
// dispatchers Rust later calls by name.
//
// Nothing checks these names but .tools/validation/check_host_boundary.py: they
// are string literals on one side and globals on the other, and both compilers
// are blind to the gap.

use super::*;

pub(crate) fn register_host_imports(
    js_ctx: &JsContext,
    scene: Arc<Mutex<Scene>>,
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
    text_engine: Rc<RefCell<text::TextEngine>>,
) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let global = ctx.globals();

        // console.log — emits to stderr when CARBON_MINI_TIMING=1, no-op otherwise.
        // Phase 1.5δ kept this routed through stderr so debug breadcrumbs can
        // surface during the GPU integration smoke test without changing the
        // public API. Apps that always-log via console.log still pay zero in
        // production runs. Accepts any rquickjs Value (number/object/etc.)
        // and best-effort stringifies it so we don't throw on `console.log(x, y)`.
        // Format one rquickjs value the way `console.log` would. Used
        // for every level (log/info/warn/error/debug) so output stays
        // consistent. Best-effort: complex objects render as
        // [object] — apps wanting full structured logging can call
        // JSON.stringify() themselves.
        fn fmt_log_args(args: &[rquickjs::Value<'_>]) -> String {
            let mut buf = String::new();
            for (i, a) in args.iter().enumerate() {
                if i > 0 { buf.push(' '); }
                if let Some(s) = a.as_string() {
                    if let Ok(s) = s.to_string() { buf.push_str(&s); continue; }
                }
                if let Some(n) = a.as_number() {
                    buf.push_str(&n.to_string()); continue;
                }
                if let Some(b) = a.as_bool() { buf.push_str(&b.to_string()); continue; }
                if a.is_null() { buf.push_str("null"); continue; }
                if a.is_undefined() { buf.push_str("undefined"); continue; }
                if let Some(obj) = a.as_object() {
                    // Error-shaped: print message + (truncated) stack.
                    let name: Option<String> = obj.get("name").ok();
                    let msg: Option<String> = obj.get("message").ok();
                    let stack: Option<String> = obj.get("stack").ok();
                    if msg.is_some() || stack.is_some() {
                        if let (Some(n), Some(m)) = (&name, &msg) {
                            buf.push_str(&format!("{n}: {m}"));
                        } else if let Some(m) = &msg {
                            buf.push_str(m);
                        }
                        if let Some(s) = &stack {
                            // Truncate stack to first ~5 frames so
                            // pages of stack don't drown out following
                            // log lines.
                            let truncated: String = s
                                .lines()
                                .take(6)
                                .collect::<Vec<_>>()
                                .join("\n");
                            buf.push('\n');
                            buf.push_str(&truncated);
                        }
                        continue;
                    }
                    // Plain object: ask JS to JSON.stringify it.
                    let ctx = obj.ctx();
                    // We have to be careful — stringify itself can throw on
                    // cycles. Fall back to "[object]" on failure.
                    let json_obj = ctx.globals().get::<_, rquickjs::Object>("JSON").ok();
                    if let Some(json) = json_obj {
                        let stringify: Option<rquickjs::Function> = json.get("stringify").ok();
                        if let Some(f) = stringify {
                            if let Ok(s) = f.call::<_, String>((obj.clone(),)) {
                                if !s.is_empty() {
                                    buf.push_str(&s);
                                    continue;
                                }
                            }
                        }
                    }
                }
                buf.push_str("[object]");
            }
            buf
        }
        // console.log / console.info are gated behind CARBON_MINI_DEBUG so the
        // default console stays clean (apps tend to log a lot). console.warn /
        // console.error always print — those are genuine issues worth seeing.
        let console_log = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            if std::env::var_os("CARBON_MINI_DEBUG").is_some() {
                eprintln!("[js] {}", fmt_log_args(&args.0));
            }
        })
            .map_err(|e| anyhow!("console.log: {e}"))?;
        let console_info = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            if std::env::var_os("CARBON_MINI_DEBUG").is_some() {
                eprintln!("[js info] {}", fmt_log_args(&args.0));
            }
        })
            .map_err(|e| anyhow!("console.info: {e}"))?;
        let console_warn = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            eprintln!("[js warn] {}", fmt_log_args(&args.0));
        })
            .map_err(|e| anyhow!("console.warn: {e}"))?;
        let console_error = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            eprintln!("[js error] {}", fmt_log_args(&args.0));
        })
            .map_err(|e| anyhow!("console.error: {e}"))?;
        let console_debug = Function::new(ctx.clone(), |args: rquickjs::function::Rest<rquickjs::Value>| -> () {
            if std::env::var_os("CARBON_MINI_DEBUG").is_some() {
                eprintln!("[js debug] {}", fmt_log_args(&args.0));
            }
        })
            .map_err(|e| anyhow!("console.debug: {e}"))?;
        let console = rquickjs::Object::new(ctx.clone()).map_err(|e| anyhow!("console: {e}"))?;
        console
            .set("log", console_log)
            .map_err(|e| anyhow!("console set: {e}"))?;
        console.set("info", console_info).map_err(|e| anyhow!("console.info set: {e}"))?;
        console.set("warn", console_warn).map_err(|e| anyhow!("console.warn set: {e}"))?;
        console.set("error", console_error).map_err(|e| anyhow!("console.error set: {e}"))?;
        console.set("debug", console_debug).map_err(|e| anyhow!("console.debug set: {e}"))?;
        // Stubs for non-essential methods that some libraries reach
        // for; avoids "console.X is not a function" crashes.
        let noop = Function::new(ctx.clone(), || () ).map_err(|e| anyhow!("noop: {e}"))?;
        for m in &["trace", "table", "dir", "group", "groupEnd", "groupCollapsed", "time", "timeEnd", "timeLog", "assert", "count", "countReset", "clear"] {
            let _ = console.set(*m, noop.clone());
        }
        global
            .set("console", console)
            .map_err(|e| anyhow!("set console: {e}"))?;

        // __cm_create_node(id, tag, propsJson)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64, tag: String, props_json: String| -> Result<(), rquickjs::Error> {
                    let props: PaintProps = serde_json::from_str(&props_json).unwrap_or_default();
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.create_node(id as u32, &tag, props);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("create_node: {e}"))?;
            global
                .set("__cm_create_node", f)
                .map_err(|e| anyhow!("set __cm_create_node: {e}"))?;
        }

        // __cm_set_text(id, text)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64, text: String| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.set_text(id as u32, text);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_text: {e}"))?;
            global
                .set("__cm_set_text", f)
                .map_err(|e| anyhow!("set __cm_set_text: {e}"))?;
        }

        // __cm_set_prop(id, key, valueJson)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64,
                      key: String,
                      value_json: String|
                      -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.set_prop(id as u32, &key, &value_json);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_prop: {e}"))?;
            global
                .set("__cm_set_prop", f)
                .map_err(|e| anyhow!("set __cm_set_prop: {e}"))?;
        }

        // __cm_reset_paint_props(id) — drop every paint-related prop on
        // a node back to defaults so the next set_prop pass sees a
        // clean slate. The reconciler calls this in commitUpdate before
        // re-applying className-resolved styles, fixing the bug where
        // state-variant styles (e.g. `data-active:bg-X`) from a stale
        // state would linger when the state transitioned away.
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.reset_paint_props(id as u32);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("reset_paint_props: {e}"))?;
            global
                .set("__cm_reset_paint_props", f)
                .map_err(|e| anyhow!("set __cm_reset_paint_props: {e}"))?;
        }

        // __cm_insert_node(parentId, childId, beforeId)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |parent: i64, child: i64, before: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let before_opt = if before < 0 { None } else { Some(before as u32) };
                    s.insert_node(parent as u32, child as u32, before_opt);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("insert_node: {e}"))?;
            global
                .set("__cm_insert_node", f)
                .map_err(|e| anyhow!("set __cm_insert_node: {e}"))?;
        }

        // __cm_remove_node(id)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.remove_node(id as u32);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("remove_node: {e}"))?;
            global
                .set("__cm_remove_node", f)
                .map_err(|e| anyhow!("set __cm_remove_node: {e}"))?;
        }

        // __cm_set_root(id)
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.set_root(id as u32);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_root: {e}"))?;
            global
                .set("__cm_set_root", f)
                .map_err(|e| anyhow!("set __cm_set_root: {e}"))?;
        }

        // __cm_request_paint()
        {
            let proxy = proxy.clone();
            let f = Function::new(ctx.clone(), move || -> Result<(), rquickjs::Error> {
                let _ = proxy.send_event(UserEvent::RequestPaint);
                Ok(())
            })
            .map_err(|e| anyhow!("request_paint: {e}"))?;
            global
                .set("__cm_request_paint", f)
                .map_err(|e| anyhow!("set __cm_request_paint: {e}"))?;
        }

        // __cm_apply_ops(opsJson) — BATCHED scene mutations. The react-mini
        // adapter buffers every create/setText/setProp/insert/remove/setRoot
        // during a single reconciler commit and flushes them here in ONE call:
        // one FFI crossing, one JSON parse, one scene lock — instead of the
        // thousands of per-op round-trips a full IDE mount would otherwise do
        // (each per-op call paid FFI marshaling + a serde_json parse + a lock).
        // The per-op host fns above remain as the non-batched fallback.
        //
        // Op format: JSON array of [opcode, ...args]:
        //   0 create   [id, tag, propsJson]
        //   1 setText  [id, text]
        //   2 setProp  [id, key, valueJson]
        //   3 insert   [parent, child, before(-1 = append)]
        //   4 remove   [id]
        //   5 setRoot  [id]
        //   6 resetProps [id]
        {
            let scene = scene.clone();
            let f = Function::new(
                ctx.clone(),
                move |ops_json: String| -> Result<(), rquickjs::Error> {
                    let ops: Vec<Vec<serde_json::Value>> =
                        match serde_json::from_str(&ops_json) {
                            Ok(v) => v,
                            Err(_) => return Ok(()),
                        };
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let num = |op: &Vec<serde_json::Value>, i: usize| -> i64 {
                        op.get(i).and_then(|v| v.as_i64()).unwrap_or(0)
                    };
                    let strv = |op: &Vec<serde_json::Value>, i: usize| -> String {
                        op.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string()
                    };
                    for op in &ops {
                        match op.first().and_then(|v| v.as_i64()).unwrap_or(-1) {
                            0 => {
                                let id = num(op, 1) as u32;
                                let tag = strv(op, 2);
                                let tag = if tag.is_empty() { "view".to_string() } else { tag };
                                let props: PaintProps =
                                    serde_json::from_str(&strv(op, 3)).unwrap_or_default();
                                s.create_node(id, &tag, props);
                            }
                            1 => s.set_text(num(op, 1) as u32, strv(op, 2)),
                            2 => {
                                let id = num(op, 1) as u32;
                                let key = strv(op, 2);
                                let val = strv(op, 3);
                                s.set_prop(id, &key, &val);
                            }
                            3 => {
                                let before = num(op, 3);
                                let before_opt = if before < 0 { None } else { Some(before as u32) };
                                s.insert_node(num(op, 1) as u32, num(op, 2) as u32, before_opt);
                            }
                            4 => s.remove_node(num(op, 1) as u32),
                            5 => s.set_root(num(op, 1) as u32),
                            6 => s.reset_paint_props(num(op, 1) as u32),
                            _ => {}
                        }
                    }
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("apply_ops: {e}"))?;
            global
                .set("__cm_apply_ops", f)
                .map_err(|e| anyhow!("set __cm_apply_ops: {e}"))?;
        }

        // __cm_set_scroll_y(id, y) — programmatic scroll. Sets the
        // node's vertical scroll offset (clamped to its valid range)
        // and requests a paint. Used by the terminal pane to snap the
        // viewport to the bottom whenever new output arrives, so the
        // user sees the live tail without having to scroll manually
        // — and mouse-wheel-up still works to read scrollback because
        // the renderer's wheel handler writes to the same `scroll_y`.
        //
        // Pass `Number.POSITIVE_INFINITY` (or any huge number) to
        // scroll to the bottom; the setter clamps to
        // (content_height - viewport_height).
        //
        // IMPORTANT: triggers a synchronous compute_layout FIRST so the
        // clamp uses the up-to-date content height. Callers that just
        // mutated text via __cm_set_text expect the new content height
        // to be reflected — without this layout pass, the clamp uses
        // the stale "max scroll" from the previous frame and the snap
        // doesn't reach the new bottom.
        {
            let scene = scene.clone();
            let text_engine = text_engine.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |id: i64, y: f64| -> Result<(), rquickjs::Error> {
                    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                    let (w, h) = HOST_WINDOW_SIZE
                        .lock()
                        .map(|m| *m)
                        .unwrap_or((1280.0, 800.0));
                    s.compute_layout(w, h, &mut text_engine.borrow_mut());
                    let _ = s.set_scroll_y(id as u32, y as f32);
                    s.repaint_dirty = true;
                    let _ = proxy.send_event(UserEvent::RequestPaint);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("set_scroll_y: {e}"))?;
            global
                .set("__cm_set_scroll_y", f)
                .map_err(|e| anyhow!("set __cm_set_scroll_y: {e}"))?;
        }

        // __cm_load_font(path) → boolean (true on success).
        // Registers a font into the text engine's fallback stack. The
        // newly-loaded font is preferred over already-loaded ones for
        // any glyph it provides; the embedded Roboto-Latin subset stays
        // as the final backstop. After loading, invalidates the per-
        // node cached layouts (Taffy needs to re-measure) and triggers
        // a repaint.
        //
        // Pair this with __cm_load_font_bytes(name, base64) for app-bundled
        // fonts that don't live at a fs-resolvable path.
        {
            let text_engine = text_engine.clone();
            let scene = scene.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |path: String| -> Result<bool, rquickjs::Error> {
                    let mut te = text_engine.borrow_mut();
                    let ok = te.load_font_path(std::path::Path::new(&path));
                    if ok {
                        // Font change invalidates every previously
                        // computed glyph cache key implicitly (new fonts
                        // get new font_idx) but the LAYOUT cached on
                        // each node measured glyph widths assuming the
                        // old stack — so mark the scene dirty so the
                        // next paint runs a fresh compute_layout.
                        scene.lock().unwrap_or_else(|e| e.into_inner()).dirty = true; scene.lock().unwrap_or_else(|e| e.into_inner()).layout_valid = false;
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                    Ok(ok)
                },
            )
            .map_err(|e| anyhow!("load_font: {e}"))?;
            global
                .set("__cm_load_font", f)
                .map_err(|e| anyhow!("set __cm_load_font: {e}"))?;
        }

        // __cm_load_font_bytes(base64_bytes) → boolean.
        // Same as __cm_load_font but accepts raw base64-encoded TTF/OTF
        // bytes. Use when the font is bundled as an asset and you don't
        // want to write it to disk first.
        {
            let text_engine = text_engine.clone();
            let scene = scene.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |b64: String| -> Result<bool, rquickjs::Error> {
                    use base64::engine::Engine as _;
                    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
                        Ok(b) => b,
                        Err(_) => return Ok(false),
                    };
                    let mut te = text_engine.borrow_mut();
                    let ok = te.load_font_bytes(bytes);
                    if ok {
                        scene.lock().unwrap_or_else(|e| e.into_inner()).dirty = true; scene.lock().unwrap_or_else(|e| e.into_inner()).layout_valid = false;
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                    Ok(ok)
                },
            )
            .map_err(|e| anyhow!("load_font_bytes: {e}"))?;
            global
                .set("__cm_load_font_bytes", f)
                .map_err(|e| anyhow!("set __cm_load_font_bytes: {e}"))?;
        }

        // __cm_load_system_font(familyChain, preferMono) → matched path | "".
        // Resolves a CSS font-family chain (e.g. the one xterm/terminals set,
        // `"JetBrainsMono Nerd Font","Hack Nerd Font Mono",monospace`) against
        // the OS font directories and loads the first match into fontdue. This
        // is how unmodified apps that ask for a system/Nerd font get the right
        // glyphs (icons, box-drawing, proper monospace) — without bundling the
        // font. Results are cached per chain so repeated font-set calls are
        // cheap.
        {
            let text_engine = text_engine.clone();
            let scene = scene.clone();
            let proxy = proxy.clone();
            let f = Function::new(
                ctx.clone(),
                move |chain: String, prefer_mono: bool| -> String {
                    thread_local! {
                        // chains already processed (don't re-scan)
                        static LOADED_CHAINS: std::cell::RefCell<std::collections::HashSet<String>> =
                            std::cell::RefCell::new(std::collections::HashSet::new());
                        // font FILES already loaded into the stack (dedup)
                        static LOADED_PATHS: std::cell::RefCell<std::collections::HashSet<String>> =
                            std::cell::RefCell::new(std::collections::HashSet::new());
                        // whether the broad-coverage fallback (braille / box-
                        // drawing) has been loaded yet
                        static COVERAGE_LOADED: std::cell::RefCell<bool> =
                            std::cell::RefCell::new(false);
                    }
                    fn norm(s: &str) -> String {
                        s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
                    }
                    fn find_best(fam: &str, prefer_mono: bool, dirs: &[String]) -> Option<std::path::PathBuf> {
                        let mut best: Option<(i32, std::path::PathBuf)> = None;
                        for dir in dirs {
                            let Ok(rd) = std::fs::read_dir(dir) else { continue };
                            for ent in rd.flatten() {
                                let path = ent.path();
                                let ext_ok = path.extension().and_then(|e| e.to_str())
                                    .map(|e| { let e = e.to_ascii_lowercase(); e == "ttf" || e == "otf" })
                                    .unwrap_or(false);
                                if !ext_ok { continue; }
                                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                                let fname = norm(stem);
                                if !fname.contains(fam) { continue; }
                                let mut score = 0i32;
                                if fname == fam { score += 100; }
                                if fname.starts_with(fam) { score += 30; }
                                if fname.contains("regular") { score += 20; }
                                if prefer_mono && fname.contains("mono") { score += 25; }
                                if fname.contains("bold") || fname.contains("italic")
                                    || fname.contains("oblique") || fname.contains("light")
                                    || fname.contains("thin") || fname.contains("extra")
                                    || fname.contains("semi") || fname.contains("medium")
                                { score -= 30; }
                                if fname.contains("wght") { score -= 8; }
                                let take = match &best { Some((bs, _)) => score > *bs, None => true };
                                if take { best = Some((score, path.clone())); }
                            }
                        }
                        best.map(|(_, p)| p)
                    }
                    if LOADED_CHAINS.with(|l| l.borrow().contains(&chain)) {
                        return String::new();
                    }
                    LOADED_CHAINS.with(|l| l.borrow_mut().insert(chain.clone()));

                    let mut dirs: Vec<String> = Vec::new();
                    if let Ok(la) = std::env::var("LOCALAPPDATA") {
                        dirs.push(format!("{}\\Microsoft\\Windows\\Fonts", la));
                    }
                    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
                    dirs.push(format!("{}\\Fonts", sysroot));

                    // Try to load a font file once (dedup by path).
                    let load_once = |path: &std::path::Path| -> bool {
                        let key = path.to_string_lossy().to_string();
                        if LOADED_PATHS.with(|l| l.borrow().contains(&key)) {
                            return false;
                        }
                        let ok = text_engine.borrow_mut().load_font_path(path);
                        if ok { LOADED_PATHS.with(|l| l.borrow_mut().insert(key)); }
                        ok
                    };

                    let mut first_path = String::new();
                    let mut loaded = 0usize;
                    // Load EVERY family in the chain that resolves to a file —
                    // a real font-fallback stack, not just the first match. The
                    // first load is the primary; later ones cover glyphs the
                    // primary lacks (e.g. one font has Nerd icons, another has
                    // braille). Cap to keep the stack small.
                    for fam_raw in chain.split(',') {
                        if loaded >= 4 { break; }
                        let trimmed = fam_raw.trim().trim_matches('"').trim_matches('\'');
                        let fam = norm(trimmed);
                        if fam.is_empty()
                            || fam == "monospace" || fam == "serif" || fam == "sansserif"
                            || fam == "system" || fam == "systemui" || fam == "ui" || fam == "inherit"
                        {
                            continue;
                        }
                        if let Some(path) = find_best(&fam, prefer_mono, &dirs) {
                            if load_once(&path) {
                                if first_path.is_empty() { first_path = path.to_string_lossy().to_string(); }
                                loaded += 1;
                            }
                        }
                    }

                    // Broad-coverage fallback (once): the chains apps request
                    // rarely include a font with Braille Patterns / box-drawing,
                    // yet terminals (winfetch/neofetch logos, TUIs) use them
                    // heavily. Cascadia Code / Consolas / DejaVu Sans Mono ship
                    // those blocks; load the first available as the last resort
                    // so missing glyphs fall back to real shapes instead of
                    // .notdef boxes.
                    if !COVERAGE_LOADED.with(|c| *c.borrow()) {
                        for cov in ["cascadiacode", "cascadiamono", "dejavusansmono", "consola"] {
                            if let Some(path) = find_best(cov, true, &dirs) {
                                if load_once(&path) {
                                    COVERAGE_LOADED.with(|c| *c.borrow_mut() = true);
                                    break;
                                }
                            }
                        }
                    }

                    if loaded > 0 {
                        if let Ok(mut s) = scene.lock() { s.dirty = true; s.layout_valid = false; }
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                    first_path
                },
            )
            .map_err(|e| anyhow!("load_system_font: {e}"))?;
            global
                .set("__cm_load_system_font", f)
                .map_err(|e| anyhow!("set __cm_load_system_font: {e}"))?;
        }

        // __cm_layout_box(id) → "x,y,w,h" (or empty if unknown).
        // Triggers a synchronous layout pass against the last known
        // window dimensions, then reads the node's absolute box from
        // taffy. DOM-shim's CarbonElement.getBoundingClientRect /
        // .offsetWidth / .clientHeight all route here so libraries
        // like react-resizable-panels (which measure their container
        // every render) get real values instead of zeros.
        //
        // Stringified return so we don't pay a JS-object alloc per
        // call; the shim parses the four-number string back.
        {
            let scene = scene.clone();
            let text_engine = text_engine.clone();
            let f = Function::new(ctx.clone(), move |id: u32| -> String {
                let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                // Use last known window size — host_app keeps it in sync
                // on every WindowEvent::Resized. Fall back to a sane
                // default so callers querying before the first paint
                // still get nonzero numbers.
                let (w, h) = HOST_WINDOW_SIZE
                    .lock()
                    .map(|m| *m)
                    .unwrap_or((1280.0, 800.0));
                s.compute_layout(w, h, &mut text_engine.borrow_mut());
                match s.absolute_box(id) {
                    Some((x, y, w, h)) => format!("{},{},{},{}", x, y, w, h),
                    None => String::new(),
                }
            })
            .map_err(|e| anyhow!("layout_box: {e}"))?;
            global
                .set("__cm_layout_box", f)
                .map_err(|e| anyhow!("set __cm_layout_box: {e}"))?;
        }

        // __cm_dump_tree() — DEBUG: print every node's id, tag, computed
        // box, parent, and a few key style props to stderr. Used during
        // bring-up to see why some elements render blank.
        {
            let scene = scene.clone();
            let text_engine = text_engine.clone();
            let f = Function::new(ctx.clone(), move || -> String {
                let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
                let (w, h) = HOST_WINDOW_SIZE
                    .lock()
                    .map(|m| *m)
                    .unwrap_or((1280.0, 800.0));
                s.compute_layout(w, h, &mut text_engine.borrow_mut());
                let mut out = String::new();
                fn walk(s: &crate::scene::Scene, id: u32, depth: usize, out: &mut String) {
                    let Some(n) = s.nodes.get(&id) else { return; };
                    let box_str = n.computed_layout
                        .map(|l| format!("box=({:.0},{:.0}) {:.0}x{:.0}", l.location.x, l.location.y, l.size.width, l.size.height))
                        .unwrap_or_else(|| "box=NONE".to_string());
                    let bg = n.props.background.map(|c| format!(" bg=#{:08x}", c)).unwrap_or_default();
                    let drag = if n.props.drag_region { " drag-region=true".to_string() } else { String::new() };
                    let h_prop = String::new();
                    let w_prop = String::new();
                    let text = n.props.text.as_ref().map(|t| format!(" text={:?}", t.chars().take(40).collect::<String>())).unwrap_or_default();
                    // TEMP DEBUG: surface font props on text nodes so we can
                    // diagnose the intra-word gap (mono-cell-centering) issue.
                    let fontdbg = if n.props.text.is_some() {
                        let fam = n.props.font_family.as_deref().unwrap_or("(none)");
                        let mono = n.props.font_family.as_deref()
                            .map(crate::text::TextEngine::family_is_mono).unwrap_or(false);
                        format!(" font_family={:?} mono={} font_size={:?} ls={:?}",
                            fam, mono, n.props.font_size, n.props.letter_spacing)
                    } else { String::new() };
                    out.push_str(&format!("{}id={} tag={} {}{}{}{}{}{}{}\n", " ".repeat(depth*2), id, n.tag, box_str, bg, text, fontdbg, drag, h_prop, w_prop));
                    for &c in &n.children {
                        walk(s, c, depth + 1, out);
                    }
                }
                walk(&s, s.root, 0, &mut out);
                out
            })
            .map_err(|e| anyhow!("dump_tree: {e}"))?;
            global
                .set("__cm_dump_tree", f)
                .map_err(|e| anyhow!("set __cm_dump_tree: {e}"))?;
        }

        // TEMP DEBUG: __cm_text_probe(text [, size]) — per-glyph metrics.
        {
            let text_engine = text_engine.clone();
            let f = Function::new(ctx.clone(), move |text: String, size: rquickjs::function::Opt<f32>| -> String {
                let px = size.0.unwrap_or(13.0);
                text_engine.borrow_mut().debug_probe(&text, px)
            })
            .map_err(|e| anyhow!("text_probe: {e}"))?;
            global
                .set("__cm_text_probe", f)
                .map_err(|e| anyhow!("set __cm_text_probe: {e}"))?;
        }

        // ─── Native CanvasRenderingContext2D (CPU, tiny-skia) ────────────────────
        // Backs <canvas>.getContext('2d') / OffscreenCanvas for unmodified npm
        // packages. See canvas2d.rs. Surfaces are keyed by the canvas element's
        // scene-node id.
        {
            // __cm_canvas2d_create(id, w, h)
            let f = Function::new(ctx.clone(), move |id: i64, w: i64, h: i64| {
                crate::canvas2d::create(id as u32, w.max(1) as u32, h.max(1) as u32);
            })
            .map_err(|e| anyhow!("c2d_create: {e}"))?;
            global.set("__cm_canvas2d_create", f).map_err(|e| anyhow!("set c2d_create: {e}"))?;

            // __cm_canvas2d_resize(id, w, h)
            let f = Function::new(ctx.clone(), move |id: i64, w: i64, h: i64| {
                crate::canvas2d::resize(id as u32, w.max(1) as u32, h.max(1) as u32);
            })
            .map_err(|e| anyhow!("c2d_resize: {e}"))?;
            global.set("__cm_canvas2d_resize", f).map_err(|e| anyhow!("set c2d_resize: {e}"))?;

            // __cm_canvas2d_destroy(id)
            let f = Function::new(ctx.clone(), move |id: i64| {
                crate::canvas2d::destroy(id as u32);
            })
            .map_err(|e| anyhow!("c2d_destroy: {e}"))?;
            global.set("__cm_canvas2d_destroy", f).map_err(|e| anyhow!("set c2d_destroy: {e}"))?;

            // __cm_canvas2d_flush(id, commandsJson)
            {
                let proxy = proxy.clone();
                let text_engine = text_engine.clone();
                let f = Function::new(ctx.clone(), move |id: i64, json: String| {
                    crate::canvas2d::flush(id as u32, &json, &mut text_engine.borrow_mut());
                    let _ = proxy.send_event(UserEvent::RequestPaint);
                })
                .map_err(|e| anyhow!("c2d_flush: {e}"))?;
                global.set("__cm_canvas2d_flush", f).map_err(|e| anyhow!("set c2d_flush: {e}"))?;
            }

            // __cm_canvas2d_measure_text(text, px, mono) -> width
            {
                let text_engine = text_engine.clone();
                let f = Function::new(ctx.clone(), move |text: String, px: f64, mono: bool| -> f64 {
                    crate::canvas2d::measure_text(&mut text_engine.borrow_mut(), &text, px as f32, mono) as f64
                })
                .map_err(|e| anyhow!("c2d_measure: {e}"))?;
                global.set("__cm_canvas2d_measure_text", f).map_err(|e| anyhow!("set c2d_measure: {e}"))?;
            }

            // __cm_canvas2d_get_pixels(id, x, y, w, h) -> base64(RGBA)
            let f = Function::new(ctx.clone(), move |id: i64, x: i64, y: i64, w: i64, h: i64| -> String {
                use base64::Engine;
                let px = crate::canvas2d::get_pixels(id as u32, x as i32, y as i32, w.max(0) as u32, h.max(0) as u32);
                base64::engine::general_purpose::STANDARD.encode(&px)
            })
            .map_err(|e| anyhow!("c2d_get_pixels: {e}"))?;
            global.set("__cm_canvas2d_get_pixels", f).map_err(|e| anyhow!("set c2d_get_pixels: {e}"))?;

            // __cm_canvas2d_put_pixels(id, base64, srcW, srcH, dx, dy, dirtyJson)
            // dirtyJson = "dirtyX,dirtyY,dirtyW,dirtyH" (the putImageData dirty
            // rect; packed as one string to keep the arg count modest).
            {
                let proxy = proxy.clone();
                let f = Function::new(ctx.clone(), move |id: i64, b64: String, sw: i64, sh: i64, dx: i64, dy: i64, dirty: String| {
                    use base64::Engine;
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
                        let mut d = dirty.split(',').map(|s| s.trim().parse::<i32>().unwrap_or(0));
                        let dirty_x = d.next().unwrap_or(0);
                        let dirty_y = d.next().unwrap_or(0);
                        let dirty_w = d.next().unwrap_or(sw as i32);
                        let dirty_h = d.next().unwrap_or(sh as i32);
                        crate::canvas2d::put_pixels(
                            id as u32, &bytes, sw.max(0) as u32, sh.max(0) as u32, dx as i32, dy as i32,
                            dirty_x, dirty_y, dirty_w, dirty_h,
                        );
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                    }
                })
                .map_err(|e| anyhow!("c2d_put_pixels: {e}"))?;
                global.set("__cm_canvas2d_put_pixels", f).map_err(|e| anyhow!("set c2d_put_pixels: {e}"))?;
            }
        }

        // ─── GPU canvas host imports (Phase 1 — OPTIONAL via 'gpu' feature) ───────
        // Phase 1A disables GPU feature to eliminate 2.5 MB wgpu dependency.
        // Phase 2: migrates to carbon-canvas plugin with dynamic loading.
        #[cfg(feature = "gpu")]
        {
            // Lazy: the GPU device is only created on the FIRST __carbon_canvas_create
            // call. UI-only apps that never instantiate a <canvas> never trigger
            // wgpu init, so cold-start is unchanged. See gpu.rs.

            // __carbon_canvas_create(width, height) -> id
            {
                let f = Function::new(
                    ctx.clone(),
                    move |w: i64, h: i64| -> Result<i64, rquickjs::Error> {
                        match gpu::create_surface(w.max(1) as u32, h.max(1) as u32) {
                            Ok(id) => Ok(id as i64),
                            Err(e) => {
                                eprintln!("[carbon-mini] canvas create failed: {e:#}");
                                Ok(0) // 0 = invalid id; JS-side checks for this
                            }
                        }
                    },
                )
                .map_err(|e| anyhow!("canvas_create: {e}"))?;
                global
                    .set("__carbon_canvas_create", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_create: {e}"))?;
            }

            // __carbon_canvas_resize(id, width, height)
            {
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64, w: i64, h: i64| -> Result<(), rquickjs::Error> {
                        let _ = gpu::resize_surface(id as u32, w.max(1) as u32, h.max(1) as u32);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_resize: {e}"))?;
                global
                    .set("__carbon_canvas_resize", f)
                    .map_err(|e| anyhow!("set __canvas_resize: {e}"))?;
            }

            // __carbon_canvas_clear(id, r, g, b, a)
            {
                let proxy = proxy.clone();
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64, r: f64, g: f64, b: f64, a: f64| -> Result<(), rquickjs::Error> {
                        let _ = gpu::clear_surface(id as u32, r as f32, g as f32, b as f32, a as f32);
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_clear: {e}"))?;
                global
                    .set("__carbon_canvas_clear", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_clear: {e}"))?;
            }

            // __carbon_canvas_destroy(id)
            {
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64| -> Result<(), rquickjs::Error> {
                        gpu::destroy_surface(id as u32);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_destroy: {e}"))?;
                global
                    .set("__carbon_canvas_destroy", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_destroy: {e}"))?;
            }

            // __carbon_canvas_execute_commands(id, jsonString) — Phase 1.5δ entry
            // point. Parses the command list and runs it against the surface's
            // executor (lazy-init on first call). Errors are logged in Rust;
            // we return silently so a malformed command never crashes JS.
            {
                let proxy = proxy.clone();
                let f = Function::new(
                    ctx.clone(),
                    move |id: i64, json: String| -> Result<(), rquickjs::Error> {
                        gpu::execute_commands_json(id as u32, &json);
                        let _ = proxy.send_event(UserEvent::RequestPaint);
                        Ok(())
                    },
                )
                .map_err(|e| anyhow!("canvas_execute_commands: {e}"))?;
                global
                    .set("__carbon_canvas_execute_commands", f)
                    .map_err(|e| anyhow!("set __carbon_canvas_execute_commands: {e}"))?;
            }
        }

        // ─── requestAnimationFrame / cancelAnimationFrame ────────────────
        //
        // We don't have a DOM. The model: each rAF call appends the JS
        // callback to a queue and posts a RequestPaint user event. On the
        // next Event::RedrawRequested, the event-loop drains the queue,
        // invokes each callback with the current timestamp, then performs
        // the paint. cancelAnimationFrame walks the queue and removes by
        // handle.
        //
        // The queue is stored on the JS side as a Map<handle, Function> on
        // globalThis (because rquickjs Function values can't be moved
        // through Rust-side state easily). Rust orchestrates by calling
        // `__cm_drain_raf` from the redraw handler.
        {
            // Initialize the JS-side support: a Map of pending rAF
            // callbacks, a counter for handles, and a drain helper that
            // the redraw path invokes once per frame.
            ctx.eval::<(), _>(
                br#"
                (function(){
                  if (globalThis.__cm_raf_queue) return;
                  const queue = new Map();
                  let nextHandle = 1;
                  globalThis.requestAnimationFrame = function(cb) {
                    if (typeof cb !== 'function') return 0;
                    const h = nextHandle++;
                    queue.set(h, cb);
                    if (typeof __cm_request_paint === 'function') __cm_request_paint();
                    return h;
                  };
                  globalThis.cancelAnimationFrame = function(h) {
                    queue.delete(h);
                  };
                  globalThis.__cm_raf_queue = queue;
                  globalThis.__cm_drain_raf = function(now) {
                    if (queue.size === 0) return false;
                    // Snapshot + clear so callbacks scheduling new rAFs don't recurse.
                    const cbs = Array.from(queue.values());
                    queue.clear();
                    for (let i = 0; i < cbs.length; i++) {
                      try { cbs[i](now); } catch (e) {}
                    }
                    return true;
                  };
                })();
                "#.as_slice(),
            )
            .ok();
        }

        // ─── Phase 3: register fast-math classes (lazy, opt-in) ──────────
        // Bundles call `globalThis.__cm_register_math()` during init to
        // install Vector3/Matrix4/Quaternion/Box3/Frustum/Color globals.
        // The carbon-fast-import Vite plugin emits this call automatically
        // when it detects rewritten three.js imports. UI-only apps don't
        // need to call it — keeping the prototype allocations off the
        // cold path entirely.
        {
            let f = Function::new(
                ctx.clone(),
                move |ctx: rquickjs::Ctx<'_>| -> Result<(), rquickjs::Error> {
                    carbon_fast_math::register_math(&ctx)
                        .map_err(|_| rquickjs::Error::Exception)
                },
            )
            .map_err(|e| anyhow!("register_math: {e}"))?;
            global
                .set("__cm_register_math", f)
                .map_err(|e| anyhow!("set __cm_register_math: {e}"))?;
        }

        Ok(())
    })?;
    Ok(())
}

// ─── Plugin loader plumbing ────────────────────────────────────────────────

/// Install the JS-side `__carbon_on_event` dispatcher and the `carbon.on`
/// subscription API. Plugins push events from worker threads via
/// `app->push_event(name, payload)`; our event-loop handler forwards them
/// here as `__carbon_on_event(name, payloadJson)` calls.
pub(crate) fn install_carbon_event_dispatcher(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        ctx.eval::<(), _>(
            br#"
            (function(){
              if (globalThis.__carbon_on_event) return;
              const handlers = new Map(); // name -> Set<fn>
              globalThis.carbon = globalThis.carbon || {};
              globalThis.carbon.on = function(name, fn) {
                if (typeof name !== 'string' || typeof fn !== 'function') {
                  throw new TypeError('carbon.on(name, fn): name must be string, fn must be function');
                }
                let set = handlers.get(name);
                if (!set) { set = new Set(); handlers.set(name, set); }
                set.add(fn);
                return function unsubscribe() { handlers.get(name)?.delete(fn); };
              };
              globalThis.__carbon_on_event = function(name, payloadJson) {
                const set = handlers.get(name);
                if (!set || set.size === 0) return;
                let payload = null;
                try { payload = (payloadJson === '' || payloadJson == null) ? null : JSON.parse(payloadJson); }
                catch (e) { /* keep payload null */ }
                // Snapshot to allow handlers to unsubscribe during dispatch.
                for (const h of Array.from(set)) {
                  try { h(payload, name); } catch (e) {
                    if (typeof console !== 'undefined' && console.error) console.error(e);
                  }
                }
              };
            })();
            "#.as_slice(),
        ).map_err(|e| anyhow!("install __carbon_on_event: {e}"))?;
        Ok(())
    })?;
    Ok(())
}

