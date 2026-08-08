// Unix (Linux + macOS shared bits) host implementations. See
// carbon/platform/mod.rs. macOS-only overrides (e.g. Finder reveal) live in
// macos.rs instead — this file is what Linux and macOS both use as-is.

use std::process::Command;

/// The shell a one-shot or background command runs under: the user's login
/// shell, falling back to `/bin/sh` if `$SHELL` isn't set.
pub fn shell_command(command: &str) -> Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut c = Command::new(shell);
    c.arg("-lc").arg(command);
    c
}

/// Wraps a persistent-session command so its exit code and the shell's
/// post-command cwd can be recovered from stdout without a real PTY.
pub fn wrap_with_sentinel(command: &str, cwd_sentinel: &str) -> String {
    format!(
        "{command}\n__carbon_rc=$?\nprintf '\\n%s%s\\n' '{cwd_sentinel}' \"$(pwd)\"\nexit $__carbon_rc\n",
    )
}
