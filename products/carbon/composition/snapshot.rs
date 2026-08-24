// QuickJS heap snapshot: build, restore, and the standalone spike.
//
// Windows-only, and gated on the `snapshot` feature, which also links the
// binary with /DYNAMICBASE:NO (see build.rs) so it loads at a constant base.
// The snapshot's absolute code pointers are only valid if it does.
//
// `try_restore_snapshot` has two definitions selected by #[cfg] — the real one
// and a `None` stub — so main() calls it unconditionally.
//
// The riskiest code in the runtime, and it has no tests: it assumes every heap
// pointer stays valid across processes. See capabilities/snapshot.

use super::*;
use super::snapshot_spike::*;

/// Isolated proof-of-mechanism for the heap snapshot. Two sub-modes:
///   --snapshot-spike build   <snap>  [bundle.js]
///   --snapshot-spike restore <snap>  [probe.js]
/// `build` evaluates a representative heap (or a JS file) inside the fixed
/// arena and writes a snapshot; `restore` maps it back in a FRESH process and
/// runs a probe + GC + alloc stress to prove the heap survived and is live.
#[cfg(all(feature = "snapshot", windows))]
pub(crate) fn snapshot_spike(mode: &str, snap_path: &str, extra: Option<&str>) -> Result<()> {
    use rquickjs::qjs;
    eprintln!("[spike] mode={mode} exe_base={:#x}", snapshot::exe_base());

    // A synthetic module-init that touches every serializable shape: nested
    // plain objects, arrays, strings, closures with captured mutable state,
    // Map, Set, RegExp, a resolved Promise.
    const SYNTH: &str = r#"
        globalThis.__lib = (function () {
          const big = {};
          for (let i = 0; i < 20000; i++) {
            big["k" + i] = { n: i, s: "val" + i, arr: [i, i + 1, i + 2] };
          }
          const m = new Map();
          for (let i = 0; i < 5000; i++) m.set("m" + i, i * i);
          const s = new Set();
          for (let i = 0; i < 5000; i++) s.add(i);
          function makeCounter(start) { let c = start; return { inc() { return ++c; }, get() { return c; } }; }
          const counters = [];
          for (let i = 0; i < 1000; i++) counters.push(makeCounter(i * 100));
          const re = /foo(bar)+/g;
          const p = Promise.resolve(42);
          return {
            big, m, s, counters, re, p,
            sum() { let t = 0; for (const k in big) t += big[k].n; return t; },
          };
        })();
        globalThis.probe = function () {
          const L = globalThis.__lib;
          return JSON.stringify({
            keys: Object.keys(L.big).length,
            mapSize: L.m.size,
            setSize: L.s.size,
            counter0: L.counters[0].get(),
            counter999: L.counters[999].get(),
            sum: L.sum(),
            reSrc: L.re.source,
          });
        };
        "ok";
    "#;

    if mode == "build" {
        snapshot::init_arena_for_build().map_err(|e| anyhow!("init arena: {e}"))?;
        unsafe {
            let mf = snapshot::malloc_functions();
            let rt = qjs::JS_NewRuntime2(&mf, std::ptr::null_mut());
            if rt.is_null() {
                return Err(anyhow!("JS_NewRuntime2 returned null"));
            }
            qjs::JS_SetMemoryLimit(rt, 0); // arena bounds memory; no QuickJS cap
            qjs::JS_SetMaxStackSize(rt, 0); // disable stack check for the spike
            let ctx = qjs::JS_NewContextRaw(rt);
            if ctx.is_null() {
                return Err(anyhow!("JS_NewContextRaw returned null"));
            }
            spike_add_intrinsics(ctx);

            // Sanity: a trivial eval must work before the heavy synthetic heap.
            qjs::JS_UpdateStackTop(rt);
            eprintln!("[spike] sanity 1+1 -> {}", spike_eval(ctx, "1+1")?);

            // Either eval a real bundle file or the synthetic heap.
            let t_eval = Instant::now();
            if let Some(file) = extra {
                // A real app bundle is what the runtime evals at module-init.
                // It references host imports (`__cm_*`, console, native OS
                // imports) by *name*, resolved at call time — and the React
                // mount is deferred to microtasks, so a plain synchronous eval
                // performs only module-init and never calls them. We still need
                // `console` to exist (libraries log at init), so install a
                // pure-JS no-op console (kept in the arena, snapshot-safe; the
                // real console is registered after restore).
                let _ = spike_eval(
                    ctx,
                    "globalThis.console={log(){},info(){},warn(){},error(){},debug(){},trace(){}};\
                     globalThis.__cm_resolve_class=function(){return '{}';};",
                );
                if file.ends_with(".qbc.zst") || file.ends_with(".qbc") {
                    // Bytecode path — mirrors the real runtime (exec-only, no
                    // parse), so eval_ms is directly comparable to the live
                    // `bundle_evaluated` phase.
                    let raw = std::fs::read(file).with_context(|| format!("read {file}"))?;
                    let bc: Vec<u8> = if file.ends_with(".qbc.zst") {
                        let ulen = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
                        lz4_flex::decompress(&raw[4..], ulen).map_err(|e| anyhow!("lz4: {e}"))?
                    } else {
                        raw
                    };
                    let func = qjs::JS_ReadObject(
                        ctx,
                        bc.as_ptr(),
                        bc.len() as _,
                        qjs::JS_READ_OBJ_BYTECODE as i32,
                    );
                    if qjs::JS_IsException(func) {
                        return Err(anyhow!("JS_ReadObject failed"));
                    }
                    let r = qjs::JS_EvalFunction(ctx, func);
                    if qjs::JS_IsException(r) {
                        let exc = qjs::JS_GetException(ctx);
                        let cstr = qjs::JS_ToCString(ctx, exc);
                        let msg = if cstr.is_null() {
                            "<unprintable>".into()
                        } else {
                            let s = std::ffi::CStr::from_ptr(cstr)
                                .to_string_lossy()
                                .into_owned();
                            qjs::JS_FreeCString(ctx, cstr);
                            s
                        };
                        qjs::JS_FreeValue(ctx, exc);
                        eprintln!("[spike] bundle bytecode eval threw (continuing): {msg}");
                    }
                    qjs::JS_FreeValue(ctx, r);
                } else {
                    let src =
                        std::fs::read_to_string(file).with_context(|| format!("read {file}"))?;
                    match spike_eval(ctx, &src) {
                        Ok(_) => {}
                        Err(e) => eprintln!("[spike] bundle eval error (continuing): {e}"),
                    }
                }
            } else {
                let r = spike_eval(ctx, SYNTH)?;
                eprintln!("[spike] synth eval -> {r}");
            }
            let eval_ms = t_eval.elapsed().as_secs_f64() * 1000.0;

            qjs::JS_RunGC(rt);

            snapshot::set_rt_ctx(rt as *mut std::ffi::c_void, ctx as *mut std::ffi::c_void);
            let used = snapshot::used_bytes();
            let live = snapshot::live_bytes();
            let t_w = Instant::now();
            let path = std::path::PathBuf::from(snap_path);
            let file_len = snapshot::write_snapshot(&path).map_err(|e| anyhow!("write: {e}"))?;
            let write_ms = t_w.elapsed().as_secs_f64() * 1000.0;
            // Also write the uncompressed mmap form (for the lazy-restore path).
            let raw_path = path.with_extension("raw");
            let raw_len =
                snapshot::write_snapshot_mmap(&raw_path).map_err(|e| anyhow!("write mmap: {e}"))?;
            eprintln!(
                "[spike] BUILD: eval={eval_ms:.1}ms  arena_used={:.2}MB  live={:.2}MB  \
                 lz4_file={:.2}MB  write={write_ms:.1}ms  raw_file={:.2}MB",
                used as f64 / 1e6,
                live as f64 / 1e6,
                file_len as f64 / 1e6,
                raw_len as f64 / 1e6,
            );
            // Probe before exit to show the live heap is correct pre-snapshot.
            if extra.is_none() {
                eprintln!(
                    "[spike] pre-snapshot probe -> {}",
                    spike_eval(ctx, "probe()")?
                );
            }
        }
        Ok(())
    } else if mode == "restore" || mode == "restore-mmap" {
        let path = std::path::PathBuf::from(snap_path);
        let t_r = Instant::now();
        let restored = if mode == "restore-mmap" {
            let raw = path.with_extension("raw");
            snapshot::restore_mmap(&raw).map_err(|e| anyhow!("restore-mmap: {e}"))?
        } else {
            snapshot::restore_from_file(&path).map_err(|e| anyhow!("restore: {e}"))?
        };
        let restore_ms = t_r.elapsed().as_secs_f64() * 1000.0;
        unsafe {
            let rt = restored.rt as *mut qjs::JSRuntime;
            let ctx = restored.ctx as *mut qjs::JSContext;
            qjs::JS_UpdateStackTop(rt);
            eprintln!("[spike] RESTORE ({mode}): returned in {restore_ms:.2}ms");
            // First full heap-touch — for the mmap path this is where pages
            // actually fault in from the file; measured separately so we can
            // see upfront-restore vs deferred page-in.
            let t_touch = Instant::now();
            qjs::JS_RunGC(rt);
            let _ = spike_eval(ctx, "Object.keys(globalThis).length")?;
            let touch_ms = t_touch.elapsed().as_secs_f64() * 1000.0;
            eprintln!("[spike] first full heap-touch (GC + walk): {touch_ms:.2}ms");

            // Generic heap-integrity probe (works for any snapshot): the global
            // object's shape survived, the GC can walk the whole restored graph,
            // and the allocator serves fresh allocations from the restored state.
            let keys = spike_eval(ctx, "Object.keys(globalThis).length")?;
            eprintln!("[spike] globalThis key count -> {keys}");
            qjs::JS_RunGC(rt);
            let keys2 = spike_eval(ctx, "Object.keys(globalThis).length")?;
            eprintln!("[spike] globalThis key count (after full GC) -> {keys2}");
            let stress = spike_eval(
                ctx,
                "(function(){let a=[];for(let i=0;i<50000;i++)a.push({i,s:'x'+i});\
                 let t=0;for(const o of a)t+=o.i;return t;})()",
            )?;
            eprintln!("[spike] alloc stress sum -> {stress} (expect 1249975000)");

            // Synthetic-snapshot extras (no-op for real bundles).
            if spike_eval(ctx, "typeof globalThis.probe")?.trim() == "function" {
                eprintln!("[spike] probe() -> {}", spike_eval(ctx, "probe()")?);
                eprintln!(
                    "[spike] counters[0].inc() -> {} (expect 1)",
                    spike_eval(ctx, "globalThis.__lib.counters[0].inc()")?
                );
            }
            // Optional caller-supplied probe file.
            if let Some(probe_file) = extra {
                if std::path::Path::new(probe_file).exists() {
                    let src = std::fs::read_to_string(probe_file)
                        .with_context(|| format!("read {probe_file}"))?;
                    eprintln!("[spike] custom probe -> {}", spike_eval(ctx, &src)?);
                }
            }
        }
        eprintln!("[spike] RESTORE OK");
        Ok(())
    } else {
        Err(anyhow!("unknown spike mode '{mode}' (use build|restore)"))
    }
}

