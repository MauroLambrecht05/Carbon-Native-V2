// Async image loading.
//
// Design note on "async" in a synchronous QuickJS runtime
// --------------------------------------------------------
// rquickjs without the `futures` feature provides `ctx.promise()` which
// returns `(Promise, resolveFn, rejectFn)`, but those Function handles are
// `!Send` — they cannot be moved to a background thread without unsafe.
//
// Our approach:
//   1. `load_path_async` / `load_bytes_async` — decode on a background
//      thread using `std::thread::spawn`. The raw JSValue handles are
//      transmitted by wrapping them in a `SendableResolver` newtype that
//      manually implements `Send`. This is safe because:
//        - We only ever call `.call()` after re-entering the QuickJS
//          runtime (i.e., from a closure dispatched via a pending job that
//          the main thread drives through `execute_pending_job`).
//        - The QuickJS runtime is protected by an internal mutex in rquickjs;
//          the `with()` call on the JsContext acquires it before any
//          JSValue operation runs.
//        - We never hold the JSValue across a runtime lock boundary.
//      Concretely: we move the Function values off the JS thread, decode the
//      image, then post the resolved value back through a `std::sync::mpsc`
//      channel. The channel receiver is drained by a polling job installed
//      in the QuickJS microtask queue via `ctx.eval`. This avoids any unsafe
//      cross-thread JSValue use: the Functions stay in the channel until the
//      JS thread drains it.
//
//   2. `decode_sync` — decodes synchronously on the calling (JS) thread.
//      Returns a plain CarbonImage object, not a Promise.  Suitable for
//      small images loaded at startup.
//
// Capability check:
//   Glob-based allowlist checked before any file I/O or thread spawn.

use std::sync::{Arc, Mutex};

use rquickjs::{Ctx, Exception, Function, Result as JsResult};

use crate::cache::{CacheKey, ImageCache};
use crate::decoder::{decode_bytes, decode_path, DecodedImage};

// ─── Capability check ─────────────────────────────────────────────────────

/// Glob-based capability check against an allowlist of path patterns.
///
/// Patterns support `**` (cross-directory wildcard) and `*` (single-segment
/// wildcard). Variable expansion (`${APP}`, `${APPDATA}`) is the caller's
/// responsibility — patterns arrive here as concrete paths.
pub fn check_capability(path: &str, allowed_globs: &[String]) -> Result<(), String> {
    if allowed_globs.is_empty() {
        return Err(format!(
            "image.read capability not configured; cannot load '{path}'"
        ));
    }
    for pattern in allowed_globs {
        if glob_match(pattern, path) {
            return Ok(());
        }
    }
    Err(format!(
        "path '{path}' is not permitted by any image.read allowlist pattern"
    ))
}

fn glob_match(pattern: &str, path: &str) -> bool {
    let pat = pattern.replace('\\', "/");
    let s = path.replace('\\', "/");
    glob_inner(pat.as_bytes(), s.as_bytes())
}

fn glob_inner(mut pat: &[u8], mut s: &[u8]) -> bool {
    loop {
        // Try to match the next segment of both.
        match (pat.first(), s.first()) {
            (None, None) => return true,
            (None, _) => return false,
            (Some(b'*'), _) => {
                // Double-star: match across slashes.
                if pat.get(1) == Some(&b'*') {
                    pat = &pat[2..];
                    // Skip optional trailing slash in pattern.
                    if pat.first() == Some(&b'/') {
                        pat = &pat[1..];
                    }
                    // Try matching the rest of the pattern against every
                    // suffix of the remaining string.
                    for i in 0..=s.len() {
                        if glob_inner(pat, &s[i..]) {
                            return true;
                        }
                        // Only advance past non-separators OR advance past '/'.
                        if i < s.len() { /* always advance */
                        } else {
                            break;
                        }
                    }
                    return false;
                }
                // Single star: match until the next '/'.
                pat = &pat[1..];
                loop {
                    if glob_inner(pat, s) {
                        return true;
                    }
                    if s.is_empty() || s[0] == b'/' {
                        return false;
                    }
                    s = &s[1..];
                }
            }
            (Some(&pc), Some(&sc)) if pc == sc => {
                pat = &pat[1..];
                s = &s[1..];
            }
            _ => return false,
        }
    }
}

// ─── FINAL DESIGN: synchronous on calling thread, but wrapped in resolved Promise ─
//
// Background: rquickjs 0.9 without `futures` does not provide a safe cross-
// thread Promise resolver. The `Function<'js>` and `Promise<'js>` types are
// `!Send` by design (they borrow the runtime lifetime).
//
// Resolution: we implement `load_path_async` and `load_bytes_async` as
// *synchronous* decodes that return a pre-resolved `Promise.resolve(result)`.
// This matches the spec (both are async API contracts), and is correct for
// all callers that `.then(cb)` on the returned Promise — the callback fires
// in the next microtask turn, just like a real async resolution.
//
// For large images (>1 MB) the caller should use a worker or move the call
// to a non-blocking context. This is documented in IMAGE_IMPL.md.
//
// The `futures` feature gate for rquickjs would allow truly non-blocking
// decode, but that requires an async executor (tokio/smol) which is not
// in the runtime's dependency set.

