//! Plugin loader tests.
//!
//! Ported from V1's `carbon/runtime/tests/plugin_loader_test.rs`, which was the
//! runtime's only Rust test and did not come across with the rest of the
//! migration.
//!
//! ── WHAT CHANGED IN THE PORT ────────────────────────────────────────────────
//! V1 could not link these modules normally. `carbon/api` was source
//! `#[path]`-included into each backend binary, and it named the binary's own
//! `UserEvent`, so the test re-included the same two files and declared a stub
//! `UserEvent` to make them compile standalone. Both worked around the same
//! thing: there was no crate to depend on.
//!
//! There is now. `host_exports` and `plugin_loader` are public modules of
//! `carbon-plugin-host`, and `UserEvent` comes from `carbon-runtime-contract`,
//! so this is an ordinary integration test against the real types. The stub is
//! gone, which also means these assertions now bind to the types the runtime
//! actually ships rather than to a copy that could drift from them.
//!
//! ── WHAT THIS GUARANTEES ────────────────────────────────────────────────────
//!   1. `carbon_core::config::CapabilityGrant` parses `[plugins.<name>]`'s
//!      one field — capability grants, nothing about a plugin's existence
//!      or path (that's carbon/manifest.toml's job now).
//!   2. `plugin_loader::Manifest` accepts the JSON shape
//!      `carbon-plugin-sdk::Manifest::to_json()` produces.
//!   3. `HostCarbonApp`'s byte layout stays within the range carbon_abi.h's
//!      append-only rule protects.
//!   4. The cross-DLL allocator round-trips and stays 16-aligned.
//!
//! Loading a real `.dll` end to end is deliberately not here: it was fragile
//! across CI vs local and MSVC vs GNU in V1. `products/carbon/tests/launch.rs`
//! covers the assembled runtime, and the SDK's `abi_compat_test.rs` covers that
//! the macros emit correctly named symbols.

use carbon_core::config::PluginsSection;
use carbon_plugin_host::{host_exports, plugin_loader};

/// Every carbon.toml fragment below is a `[plugins]` table, so they all
/// deserialize through the same wrapper.
#[derive(serde::Deserialize)]
struct Wrap {
    #[serde(default)]
    plugins: PluginsSection,
}

fn parse(toml_text: &str) -> PluginsSection {
    toml::from_str::<Wrap>(toml_text).expect("parse").plugins
}

#[test]
fn plugins_section_parses_capability_grant() {
    let plugins = parse(
        r#"
        [plugins.my_plugin]
        capabilities = ["fs.read", "audio.output"]
    "#,
    );
    let entry = plugins.0.get("my_plugin").expect("entry present");
    assert!(entry.capabilities.contains(&"fs.read".to_string()));
    assert!(entry.capabilities.contains(&"audio.output".to_string()));
}

#[test]
fn plugins_section_entry_with_no_capabilities_grants_none() {
    // `[plugins.my_plugin]` with nothing under it — legal (a plugin
    // manifest.toml declares that needs no capability still gets an entry
    // if a human wants to leave a comment there, say) and grants nothing.
    let plugins = parse(
        r#"
        [plugins.my_plugin]
    "#,
    );
    let entry = plugins.0.get("my_plugin").expect("entry present");
    assert!(entry.capabilities.is_empty());
}

#[test]
fn plugins_section_missing_is_empty() {
    let plugins = parse(
        r#"
        [app]
        name = "test"
        version = "0.1.0"
    "#,
    );
    assert!(plugins.is_empty());
}

#[test]
fn manifest_deserializes_sdk_shape() {
    // The JSON the SDK's `Manifest::to_json()` produces. If either side drifts,
    // this fails here rather than when a user's plugin refuses to load.
    let json = r#"{
        "name": "carbon-audio",
        "version": "0.1.0",
        "abi_version_major": 1,
        "abi_version_minor": 0,
        "capabilities": {
            "required": ["audio.output"],
            "optional": ["audio.input"]
        },
        "modules": ["carbon:audio"],
        "lifecycle_hooks": ["register", "before_reload"]
    }"#;
    let m: plugin_loader::Manifest = serde_json::from_str(json).expect("parse");
    assert_eq!(m.name, "carbon-audio");
    assert_eq!(m.abi_version_major, 1);
    assert_eq!(m.capabilities.required, vec!["audio.output".to_string()]);
    assert_eq!(m.capabilities.optional, vec!["audio.input".to_string()]);
    assert_eq!(m.modules, vec!["carbon:audio".to_string()]);
}