/// `--snapshot-build <project-dir>`: evaluate the app bundle purely for
/// module-init (with the mount deferred via `__cm_defer_mount`) inside the
/// fixed-address snapshot arena, then write the heap image next to the bundle
/// as `dist/bundle.cmsnap.raw` + `.meta`. Window-less; exits when done. The
/// normal startup path then memory-maps that image instead of re-evaluating
/// the bundle.
#[cfg(all(feature = "snapshot", windows))]
pub(crate) fn snapshot_build_app(project_dir: &std::path::Path) -> Result<()> {
    use rquickjs::qjs;
    let t0 = Instant::now();
    // Prefer bytecode (matches what the runtime evals) > source.
    let cand = [
        project_dir.join("dist/bundle.qbc.zst"),
        project_dir.join("dist/bundle.qbc"),
        project_dir.join("dist/bundle.js"),
    ];
    let bundle = cand
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| anyhow!("no dist/bundle.* found under {}", project_dir.display()))?;

    snapshot::init_arena_for_build().map_err(|e| anyhow!("init arena: {e}"))?;
    unsafe {
        let mf = snapshot::malloc_functions();
        let rt = qjs::JS_NewRuntime2(&mf, std::ptr::null_mut());
        if rt.is_null() {
            return Err(anyhow!("JS_NewRuntime2 null"));
        }
        qjs::JS_SetMemoryLimit(rt, 0);
        qjs::JS_SetMaxStackSize(rt, 0);
        qjs::JS_SetGCThreshold(rt, 64 * 1024);
        let ctx = qjs::JS_NewContextRaw(rt);
        if ctx.is_null() {
            return Err(anyhow!("JS_NewContextRaw null"));
        }
        spike_add_intrinsics(ctx);
        qjs::JS_UpdateStackTop(rt);

        // Prelude: defer the mount, and stand in a pure-JS console (the real
        // rquickjs console is registered after restore; module-init logs at
        // build time are intentionally dropped). The bundle's `render(<App/>)`
        // sees `__cm_defer_mount` and stashes `__cm_run_deferred_mount`.
        // Prelude: defer the mount + stand in for the host imports that
        // module-init touches. React apps mount their visible tree through
        // `render()` (deferred), but carbon-dom-shim creates `document.body` at
        // install time and the bundle reads OS/app facts at module-init.
        //
        // CRITICAL: the VALUE-returning stubs must return EXACTLY what the real
        // native host fns return, because apps compute module-level constants
        // from them (e.g. terax: `const IS_WINDOWS = platform() === "windows"`).
        // Those constants are baked into the snapshot, so a stub that returns a
        // different value (e.g. "win32" vs "windows") silently corrupts app
        // behaviour after restore. The build runs the same binary on the same
        // machine, so we inject the real values here.
        let platform = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unknown"
        };
        let arch = if cfg!(target_arch = "x86_64") {
            "x86_64"
        } else if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else if cfg!(target_arch = "x86") {
            "x86"
        } else {
            "unknown"
        };
        let home = dirs::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let pd = project_dir.to_path_buf();
        let (app_name, app_version) = read_app_metadata(&pd);
        let (win_w, win_h, _dec) = read_window_cfg(&pd);
        // JSON-encode so backslashes/quotes in paths are escaped safely.
        let j = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
        let prelude = format!(
            r#"
            globalThis.__cm_defer_mount = true;
            globalThis.console = {{ log(){{}}, info(){{}}, warn(){{}}, error(){{}}, debug(){{}}, trace(){{}} }};
            (function () {{
              const noop = function () {{}};
              // Host imports the bundle may CALL at module-init. The dispatch
              // callbacks and JS-managed state (__cm_node_id_seq, …) are owned by
              // the bundle and must NOT be stubbed.
              const hostFns = [
                "__cm_create_node","__cm_set_prop","__cm_set_text","__cm_insert_node",
                "__cm_remove_node","__cm_set_root","__cm_request_paint","__cm_reset_paint_props",
                "__cm_set_scroll_y","__cm_broadcast_resize","__cm_load_system_font","__cm_canvas",
                "__cm_test","__cm_invoke","__cm_invoke_has",
                "__cm_autostart_enable","__cm_autostart_disable","__cm_autostart_is_enabled",
                "__cm_proc_relaunch_self","__cm_shell_open","__cm_shell_reveal",
                "__cm_pty_spawn","__cm_pty_write","__cm_pty_read","__cm_pty_resize","__cm_pty_close",
                "__cm_window_close","__cm_window_focus","__cm_window_hide","__cm_window_show",
                "__cm_window_minimize","__cm_window_maximize","__cm_window_unmaximize",
                "__cm_window_toggle_maximize","__cm_window_is_focused","__cm_window_is_maximized",
                "__cm_window_is_minimized","__cm_window_set_title","__cm_window_set_fullscreen",
                "__cm_window_start_drag","__cm_window_open"
              ];
              for (const n of hostFns) {{
                if (typeof globalThis[n] !== "function") globalThis[n] = noop;
              }}
              // Value-returning host fns — REAL values (must match native).
              globalThis.__cm_resolve_class = function () {{ return "{{}}"; }};
              globalThis.__cm_layout_box = function () {{
                return JSON.stringify({{ x:0, y:0, width:0, height:0, top:0, left:0, right:0, bottom:0 }});
              }};
              globalThis.__cm_os_platform = function () {{ return {platform}; }};
              globalThis.__cm_os_arch = function () {{ return {arch}; }};
              globalThis.__cm_fs_home_dir = function () {{ return {home}; }};
              globalThis.__cm_app_name = function () {{ return {app_name}; }};
              globalThis.__cm_app_version = function () {{ return {app_version}; }};
              globalThis.__cm_window_label = function () {{ return "main"; }};
              globalThis.__cm_window_opts_json = function () {{ return "{{}}"; }};
              globalThis.__cm_window_device_pixel_ratio = function () {{ return 1; }};
              globalThis.__cm_window_inner_width = function () {{ return {win_w}; }};
              globalThis.__cm_window_inner_height = function () {{ return {win_h}; }};
            }})();
            "#,
            platform = j(platform),
            arch = j(arch),
            home = j(&home),
            app_name = j(&app_name),
            app_version = j(&app_version),
            win_w = win_w as i64,
            win_h = win_h as i64,
        );
        spike_eval(ctx, &prelude)?;

        match snapshot_eval_bundle_file(ctx, &bundle) {
            Ok(()) => {}
            Err(e) => eprintln!("[carbon-mini snapshot-build] bundle eval error (continuing): {e}"),
        }

        // Did the framework defer the mount? If not, the snapshot won't be
        // restorable into a rendered app — warn loudly.
        let deferred = spike_eval(ctx, "typeof globalThis.__cm_run_deferred_mount")?;
        if deferred.trim() != "function" {
            eprintln!(
                "[carbon-mini snapshot-build] WARNING: __cm_run_deferred_mount not set \
                 (the bundle didn't call render() under __cm_defer_mount, or it mounted \
                 synchronously). Restore may show a blank window."
            );
        }

        qjs::JS_RunGC(rt);
        snapshot::set_rt_ctx(rt as *mut std::ffi::c_void, ctx as *mut std::ffi::c_void);

        let raw_path = project_dir.join("dist/bundle.cmsnap.raw");
        let raw_len =
            snapshot::write_snapshot_mmap(&raw_path).map_err(|e| anyhow!("write: {e}"))?;
        let build_ms = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "[carbon-mini snapshot-build] {} -> {} ({:.2} MB heap, {:.2} MB live) in {build_ms:.0}ms",
            bundle.display(),
            raw_path.display(),
            raw_len as f64 / 1e6,
            snapshot::live_bytes() as f64 / 1e6,
        );
    }
    Ok(())
}

