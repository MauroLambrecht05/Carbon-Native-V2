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
//
// ── Layout ──────────────────────────────────────────────────────────────────
// One adapter per target OS, selected by cfg. `adapters/`, like every other
// crate in this tier: a per-platform implementation of a swappable operation
// is a driven adapter, and calling the directory `targets/` named the axis
// the files vary along rather than what they are.

#[cfg(windows)]
#[path = "adapters/windows.rs"]
pub mod windows;

#[cfg(target_os = "macos")]
#[path = "adapters/macos.rs"]
pub mod macos;

#[cfg(not(windows))]
#[path = "adapters/unix.rs"]
pub mod unix;