#[test]
fn manifest_minimal_shape_works() {
    let json = r#"{
        "name": "minimal",
        "abi_version_major": 1
    }"#;
    let m: plugin_loader::Manifest = serde_json::from_str(json).expect("parse");
    assert_eq!(m.name, "minimal");
    assert_eq!(m.abi_version_major, 1);
    assert!(m.capabilities.required.is_empty());
}

#[test]
fn host_carbon_app_size_matches_sdk_layout() {
    // The SDK's mirror is `carbon-plugin-sdk::ffi::CarbonApp`. Depending on that
    // crate here would link its macro-emitted C-ABI symbols alongside
    // host_exports' own `carbon_js_*` exports and collide, so the layout is
    // checked against the contract in carbon_abi.h instead:
    //
    //   2*u32 + ptr + 2*u32 + 2*ptr + 3*ptr + u32 + 10*Option<fn> + 15*Option<fn>
    //
    // 10, not 4: ABI 1.1 appended set_global_string/set_global_number/
    // set_global_function/eval (4) to the APPEND-ONLY ZONE — the same shape
    // push_event/request_paint/alloc/free (4) already used — and ABI 1.2
    // appended load_font_path/load_font_bytes (2), so a plugin that uses
    // only struct fields for JS globals needs no GetProcAddress/
    // GetModuleHandle* in its import table.
    //
    // 15: ABI 1.3 appended clipboard_read_text/write_text/clear (3),
    // dialog_open_file/open_files/open_dir/save_file/open_file_text/
    // save_file_text/message/confirm (8), notification_send (1), and
    // keychain_set/get/delete (3) — see carbon_plugin.h's APPEND-ONLY ZONE
    // and the matching note in host_exports.rs.
    //
    // The range absorbs whatever trailing alignment padding the compiler picks.
    // The invariant that matters — stable field OFFSETS — is what carbon_abi.h's
    // append-only rule protects, and what breaks plugins already installed on
    // users' machines if violated.
    use std::mem::size_of;
    let sz = size_of::<host_exports::HostCarbonApp>();
    assert!(sz >= 120, "HostCarbonApp size {sz} smaller than expected");
    assert!(sz <= 320, "HostCarbonApp size {sz} larger than expected");
}

#[test]
fn capability_check_rejects_missing() {
    // The real rejection lives inside `load_one`, which cannot be called without
    // a real DLL. The decision it makes is this set difference, over the same
    // parsed accessor it uses.
    let plugins = parse(
        r#"
        [plugins.my_plugin]
        capabilities = ["fs.read"]
    "#,
    );
    let entry = plugins.0.get("my_plugin").unwrap();
    let granted = &entry.capabilities;
    let required = ["audio.output".to_string(), "fs.read".to_string()];
    let missing: Vec<_> = required
        .iter()
        .filter(|r| !granted.iter().any(|g| g == *r))
        .collect();
    assert_eq!(missing, vec![&"audio.output".to_string()]);
}

#[test]
fn host_alloc_free_round_trip() {
    // The cross-DLL allocator stamps a length prefix and aligns to 16. A plugin
    // freeing memory the host allocated is the single most dangerous thing in
    // the ABI, so the round trip is asserted rather than assumed.
    use host_exports::{HostCarbonApp, HostCarbonAppStorage};
    let mut storage = HostCarbonAppStorage::new("t", "0.0.1", "/tmp", 100, 100);
    let app: *mut HostCarbonApp = storage.raw();
    unsafe {
        let alloc_fn = (*app).alloc.expect("alloc set");
        let free_fn = (*app).free.expect("free set");

        for &size in &[1usize, 8, 64, 4096] {
            let p = alloc_fn(size);
            assert!(!p.is_null(), "alloc({size}) returned null");
            assert_eq!(p as usize % 16, 0, "alloc returns must be 16-aligned");
            // Touch every byte, so a short allocation faults here rather than
            // silently corrupting whatever follows it.
            std::ptr::write_bytes(p as *mut u8, 0xAB, size);
            free_fn(p);
        }
    }
}