/// Create a fresh JS runtime + context with the standard carbon-mini intrinsic
/// set. Used by the normal (non-snapshot) cold path and as the snapshot-restore
/// fallback.
pub(crate) fn stack_size_bytes() -> usize {
    std::env::var("CARBON_STACK_MB")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .map(|mb| mb * 1024 * 1024)
        .unwrap_or(4 * 1024 * 1024)
}

pub(crate) fn create_fresh_runtime() -> Result<(JsRuntime, JsContext)> {
    let js_rt = JsRuntime::new().map_err(|e| anyhow!("js runtime: {e}"))?;
    js_rt.set_gc_threshold(64 * 1024);
    js_rt.set_memory_limit(256 * 1024 * 1024);
    js_rt.set_max_stack_size(stack_size_bytes());
    let js_ctx = JsContext::builder()
        .with::<intrinsic::Eval>()
        .with::<intrinsic::RegExp>()
        .with::<intrinsic::Json>()
        .with::<intrinsic::MapSet>()
        .with::<intrinsic::TypedArrays>()
        .with::<intrinsic::Date>()
        .with::<intrinsic::Promise>()
        .with::<intrinsic::BigInt>()
        .with::<intrinsic::Performance>()
        .with::<intrinsic::Proxy>()
        .with::<intrinsic::WeakRef>()
        .build(&js_rt)
        .map_err(|e| anyhow!("js ctx: {e}"))?;
    Ok((js_rt, js_ctx))
}

