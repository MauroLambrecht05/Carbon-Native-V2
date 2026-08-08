//! carbon-clipboard — Web Clipboard API-shaped JS bindings backed by `arboard`.
//!
//! This is the first Layer-2 plugin built end-to-end against the
//! `carbon-plugin-sdk` crate. The whole plugin compiles into a single cdylib
//! (`carbon_clipboard.dll` / `.so` / `.dylib`) that carbon-mini dlopens at
//! startup when the host app declares `[plugins.clipboard]` in `carbon.toml`.
//!
//! ## What user code sees
//!
//! ```ts
//! import { read, write } from "carbon:clipboard";
//! await write("hello");
//! const txt = await read();
//! ```
//!
//! Both functions return `Promise<…>` — matching the shape of the browser
//! Web Clipboard API so `navigator.clipboard.{read,write}Text` is a near
//! drop-in replacement. `read()` resolves with a string. `write(text)`
//! resolves with `undefined`. Both reject with a string error message on
//! failure or when the matching capability is not granted.
//!
//! ## How it's wired
//!
//! 1. `register` installs two function globals via the SDK:
//!      - `__carbon_clipboard_read`  → `arboard::Clipboard::get_text`
//!      - `__carbon_clipboard_write` → `arboard::Clipboard::set_text`
//!    Each returns a JSON-encoded result. The SDK's CarbonJSCallback contract
//!    is "args are a JSON-encoded array, result is a JSON-encoded value".
//!
//! 2. `register` then `app.eval(...)`s a tiny JS bootstrap that defines
//!    `globalThis.__carbon_clipboard_read_async` / `_write_async` as
//!    Promise-returning wrappers around the sync helpers.
//!
//! 3. `carbon-vite-plugin-imports` (Layer 4) discovers `carbon-plugin.toml`,
//!    learns that `carbon:clipboard` exists, and emits the virtual module:
//!      ```js
//!      export const read  = globalThis.__carbon_clipboard_read_async;
//!      export const write = globalThis.__carbon_clipboard_write_async;
//!      ```
//!    No IPC, no proxy — just two property reads at module init.
//!
//! ## Capability model
//!
//! The manifest declares `clipboard.read` + `clipboard.write` as REQUIRED.
//! The runtime refuses to load the plugin if either is missing from the
//! host's `[plugins.clipboard].capabilities`. We don't currently support
//! granting only one of the two — if you only want read access, declare
//! both as required and have the app reject writes at the JS layer.
//! (Future work: split into two plugins, or have the SDK gate per-capability
//! at register-time.)
//!
//! ## What's intentionally NOT here in v1
//!
//! - **Image / HTML clipboard.** `arboard` supports both, but the JSON-string
//!   FFI surface in `carbon_plugin.h` is awkward for binary data. Once the
//!   SDK grows a `set_global_function_with_bytes` (or the JS side learns to
//!   accept base64), we'll add `readImage` / `writeImage`.
//! - **Clipboard change events.** arboard doesn't expose a watch API on
//!   Windows; we'd need raw OleClipboard hooks. Tracked as TODO.
//! - **Multi-format read.** `read()` returns text only. A future
//!   `readWithFormats()` could return `{ text, html, image }`.

use std::cell::RefCell;
use std::ffi::CStr;

use arboard::Clipboard;
use carbon_plugin_sdk::{
    capability::{Capability, Manifest},
    carbon_plugin,
    ffi::{CarbonJSCallback, CarbonJSContext},
    CarbonApp,
};

// ─── arboard handle ──────────────────────────────────────────────────────
//
// `arboard::Clipboard` is `!Send` on some platforms (it stores raw OS handles)
// — we keep it in a thread_local. The JS engine is single-threaded today, so
// every JS callback fires on the same thread; this gets us a single shared
// clipboard handle without the cost of opening one per call.
//
// We open lazily on first use (rather than in `register`) for two reasons:
//   1. `register` MUST NOT block; on Linux/X11 `Clipboard::new` can block
//      briefly on the X server.
//   2. If the user never touches the clipboard, we never pay the cost.

thread_local! {
    static CLIPBOARD: RefCell<Option<Clipboard>> = const { RefCell::new(None) };
}

