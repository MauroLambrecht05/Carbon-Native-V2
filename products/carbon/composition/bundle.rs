// Loading and evaluating the app's JavaScript bundle.
//
// Two forms: plain `dist/bundle.js`, and `dist/bundle.qbc.zst` — QuickJS
// bytecode, lz4-compressed, which skips the parser at launch. carbon.toml's
// `[runtime] bytecode` decides which is written; this prefers the bytecode when
// it is present and current.
//
// `bundle_evaluated` is the phase that proves the app's own code ran, rather
// than the runtime having started and painted an empty window.

use super::*;

/// Build-time helper: compile a JS bundle to QuickJS bytecode, then
/// zstd-compress it. The runtime reads the .qbc.zst file directly,
/// decompresses to memory, deserializes via JS_ReadObject — no parse step.
///
/// Usage: carbon-mini.exe --compile-bundle <input.js> <output.qbc.zst>
pub(crate) fn compile_bundle(input: &str, output: &str) -> Result<()> {
    let src = std::fs::read(input).with_context(|| format!("read {input}"))?;
    let rt = JsRuntime::new().map_err(|e| anyhow!("rt: {e}"))?;
    let ctx = JsContext::builder()
        .with::<intrinsic::Eval>()
        .with::<intrinsic::RegExp>()
        .with::<intrinsic::Json>()
        .with::<intrinsic::MapSet>()
        .with::<intrinsic::TypedArrays>()
        .build(&rt)
        .map_err(|e| anyhow!("ctx: {e}"))?;
    ctx.with(|ctx| -> Result<()> {
        // Compile (don't execute) — JS_Eval with EVAL_TYPE_GLOBAL | EVAL_FLAG_COMPILE_ONLY
        // returns a function value containing the bytecode. We then serialize
        // it via JS_WriteObject. This is the same shape the runtime uses on load.
        use rquickjs::qjs;
        let mut src_with_null = src.clone();
        src_with_null.push(0);
        let cstr_ptr = src_with_null.as_ptr() as *const i8;
        let filename = std::ffi::CString::new(input).unwrap();
        let raw_ctx = ctx.as_raw().as_ptr();
        let func_val = unsafe {
            qjs::JS_Eval(
                raw_ctx,
                cstr_ptr,
                src.len() as u64,
                filename.as_ptr(),
                (qjs::JS_EVAL_TYPE_GLOBAL | qjs::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
            )
        };
        if unsafe { qjs::JS_IsException(func_val) } {
            return Err(anyhow!("compile failed (JS exception)"));
        }
        let mut out_len: u64 = 0;
        let buf_ptr = unsafe {
            qjs::JS_WriteObject(
                raw_ctx,
                &mut out_len as *mut u64,
                func_val,
                qjs::JS_WRITE_OBJ_BYTECODE as i32,
            )
        };
        if buf_ptr.is_null() {
            return Err(anyhow!("JS_WriteObject returned null"));
        }
        let bytes = unsafe { std::slice::from_raw_parts(buf_ptr, out_len as usize).to_vec() };
        unsafe {
            qjs::js_free(raw_ctx, buf_ptr as *mut std::ffi::c_void);
            qjs::JS_FreeValue(raw_ctx, func_val);
        }
        // lz4-compress the bytecode. Pure-Rust, ~4 GB/s decompress, modest
        // compression ratio (~2× worse than zstd) but adds ~50 KB to the binary
        // vs zstd's ~420 KB. Worth the trade for 36-100 KB bundles.
        // Frame format: 4-byte little-endian uncompressed length prefix +
        // raw lz4 block. Lets the decoder pre-allocate the exact output size.
        let mut compressed = (bytes.len() as u32).to_le_bytes().to_vec();
        compressed.extend_from_slice(&lz4_flex::compress(&bytes));
        std::fs::write(output, &compressed).with_context(|| format!("write {output}"))?;
        eprintln!(
            "[carbon-mini] compiled {} ({} B JS) -> {} ({} B .qbc.zst, {} B bytecode pre-compress)",
            input,
            src.len(),
            output,
            compressed.len(),
            bytes.len()
        );
        Ok(())
    })?;
    Ok(())
}

/// Read the bundle at `path` and eval it in the given JS context.
/// Used for both initial startup and HMR reloads.
///
/// Three formats supported (same as before):
///   .qbc.zst — lz4-compressed bytecode (default when [runtime] bytecode = true)
///   .qbc     — raw bytecode (rare; if user pre-decompressed)
///   .js      — source, parse-and-eval at runtime
///
/// The .js source path wraps the bundle in an IIFE before eval. This is
/// strictly required for HMR: re-eval'ing top-level `const` / `let`
/// declarations in the same context throws "redeclaration of const X"
/// inside QuickJS. Wrapping in `(function(){ ... })()` makes every
/// declaration local to a fresh function scope, so reloads compose cleanly.
/// Bytecode-compiled scripts already have their own scope per JS_ReadObject
/// payload, so they don't need the wrapper.
///
/// Split into two phases so the disk read + lz4 decompress can run on a
/// worker thread while the main thread builds the OS window. `read_bundle`
/// is Send and side-effect-free; `eval_bundle_src` requires the main JS
/// context and must run on the thread that owns it.
pub(crate) struct BundleSrc {
    bytes: Vec<u8>,
    is_bytecode: bool,
}

pub(crate) fn read_bundle(path: &PathBuf) -> Result<BundleSrc> {
    let raw = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let path_str = path.to_string_lossy();
    let is_zst = path_str.ends_with(".qbc.zst");
    let is_bytecode = is_zst || path_str.ends_with(".qbc");
    let bytes: Vec<u8> = if is_zst {
        if raw.len() < 4 {
            return Err(anyhow!("bundle .qbc.zst too short ({} B)", raw.len()));
        }
        let uncompressed_len = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        lz4_flex::decompress(&raw[4..], uncompressed_len)
            .map_err(|e| anyhow!("lz4 decompress {}: {e}", path.display()))?
    } else {
        raw
    };
    Ok(BundleSrc { bytes, is_bytecode })
}

pub(crate) fn eval_bundle_src(js_ctx: &JsContext, src: &BundleSrc) -> Result<()> {
    let is_bytecode = src.is_bytecode;
    let src = &src.bytes;
    js_ctx.with(|ctx| -> Result<()> {
        if is_bytecode {
            use rquickjs::qjs;
            let raw_ctx = ctx.as_raw().as_ptr();
            let func_val = unsafe {
                qjs::JS_ReadObject(
                    raw_ctx,
                    src.as_ptr(),
                    src.len() as u64,
                    qjs::JS_READ_OBJ_BYTECODE as i32,
                )
            };
            if unsafe { qjs::JS_IsException(func_val) } {
                return Err(anyhow!("JS_ReadObject failed (bad bytecode)"));
            }
            let result = unsafe { qjs::JS_EvalFunction(raw_ctx, func_val) };
            if unsafe { qjs::JS_IsException(result) } {
                // Read the actual exception so we get a useful error.
                let exc = unsafe { qjs::JS_GetException(raw_ctx) };
                let msg = unsafe {
                    let cstr = qjs::JS_ToCString(raw_ctx, exc);
                    let s = if cstr.is_null() {
                        "<unprintable exception>".to_string()
                    } else {
                        std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned()
                    };
                    if !cstr.is_null() {
                        qjs::JS_FreeCString(raw_ctx, cstr);
                    }
                    qjs::JS_FreeValue(raw_ctx, exc);
                    s
                };
                return Err(anyhow!("JS_EvalFunction threw: {msg}"));
            }
            unsafe { qjs::JS_FreeValue(raw_ctx, result) };
        } else {
            // Wrap the source in an IIFE so re-eval doesn't trip over
            // top-level const/let from a previous load. Also wrap in a
            // try/catch that promotes thrown primitives (null, undefined,
            // strings) into Error objects with a stack trace — those are
            // hostile to diagnose otherwise because QuickJS only surfaces
            // the raw value with no location info.
            let mut wrapped = Vec::with_capacity(src.len() + 128);
            wrapped.extend_from_slice(b"(function(){\ntry{\n");
            wrapped.extend_from_slice(&src);
            wrapped.extend_from_slice(
                b"\n}catch(__cm_e){\
                    if(__cm_e==null||typeof __cm_e!=='object'){\
                        var __cm_err=new Error('bundle threw non-error: '+String(__cm_e));\
                        __cm_err.original=__cm_e;\
                        throw __cm_err;\
                    }\
                    if(!__cm_e.stack){__cm_e.stack=(new Error()).stack;}\
                    throw __cm_e;\
                }\n})();",
            );
            match ctx.eval::<(), _>(wrapped.as_slice()) {
                Ok(()) => {}
                Err(e) => {
                    // Exception path: rquickjs `Error::Exception` has the
                    // message stashed in the ctx; pull it out so we can
                    // surface a useful diagnostic instead of a generic
                    // "Exception generated by QuickJS".
                    eprintln!("[carbon-mini DEBUG] rquickjs error variant: {:?}", e);
                    if matches!(e, rquickjs::Error::Exception) {
                        let exc = ctx.catch();
                        eprintln!("[carbon-mini DEBUG] is_error={} is_object={} is_null={} is_undefined={} is_string={}", exc.is_error(), exc.is_object(), exc.is_null(), exc.is_undefined(), exc.is_string());
                        // Three diagnostic strategies, tried in order:
                        //   1. Error-shaped object: read .message + .stack
                        //   2. Any other object: read .message; fall back to JSON-ish dump
                        //   3. Primitive / null: convert to string + include type tag
                        let details: String = if let Some(ex_obj) = exc.clone().into_object() {
                            let msg: Option<String> = ex_obj.get("message").ok();
                            let stack: Option<String> = ex_obj.get("stack").ok();
                            let name: Option<String> = ex_obj.get("name").ok();
                            match (name, msg, stack) {
                                (Some(n), Some(m), Some(s)) => format!("{n}: {m}\n{s}"),
                                (Some(n), Some(m), None) => format!("{n}: {m}"),
                                (None, Some(m), Some(s)) => format!("{m}\n{s}"),
                                (None, Some(m), None) => m,
                                (_, None, Some(s)) => s,
                                _ => {
                                    // Last-ditch: try the value's toString(), then a raw type tag.
                                    let as_str: Option<String> = ctx
                                        .eval::<String, _>(b"__last = arguments[0]; String(__last)".as_slice())
                                        .ok();
                                    as_str.unwrap_or_else(|| format!("{:?}", ex_obj))
                                }
                            }
                        } else {
                            // Primitive throw — get type + string form.
                            let type_str = if exc.is_null() { "null" }
                                else if exc.is_undefined() { "undefined" }
                                else if exc.is_string() { "string" }
                                else if exc.is_number() { "number" }
                                else if exc.is_bool() { "bool" }
                                else { "primitive" };
                            // exc.into_string() consumes the value; clone first.
                            let str_form: String = match exc.clone().into_string() {
                                Some(s) => s.to_string().unwrap_or_default(),
                                None => format!("{:?}", exc),
                            };
                            format!("{type_str}: {str_form}")
                        };
                        return Err(anyhow!("eval bundle threw: {details}"));
                    }
                    return Err(anyhow!("eval bundle: {e}"));
                }
            }
        }
        Ok(())
    })?;
    Ok(())
}

/// Backward-compat wrapper: read + eval in one call. Used by HMR
/// reload (which re-eval's a fresh bundle in the SAME JS context after
/// `__cm_hmr_reset` runs). Cold-start path uses the split form so the
/// disk read can overlap with window creation.
pub(crate) fn load_and_eval_bundle(js_ctx: &JsContext, path: &PathBuf) -> Result<()> {
    let src = read_bundle(path)?;
    eval_bundle_src(js_ctx, &src)
}
