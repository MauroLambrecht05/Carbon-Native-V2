//! carbon-blitz — M2: the JS → blitz-dom → vello pipeline.
//!
//! This is the real engine skeleton (M1's `launch_static_html` throwaway is
//! gone). It stands up:
//!   - a tao window + event loop (same windowing as carbon-mini, so mini's
//!     tao-coupled `native/*` layer can be reused in M3),
//!   - a `blitz_dom::BaseDocument` (stylo cascade + taffy layout + parley text),
//!   - a `VelloWindowRenderer` painting that document onto the tao surface,
//!   - a QuickJS runtime whose `__cm_*` host imports drive the document through
//!     a `DocumentMutator` (the same host-import contract carbon-dom-shim calls).
//!
//! M2 proves the pipeline with a small inline JS harness that builds a styled
//! card via `__cm_create_node` / `__cm_set_prop` (inline styles). M3 swaps the
//! harness for a real carbon bundle (carbon-dom-shim + react-mini-runtime),
//! adds `class` + registered Tailwind CSS (so stylo cascades it), and pulls in
//! mini's `native/*` OS layer.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use anyrender::WindowRenderer;
use anyrender_vello::VelloWindowRenderer;
use blitz_dom::{ns, Attribute, BaseDocument, DocumentConfig, LocalName, QualName, DEFAULT_CSS};
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use rquickjs::{Context as JsContext, Function, Runtime as JsRuntime};
use tao::dpi::LogicalSize;
use tao::event::{ElementState, Event, MouseButton, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::keyboard::{Key, ModifiersState};
use tao::window::WindowBuilder;

// ─── Host API surface, shared with every other backend (see carbon/host) ───
// blitz inherits mini's entire native OS layer + plugin machinery instead of
// reimplementing it. These files depend on the crate root providing only
// `UserEvent` + `tlog` (verified: no other crate:: refs, no super::) plus tao.
// V1 spliced carbon/runtime/mod.rs in here textually (`include!`), so that
// unqualified `native::`, `platform::`, `os_theme::`, `host_exports::` and
// `plugin_loader::` call sites resolved without a module path. Those are five
// crates now. Re-binding the old names keeps every call site in this file
// exactly as it was, which is the point: a 4,400-line composition root is not
// where you want to also be rewriting a few hundred paths.
use carbon_runtime_contract::{UserEvent, WindowOp};
use carbon_os as native;
use carbon_os::os_theme;
use carbon_platform as platform;
use carbon_plugin_host::host_exports;
use carbon_plugin_host::plugin_loader;

/// Event-loop user events posted from native worker threads (net/pty/ws) and
/// the window-control host imports. mirrors carbon-mini — must stay in
/// sync, since the shared `native/*` modules construct these variants.


/// Sub-step timing hook the native modules call. No-op unless CARBON_MINI_TIMING.
pub fn tlog(phase: &str) {
    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        eprintln!("[timing] {phase}");
    }
}

/// Escape a string for embedding inside a JS double-quoted string literal
/// (returns the inner content, no surrounding quotes). Used for PluginEvent.
fn json_escape(s: &str) -> String {
    let full = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string());
    full.get(1..full.len().saturating_sub(1)).unwrap_or("").to_string()
}

// ─── Bridge state ───────────────────────────────────────────────────────────
//
// The QuickJS runtime is single-threaded and lives on the main (event-loop)
// thread, so a thread-local holds the document the `__cm_*` host imports mutate.
// This mirrors the way carbon-mini keeps its Scene reachable from the host
// closures — but here the closures capture nothing (they reach the thread-local
// directly), which sidesteps the Arc<Mutex> capture + Send bounds entirely.

struct DocState {
    doc: BaseDocument,
    /// carbon JS node id → blitz slab node id. carbon ids come from the
    /// shared allocator (`globalThis.__cm_node_id_seq`); Blitz assigns its own.
    id_map: HashMap<i64, usize>,
    /// Reverse: blitz element id → carbon id, for mapping a hit-tested node
    /// back to the carbon node the JS reconciler dispatches events to.
    rev_map: HashMap<usize, i64>,
    /// The `<body>` node the carbon root gets attached under on `__cm_set_root`.
    body_id: usize,
    /// carbon "text" node id → its child blitz text node. carbon `<text>` nodes
    /// are STYLED leaves (react-mini-runtime sets font/color on them + text
    /// content), so we model each as a span element wrapping a text node: the
    /// span (in `id_map`) carries styles + tree position, the child text node
    /// (here) receives `set_text`.
    text_child: HashMap<i64, usize>,
    /// carbon ids that are SVG elements (svg/path/circle/…). Their props are
    /// SVG presentation ATTRIBUTES (d, fill, viewBox…), not CSS — blitz renders
    /// the `<svg>` by serializing its outer_html through usvg, so the attributes
    /// must be set verbatim (original casing, no px).
    svg_nodes: HashSet<i64>,
    /// Set on any mutation; the event loop repaints when true.
    dirty: bool,
}

/// Tags that are SVG elements (unambiguous subset — excludes text/title/a which
/// also exist in HTML). Their props route to attributes, not styles.
fn is_svg_tag(tag: &str) -> bool {
    matches!(
        tag,
        "svg" | "path" | "circle" | "rect" | "line" | "polyline" | "polygon"
            | "ellipse" | "g" | "defs" | "use" | "symbol" | "clipPath" | "mask"
            | "pattern" | "linearGradient" | "radialGradient" | "stop" | "tspan"
            | "foreignObject" | "marker" | "filter"
    )
}

/// Register an author stylesheet: create a `<style>` node holding the CSS and
/// let stylo parse + cascade it. Used by the `__cm_register_stylesheet` host
/// import AND to auto-load a compiled `app.css` next to the bundle.
fn register_css(css: &str) {
    with_doc(|st| {
        let body = st.body_id;
        let style_id = {
            let mut m = st.doc.mutate();
            let s = m.create_element(html_qual("style"), Vec::<Attribute>::new());
            let t = m.create_text_node(css);
            m.append_children(s, &[t]);
            // Attach the <style> to the tree (UA gives it display:none). An
            // ORPHAN style node never gets a primary style, but the
            // stylesheet-add invalidation still walks to it → stylo panics in
            // is_display_none. Being in the tree, it's styled like any element.
            m.append_children(body, &[s]);
            m.flush();
            s
        };
        st.doc.upsert_stylesheet_for_node(style_id);
        st.dirty = true;
    });
}

