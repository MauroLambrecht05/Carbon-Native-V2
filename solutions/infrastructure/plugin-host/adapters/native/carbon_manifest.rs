// Re-parses the app's own carbon.toml and hands back a JSON snapshot of
// the fields an app has a legitimate runtime reason to introspect — backs
// the `manifest_read` ABI trampoline in abi/host_exports.rs (ABI 1.23).
//
// Fresh on every call, not cached: carbon.toml can change under `carbon
// dev` (no file-watch/restart tie-in exists for it the way the JS bundle
// has one), and re-parsing a small TOML file is cheap enough that caching
// would only add a staleness bug for no measurable benefit.
//
// Deliberately excludes `[dev-signing] trusted_keys` and each plugin
// grant's free-form `config` blob — the former is a build-time trust
// anchor with no runtime use case, the latter is "reserved for future
// use" per carbon_core::config::CapabilityGrant's own doc comment and not
// yet a stable contract worth exposing.
//
// PLATFORM: none — plain file I/O, works everywhere.

use anyhow::{anyhow, Result};
use carbon_core::config::Config;
use std::path::Path;

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn json_string_array(items: &[String]) -> String {
    let inner: Vec<String> = items.iter().map(|s| json_escape(s)).collect();
    format!("[{}]", inner.join(","))
}

fn json_opt_string(s: &Option<String>) -> String {
    match s {
        Some(v) => json_escape(v),
        None => "null".to_string(),
    }
}

pub fn read(project_dir: &str) -> Result<String> {
    let cfg = Config::load(Path::new(project_dir)).map_err(|e| anyhow!("carbon.toml: {e}"))?;

    let window = &cfg.app.window;
    let caps = &cfg.app.capabilities;

    let mut plugins_json = String::from("{");
    for (i, (name, grant)) in cfg.plugins.iter().enumerate() {
        if i > 0 {
            plugins_json.push(',');
        }
        plugins_json.push_str(&format!(
            "{}:{{\"capabilities\":{}}}",
            json_escape(name),
            json_string_array(&grant.capabilities)
        ));
    }
    plugins_json.push('}');

    Ok(format!(
        "{{\"app\":{{\"name\":{},\"version\":{},\"displayName\":{},\"window\":{{\"title\":{},\"width\":{},\"height\":{},\"resizable\":{},\"decorations\":{}}}}},\
\"runtime\":{{\"backend\":{},\"bytecode\":{},\"image\":{},\"audio\":{}}},\
\"capabilities\":{{\"fsRead\":{},\"fsWrite\":{},\"netFetch\":{},\"systemNotify\":{},\"imageRead\":{}}},\
\"plugins\":{}}}",
        json_escape(&cfg.app.name),
        json_escape(&cfg.app.version),
        json_opt_string(&cfg.app.display_name),
        json_opt_string(&window.title),
        window.width,
        window.height,
        window.resizable,
        window.decorations,
        json_escape(&cfg.runtime.backend),
        cfg.runtime.bytecode,
        cfg.runtime.image,
        cfg.runtime.audio,
        json_string_array(&caps.fs_read),
        json_string_array(&caps.fs_write),
        json_string_array(&caps.net_fetch),
        caps.system_notify,
        json_string_array(&caps.image_read),
        plugins_json,
    ))
}