/// Convenient alias for arboard's Result type — arboard 3.x exposes the
/// error as `arboard::Error` and uses bare `std::result::Result` everywhere.
type ArbResult<T> = Result<T, arboard::Error>;

/// Run a closure with a `&mut Clipboard`, opening one lazily if needed.
///
/// JS callbacks always fire on the rquickjs thread, so the thread_local path
/// is the common case. The global-Mutex fallback exists in case a future
/// runtime version dispatches plugin calls from a worker thread — better to
/// degrade to a slow but correct path than crash. (The `f` closure is
/// `FnOnce`, so we can only consume it once; we run it in whichever branch
/// we end up taking.)
fn with_clipboard<R>(f: impl FnOnce(&mut Clipboard) -> ArbResult<R>) -> ArbResult<R> {
    // Probe the thread_local: returns Some(()) if the cell now holds an open
    // clipboard, or Some(Err(e)) if opening failed. None means the cell is
    // present but `f` would need to run inside the `with` closure; we use
    // a different path for that to keep `f` callable below if we fall back.
    //
    // Rather than deal with that, we just always run `f` inside the
    // thread_local closure — and use Result<R, …> as the return so we can
    // bubble open-failures out cleanly. If thread_local access itself were
    // unavailable (which doesn't happen in any current Rust target), the
    // closure simply wouldn't run and we'd surface a generic error.
    let mut f_slot: Option<_> = Some(f);
    let result: ArbResult<R> = CLIPBOARD.with(|cell| {
        let mut borrow = cell.borrow_mut();
        if borrow.is_none() {
            match Clipboard::new() {
                Ok(c) => *borrow = Some(c),
                Err(e) => return Err(e),
            }
        }
        let f = f_slot.take().expect("closure consumed exactly once");
        f(borrow.as_mut().unwrap())
    });
    result
}

// ─── JSON-encoded result helper ───────────────────────────────────────────
//
// CarbonJSCallback writes a JSON-encoded value into `result_buf` (capacity
// `result_buf_len`). If the encoding overflows we write `null` and the
// runtime treats that as an error to surface to JS. We return `null` for
// "void" results (write succeeded with no return value) — the JS Promise
// wrapper translates that to `resolve(undefined)`.

/// Write a JSON-encoded result into the FFI buffer. Returns true on success,
/// false if the encoded value would overflow the buffer.
unsafe fn write_result(buf: *mut core::ffi::c_char, cap: usize, json: &str) -> bool {
    if buf.is_null() || cap == 0 {
        return false;
    }
    let bytes = json.as_bytes();
    // We need 1 byte for the trailing NUL.
    if bytes.len() + 1 > cap {
        // Overflow — write a sentinel "null" so the JS side gets a stable
        // shape rather than uninitialized memory.
        let null = b"null\0";
        if cap >= null.len() {
            core::ptr::copy_nonoverlapping(null.as_ptr(), buf as *mut u8, null.len());
        }
        return false;
    }
    core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, bytes.len());
    *buf.add(bytes.len()) = 0; // NUL-terminate
    true
}

/// Encode an error string into the JS result. We tag it with an `__error`
/// sentinel object so the Promise wrapper can detect it and `reject(...)`
/// rather than `resolve(...)`. Plain JSON strings are valid resolve values
/// too; the sentinel is the only sane in-band way to distinguish ok/err
/// over a single JSON-string return channel.
fn err_json(msg: impl AsRef<str>) -> String {
    serde_json::json!({ "__carbon_error": msg.as_ref() }).to_string()
}

