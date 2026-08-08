// Platform-specific implementations.
//
// A real crate here, where V1 `#[path]`-included this source into every backend
// so it could share the including crate's UserEvent and tlog without a trait
// indirection. It does not need either: every function below is a plain
// swappable operation over the OS, with no runtime types in its signatures.
// Being a crate means it compiles and can be tested on its own.
//
// Not everything OS-specific in the tree lives here: `main.rs`'s
// `#![windows_subsystem = "windows"]` is a crate-level inner attribute and
// can't live in an included module, and build.rs's Windows resource
// embedding is a build-script concern tied to its own crate. This holds the
// pieces that are genuinely swappable functions — the shell command a
// backend spawns, how a persistent shell session recovers its exit code and
// cwd, how "reveal in file manager" is implemented.

#[cfg(windows)]
#[path = "targets/windows.rs"]
pub mod windows;

#[cfg(target_os = "macos")]
#[path = "targets/macos.rs"]
pub mod macos;

#[cfg(not(windows))]
#[path = "targets/unix.rs"]
pub mod unix;
