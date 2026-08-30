// System notifications via notify-rust, backing `notification_send` (ABI
// 1.3, abi/host_exports.rs). Previously a `carbon-os` adapter installing
// `__cm_notification_send` directly onto the JS context — moved here so
// notifications go through the `notification` plugin
// (products/carbon-sdk/notification) like every other optional OS
// capability. The notify-rust usage is unchanged.
//
// Notifications fire-and-forget — the user dismisses them via the OS, not
// our app. No click callbacks: notify-rust supports them but requires
// keeping a tokio-style event loop alive for the notification's lifetime,
// which doesn't compose well with the single-threaded paint loop.

use anyhow::Result;
use notify_rust::Notification;

/// `icon` is a file path on disk, or empty to use the system default icon.
pub fn send(title: &str, body: &str, icon: &str) -> Result<()> {
    let mut n = Notification::new();
    n.summary(title).body(body);
    if !icon.is_empty() {
        n.icon(icon);
    }
    n.show()?;
    Ok(())
}