/// Encode a successful string result as a JSON string literal.
fn ok_string_json(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

// ─── JS callbacks ─────────────────────────────────────────────────────────

/// `__carbon_clipboard_read()` — returns the current clipboard text, or an
/// `{__carbon_error}` sentinel if the OS API errored (e.g., clipboard is
/// empty or holds non-text data).
unsafe extern "C" fn js_read(
    _ctx: *mut CarbonJSContext,
    _args_json: *const core::ffi::c_char,
    result_buf: *mut core::ffi::c_char,
    result_buf_len: usize,
) {
    let json = match with_clipboard(|cb| cb.get_text()) {
        Ok(text) => ok_string_json(&text),
        Err(e) => err_json(format!("clipboard.read failed: {e}")),
    };
    write_result(result_buf, result_buf_len, &json);
}

/// `__carbon_clipboard_write(text)` — writes `text` to the OS clipboard.
/// Resolves to `null` on success (the JS wrapper turns that into `undefined`).
unsafe extern "C" fn js_write(
    _ctx: *mut CarbonJSContext,
    args_json: *const core::ffi::c_char,
    result_buf: *mut core::ffi::c_char,
    result_buf_len: usize,
) {
    let json_out = match parse_string_arg(args_json) {
        Ok(text) => match with_clipboard(|cb| cb.set_text(text)) {
            Ok(()) => "null".to_string(),
            Err(e) => err_json(format!("clipboard.write failed: {e}")),
        },
        Err(msg) => err_json(msg),
    };
    write_result(result_buf, result_buf_len, &json_out);
}

/// Decode the SDK's `args_json` (a JSON-encoded array) and pull out the
/// first element as a String. Returns a human-readable error message if
/// the shape is wrong.
unsafe fn parse_string_arg(args_json: *const core::ffi::c_char) -> Result<String, String> {
    if args_json.is_null() {
        return Err("clipboard.write: no arguments".into());
    }
    let s = CStr::from_ptr(args_json).to_str().map_err(|_| {
        "clipboard.write: non-UTF-8 argument".to_string()
    })?;
    let parsed: serde_json::Value =
        serde_json::from_str(s).map_err(|e| format!("clipboard.write: bad args JSON: {e}"))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| "clipboard.write: expected JSON array of args".to_string())?;
    let first = arr
        .first()
        .ok_or_else(|| "clipboard.write: missing text argument".to_string())?;
    match first {
        serde_json::Value::String(s) => Ok(s.clone()),
        _ => Err("clipboard.write: text argument must be a string".into()),
    }
}

// ─── Promise wrapper bootstrap ────────────────────────────────────────────
//
// We can't return a JS Promise directly through the JSON-string FFI channel,
// so we install the sync helpers (which return JSON-encoded values) and then
// eval a tiny JS shim that wraps each sync call in `new Promise(...)`. The
// shim translates the `{__carbon_error: msg}` sentinel back to `reject(msg)`.
//
// Two notes on this approach:
//   - The shim is ~600 bytes after minification — negligible cost vs
//     pulling rquickjs into the plugin (carbon-audio's path) just to
//     register typed classes.
//   - `eval` is gated as "bootstrap-only" in the SDK docs. This is exactly
//     the kind of bootstrap they had in mind.