thread_local! {
    static DOC: RefCell<Option<DocState>> = const { RefCell::new(None) };
}

/// Build a QualName for an HTML-namespaced element/attribute from a runtime tag.
fn html_qual(name: &str) -> QualName {
    QualName::new(None, ns!(html), LocalName::from(name))
}

/// Attribute keys that are real HTML attributes (routed to `set_attribute`),
/// vs. everything else which is treated as an inline style property. This is
/// the same split a browser makes between `el.setAttribute` and `el.style.*`.
fn is_attribute_key(key: &str) -> bool {
    matches!(
        key,
        "id" | "role" | "href" | "src" | "alt" | "type" | "value" | "name"
            | "title" | "placeholder" | "tabindex" | "for" | "checked" | "disabled"
            | "selected" | "readonly" | "multiple" | "hidden" | "contenteditable"
            | "dir" | "lang" | "spellcheck" | "autocapitalize" | "autocorrect"
            | "autocomplete" | "autofocus" | "inputmode" | "enterkeyhint"
            | "maxlength" | "minlength" | "rows" | "cols" | "wrap" | "accept"
            | "download" | "target" | "rel" | "draggable" | "translate"
    ) || key.starts_with("data-")
        || key.starts_with("aria-")
}

/// carbon sends every prop value as `JSON.stringify(value)`. Unwrap it back to
/// the raw string: `"\"foo\""` → `foo`, `"12"` → `12`. Used for attributes.
fn json_to_value(raw: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Number(n)) => n.to_string(),
        Ok(serde_json::Value::Bool(b)) => b.to_string(),
        Ok(serde_json::Value::Null) => String::new(),
        Ok(v) => v.to_string(),
        Err(_) => raw.to_string(),
    }
}

/// react-mini-runtime emits style keys in React's shape — camelCase
/// (`fontSize`, `borderRadius`). stylo needs kebab-case CSS names.
fn camel_to_kebab(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Style properties blitz/stylo doesn't implement, or mini-scene-only props
/// that aren't CSS. Filtered BEFORE `set_style_property` so blitz-dom doesn't
/// `eprintln!("Warning: unsupported property …")` per node (thousands of lines
/// on terax) — and so we skip the wasted parse. None of these affect layout
/// or paint in the Blitz engine today.
fn is_unsupported_style(prop: &str) -> bool {
    // mini-scene state props: background-hover, color-hover, outline-hover, …
    prop.ends_with("-hover")
        || matches!(
            prop,
            "clickable"
                | "user-select" | "-webkit-user-select" | "-moz-user-select" | "-ms-user-select"
                | "touch-action" | "font-kerning" | "tab-index"
                | "-webkit-font-smoothing" | "-moz-osx-font-smoothing"
                | "appearance" | "-webkit-appearance" | "-webkit-tap-highlight-color"
                | "text-size-adjust" | "-webkit-text-size-adjust"
                | "scrollbar-width" | "scrollbar-color" | "overscroll-behavior"
                | "resize" | "-webkit-overflow-scrolling" | "-webkit-line-clamp"
                | "-webkit-box-orient" | "-webkit-background-clip" | "text-rendering"
                | "content-visibility" | "contain-intrinsic-size" | "will-change"
                | "-webkit-touch-callout" | "-webkit-user-drag" | "-webkit-app-region"
                | "print-color-adjust" | "-webkit-print-color-adjust" | "color-adjust"
        )
}

/// CSS properties whose numeric values are unitless (no `px`).
fn is_unitless(prop: &str) -> bool {
    matches!(
        prop,
        "opacity" | "z-index" | "font-weight" | "flex-grow" | "flex-shrink"
            | "order" | "line-height" | "flex" | "zoom" | "tab-size" | "flex-basis"
    )
}

/// Convert a JSON'd style value to a CSS value for property `prop`. React sends
/// bare numbers for lengths (`padding: 16`); CSS needs `16px` (0 stays `0`).
/// Unitless props keep the bare number. Strings pass through.
fn json_to_css_value(raw: &str, prop: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f == 0.0 || is_unitless(prop) {
                n.to_string()
            } else {
                format!("{n}px")
            }
        }
        Ok(serde_json::Value::Bool(b)) => b.to_string(),
        Ok(serde_json::Value::Null) => String::new(),
        Ok(v) => v.to_string(),
        Err(_) => raw.to_string(),
    }
}

fn with_doc<F: FnOnce(&mut DocState)>(f: F) {
    DOC.with(|d| {
        if let Some(st) = d.borrow_mut().as_mut() {
            f(st);
        }
    });
}

/// Drain QuickJS's pending-job queue (Promise resolutions, queueMicrotask,
/// our microtask-backed setTimeout). Without this, async chains never advance
/// and React never commits its initial render. Mirrors carbon-mini.
fn drain_jobs(rt: &JsRuntime) {
    let mut i = 0;
    loop {
        match rt.execute_pending_job() {
            Ok(true) => {
                i += 1;
                if i > 200_000 {
                    eprintln!("[mini-blitz] drain hit iteration cap");
                    break;
                }
            }
            Ok(false) => break,
            Err(e) => {
                eprintln!("[mini-blitz] pending job error: {e:?}");
                break;
            }
        }
    }
}

/// Drain jobs, force-flush React's concurrent work, drain again. carbon apps
/// have no natural event boundary, so we synthesize one (same as mini).
fn drain_and_flush(rt: &JsRuntime, ctx: &JsContext) {
    drain_jobs(rt);
    let _ = ctx.with(|ctx| {
        ctx.eval::<(), _>(b"globalThis.__cm_flush_react && globalThis.__cm_flush_react();".as_slice())
    });
    drain_jobs(rt);
}

/// One frame of JS work: fire due timers + queued rAF callbacks, then advance
/// microtasks and flush React. Returns true if animation-frame work is still
/// pending (so the loop keeps ticking at ~60fps instead of sleeping).
fn tick_js_frame(rt: &JsRuntime, ctx: &JsContext) -> bool {
    let _ = ctx.with(|c| {
        c.eval::<(), _>(
            b"globalThis.__cm_run_timers&&__cm_run_timers();globalThis.__cm_run_raf&&__cm_run_raf();"
                .as_slice(),
        )
    });
    drain_and_flush(rt, ctx);
    ctx.with(|c| {
        c.eval::<bool, _>(b"!!(globalThis.__cm_has_pending&&__cm_has_pending())".as_slice())
            .unwrap_or(false)
    })
}

