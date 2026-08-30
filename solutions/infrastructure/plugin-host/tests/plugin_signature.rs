//! The trust gate in `plugin_loader::load_one`, exercised against a REAL
//! compiled plugin.
//!
//! ── WHY THIS IS OPT-IN RATHER THAN ALWAYS-ON ────────────────────────────────
//! `tests/plugin_loader.rs` explains why loading a real `.dll` end to end is
//! deliberately not in the default suite: it was fragile across CI vs local and
//! MSVC vs GNU in V1. That reasoning still holds, and nothing here changes it —
//! so this file needs a plugin someone already built, named by an environment
//! variable, and does nothing at all without one. It is a check you RUN, not a
//! check that runs itself:
//!
//!   cd labs/examples/pulse/carbon/plugins/local/carbon-hotkey && zig build
//!   cargo run -p carbon-plugin-trust --bin carbon-plugin-sign -- \
//!       sign zig-out/lib/carbon_hotkey.dll
//!   CARBON_TEST_SIGNED_PLUGIN=<abs path to carbon_hotkey.dll> \
//!       cargo test -p carbon-plugin-host --test plugin_signature -- --nocapture
//!
//! The alternative — committing a prebuilt signed `.dll` fixture — would put a
//! binary in the repository (which the tree bans, see publishing/rust's note on
//! the two vendored `.exe`s it replaced) and would pin the test to one platform
//! and one ABI forever.
//!
//! ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
//! Both directions, through the real public entry point
//! (`PluginRegistry::load_from_config`), not a reimplementation of the check:
//!
//!   1. a correctly signed plugin loads;
//!   2. flipping one byte of the `.dll` makes it refuse;
//!   3. flipping one byte of the `.sig` makes it refuse;
//!   4. deleting the `.sig` makes it refuse.
//!
//! Each of (2)–(4) runs against a COPY in a temp directory, so the real
//! artifact is never damaged.

use carbon_core::config::{AppManifest, AppManifestEntry, CapabilityGrant, PluginSource};
use carbon_plugin_host::host_exports::{HostCarbonApp, HostCarbonAppStorage};
use carbon_plugin_host::plugin_loader::PluginRegistry;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// The plugin under test, or `None` when this check was not asked for.
fn signed_plugin() -> Option<PathBuf> {
    let raw = std::env::var_os("CARBON_TEST_SIGNED_PLUGIN")?;
    let path = PathBuf::from(raw);
    assert!(
        path.is_file(),
        "CARBON_TEST_SIGNED_PLUGIN points at {} which is not a file",
        path.display()
    );
    Some(path)
}

// Mirrors plugin_loader.rs's own (private) native_os_name/native_arch_name/
// native_ext — duplicated rather than exposed, since this test only ever
// runs against the host it's compiled for anyway.
fn native_ext() -> &'static str {
    if cfg!(target_os = "windows") {
        "dll"
    } else if cfg!(target_os = "macos") {
        "dylib"
    } else {
        "so"
    }
}

fn native_dir_suffix() -> PathBuf {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        if cfg!(target_os = "macos") {
            "arm64"
        } else {
            "aarch64"
        }
    } else {
        "x86_64"
    };
    Path::new("carbon").join("native").join(os).join(arch)
}

/// Load exactly one plugin, staged the way `carbon/build.zig` would, and
/// report how many made it in.
///
/// Goes through `load_from_config` — the same call the runtime makes — so the
/// gate under test is the one that actually ships, ordering included.
fn load_count(project_dir: &Path) -> usize {
    let mut plugins = BTreeMap::new();
    plugins.insert(
        "carbon-hotkey".to_string(),
        AppManifestEntry {
            source: PluginSource::Local,
            enabled: true,
            version: None,
        },
    );
    let manifest = AppManifest { plugins };
    let grants: BTreeMap<String, CapabilityGrant> = BTreeMap::new();

    let mut storage = HostCarbonAppStorage::new("sig-test", "0.0.1", ".", 100, 100);
    let app: *mut HostCarbonApp = storage.raw();
    let registry = PluginRegistry::load_from_config(&manifest, &grants, project_dir, app)
        .expect("load_from_config never fails as a whole; it skips");
    registry.plugin_count()
}

/// Stage `<dll>` and `<dll>.sig` into a fresh temp directory shaped like
/// `<dir>/carbon/native/<os>/<arch>/carbon-hotkey.<ext>` — exactly what
/// `carbon/build.zig` would have produced — so a tampering test can mutate
/// the copy without touching the artifact the developer built. Returns the
/// PROJECT dir (what `load_count` takes), not the staged file itself.
fn stage_copy(dll: &Path, tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("carbon-sig-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let native_dir = dir.join(native_dir_suffix());
    fs::create_dir_all(&native_dir).expect("temp dir");

    let copy = native_dir.join(format!("carbon-hotkey.{}", native_ext()));
    fs::copy(dll, &copy).expect("copy dll");

    let src_sig = PathBuf::from(format!("{}.sig", dll.display()));
    let copy_sig = PathBuf::from(format!("{}.sig", copy.display()));
    fs::copy(&src_sig, &copy_sig).expect("copy sig — did you run `carbon-plugin-sign sign`?");

    (dir, copy, copy_sig)
}

#[test]
fn a_correctly_signed_plugin_loads() {
    let Some(dll) = signed_plugin() else {
        eprintln!("skipped: set CARBON_TEST_SIGNED_PLUGIN to run this");
        return;
    };
    let (dir, _, _) = stage_copy(&dll, "ok");
    assert_eq!(
        load_count(&dir),
        1,
        "a plugin signed with Carbon's key should load"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_tampered_dll_is_refused() {
    let Some(dll) = signed_plugin() else {
        eprintln!("skipped: set CARBON_TEST_SIGNED_PLUGIN to run this");
        return;
    };
    let (dir, copy, _) = stage_copy(&dll, "dll");

    // One byte, somewhere in the middle of the image, so the file is still a
    // structurally valid DLL that the OS loader would happily map. The point is
    // that the refusal comes from the signature, not from a corrupt header.
    let mut bytes = fs::read(&copy).expect("read copy");
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0x01;
    fs::write(&copy, &bytes).expect("write tampered copy");

    assert_eq!(
        load_count(&dir),
        0,
        "a plugin with one flipped byte must not load"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_tampered_signature_is_refused() {
    let Some(dll) = signed_plugin() else {
        eprintln!("skipped: set CARBON_TEST_SIGNED_PLUGIN to run this");
        return;
    };
    let (dir, _copy, sig) = stage_copy(&dll, "sig");

    let mut bytes = fs::read(&sig).expect("read sig");
    bytes[0] ^= 0x01;
    fs::write(&sig, &bytes).expect("write tampered sig");

    assert_eq!(load_count(&dir), 0, "a forged signature must not load");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_unsigned_plugin_is_refused() {
    let Some(dll) = signed_plugin() else {
        eprintln!("skipped: set CARBON_TEST_SIGNED_PLUGIN to run this");
        return;
    };
    let (dir, _copy, sig) = stage_copy(&dll, "unsigned");
    fs::remove_file(&sig).expect("remove sig");

    assert_eq!(
        load_count(&dir),
        0,
        "a plugin with no signature at all must not load"
    );
    let _ = fs::remove_dir_all(&dir);
}
