// Registering blitz's half of the scene-graph boundary.
//
// The same names mini registers, backed by a DOM instead of a scene graph.
// Both are checked against contracts/runtime by
// .tools/validation/check_host_boundary.py.

use super::*;

pub(crate) fn register_host_imports(ctx: &JsContext) -> Result<()> {
    ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        macro_rules! set_fn {
            ($name:literal, $f:expr) => {{
                let f = Function::new(ctx.clone(), $f).map_err(|e| anyhow!(concat!($name, ": {}"), e))?;
                g.set($name, f).map_err(|e| anyhow!(concat!("set ", $name, ": {}"), e))?;
            }};
        }

        set_fn!("__cm_create_node", move |id: i64, tag: String, _props: String| {
            cm_create_node(id, &tag);
        });
        set_fn!("__cm_set_text", move |id: i64, text: String| {
            cm_set_text(id, &text);
        });
        set_fn!("__cm_set_prop", move |id: i64, key: String, value_json: String| {
            cm_set_prop(id, &key, &value_json);
        });
        set_fn!("__cm_insert_node", move |parent: i64, child: i64, before: i64| {
            cm_insert_node(parent, child, before);
        });
        set_fn!("__cm_remove_node", move |id: i64| {
            cm_remove_node(id);
        });
        set_fn!("__cm_set_root", move |id: i64| {
            cm_set_root(id);
        });
        // Register an author stylesheet (the real-CSS path): create a <style>
        // node holding the CSS, then let stylo parse + cascade it. This is how
        // class-based apps (shadcn/Tailwind) get styled — the build pipeline
        // emits the app's real Tailwind CSS and calls this, and `className` on
        // nodes (routed to the `class` attribute) matches against it. No
        // class→style hardcoding.
        set_fn!("__cm_register_stylesheet", move |css: String| {
            register_css(&css);
        });
        // Paint is driven by the event loop after eval; JS just marks dirty.
        set_fn!("__cm_request_paint", move || {
            with_doc(|st| st.dirty = true);
        });
        // getBoundingClientRect / offsetWidth etc. — resolve layout (memoized by
        // blitz's damage tracking), then return the node's ABSOLUTE box by
        // summing final_layout.location up the parent chain. Measurement-driven
        // libraries (react-resizable-panels, Radix/Floating-UI) depend on this;
        // returning zeros collapses/mis-positions their panels.
        set_fn!("__cm_layout_box", move |id: i64| -> String {
            DOC.with(|d| {
                let mut b = d.borrow_mut();
                let Some(st) = b.as_mut() else { return "0,0,0,0".to_string() };
                let Some(&bid) = st.id_map.get(&id) else { return "0,0,0,0".to_string() };
                st.doc.resolve(0.0);
                let (w, h) = st
                    .doc
                    .get_node(bid)
                    .map(|n| (n.final_layout.size.width, n.final_layout.size.height))
                    .unwrap_or((0.0, 0.0));
                let (mut x, mut y) = (0.0f32, 0.0f32);
                let mut cur = Some(bid);
                while let Some(nid) = cur {
                    match st.doc.get_node(nid) {
                        Some(n) => {
                            x += n.final_layout.location.x;
                            y += n.final_layout.location.y;
                            cur = n.parent;
                        }
                        None => break,
                    }
                }
                format!("{x},{y},{w},{h}")
            })
        });

        // Extra host imports the real carbon bundle (carbon-dom-shim +
        // react-mini-runtime) calls at startup. Most are no-ops for now; the
        // window-size ones read the live viewport.
        set_fn!("__cm_reset_paint_props", move |_id: i64| {});
        set_fn!("__cm_load_system_font", move |_family: String| {});
        set_fn!("__cm_test", move || {});
        // GPU canvas (xterm terminal) — not wired in the Blitz engine yet;
        // stub returns 0 so canvas creation/draw ops no-op instead of crashing.
        set_fn!("__cm_canvas", move || -> i64 { 0 });
        set_fn!("__cm_set_scroll_y", move |_id: i64, _y: f64| {});
        // NOTE: __cm_window_inner_width/height/device_pixel_ratio and all the
        // __cm_window_* ops are provided by the reused native::window module
        // (register_all), which reads the size/scale slots we feed on resize.

        // console.* + timers over a host print / microtasks. Timers flatten to
        // microtasks — fine for a static first render; real timing lands in M4.
        //
        // `__cm_log(level, target, message)` is NOT registered here — it comes
        // from the shared `native::register_all` (carbon/host/native/log.rs),
        // called right after register_host_imports in main(). This console
        // shim must call the same 3-arg contract that registration provides
        // (matching carbon/runtime/bindings' own console wrapper) — a
        // 1-arg version registered here would just get silently overwritten
        // by the shared one, and every console.log call would then throw an
        // arity mismatch.
        ctx.eval::<(), _>(
            br##"
            globalThis.console = {
                log:   (...a) => __cm_log('info',  'app', a.map(String).join(' ')),
                info:  (...a) => __cm_log('info',  'app', a.map(String).join(' ')),
                warn:  (...a) => __cm_log('warn',  'app', a.map(String).join(' ')),
                error: (...a) => __cm_log('error', 'app', a.map(String).join(' ')),
                debug: () => {}, trace: () => {}, group: () => {}, groupEnd: () => {}, dir: () => {},
            };
            globalThis.queueMicrotask = globalThis.queueMicrotask || ((cb) => Promise.resolve().then(cb));
            // Deferred timers + rAF: callbacks are QUEUED, not run as immediate
            // microtasks. The Rust event loop flushes them once per frame via
            // __cm_run_timers / __cm_run_raf. Running them as microtasks (the old
            // way) let rAF/scheduler reschedule loops spin forever inside a
            // single drain - which hung terax's mount before it ever painted.
            globalThis.__cm_timers = new Map();
            globalThis.__cm_timer_seq = 0;
            globalThis.setTimeout = (cb, ms) => { const id = ++globalThis.__cm_timer_seq; globalThis.__cm_timers.set(id, { cb: cb, due: Date.now() + (+ms || 0) }); return id; };
            globalThis.clearTimeout = (id) => { globalThis.__cm_timers.delete(id); };
            globalThis.setInterval = (cb, ms) => { const id = ++globalThis.__cm_timer_seq; globalThis.__cm_timers.set(id, { cb: cb, due: Date.now() + (+ms || 0), interval: (+ms || 0) }); return id; };
            globalThis.clearInterval = (id) => { globalThis.__cm_timers.delete(id); };
            globalThis.__cm_run_timers = () => { const now = Date.now(); const due = []; globalThis.__cm_timers.forEach((t, id) => { if (t.due <= now) due.push(id); }); for (const id of due) { const t = globalThis.__cm_timers.get(id); if (!t) continue; if (t.interval !== undefined) { t.due = now + Math.max(1, t.interval); } else { globalThis.__cm_timers.delete(id); } try { t.cb(); } catch (e) { __cm_log('error', 'app', 'timer ' + e); } } };
            globalThis.__cm_raf_queue = [];
            globalThis.__cm_raf_seq = 0;
            globalThis.requestAnimationFrame = (cb) => { globalThis.__cm_raf_queue.push(cb); return ++globalThis.__cm_raf_seq; };
            globalThis.cancelAnimationFrame = () => {};
            globalThis.__cm_run_raf = () => { const q = globalThis.__cm_raf_queue; globalThis.__cm_raf_queue = []; const t = Date.now(); for (let i = 0; i < q.length; i++) { try { q[i](t); } catch (e) {} } };
            globalThis.__cm_has_pending = () => (globalThis.__cm_raf_queue.length > 0) || (globalThis.__cm_timers.size > 0);
            "##
            .as_slice(),
        )
        .map_err(|e| anyhow!("prelude eval: {e}"))?;
        Ok(())
    })
}

