// System theme tracker. Sits between `main.rs` (which receives
// `WindowEvent::ThemeChanged` from tao + reads the initial value off
// the WindowBuilder) and `native/os.rs` (which exposes the current
// value to JS via `__cm_os_theme()`).
//
// Storage is a `Mutex<&'static str>` of {"light", "dark"}. The
// integers route through &'static str so the JS host import returns
// owned strings without any allocation per call beyond Rust →
// rquickjs marshalling.

use std::sync::Mutex;
use std::sync::OnceLock;

fn slot() -> &'static Mutex<&'static str> {
    static S: OnceLock<Mutex<&'static str>> = OnceLock::new();
    S.get_or_init(|| Mutex::new("light"))
}

pub fn set(theme: &str) {
    let s = if theme.eq_ignore_ascii_case("dark") { "dark" } else { "light" };
    *slot().lock().unwrap_or_else(|e| e.into_inner()) = s;
}

pub fn current() -> String {
    (*slot().lock().unwrap_or_else(|e| e.into_inner())).to_string()
}
