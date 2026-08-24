// Raw-FFI QuickJS helpers for the snapshot spike and snapshot-build path.
//
// These operate on a `*mut JSContext` obtained via `JS_NewContextRaw` (which
// starts empty, unlike the high-level `rquickjs::Context`), so every call
// goes through `rquickjs::qjs` directly. Used by `snapshot.rs`'s
// `snapshot_spike` and `snapshot_build_app`.

use super::*;

/// Raw-FFI eval helper for the snapshot spike. Evals `code` in `ctx` and
/// returns the result coerced to a String, or the exception message on error.
#[cfg(all(feature = "snapshot", windows))]
pub(crate) unsafe fn spike_eval(ctx: *mut rquickjs::qjs::JSContext, code: &str) -> Result<String> {
    use rquickjs::qjs;
    let mut buf = code.as_bytes().to_vec();
    buf.push(0);
    let filename = std::ffi::CString::new("<spike>").unwrap();
    let val = qjs::JS_Eval(
        ctx,
        buf.as_ptr() as *const i8,
        code.len() as _,
        filename.as_ptr(),
        qjs::JS_EVAL_TYPE_GLOBAL as i32,
    );
    if qjs::JS_IsException(val) {
        let exc = qjs::JS_GetException(ctx);
        let cstr = qjs::JS_ToCString(ctx, exc);
        let msg = if cstr.is_null() {
            "<unprintable exception>".to_string()
        } else {
            let s = std::ffi::CStr::from_ptr(cstr)
                .to_string_lossy()
                .into_owned();
            qjs::JS_FreeCString(ctx, cstr);
            s
        };
        qjs::JS_FreeValue(ctx, exc);
        return Err(anyhow!("JS exception: {msg}"));
    }
    let cstr = qjs::JS_ToCString(ctx, val);
    let s = if cstr.is_null() {
        String::new()
    } else {
        let s = std::ffi::CStr::from_ptr(cstr)
            .to_string_lossy()
            .into_owned();
        qjs::JS_FreeCString(ctx, cstr);
        s
    };
    qjs::JS_FreeValue(ctx, val);
    Ok(s)
}

/// Add the same intrinsic set the real runtime's context uses, on a context
/// created via `JS_NewContextRaw` (which starts empty).
#[cfg(all(feature = "snapshot", windows))]
pub(crate) unsafe fn spike_add_intrinsics(ctx: *mut rquickjs::qjs::JSContext) {
    use rquickjs::qjs;
    qjs::JS_AddIntrinsicBaseObjects(ctx);
    qjs::JS_AddIntrinsicEval(ctx);
    qjs::JS_AddIntrinsicRegExpCompiler(ctx);
    qjs::JS_AddIntrinsicRegExp(ctx);
    qjs::JS_AddIntrinsicJSON(ctx);
    qjs::JS_AddIntrinsicProxy(ctx);
    qjs::JS_AddIntrinsicMapSet(ctx);
    qjs::JS_AddIntrinsicTypedArrays(ctx);
    qjs::JS_AddIntrinsicPromise(ctx);
    qjs::JS_AddIntrinsicBigInt(ctx);
    qjs::JS_AddIntrinsicDate(ctx);
    qjs::JS_AddPerformance(ctx);
    qjs::JS_AddIntrinsicWeakRef(ctx);
}

/// Eval a bundle file (bytecode `.qbc.zst`/`.qbc` or `.js` source) into a raw
/// context. Used by the snapshot build path. Errors during eval are returned
/// (the caller decides whether a partial heap is still useful).
#[cfg(all(feature = "snapshot", windows))]
pub(crate) unsafe fn snapshot_eval_bundle_file(
    ctx: *mut rquickjs::qjs::JSContext,
    file: &std::path::Path,
) -> Result<()> {
    use rquickjs::qjs;
    let path_str = file.to_string_lossy();
    if path_str.ends_with(".qbc.zst") || path_str.ends_with(".qbc") {
        let raw = std::fs::read(file).with_context(|| format!("read {}", file.display()))?;
        let bc: Vec<u8> = if path_str.ends_with(".qbc.zst") {
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
        let threw = qjs::JS_IsException(r);
        if threw {
            let exc = qjs::JS_GetException(ctx);
            let cstr = qjs::JS_ToCString(ctx, exc);
            let msg = if cstr.is_null() {
                "<unprintable>".to_string()
            } else {
                let s = std::ffi::CStr::from_ptr(cstr)
                    .to_string_lossy()
                    .into_owned();
                qjs::JS_FreeCString(ctx, cstr);
                s
            };
            qjs::JS_FreeValue(ctx, exc);
            qjs::JS_FreeValue(ctx, r);
            return Err(anyhow!("bundle eval threw: {msg}"));
        }
        qjs::JS_FreeValue(ctx, r);
        Ok(())
    } else {
        let src =
            std::fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?;
        spike_eval(ctx, &src).map(|_| ())
    }
}