// ─── __cm_* host-import implementations (drive the blitz DocumentMutator) ─────

fn cm_create_node(id: i64, tag: &str) {
    with_doc(|st| {
        let (blitz_id, text_child) = {
            let mut m = st.doc.mutate();
            let r = if tag == "text" {
                // Styled text leaf → span element wrapping a text node.
                let el = m.create_element(html_qual("span"), Vec::<Attribute>::new());
                let tx = m.create_text_node("");
                m.append_children(el, &[tx]);
                (el, Some(tx))
            } else {
                (m.create_element(html_qual(tag), Vec::<Attribute>::new()), None)
            };
            m.flush();
            r
        };
        st.id_map.insert(id, blitz_id);
        st.rev_map.insert(blitz_id, id);
        if is_svg_tag(tag) {
            st.svg_nodes.insert(id);
        }
        if let Some(tx) = text_child {
            st.text_child.insert(id, tx);
        }
        st.dirty = true;
    });
}

fn cm_set_text(id: i64, text: &str) {
    with_doc(|st| {
        // "text" nodes route to their child text node; anything else directly.
        let target = st.text_child.get(&id).copied().or_else(|| st.id_map.get(&id).copied());
        if let Some(bid) = target {
            let mut m = st.doc.mutate();
            m.set_node_text(bid, text);
            m.flush();
            st.dirty = true;
        }
    });
}

/// Set an attribute on a node, choosing the right stylo path.
///
/// blitz's `DocumentMutator::set_attribute` always takes a stylo SNAPSHOT and
/// sets a `restyle_subtree` invalidation hint — correct for updating an
/// already-styled element. But react-mini-runtime sets `className` on FRESH,
/// never-styled nodes; a snapshot on such a node makes stylo's next resolve
/// walk an unstyled subtree in `is_display_none` and panic (data.rs:190).
/// HTML parsing avoids this by writing attributes at construction (no
/// snapshot). We mirror that: for an unstyled node (no primary style yet),
/// write the attribute straight to `ElementData` — its initial `ALL_DAMAGE`
/// (from create_element) styles it cleanly. Only styled nodes take the
/// snapshot/invalidation path.
fn set_attr(st: &mut DocState, bid: usize, name: QualName, value: &str) {
    let styled = st
        .doc
        .get_node(bid)
        .map(|n| n.primary_styles().is_some())
        .unwrap_or(false);
    if styled {
        let mut m = st.doc.mutate();
        m.set_attribute(bid, name, value);
        m.flush();
    } else if let Some(node) = st.doc.get_node_mut(bid) {
        if let blitz_dom::NodeData::Element(ref mut el) = node.data {
            el.attrs.set(name, value);
        }
    }
    st.dirty = true;
}

fn cm_set_prop(id: i64, key: &str, value_json: &str) {
    with_doc(|st| {
        let Some(&bid) = st.id_map.get(&id) else { return };
        // SVG elements: every prop is a presentation ATTRIBUTE (d, fill, stroke,
        // viewBox, width…), set verbatim (original casing, no px) so blitz's
        // outer_html→usvg path parses + renders the icon. className stays too.
        if st.svg_nodes.contains(&id) {
            let val = json_to_value(value_json);
            let name = if key == "className" || key == "class" { "class" } else { key };
            set_attr(st, bid, html_qual(name), &val);
            return;
        }
        // set_attribute / set_style_property panic on non-element nodes; guard.
        // (With text→span, every mapped node is an element — this is a safety net.)
        if st.doc.get_node(bid).map(|n| n.element_data().is_none()).unwrap_or(true) {
            return;
        }

        // class → real class attribute so stylo can cascade registered CSS.
        if key == "className" || key == "class" {
            let val = json_to_value(value_json);
            set_attr(st, bid, html_qual("class"), &val);
            return;
        }
        if is_attribute_key(key) {
            let val = json_to_value(value_json);
            set_attr(st, bid, html_qual(key), &val);
            return;
        }

        // Inline style property. Normalize react-mini-runtime's shape → CSS:
        // camelCase → kebab, bare numbers → px. `clickable` (a mini-scene marker
        // for hit-testing, not CSS) is dropped — events land in M4.
        let css_key = camel_to_kebab(key);
        if is_unsupported_style(&css_key) {
            return;
        }
        let val = json_to_css_value(value_json, &css_key);
        if val.is_empty() {
            return;
        }
        let mut m = st.doc.mutate();
        m.set_style_property(bid, &css_key, &val);
        m.flush();
        st.dirty = true;
    });
}

fn cm_insert_node(parent: i64, child: i64, before: i64) {
    with_doc(|st| {
        let (Some(&pb), Some(&cb)) = (st.id_map.get(&parent), st.id_map.get(&child)) else {
            return;
        };
        let mut m = st.doc.mutate();
        if before < 0 {
            m.append_children(pb, &[cb]);
        } else if let Some(&bb) = st.id_map.get(&before) {
            m.insert_nodes_before(bb, &[cb]);
        } else {
            m.append_children(pb, &[cb]);
        }
        m.flush();
        st.dirty = true;
    });
}

fn cm_remove_node(id: i64) {
    with_doc(|st| {
        if let Some(&bid) = st.id_map.get(&id) {
            let mut m = st.doc.mutate();
            m.remove_node(bid);
            m.flush();
            st.id_map.remove(&id);
            st.rev_map.remove(&bid);
            st.text_child.remove(&id);
            st.svg_nodes.remove(&id);
            st.dirty = true;
        }
    });
}

/// Attach the carbon scene root under the document `<body>`.
fn cm_set_root(id: i64) {
    with_doc(|st| {
        if let Some(&bid) = st.id_map.get(&id) {
            let body = st.body_id;
            let mut m = st.doc.mutate();
            m.append_children(body, &[bid]);
            m.flush();
            st.dirty = true;
        }
    });
}

// ─── JS host wiring ──────────────────────────────────────────────────────────