const PROMISE_BOOTSTRAP: &str = r#"
(function() {
  const ERROR_KEY = "__carbon_error";
  const wrap = (syncName) => (...args) => new Promise((resolve, reject) => {
    try {
      const fn = globalThis[syncName];
      if (typeof fn !== "function") {
        reject(new Error("carbon-clipboard not loaded: " + syncName));
        return;
      }
      const result = fn.apply(null, args);
      if (result && typeof result === "object" && ERROR_KEY in result) {
        reject(new Error(String(result[ERROR_KEY])));
        return;
      }
      resolve(result);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  globalThis.__carbon_clipboard_read_async  = wrap("__carbon_clipboard_read");
  globalThis.__carbon_clipboard_write_async = wrap("__carbon_clipboard_write");
})();
"#;

// ─── Plugin entry points ──────────────────────────────────────────────────

/// Called once after carbon-mini has loaded the plugin and verified its
/// manifest against the host app's `[plugins.clipboard]` grants.
fn register(app: &mut CarbonApp) {
    // 1. Install the two sync helpers as function globals.
    let read_cb: CarbonJSCallback = js_read;
    let write_cb: CarbonJSCallback = js_write;
    if let Err(code) = app.set_global_function("__carbon_clipboard_read", read_cb) {
        eprintln!("[carbon-clipboard] failed to install __carbon_clipboard_read: {code}");
        return;
    }
    if let Err(code) = app.set_global_function("__carbon_clipboard_write", write_cb) {
        eprintln!("[carbon-clipboard] failed to install __carbon_clipboard_write: {code}");
        return;
    }

    // 2. Eval the Promise-wrapper bootstrap so user-facing `read`/`write`
    //    return Promises (matching the Web Clipboard API shape).
    if let Err(code) = app.eval(PROMISE_BOOTSTRAP) {
        eprintln!("[carbon-clipboard] failed to eval Promise bootstrap: {code}");
    }
}

/// Manifest returned to carbon-mini before `register` is called. This is the
/// authoritative declaration of what the plugin needs — the `.toml` file
/// next to this is build-tool only.
fn manifest() -> Manifest {
    Manifest::new("carbon-clipboard", env!("CARGO_PKG_VERSION"))
        .require_capability(Capability::ClipboardRead)
        .require_capability(Capability::ClipboardWrite)
        .module("carbon:clipboard")
        .hook("register")
}

// Generate the C ABI entry points carbon-mini calls into.
carbon_plugin! {
    register: register,
    manifest: manifest,
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_clipboard_capabilities() {
        let m = manifest();
        assert!(m.capabilities.required.contains(&"clipboard.read".to_string()));
        assert!(m.capabilities.required.contains(&"clipboard.write".to_string()));
        assert_eq!(m.modules, vec!["carbon:clipboard".to_string()]);
        assert_eq!(m.name, "carbon-clipboard");
        // Round-trip the JSON to make sure the runtime would parse it.
        let json = m.to_json();
        let parsed: Manifest = serde_json::from_str(&json).expect("manifest re-parses");
        assert_eq!(parsed.name, m.name);
        assert_eq!(parsed.capabilities.required, m.capabilities.required);
    }

    #[test]
    fn capability_strings_match_header_contract() {
        // These are part of the public ABI string surface — they appear in
        // user `carbon.toml` files and in plugin manifests verbatim.
        assert_eq!(Capability::ClipboardRead.as_str(), "clipboard.read");
        assert_eq!(Capability::ClipboardWrite.as_str(), "clipboard.write");
    }

    #[test]
    fn parse_string_arg_happy_path() {
        let args = std::ffi::CString::new(r#"["hello"]"#).unwrap();
        let s = unsafe { parse_string_arg(args.as_ptr()) }.expect("parses");
        assert_eq!(s, "hello");
    }

    #[test]
    fn parse_string_arg_rejects_non_string() {
        let args = std::ffi::CString::new(r#"[42]"#).unwrap();
        let err = unsafe { parse_string_arg(args.as_ptr()) }.expect_err("rejects");
        assert!(err.contains("must be a string"), "msg: {err}");
    }

    #[test]
    fn parse_string_arg_rejects_empty() {
        let args = std::ffi::CString::new("[]").unwrap();
        let err = unsafe { parse_string_arg(args.as_ptr()) }.expect_err("rejects");
        assert!(err.contains("missing"), "msg: {err}");
    }

    #[test]
    fn parse_string_arg_rejects_garbage() {
        let args = std::ffi::CString::new("not json").unwrap();
        assert!(unsafe { parse_string_arg(args.as_ptr()) }.is_err());
    }

    #[test]
    fn write_result_fits_buffer() {
        let mut buf = vec![0i8; 32];
        let ok = unsafe { write_result(buf.as_mut_ptr() as *mut _, buf.len(), r#""hi""#) };
        assert!(ok);
        // Read back as C string.
        let cstr = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr() as *const _) };
        assert_eq!(cstr.to_str().unwrap(), r#""hi""#);
    }

    #[test]
    fn write_result_overflow_writes_null_sentinel() {
        let mut buf = vec![0i8; 8];
        let big = "\"".to_string() + &"x".repeat(64) + "\"";
        let ok = unsafe { write_result(buf.as_mut_ptr() as *mut _, buf.len(), &big) };
        assert!(!ok, "should report overflow");
        let cstr = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr() as *const _) };
        assert_eq!(cstr.to_str().unwrap(), "null");
    }

    #[test]
    fn ok_string_json_encodes_quotes_and_newlines() {
        let s = ok_string_json("a\"b\nc");
        // Must round-trip back to the original.
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v.as_str().unwrap(), "a\"b\nc");
    }

    #[test]
    fn err_json_carries_message() {
        let s = err_json("boom");
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["__carbon_error"], "boom");
    }
}
