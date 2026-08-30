// Deep-linking (custom URL scheme) self-registration + single-instance
// URL forwarding, backing `deeplink_register` (ABI 1.6,
// abi/host_exports.rs).
//
// NO PRECEDENT IN THIS CODEBASE — confirmed by research before writing
// this: no registry writes, no Info.plist CFBundleURLTypes, no .desktop
// MimeType=, no single-instance enforcement anywhere. The closest relative
// is autostart.rs, which self-registers with the OS AT RUNTIME (not at
// install time) — this follows that same shape for Windows/Linux.
//
// ── WHY std::net, NOT A NAMED-PIPE/UNIX-SOCKET CRATE ────────────────────
// The obvious crate for the single-instance IPC piece (`interprocess`,
// cross-platform named pipes / Unix sockets) was deliberately NOT used —
// its own README carries an explicit, direct request that LLM coding
// assistants not use it. A loopback TCP listener via plain `std::net`
// covers the same need (single machine, single user session) with zero
// new dependencies. Real trade-off, stated plainly: unlike a named pipe
// with a Windows ACL or a Unix socket with file permissions, a loopback
// TCP port has no built-in access control — any other LOCAL process could
// in principle connect and claim to be "a second launch." For a
// dev-friendly "don't open two windows" mechanism (not a security
// boundary — the port carries a URL string, nothing privileged) that is
// an acceptable v1 trade-off, not a silently ignored one.
//
// ── macOS ────────────────────────────────────────────────────────────────
// Genuinely NOT runtime-registerable — CFBundleURLTypes must be baked into
// Info.plist at package time. register() on macOS returns an error saying
// so rather than silently doing nothing; see the packaging generator
// (dmg.ts) for the build-time half of this feature.
//
// ── SINGLE-INSTANCE IS BEST-EFFORT, NOT ZERO-FLASH ──────────────────────
// Plugins load AFTER the window already exists (see mini.rs: window at
// construction, plugin load later) — there is no lifecycle hook early
// enough for a plugin to block window creation on "is another instance
// already running." A second launch's window can flash briefly before
// this code detects the first instance, forwards the URL, and exits the
// process. Fixing that fully needs a new, earlier lifecycle hook — real
// core-runtime scope beyond what a plugin can do, not attempted here.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use anyhow::anyhow;
use anyhow::Result;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;

#[cfg(target_os = "windows")]
fn register_scheme(scheme: &str) -> Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = std::env::current_exe()?;
    let exe_str = exe.to_string_lossy();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(format!("Software\\Classes\\{scheme}"))?;
    key.set_value("", &format!("URL:{scheme} Protocol"))?;
    key.set_value("URL Protocol", &"")?;

    let (icon_key, _) = key.create_subkey("DefaultIcon")?;
    icon_key.set_value("", &format!("{exe_str},1"))?;

    let (cmd_key, _) = key.create_subkey("shell\\open\\command")?;
    cmd_key.set_value("", &format!("\"{exe_str}\" \"%1\""))?;

    Ok(())
}

#[cfg(target_os = "linux")]
fn register_scheme(app_name: &str, scheme: &str) -> Result<()> {
    let exe = std::env::current_exe()?;
    let home = std::env::var("HOME").map_err(|_| anyhow!("HOME is not set"))?;
    let apps_dir = format!("{home}/.local/share/applications");
    std::fs::create_dir_all(&apps_dir)?;

    let desktop_name = format!("{app_name}-deeplink.desktop");
    let desktop_path = format!("{apps_dir}/{desktop_name}");
    let contents = format!(
        "[Desktop Entry]\nType=Application\nName={app_name}\nExec={} %u\nMimeType=x-scheme-handler/{scheme};\nNoDisplay=true\n",
        exe.to_string_lossy(),
    );
    std::fs::write(&desktop_path, contents)?;

    // Best-effort — a missing update-desktop-database/xdg-mime binary
    // (unusual, but not every minimal Linux install has them) shouldn't
    // fail registration outright; the .desktop file is still written.
    let _ = std::process::Command::new("update-desktop-database").arg(&apps_dir).status();
    let _ = std::process::Command::new("xdg-mime")
        .args(["default", &desktop_name, &format!("x-scheme-handler/{scheme}")])
        .status();

    Ok(())
}

#[cfg(target_os = "macos")]
fn register_scheme(_scheme: &str) -> Result<()> {
    Err(anyhow!(
        "deep-link scheme registration on macOS must be declared in Info.plist at package \
         time (CFBundleURLTypes), not at runtime — see the dmg packaging generator's \
         generateInfoPlist()"
    ))
}

/// FNV-1a over (app_name, scheme) — deterministic per app+scheme, so two
/// unrelated Carbon apps (or the same app with two different registered
/// schemes) don't collide on the same loopback port.
fn derive_port(app_name: &str, scheme: &str) -> u16 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in app_name.bytes().chain(std::iter::once(b':')).chain(scheme.bytes()) {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    // Dynamic/private port range (49152-65535), per IANA.
    49152 + (hash % 16384) as u16
}

/// Tries to hand `url` to an already-running instance. Returns true if
/// delivered (caller should exit immediately) — false if nothing is
/// listening (caller should become the listener itself).
fn try_forward(app_name: &str, scheme: &str, url: &str) -> bool {
    let port = derive_port(app_name, scheme);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    match TcpStream::connect_timeout(&addr, Duration::from_millis(200)) {
        Ok(mut stream) => {
            let _ = stream.write_all(url.as_bytes());
            let _ = stream.write_all(b"\n");
            true
        }
        Err(_) => false,
    }
}

fn start_listener(app_name: &str, scheme: &str) {
    let port = derive_port(app_name, scheme);
    let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) else {
        // Someone else already bound it. Shouldn't happen — we only get
        // here after try_forward already failed to connect — but not
        // fatal either way: worst case, this launch just never receives
        // forwarded URLs.
        return;
    };
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = String::new();
            if stream.read_to_string(&mut buf).is_ok() {
                let url = buf.trim().to_string();
                if !url.is_empty() {
                    deliver(&url);
                }
            }
        }
    });
}

fn deliver(url: &str) {
    let payload = format!("{{\"url\":{}}}", serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string()));
    crate::host_exports::push_plugin_event("deeplink.url".to_string(), payload);
}

static REGISTERED_ONCE: OnceLock<()> = OnceLock::new();

/// Registers `scheme`, then either forwards this launch's URL (if any) to
/// an already-running instance and exits the process, or becomes the
/// listener for future launches. Idempotent within a process — a plugin
/// calling this from both `carbon_plugin_register` and
/// `carbon_plugin_after_reload` (the usual pattern for re-installing
/// globals after HMR) must NOT re-run the forward/listen dance on every
/// hot reload, or a reload would see argv's original launch URL again and
/// mistake ITSELF for a second instance.
pub fn register(app_name: &str, scheme: &str) -> Result<()> {
    if REGISTERED_ONCE.set(()).is_err() {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    register_scheme(scheme)?;
    #[cfg(target_os = "linux")]
    register_scheme(app_name, scheme)?;
    #[cfg(target_os = "macos")]
    register_scheme(scheme)?;

    let prefix = format!("{scheme}://");
    let cold_start_url = std::env::args().find(|a| a.starts_with(&prefix));

    if let Some(url) = &cold_start_url {
        if try_forward(app_name, scheme, url) {
            std::process::exit(0);
        }
    }

    start_listener(app_name, scheme);

    if let Some(url) = cold_start_url {
        deliver(&url);
    }

    Ok(())
}