fn register_host_imports(ctx: &JsContext) -> Result<()> {
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

// M2 harness: builds a styled card entirely via the __cm_* host imports, the
// same calls carbon-dom-shim makes for a real app — but hand-written so M2 is
// self-contained (no bundle, no dom-shim, no native yet). Uses inline styles;
// the class + registered-CSS path lands in M3.
const HARNESS_JS: &str = r##"
let seq = 0;
const node = (tag, style, parent) => {
  const id = ++seq;
  __cm_create_node(id, tag, "{}");
  for (const k in style) __cm_set_prop(id, k, JSON.stringify(style[k]));
  if (parent === 0) __cm_set_root(id);
  else if (parent) __cm_insert_node(parent, id, -1);
  return id;
};
const text = (s, parent) => {
  const id = ++seq;
  __cm_create_node(id, "text", "{}");
  __cm_set_text(id, s);
  __cm_insert_node(parent, id, -1);
  return id;
};

const screen = node("div", {
  "width": "100vw", "height": "100vh",
  "display": "flex", "align-items": "center", "justify-content": "center",
  "background": "#0a0a0a",
}, 0);

const card = node("div", {
  "width": "380px",
  "display": "flex", "flex-direction": "column", "gap": "16px",
  "padding": "24px",
  "background": "#1a1a1a",
  "border": "1px solid rgba(255,255,255,0.10)",
  "border-radius": "12px",
  "box-shadow": "0 10px 30px rgba(0,0,0,0.6)",
  "font-family": "system-ui, sans-serif",
}, screen);

const titleRow = node("div", { "display": "flex", "justify-content": "space-between", "align-items": "center" }, card);
const title = node("div", { "color": "#fafafa", "font-size": "18px", "font-weight": "600" }, titleRow);
text("carbon-blitz", title);
const badge = node("div", {
  "color": "#a1a1a1", "font-size": "12px",
  "padding": "2px 8px", "border-radius": "9999px",
  "background": "rgba(255,255,255,0.06)", "border": "1px solid rgba(255,255,255,0.10)",
}, titleRow);
text("M2 · DocumentMutator", badge);

const sub = node("div", { "color": "#a1a1a1", "font-size": "14px", "line-height": "1.5" }, card);
text("Built via __cm_* host imports → blitz-dom → stylo → taffy → vello. Real CSS, inline styles, GPU paint.", sub);

const divider = node("div", { "height": "1px", "background": "rgba(255,255,255,0.10)" }, card);

const button = node("div", {
  "display": "flex", "align-items": "center", "justify-content": "center",
  "height": "40px", "border-radius": "8px",
  "background": "#fafafa", "color": "#171717", "font-size": "14px", "font-weight": "500",
}, card);
text("Continue", button);

// className + registered-CSS cascade test (the mini-blitz thesis: real CSS,
// no hardcoding). The pill below has NO inline style — it's styled purely by
// stylo matching `.pill` from the registered author stylesheet.
__cm_register_stylesheet(".pill{background:#3b82f6;color:#ffffff;padding:6px 14px;border-radius:9999px;font-size:13px;align-self:flex-start;} .pill:hover{background:#2563eb;}");
const pill = node("div", {}, card);
__cm_set_prop(pill, "className", JSON.stringify("pill"));
text("styled by .pill class (stylo cascade)", pill);

console.log("harness built", seq, "nodes");
"##;

// ─── main ────────────────────────────────────────────────────────────────────

fn main() -> Result<()> {
    // Per-monitor DPI-aware v2 (same as carbon-mini) so the window reports a
    // physical inner size + real scale and vello paints at native resolution.
    #[cfg(target_os = "windows")]
    unsafe {
        extern "system" {
            fn SetProcessDpiAwarenessContext(value: isize) -> i32;
        }
        if SetProcessDpiAwarenessContext(-4) == 0 && SetProcessDpiAwarenessContext(-3) == 0 {
            let _ = SetProcessDpiAwarenessContext(-2);
        }
    }

    let event_loop: EventLoop<UserEvent> =
        EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Window label/opts (native::window reads these; multi-window support).
    native::window::set_window_label("main".to_string());
    native::window::set_window_opts_json("{}".to_string());

    let window = Arc::new(
        WindowBuilder::new()
            .with_title("carbon-blitz")
            .with_inner_size(LogicalSize::new(1100.0, 720.0))
            .with_visible(false)
            .build(&event_loop)
            .map_err(|e| anyhow!("build window: {e}"))?,
    );

    // Force dark: terax (and most shadcn apps) are dark-first, and their theme
    // provider resolves "system" via `matchMedia("(prefers-color-scheme:dark)")`.
    // We make matchMedia report this (below), and keep the scaffold's
    // <html class="dark">, matchMedia, and the app's ThemeProvider all agreeing
    // on dark — otherwise the provider flips html to "light" mid-mount and the
    // cascade half-updates (dark chrome, light panels). JS reads __cm_os_theme.
    os_theme::set("dark");

    let phys = window.inner_size();
    let scale = window.scale_factor() as f32;
    // Feed the size/scale slots native::window's __cm_window_inner_* read.
    native::window::set_inner_size(phys.width.max(1), phys.height.max(1));
    native::window::set_scale_factor(scale as f64);
    let viewport = Viewport::new(phys.width.max(1), phys.height.max(1), scale, ColorScheme::Dark);

    // Build the document with the browser UA stylesheet (gives div/body/etc.
    // their default `display: block` — without it every element is `inline`).
    // blitz's DEFAULT_CSS UA sheet styles form controls like a 1990s browser:
    // `button { background:#EFEFEF; border:1px solid #999; padding:1px 6px }`.
    // Tailwind apps assume the preflight reset (transparent, no border/padding)
    // — but stylo doesn't let the app's layered `@layer base` preflight beat the
    // unlayered UA rule, so every <button> (file rows, toolbar) showed the grey
    // UA background + border. We neutralize those UA defaults IN the UA sheet
    // (same origin, later rule wins), so the app's Tailwind utilities control
    // buttons/inputs entirely — exactly what a browser + preflight does.
    const UA_RESET: &str = "\nbutton, input[type=submit], input[type=reset], input[type=button] { background-color: transparent; border: 0; border-radius: 0; padding: 0; color: inherit; font: inherit; text-align: inherit; }\ninput, textarea, select { background-color: transparent; border: 0; padding: 0; color: inherit; font: inherit; }\n";
    let ua_css = format!("{DEFAULT_CSS}{UA_RESET}");
    let mut doc = BaseDocument::new(DocumentConfig {
        viewport: Some(viewport),
        ua_stylesheets: Some(vec![ua_css]),
        ..Default::default()
    });

    // Scaffold <html><body></body></html> under the document root (node 0 —
    // the NodeData::Document created first by BaseDocument::new).
    let (html_id, body_id) = {
        let mut m = doc.mutate();
        let html = m.create_element(html_qual("html"), Vec::new());
        let body = m.create_element(html_qual("body"), Vec::new());
        m.append_children(html, &[body]);
        m.append_children(0, &[html]);
        m.flush();
        (html, body)
    };

    DOC.with(|d| {
        *d.borrow_mut() = Some(DocState {
            doc,
            id_map: HashMap::new(),
            rev_map: HashMap::new(),
            text_child: HashMap::new(),
            svg_nodes: HashSet::new(),
            body_id,
            dirty: true,
        });
    });

    // CRITICAL ORDERING: resolve the BARE scaffold first (pure initial styling,
    // no pending invalidations), so html/body get a primary style. Any
    // attribute or stylesheet change BEFORE the first resolve leaves stylo's
    // invalidation walking a node with no primary style → panic
    // (data.rs:190 is_display_none). Only after this clean resolve do we apply
    // the dark class (terax is dark-first) + the author CSS.
    with_doc(|st| st.doc.resolve(0.0));
    with_doc(|st| {
        let mut m = st.doc.mutate();
        m.set_attribute(html_id, html_qual("class"), "dark");
        m.flush();
    });

    // JS runtime — build the DOM by evaluating the harness through the __cm_*
    // host imports. (Kept alive for the process; M2 doesn't re-enter JS.)
    let js_rt = JsRuntime::new().map_err(|e| anyhow!("js runtime: {e}"))?;
    // QuickJS runtime limits (same as mini). The default max stack is tiny —
    // terax's React reconciler recurses deep enough to hit "Maximum call stack
    // size exceeded" mid-mount without this. QuickJS runs on the native stack,
    // so 8 MB fits comfortably inside the 256 MB main-thread stack (build.rs).
    js_rt.set_gc_threshold(64 * 1024);
    js_rt.set_memory_limit(512 * 1024 * 1024);
    js_rt.set_max_stack_size(8 * 1024 * 1024);
    let js_ctx = JsContext::full(&js_rt).map_err(|e| anyhow!("js ctx: {e}"))?;
    register_host_imports(&js_ctx)?;

    // Native OS layer (reused from mini): fs, process, shell, pty, net,
    // clipboard, dialog, keychain, notification, autostart, window ops, os,
    // invoke, store, log — everything terax's host imports need. register_all
    // stashes the event-loop proxy so worker threads post back UserEvents.
    // blitz's own tlog — one line per phase, gated IN by CARBON_MINI_TIMING,
    // where mini's traces deltas and is gated OUT by CARBON_NO_TIMING. That
    // difference is why tlog is a port rather than a shared function.
    native::register_all(&js_ctx, proxy.clone(), &tlog)?;
    host_exports::mark_current_thread_as_js();
    host_exports::install_event_loop_proxy(proxy.clone());

    // Register the app's compiled Tailwind/shadcn CSS (if present next to the
    // bundle) BEFORE the app mounts, so class-based nodes are styled against it
    // during their INITIAL styling. Registering a stylesheet AFTER the tree
    // exists triggers a stylo invalidation that panics on the partially-styled
    // tree (is_display_none on a node with no primary style) — so it must
    // happen up front, into the empty html/body scaffold.
    let bundle_arg = std::env::args().nth(1);
    if let Some(bpath) = &bundle_arg {
        let css_path = std::path::Path::new(bpath).with_file_name("app.css");
        match std::fs::read_to_string(&css_path) {
            Ok(css) => {
                eprintln!("[mini-blitz] registering app.css ({} bytes) before mount", css.len());
                register_css(&css);
                with_doc(|st| st.doc.resolve(0.0));
            }
            Err(_) => eprintln!("[mini-blitz] (no app.css next to bundle — class-based styling unstyled)"),
        }
    }

    // Evaluate the app: a real carbon bundle passed as argv[1], else the M2
    // inline harness. Bundles are IIFE-wrapped scripts (carbon-dom-shim +
    // react-mini-runtime + app), so a plain script eval mounts React during
    // eval; draining the microtask queue afterwards lands the initial commit.
    js_ctx.with(|ctx| {
        let (code, label): (Vec<u8>, &str) = match &bundle_arg {
            Some(p) => match std::fs::read(p) {
                Ok(b) => (b, "bundle"),
                Err(e) => {
                    eprintln!("[mini-blitz] cannot read bundle {p}: {e}");
                    (HARNESS_JS.as_bytes().to_vec(), "harness")
                }
            },
            None => (HARNESS_JS.as_bytes().to_vec(), "harness"),
        };
        match ctx.eval::<(), _>(code.as_slice()) {
            Ok(()) => eprintln!("[mini-blitz] {label} evaluated ok"),
            Err(_) => {
                let exc = ctx.catch();
                if let Some(ex) = exc.as_exception() {
                    eprintln!(
                        "[mini-blitz] {label} threw: {}\n{}",
                        ex.message().unwrap_or_default(),
                        ex.stack().unwrap_or_default()
                    );
                } else {
                    eprintln!("[mini-blitz] {label} eval failed (non-exception value)");
                }
            }
        }
    });

    // Theme: terax's ThemeProvider resolves "system" via window.matchMedia. The
    // dom-shim's matchMedia returns false → the provider flips <html> to "light"
    // mid-mount and the cascade half-updates (dark chrome, light panels). Make
    // matchMedia report the OS theme (dark, forced above) and seed the app's
    // fast-path preference to "dark". terax mounts via createRoot (concurrent),
    // so its first render runs in the pump below — after this override lands.
    let _ = js_ctx.with(|ctx| {
        ctx.eval::<(), _>(
            br#"(function(){
              var mm = function(q){ q = String(q); var dark = false;
                try { dark = (globalThis.__cm_os_theme && globalThis.__cm_os_theme()) === 'dark'; } catch(e){}
                var m = /prefers-color-scheme\s*:\s*dark/.test(q) ? dark
                      : (/prefers-color-scheme\s*:\s*light/.test(q) ? !dark : false);
                return { matches: m, media: q, onchange: null,
                  addEventListener: function(){}, removeEventListener: function(){},
                  addListener: function(){}, removeListener: function(){},
                  dispatchEvent: function(){ return false; } }; };
              globalThis.matchMedia = mm;
              if (globalThis.window) globalThis.window.matchMedia = mm;
              try { globalThis.localStorage && globalThis.localStorage.setItem('terax-ui-theme-shadow','dark'); } catch(e){}
            })();"#
                .as_slice(),
        )
    });

    drain_and_flush(&js_rt, &js_ctx);
    // Style the freshly-mounted tree NOW. stylo's incremental invalidation (run
    // on each resolve after an attribute change) assumes a node's descendants
    // already have a primary style — so we must resolve per mutation-batch, not
    // let a huge pile of unstyled+invalidated nodes accumulate (which panics in
    // stylo's `is_display_none` during invalidation).
    with_doc(|st| st.doc.resolve(0.0));

    // Pump several frames so React's initial mount (scheduled via the deferred
    // timers/rAF) runs before the first paint — avoids a blank first frame.
    for _ in 0..12 {
        let pending = tick_js_frame(&js_rt, &js_ctx);
        // Resolve each batch so new nodes get styled before the next batch's
        // invalidations reference them (see the per-batch note above).
        with_doc(|st| st.doc.resolve(0.0));
        if !pending {
            break;
        }
    }

    // Force dark theme after mount. terax's ThemeProvider resolves "system" (and
    // consults the native store) and may set <html class="light">, which makes
    // panels use the light theme vars while chrome/text stay dark — the
    // half-updated look. We're dark-first: re-assert `dark` and re-cascade.
    with_doc(|st| {
        let cls = st
            .doc
            .get_node(html_id)
            .and_then(|n| n.data.attr(blitz_dom::local_name!("class")).map(|s| s.to_string()));
        set_attr(st, html_id, html_qual("class"), "dark");
        st.doc.resolve(0.0);
        // Theme diagnostics (CM_DUMP=1): html class + computed backgrounds +
        // a scan for any remaining opaque light-background elements + classes.
        if std::env::var_os("CM_DUMP").is_some() {
            eprintln!("[theme] html class after mount = {cls:?}");
            let body = st.body_id;
            for (label, id) in [("html", html_id), ("body", body)] {
                if let Some(s) = st.doc.get_node(id).and_then(|n| n.primary_styles()) {
                    let cc = s.clone_color();
                    let bg = s.get_background().background_color.resolve_to_absolute(&cc);
                    eprintln!("[bg] {label} = {bg:?}");
                }
            }
            let mut hits = 0;
            for (&cid, &bid) in st.id_map.iter() {
                if hits >= 16 {
                    break;
                }
                if let Some(n) = st.doc.get_node(bid) {
                    if let Some(s) = n.primary_styles() {
                        let cc = s.clone_color();
                        let bg = s.get_background().background_color.resolve_to_absolute(&cc);
                        if bg.alpha > 0.5 && bg.components.0 > 0.6 {
                            let cls = n.data.attr(blitz_dom::local_name!("class")).map(|s| s.to_string());
                            eprintln!("[light-bg] carbon={cid} bg={bg:?} class={cls:?}");
                            hits += 1;
                        }
                    }
                }
            }
        }
    });

    // Headless screenshot mode (CM_SCREENSHOT=<path>): pump a while to let the
    // app settle, render the doc to a PNG via vello's offscreen image renderer,
    // and exit. Reliable verification independent of window z-order / GPU
    // capture — and the basis for the A/B fidelity benchmark.
    if let Ok(shot_path) = std::env::var("CM_SCREENSHOT") {
        for _ in 0..160 {
            tick_js_frame(&js_rt, &js_ctx);
            std::thread::sleep(Duration::from_millis(6));
        }
        DOC.with(|d| {
            if let Some(st) = d.borrow_mut().as_mut() {
                st.doc.resolve(0.0);
                let (w, h) = st.doc.viewport().window_size;
                let scale = st.doc.viewport().scale_f64();
                use anyrender::ImageRenderer;
                let mut ir = anyrender_vello::VelloImageRenderer::new(w, h);
                let mut buf: Vec<u8> = Vec::new();
                ir.render_to_vec(|scene| paint_scene(scene, &st.doc, scale, w, h), &mut buf);
                save_png(&shot_path, w, h, &buf);
                eprintln!("[mini-blitz] screenshot saved: {shot_path} ({w}x{h}, nodes={})", st.id_map.len());
            }
        });
        std::process::exit(0);
    }

    // Renderer — bind vello to the tao window (Arc<Window> → Arc<dyn WindowHandle>).
    let mut renderer = VelloWindowRenderer::new();
    let handle: Arc<dyn anyrender::WindowHandle> = window.clone();
    renderer.resume(handle, phys.width.max(1), phys.height.max(1));
    if !renderer.is_active() {
        return Err(anyhow!("vello renderer failed to resume"));
    }

    // Show the window, then drive the first paint from a redraw request WHILE
    // visible. Painting before set_visible presents to a surface the compositor
    // then discards (black window); the dirty flag + MainEventsCleared below
    // guarantee at least one visible frame.
    window.set_visible(true);
    window.request_redraw();

    let window_for_loop = window.clone();
    // Cursor position in LOGICAL (CSS) pixels — blitz lays out in CSS px and
    // scales at paint, so hit-testing uses logical coords.
    let mut mouse_pos = (0.0f32, 0.0f32);
    // Keyboard modifier state (tao tracks it via ModifiersChanged).
    let mut modifiers = ModifiersState::empty();
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => *control_flow = ControlFlow::Exit,
                WindowEvent::CursorMoved { position, .. } => {
                    let sf = window_for_loop.scale_factor();
                    mouse_pos = ((position.x / sf) as f32, (position.y / sf) as f32);
                }
                WindowEvent::MouseInput { state, button, .. } => {
                    if button == MouseButton::Left {
                        let (mx, my) = mouse_pos;
                        // Hit-test, then collect the carbon ids from the target
                        // up to the root. react-mini-runtime's __cm_dispatch_*
                        // are NON-bubbling (they only fire the handler for the
                        // exact id), so we dispatch to every ancestor ourselves
                        // — manual event bubbling. Non-handler nodes are no-ops.
                        let chain: Vec<i64> = DOC.with(|d| {
                            let b = d.borrow();
                            let Some(st) = b.as_ref() else { return Vec::new() };
                            let Some(hit) = st.doc.hit(mx, my) else { return Vec::new() };
                            let mut out = Vec::new();
                            let mut nid = Some(hit.node_id);
                            while let Some(n) = nid {
                                if let Some(&cid) = st.rev_map.get(&n) {
                                    out.push(cid);
                                }
                                nid = st.doc.get_node(n).and_then(|node| node.parent);
                            }
                            out
                        });
                        if std::env::var_os("CM_DEBUG_EVENTS").is_some() {
                            eprintln!("[event] click ({mx:.0},{my:.0}) state={state:?} chain={chain:?}");
                        }
                        if !chain.is_empty() {
                            let pressed = state == ElementState::Pressed;
                            let phase = if pressed { "down" } else { "up" };
                            let mut code = String::new();
                            for cid in &chain {
                                code.push_str(&format!(
                                    "globalThis.__cm_dispatch_pointer&&__cm_dispatch_pointer({cid},'{phase}',{mx},{my},0);"
                                ));
                            }
                            if !pressed {
                                for cid in &chain {
                                    code.push_str(&format!(
                                        "globalThis.__cm_dispatch_click&&__cm_dispatch_click({cid});"
                                    ));
                                }
                            }
                            let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(code.as_bytes()));
                            drain_and_flush(&js_rt, &js_ctx);
                            with_doc(|s| s.dirty = true);
                            window_for_loop.request_redraw();
                        }
                    }
                }
                WindowEvent::ModifiersChanged(state) => {
                    modifiers = state;
                }
                WindowEvent::KeyboardInput { event: key_event, .. } => {
                    if key_event.state == ElementState::Pressed {
                        let key_label = match &key_event.logical_key {
                            Key::Character(s) => s.to_string(),
                            Key::Enter => "Enter".to_string(),
                            Key::Escape => "Escape".to_string(),
                            Key::Tab => "Tab".to_string(),
                            Key::Backspace => "Backspace".to_string(),
                            Key::Delete => "Delete".to_string(),
                            Key::ArrowUp => "ArrowUp".to_string(),
                            Key::ArrowDown => "ArrowDown".to_string(),
                            Key::ArrowLeft => "ArrowLeft".to_string(),
                            Key::ArrowRight => "ArrowRight".to_string(),
                            Key::Space => " ".to_string(),
                            Key::Home => "Home".to_string(),
                            Key::End => "End".to_string(),
                            Key::PageUp => "PageUp".to_string(),
                            Key::PageDown => "PageDown".to_string(),
                            other => format!("{other:?}"),
                        };
                        let kj = serde_json::to_string(&key_label).unwrap_or_else(|_| "\"\"".into());
                        let s = format!(
                            "globalThis.__cm_dispatch_keydown&&__cm_dispatch_keydown({kj},{},{},{},{});",
                            modifiers.control_key(), modifiers.shift_key(), modifiers.alt_key(), modifiers.super_key());
                        let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                        drain_and_flush(&js_rt, &js_ctx);
                        with_doc(|st| st.dirty = true);
                        window_for_loop.request_redraw();
                    }
                }
                WindowEvent::MouseWheel { delta, .. } => {
                    let sf = window_for_loop.scale_factor();
                    let (dx, dy) = match delta {
                        tao::event::MouseScrollDelta::PixelDelta(p) => (p.x / sf, p.y / sf),
                        tao::event::MouseScrollDelta::LineDelta(cx, cy) => (cx as f64 * 20.0, cy as f64 * 20.0),
                        _ => (0.0, 0.0),
                    };
                    let (mx, my) = mouse_pos;
                    let changed = DOC.with(|d| {
                        let mut b = d.borrow_mut();
                        let Some(st) = b.as_mut() else { return false };
                        match st.doc.hit(mx, my) {
                            Some(hit) => st.doc.scroll_node_by_has_changed(hit.node_id, dx, dy),
                            None => st.doc.scroll_viewport_by_has_changed(dx, dy),
                        }
                    });
                    if changed {
                        with_doc(|st| st.dirty = true);
                        window_for_loop.request_redraw();
                    }
                }
                WindowEvent::Focused(focused) => {
                    native::window::set_is_focused(focused);
                    let s = format!("globalThis.__cm_dispatch_window_focus&&__cm_dispatch_window_focus({focused});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                WindowEvent::Resized(size) => {
                    let (w, h) = (size.width.max(1), size.height.max(1));
                    with_doc(|st| {
                        st.doc.viewport_mut().window_size = (w, h);
                        st.dirty = true;
                    });
                    renderer.set_size(w, h);
                    native::window::set_inner_size(w, h);
                    native::window::bump_resize_tick();
                    // Notify JS (ResizeObserver, Radix/Floating-UI, WindowControls).
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(
                        b"globalThis.__cm_window_dispatch_resize&&__cm_window_dispatch_resize();globalThis.__cm_broadcast_resize&&__cm_broadcast_resize();".as_slice()));
                    window_for_loop.request_redraw();
                }
                WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                    native::window::set_scale_factor(scale_factor);
                    with_doc(|st| {
                        st.doc.viewport_mut().set_hidpi_scale(scale_factor as f32);
                        st.dirty = true;
                    });
                    window_for_loop.request_redraw();
                }
                _ => {}
            },
            Event::RedrawRequested(_) => render_frame(&mut renderer),
            // Events posted from native worker threads (net/pty/ws) and the
            // window-control host imports — forwarded to the JS dispatchers.
            Event::UserEvent(ue) => match ue {
                UserEvent::RequestPaint => window_for_loop.request_redraw(),
                UserEvent::FetchHeaders { id, status, headers_json } => {
                    let s = format!("globalThis.__cm_fetch_dispatch_headers&&__cm_fetch_dispatch_headers({id},{status},{headers_json});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::FetchChunk { id, data } => {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    let s = format!("globalThis.__cm_fetch_dispatch_chunk&&__cm_fetch_dispatch_chunk({id},\"{b64}\");");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::FetchEnd { id } => {
                    let s = format!("globalThis.__cm_fetch_dispatch_end&&__cm_fetch_dispatch_end({id});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::FetchError { id, message } => {
                    let msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".into());
                    let s = format!("globalThis.__cm_fetch_dispatch_error&&__cm_fetch_dispatch_error({id},{msg});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::ChannelMessage { channel_id, json } => {
                    let s = format!("globalThis.__cm_channel_dispatch&&__cm_channel_dispatch({channel_id},{json});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::WsOpen { id } => {
                    let s = format!("globalThis.__cm_ws_dispatch_open&&__cm_ws_dispatch_open({id});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::WsMessage { id, data, is_text } => {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    let s = format!("globalThis.__cm_ws_dispatch_message&&__cm_ws_dispatch_message({id},\"{b64}\",{is_text});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::WsClose { id, code, reason } => {
                    let r = serde_json::to_string(&reason).unwrap_or_else(|_| "\"\"".into());
                    let s = format!("globalThis.__cm_ws_dispatch_close&&__cm_ws_dispatch_close({id},{code},{r});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::WsError { id, message } => {
                    let msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".into());
                    let s = format!("globalThis.__cm_ws_dispatch_error&&__cm_ws_dispatch_error({id},{msg});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::PtyOutput { id } => {
                    let s = format!("globalThis.__cm_pty_dispatch_output&&__cm_pty_dispatch_output({id});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                    drain_and_flush(&js_rt, &js_ctx);
                    window_for_loop.request_redraw();
                }
                UserEvent::PtyExit { id } => {
                    let s = format!("globalThis.__cm_pty_dispatch_exit&&__cm_pty_dispatch_exit({id});");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                    drain_and_flush(&js_rt, &js_ctx);
                    window_for_loop.request_redraw();
                }
                UserEvent::WindowOp(op) => {
                    use WindowOp::*;
                    match op {
                        Show => window_for_loop.set_visible(true),
                        Hide => window_for_loop.set_visible(false),
                        Minimize => window_for_loop.set_minimized(true),
                        Maximize => window_for_loop.set_maximized(true),
                        Unmaximize => window_for_loop.set_maximized(false),
                        ToggleMaximize => window_for_loop.set_maximized(!window_for_loop.is_maximized()),
                        Restore => {
                            window_for_loop.set_minimized(false);
                            window_for_loop.set_visible(true);
                        }
                        Focus => window_for_loop.set_focus(),
                        Close => *control_flow = ControlFlow::Exit,
                    }
                }
                UserEvent::WindowSetTitle(t) => window_for_loop.set_title(&t),
                UserEvent::WindowSetFullscreen(on) => {
                    window_for_loop.set_fullscreen(if on {
                        Some(tao::window::Fullscreen::Borderless(None))
                    } else {
                        None
                    });
                }
                UserEvent::WindowStartDrag => {
                    let _ = window_for_loop.drag_window();
                }
                UserEvent::PluginEvent { name, payload } => {
                    let en = json_escape(&name);
                    let pj = if payload.is_empty() { "null".to_string() } else { json_escape(&payload) };
                    let s = format!("globalThis.__carbon_on_event&&__carbon_on_event(\"{en}\",\"{pj}\");");
                    let _ = js_ctx.with(|ctx| ctx.eval::<(), _>(s.as_bytes()));
                }
                UserEvent::ReloadBundle => {}
            },
            Event::MainEventsCleared => {
                // Fire due timers + queued animation-frame callbacks, advance
                // microtasks + React's commit, then repaint if the doc changed.
                let pending = tick_js_frame(&js_rt, &js_ctx);
                let dirty = DOC.with(|d| d.borrow().as_ref().map(|s| s.dirty).unwrap_or(false));
                if dirty {
                    window_for_loop.request_redraw();
                }
                // Keep ticking at ~60fps while animation/timer work is pending;
                // otherwise sleep until the next OS event (no idle CPU spin).
                *control_flow = if pending || dirty {
                    ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(16))
                } else {
                    ControlFlow::Wait
                };
            }
            _ => {}
        }
    });
}

/// Encode an RGBA8 buffer as a PNG file (headless screenshot mode).
fn save_png(path: &str, w: u32, h: u32, rgba: &[u8]) {
    let file = match std::fs::File::create(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[mini-blitz] screenshot: cannot create {path}: {e}");
            return;
        }
    };
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    match enc.write_header() {
        Ok(mut writer) => {
            let _ = writer.write_image_data(rgba);
        }
        Err(e) => eprintln!("[mini-blitz] screenshot: png header failed: {e}"),
    }
}

/// Resolve (stylo restyle + taffy relayout) then paint the document via vello.
/// Wrapped in catch_unwind so a stylo/layout/paint edge-case panic recovers
/// (logs + skips the frame) instead of killing the window — mini's never-crash
/// guarantee. panic=unwind is the default profile, so this actually catches.
fn render_frame(renderer: &mut VelloWindowRenderer) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        render_frame_inner(renderer);
    }));
    if result.is_err() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        if N.fetch_add(1, Ordering::Relaxed) < 8 {
            eprintln!("[mini-blitz] render_frame panicked (recovered, frame skipped)");
        }
    }
}