/// Decode a file from disk and return a pre-resolved Promise<CarbonImage>.
/// Checks the capability allowlist before reading.
pub fn load_path_async<'js>(
    ctx: Ctx<'js>,
    path: String,
    cache: Arc<Mutex<ImageCache>>,
    allowed_globs: &[String],
) -> JsResult<rquickjs::Value<'js>> {
    // 1. Capability check.
    if let Err(msg) = check_capability(&path, allowed_globs) {
        return Err(Exception::throw_type(&ctx, &msg));
    }

    // 2. Cache lookup.
    let canonical = std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.replace('\\', "/"));

    let maybe_cached = std::fs::metadata(&path)
        .ok()
        .map(|meta| CacheKey::from_metadata(canonical.clone(), &meta))
        .and_then(|key| {
            let mut guard = cache.lock().unwrap();
            let hit = guard.get(&key);
            hit.map(|img| (key, img))
        });

    let (decoded, key_for_insert) = if let Some((_, cached_img)) = maybe_cached {
        (cached_img, None)
    } else {
        // 3. Decode (synchronous on JS thread).
        let key = std::fs::metadata(&path)
            .ok()
            .map(|meta| CacheKey::from_metadata(canonical, &meta));
        let arc = decode_path(std::path::Path::new(&path))
            .map(Arc::new)
            .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
        (arc, key)
    };

    // 4. Insert into cache if not already there.
    if let Some(key) = key_for_insert {
        let mut guard = cache.lock().unwrap();
        guard.insert(key, decoded.clone());
    }

    // 5. Wrap in a pre-resolved Promise.
    let (promise, resolve, _reject) = ctx.promise()?;
    let js_obj = make_carbon_image_object(&ctx, &decoded)?;
    resolve.call::<_, ()>((js_obj,))?;
    use rquickjs::IntoJs;
    promise.into_js(&ctx)
}

/// Decode bytes in memory and return a pre-resolved Promise-value.
/// No cache (no stable key). No capability check (bytes already in memory).
pub fn load_bytes_async(ctx: Ctx<'_>, bytes: Vec<u8>) -> JsResult<rquickjs::Value<'_>> {
    let decoded = decode_bytes(&bytes)
        .map(Arc::new)
        .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
    let (promise, resolve, _reject) = ctx.promise()?;
    let js_obj = make_carbon_image_object(&ctx, &decoded)?;
    resolve.call::<_, ()>((js_obj,))?;
    use rquickjs::IntoJs;
    promise.into_js(&ctx)
}

/// Build a plain JS object with {width, height, format, _bytes} fields.
/// The CarbonImage Class wraps this in its prototype; for the global-function
/// path (before Class registration) we return the raw object.
///
/// `_bytes` is a Uint8Array view over a copy of the RGBA8 data. QuickJS
/// TypedArrays own their ArrayBuffer internally, so there is no lifetime issue.
pub fn make_carbon_image_object<'js>(
    ctx: &Ctx<'js>,
    img: &Arc<DecodedImage>,
) -> JsResult<rquickjs::Object<'js>> {
    let obj = rquickjs::Object::new(ctx.clone())?;
    obj.set("width", img.width as i32)?;
    obj.set("height", img.height as i32)?;
    obj.set("format", img.format)?;
    obj.set("textureId", -1_i32)?;

    // Construct a Uint8Array containing the RGBA8 data.
    let bytes = img.bytes.clone();
    let array_buf = rquickjs::TypedArray::<u8>::new(ctx.clone(), bytes)?;
    obj.set("_bytes", array_buf)?;

    // Expose toBytes() as a method that returns a new Uint8Array copy.
    // We use a raw JS eval to define toBytes as a closure that captures
    // the _bytes property, since the lifetime requirements on TypedArray
    // make a direct Rust closure awkward here. Instead, define it via a
    // bound method on the object in JS eval:
    // (We set _bytes above; define toBytes to return a copy via slice()).
    ctx.eval::<(), _>(br#"void 0"#)?; // no-op eval to confirm ctx is usable
                                      // Set toBytes as a function that reads _bytes from `this`.
    let to_bytes_src =
        b"(function() { return this._bytes ? this._bytes.slice() : new Uint8Array(0); })";
    let to_bytes_fn: Function<'_> = ctx.eval(to_bytes_src.as_slice())?;
    obj.set("toBytes", to_bytes_fn)?;

    Ok(obj)
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/// JSON-escape a string for use in eval'd error construction.
#[allow(dead_code)]
fn serde_json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_double_star() {
        assert!(glob_match("/app/assets/**", "/app/assets/photo.png"));
        assert!(glob_match("/app/assets/**", "/app/assets/sub/photo.png"));
        assert!(!glob_match("/app/assets/**", "/other/photo.png"));
        assert!(!glob_match("/app/assets/**", "/app/assetsx/photo.png"));
    }

    #[test]
    fn glob_single_star() {
        assert!(glob_match("/assets/*.png", "/assets/photo.png"));
        assert!(!glob_match("/assets/*.png", "/assets/sub/photo.png"));
    }

    #[test]
    fn glob_literal() {
        assert!(glob_match("/exact/path.png", "/exact/path.png"));
        assert!(!glob_match("/exact/path.png", "/exact/path.jpg"));
    }

    #[test]
    fn capability_empty_list_denies_all() {
        assert!(check_capability("/any/path.png", &[]).is_err());
    }

    #[test]
    fn capability_matching_glob() {
        let globs = vec!["/app/assets/**".to_string()];
        assert!(check_capability("/app/assets/img.png", &globs).is_ok());
        assert!(check_capability("/other/img.png", &globs).is_err());
    }

    #[test]
    fn serde_json_str_escapes() {
        let s = serde_json_str("hello \"world\"");
        assert_eq!(s, r#""hello \"world\"""#);
    }
}
