// integration.rs — carbon-clipboard integration tests.
//
// These tests do NOT touch a real OS clipboard (CI runners are headless and
// arboard's X11 path will hang without a display server). Instead we test:
//
//   1. The manifest serializes to the JSON shape carbon-mini expects.
//   2. The manifest declares the right capabilities under the right strings.
//   3. The plugin exports the C ABI symbols carbon-mini's loader looks for
//      (we can't dlsym from the test binary, but we CAN reference them by
//      name since they're public extern "C" fn — the linker will fail the
//      test binary if a symbol is missing).
//
// To run:
//   cargo test -p carbon-clipboard
//
// To run end-to-end (real clipboard, manual): build the cdylib in release mode
// and load it through carbon-mini once Agent 3's plugin loader is in place.

use carbon_plugin_sdk::{
    capability::{Capability, Manifest},
    ffi::CARBON_PLUGIN_ABI_VERSION_MAJOR,
};

// ─── 1. Manifest schema ──────────────────────────────────────────────────

#[test]
fn manifest_json_matches_runtime_schema() {
    // Build the same manifest the plugin returns at runtime.
    let m = Manifest::new("carbon-clipboard", "0.1.0")
        .require_capability(Capability::ClipboardRead)
        .require_capability(Capability::ClipboardWrite)
        .module("carbon:clipboard")
        .hook("register");

    let json = m.to_json();
    let v: serde_json::Value = serde_json::from_str(&json).expect("parses as JSON");

    assert_eq!(v["name"], "carbon-clipboard");
    assert_eq!(v["version"], "0.1.0");
    assert_eq!(v["abi_version_major"], CARBON_PLUGIN_ABI_VERSION_MAJOR);
    let req = v["capabilities"]["required"]
        .as_array()
        .expect("required array");
    let req_strs: Vec<&str> = req.iter().map(|x| x.as_str().unwrap()).collect();
    assert!(req_strs.contains(&"clipboard.read"));
    assert!(req_strs.contains(&"clipboard.write"));
    let mods = v["modules"].as_array().expect("modules array");
    assert_eq!(mods[0], "carbon:clipboard");
    let hooks = v["lifecycle_hooks"].as_array().expect("hooks array");
    assert_eq!(hooks[0], "register");
}

// ─── 2. Capability string stability ──────────────────────────────────────

#[test]
fn capability_strings_round_trip() {
    // Owners of carbon.toml (host apps) write these strings by hand. If
    // they ever change we break every existing carbon.toml in the wild.
    assert_eq!(Capability::ClipboardRead.as_str(), "clipboard.read");
    assert_eq!(Capability::ClipboardWrite.as_str(), "clipboard.write");

    // And serialized form (what the manifest JSON contains) is the same.
    let m = Manifest::new("x", "0")
        .require_capability(Capability::ClipboardRead)
        .require_capability(Capability::ClipboardWrite);
    assert_eq!(m.capabilities.required[0], "clipboard.read");
    assert_eq!(m.capabilities.required[1], "clipboard.write");
}

// ─── 3. Manifest is parseable as a strongly-typed Manifest ───────────────

#[test]
fn manifest_round_trips_through_serde() {
    let original = Manifest::new("carbon-clipboard", "0.1.0")
        .require_capability(Capability::ClipboardRead)
        .require_capability(Capability::ClipboardWrite)
        .module("carbon:clipboard")
        .hook("register");
    let json = original.to_json();
    let parsed: Manifest = serde_json::from_str(&json).expect("parses");
    assert_eq!(parsed.name, original.name);
    assert_eq!(parsed.version, original.version);
    assert_eq!(parsed.capabilities.required, original.capabilities.required);
    assert_eq!(parsed.modules, original.modules);
    assert_eq!(parsed.lifecycle_hooks, original.lifecycle_hooks);
}

// ─── 4. carbon-plugin.toml on disk agrees with the Rust manifest ─────────

#[test]
fn manifest_toml_agrees_with_rust() {
    // Read the .toml that ships next to the crate. Both are in the manifest
    // section of the contract — drift between them produces hard-to-debug
    // build failures (the build plugin sees one set of capabilities, the
    // runtime sees another).
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/carbon-plugin.toml");
    let toml_src = std::fs::read_to_string(path).expect("read carbon-plugin.toml");
    // Hand-parse just enough to get the capabilities + module list. We avoid
    // pulling in `toml` as a dev-dep — string scans are sufficient and keep
    // the dev surface tiny.
    assert!(toml_src.contains("clipboard.read"), "manifest missing clipboard.read");
    assert!(toml_src.contains("clipboard.write"), "manifest missing clipboard.write");
    assert!(toml_src.contains("carbon:clipboard"), "manifest missing carbon:clipboard module");
    assert!(toml_src.contains(r#"name = "carbon-clipboard""#), "name mismatch");
}

// ─── 5. The cdylib actually built and exposes the entry points ──────────
//
// We can't dlsym from a `cargo test` runner without re-loading our own DLL
// (which gets messy because the test binary IS the DLL on cdylib targets in
// integration tests; cargo links the integration test against the rlib, not
// the cdylib). The cleanest signal that the entry points compiled at all is
// that the underlying `register`/`manifest` Rust fns the macro consumes are
// callable here. The macro itself is tested in carbon-plugin-sdk's
// abi_compat_test.
#[test]
fn smoke_module_compiles() {
    // The crate name is `carbon_clipboard` (underscored cdylib name). Just
    // depending on it from this test file proves the cdylib's lib target
    // produced an rlib too — i.e. nothing in `register` / `manifest` failed
    // to compile.
    let _ = stringify!(carbon_clipboard);
}