/// Try to restore a prebuilt startup heap snapshot for `project_dir`. Returns
/// the wrapped runtime + context on success; `None` (cold path) if disabled,
/// absent, or restore fails. Gated behind `CARBON_SNAPSHOT` so it's strictly
/// opt-in.
#[cfg(all(feature = "snapshot", windows))]
pub(crate) fn try_restore_snapshot(
    project_dir: &std::path::Path,
    t0: Instant,
) -> Option<(JsRuntime, JsContext)> {
    // OPT-IN (CARBON_SNAPSHOT=1). The snapshot restores a heap whose module-init
    // ran at BUILD time with a stand-in environment; apps that derive state from
    // host fns at module-init (e.g. terax: terminal/explorer/stores) can behave
    // differently than a cold start, so auto-on is unsafe for arbitrary apps.
    // Left opt-in until a build-time real-host-environment pass lands. Verified
    // safe for simple React apps (see examples/react).
    if std::env::var_os("CARBON_SNAPSHOT").is_none() {
        return None;
    }
    let raw = project_dir.join("dist/bundle.cmsnap.raw");
    let meta = raw.with_extension("meta");
    if !raw.exists() || !meta.exists() {
        return None;
    }
    // Staleness guard: only use the snapshot if it is at least as new as the
    // bundle it was built from. A bundle rebuilt without a matching snapshot
    // (e.g. an HMR/edit cycle) is therefore NEVER restored from a stale image —
    // we fall back to evaluating the fresh bundle. (The code fingerprint already
    // rejects snapshots from a different binary.)
    let snap_mtime = std::fs::metadata(&raw).and_then(|m| m.modified()).ok();
    let bundle_mtime = ["dist/bundle.qbc.zst", "dist/bundle.qbc", "dist/bundle.js"]
        .iter()
        .filter_map(|p| {
            std::fs::metadata(project_dir.join(p))
                .and_then(|m| m.modified())
                .ok()
        })
        .max();
    if let (Some(s), Some(b)) = (snap_mtime, bundle_mtime) {
        if s < b {
            eprintln!("[carbon-mini] snapshot is older than the bundle; using cold path");
            return None;
        }
    }
    match snapshot::restore_mmap(&raw) {
        Ok(r) => unsafe {
            let rt_ptr = r.rt as *mut rquickjs::qjs::JSRuntime;
            let ctx_ptr = r.ctx as *mut rquickjs::qjs::JSContext;
            // Re-arm the runtime for this thread/process: anchor the stack-
            // overflow check at the current (shallow) frame before any JS runs.
            rquickjs::qjs::JS_SetMaxStackSize(rt_ptr, stack_size_bytes() as u64);
            rquickjs::qjs::JS_UpdateStackTop(rt_ptr);
            // Wrap the raw runtime/context back into the high-level API (installs
            // a fresh Opaque + the rquickjs RustClass/RustFunction classes).
            let rt = match JsRuntime::from_raw_restored(rt_ptr) {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[carbon-mini] from_raw_restored failed: {e}");
                    return None;
                }
            };
            rt.set_gc_threshold(64 * 1024);
            let ctx_nn = std::ptr::NonNull::new(ctx_ptr)?;
            let ctx = JsContext::from_raw(ctx_nn, rt.clone());
            timing_log("snapshot_restored", t0);
            Some((rt, ctx))
        },
        Err(e) => {
            eprintln!("[carbon-mini] snapshot restore unavailable ({e}); using cold path");
            None
        }
    }
}

#[cfg(not(all(feature = "snapshot", windows)))]
pub(crate) fn try_restore_snapshot(
    _project_dir: &std::path::Path,
    _t0: Instant,
) -> Option<(JsRuntime, JsContext)> {
    None
}