fn render_frame_inner(renderer: &mut VelloWindowRenderer) {
    DOC.with(|d| {
        if let Some(st) = d.borrow_mut().as_mut() {
            st.doc.resolve(0.0);
            // Layout-box diagnostics (set CM_DUMP=1). Kept as a dev aid — the
            // computed taffy boxes are how we confirmed stylo+taffy+parley work.
            if std::env::var_os("CM_DUMP").is_some() {
                use std::sync::atomic::{AtomicU32, Ordering};
                static FRAME: AtomicU32 = AtomicU32::new(0);
                let f = FRAME.fetch_add(1, Ordering::Relaxed);
                if f < 4 {
                    let bl = st.doc.get_node(st.body_id).map(|n| n.final_layout);
                    let root_el = st.doc.get_node(0).map(|n| n.final_layout);
                    eprintln!(
                        "[frame {f}] nodes={} viewport={:?} scale={} body={:?} doc_root={:?}",
                        st.id_map.len(),
                        st.doc.viewport().window_size,
                        st.doc.viewport().scale_f64(),
                        bl.map(|l| (l.location.x, l.location.y, l.size.width, l.size.height)),
                        root_el.map(|l| (l.size.width, l.size.height)),
                    );
                    // First carbon root child (the app container) size.
                    if let Some(&b1) = st.id_map.get(&1) {
                        if let Some(n) = st.doc.get_node(b1) {
                            let l = n.final_layout;
                            eprintln!("[frame {f}] carbon-root(1) size=({:.1}x{:.1})", l.size.width, l.size.height);
                        }
                    }
                }
            }
            let (w, h) = st.doc.viewport().window_size;
            let scale = st.doc.viewport().scale_f64();
            renderer.render(|scene| paint_scene(scene, &st.doc, scale, w, h));
            st.dirty = false;
        }
    });
}
