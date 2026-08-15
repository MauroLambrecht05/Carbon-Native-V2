// Windows-specific host implementations. See carbon/platform/mod.rs.

use std::path::Path;
use std::process::Command;

/// The shell a one-shot or background command runs under.
pub fn shell_command(command: &str) -> Command {
    let mut c = Command::new("powershell.exe");
    c.arg("-NoProfile").arg("-Command").arg(command);
    c
}

/// Wraps a persistent-session command so its exit code and the shell's
/// post-command cwd can be recovered from stdout without a real PTY.
pub fn wrap_with_sentinel(command: &str, cwd_sentinel: &str) -> String {
    format!(
        "{command}\n$__carbon_rc = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\n\"`n{cwd_sentinel}$($PWD.Path)\"\nexit $__carbon_rc\n",
    )
}

/// Reveals `path` in Explorer with the file highlighted. Fire-and-forget:
/// a failed spawn is silently ignored, matching the pre-extraction behavior.
pub fn reveal_in_file_manager(path: &Path) {
    let _ = Command::new("explorer.exe")
        .arg("/select,")
        .arg(path)
        .spawn();
}
