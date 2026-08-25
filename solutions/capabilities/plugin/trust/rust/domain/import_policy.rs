// The mechanical check that a compiled plugin cannot reach the operating
// system behind the SDK's back.
//
// ── WHAT THIS ENFORCES ──────────────────────────────────────────────────────
// `.local/notes/roadmap/04-security-and-capabilities/README.md`, Layer 3 step
// 3: a plugin published through Carbon's trust channel is loaded *in-process*
// by `libloading::Library::new`, so once its entry point runs it has the
// host's full authority. The manifest capability check gates which extension
// points get *dispatched*; it does not gate what the code inside an
// already-called `carbon_plugin_register` does. The import table is where
// that gap gets closed: a plugin that never imports an OS entry point cannot
// call one.
//
// Two independent rules, because one alone is trivially defeated:
//
//   * a MODULE denylist — `kernel32` / `user32` / `ntdll` (raw OS surface)
//     and `ws2_32` / `wininet` / `winhttp` (network egress, denied
//     unconditionally per the Fs/Net split: a Zig plugin never gets a network
//     verb, it pushes an effect to JS, which has `fetch`).
//   * a SYMBOL denylist that applies to EVERY module —
//     `LoadLibrary*` / `GetProcAddress` / `GetModuleHandle*`. These are the
//     loophole around any static import-table check: resolve `kernel32!Sleep`
//     at runtime and the import table stays clean. Denying them by module
//     alone would miss a forwarder DLL, so they are denied by name wherever
//     they appear.
//
// Everything a module denylist does not name still has to be judged, so the
// policy is ultimately an ALLOWLIST: the host executable (which is where a
// plugin's `carbon_js_*` calls would come from if they were statically
// imported) plus the C runtime that Zig's own compiled output needs. Anything
// neither allowed nor denied is reported as `UnknownModule` and fails — a new
// OS DLL nobody thought of is exactly the case a denylist misses.
//
// One exception, and it is measured rather than assumed: `CRT_SCAFFOLDING`,
// eight `kernel32` symbols the MSVC CRT emits into every DLL for stack-cookie
// fast-fail and SEH unwinding. Mandatory `ReleaseSafe` is what makes them
// unavoidable — see the note on that constant.
//
// ── WHY THE SYMBOL DENYLIST DOES NOT NEED AN EXCEPTION FOR THE SDK ─────────
// `carbon_plugin.h` ABI 1.1 appended `set_global_string`/`set_global_number`/
// `set_global_function`/`eval` as function pointers on `CarbonApp` itself —
// the same shape `push_event`/`request_paint` already used. The Zig SDK
// (solutions/capabilities/plugin/sdk/zig) calls through those fields now,
// not GetProcAddress/GetModuleHandleW, so a real Carbon plugin's import table
// has no legitimate reason to carry either symbol. See
// tests/fixtures/zig/allowed-plugin for the worked example, and
// carbon_plugin.h's note on those four fields for the full reasoning.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
// It says nothing about a plugin that stays inside its own process and
// corrupts memory. That residual is what mandatory `ReleaseSafe` (Layer 3
// step 4) covers, and the two are independent on purpose.

use std::collections::BTreeSet;
use std::fmt;

/// One entry in a binary's import table.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Import {
    /// The module as the import table spells it, lowercased. Windows module
    /// names are case-insensitive and real binaries are inconsistent about it
    /// (`KERNEL32.dll` and `kernel32.dll` both occur), so every comparison in
    /// this file happens on the lowercased form and the original casing is
    /// simply not kept — there is nothing a caller could correctly do with it.
    pub module: String,
    /// The imported symbol. Case is preserved: symbol names are
    /// case-SENSITIVE, and `GetProcAddress` is a different symbol from
    /// `getprocaddress`.
    pub symbol: String,
    /// Set when the import is by ordinal rather than by name. An ordinal-only
    /// import hides which function is being pulled in, so it is never
    /// allowable from a denied module — see `Violation::OrdinalImport`.
    pub ordinal: Option<u16>,
}

impl fmt::Display for Import {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.ordinal {
            Some(n) if self.symbol.is_empty() => write!(f, "{}!#{}", self.module, n),
            _ => write!(f, "{}!{}", self.module, self.symbol),
        }
    }
}

/// Why one import is not allowed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    /// The module itself is on the denylist.
    DeniedModule { import: Import, reason: &'static str },
    /// The symbol is denied wherever it appears, whatever module it came from.
    DeniedSymbol { import: Import, reason: &'static str },
    /// The module is neither denied nor allowed. Not a lesser finding: an
    /// allowlist that silently passes what it has not heard of is a denylist.
    UnknownModule { import: Import },
    /// An import by ordinal from a module that is not on the allowlist. The
    /// symbol denylist cannot see through an ordinal, so this is refused
    /// rather than guessed at.
    OrdinalImport { import: Import },
}

impl Violation {
    pub fn import(&self) -> &Import {
        match self {
            Violation::DeniedModule { import, .. }
            | Violation::DeniedSymbol { import, .. }
            | Violation::UnknownModule { import }
            | Violation::OrdinalImport { import } => import,
        }
    }
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Violation::DeniedModule { import, reason } => {
                write!(f, "{import} — denied module ({reason})")
            }
            Violation::DeniedSymbol { import, reason } => {
                write!(f, "{import} — denied symbol ({reason})")
            }
            Violation::UnknownModule { import } => write!(
                f,
                "{import} — module is on neither the allowlist nor the denylist"
            ),
            Violation::OrdinalImport { import } => write!(
                f,
                "{import} — imported by ordinal, so the symbol denylist cannot see it"
            ),
        }
    }
}

/// A denied module and the sentence that says why, so a rejection message can
/// tell a plugin author what to do instead rather than only what not to do.
struct DeniedModule {
    name: &'static str,
    reason: &'static str,
}

/// The module denylist, straight from Layer 3 step 3.
const DENIED_MODULES: &[DeniedModule] = &[
    DeniedModule {
        name: "kernel32",
        reason: "raw OS surface — use the SDK's app.* verbs",
    },
    DeniedModule {
        name: "kernelbase",
        reason: "kernel32's implementation half — same surface, different name",
    },
    DeniedModule {
        name: "user32",
        reason: "raw window/input surface — use an extension point",
    },
    DeniedModule {
        name: "ntdll",
        reason: "the native API below kernel32",
    },
    DeniedModule {
        name: "advapi32",
        reason: "registry and token surface",
    },
    DeniedModule {
        name: "ws2_32",
        reason: "network egress — a plugin pushes an effect to JS, which has fetch",
    },
    DeniedModule {
        name: "wininet",
        reason: "network egress — a plugin pushes an effect to JS, which has fetch",
    },
    DeniedModule {
        name: "winhttp",
        reason: "network egress — a plugin pushes an effect to JS, which has fetch",
    },
];

/// Denied from ANY module, not only the ones above.
///
/// A static import-table check answers "what can this binary call". These four
/// families answer "what can this binary go and find at runtime", which makes
/// the first answer meaningless. `kernel32` being denied already is not
/// enough: a forwarder, a re-exporting shim, or an `api-ms-win-core-*`
/// apiset all export `LoadLibraryExW` under their own module name.
const DENIED_SYMBOLS: &[(&str, &str)] = &[
    ("LoadLibraryA", "dynamic module loading"),
    ("LoadLibraryW", "dynamic module loading"),
    ("LoadLibraryExA", "dynamic module loading"),
    ("LoadLibraryExW", "dynamic module loading"),
    ("LoadPackagedLibrary", "dynamic module loading"),
    ("GetProcAddress", "dynamic symbol resolution"),
    ("GetProcAddressForCaller", "dynamic symbol resolution"),
    ("GetModuleHandleA", "reaching another module's base address"),
    ("GetModuleHandleW", "reaching another module's base address"),
    ("GetModuleHandleExA", "reaching another module's base address"),
    ("GetModuleHandleExW", "reaching another module's base address"),
];

/// The one place a DENIED module is still allowed, symbol by symbol.
///
/// MEASURED, NOT ASSUMED. Every MSVC-linked DLL — including one whose entire
/// source is a single bounds-checked array read — carries these eight
/// `kernel32` entry points, emitted by the CRT itself for `__report_gsfailure`
/// (stack-cookie fast fail) and SEH unwinding. `tests/fixtures/zig/
/// allowed-plugin` is exactly that DLL, and its import table is this list plus
/// `memcpy`/`memset`.
///
/// This is not a hole being punched for convenience. Mandatory `ReleaseSafe`
/// (Layer 3 step 4) is what makes these unavoidable: safety checks are what
/// keep the panic path reachable, and the panic path is what pulls in the
/// unwinder. A policy that refused them would refuse every plugin that
/// obeyed the rule beside it.
///
/// It is an exhaustive pair list rather than a module-wide relaxation for the
/// obvious reason: `kernel32!CreateFileW` in a plugin still fails, and adding
/// a ninth symbol here is a deliberate, reviewable act.
///
/// The residual is worth stating: `TerminateProcess` lets a plugin kill the
/// host. So does dereferencing a null pointer, from inside the same process,
/// with no imports at all — so this changes nothing about what a plugin can
/// do, only about what it can be seen to do.
const CRT_SCAFFOLDING: &[(&str, &str)] = &[
    ("kernel32", "GetCurrentProcess"),
    ("kernel32", "IsProcessorFeaturePresent"),
    ("kernel32", "RtlCaptureContext"),
    ("kernel32", "RtlLookupFunctionEntry"),
    ("kernel32", "RtlVirtualUnwind"),
    ("kernel32", "SetUnhandledExceptionFilter"),
    ("kernel32", "TerminateProcess"),
    ("kernel32", "UnhandledExceptionFilter"),
];

/// The C runtime a Zig-compiled artifact links against.
///
/// DERIVED, NOT GUESSED. This list is what `carbon-import-check --list`
/// actually printed for real artifacts built with zig 0.16.0 on this machine —
/// `tests/fixtures/zig/allowed-plugin`, and `labs/examples/pulse/plugins/
/// carbon-pulse` cross-built for `x86_64-windows-msvc`. Anything a future zig
/// release adds shows up as `UnknownModule` with the module named, which is
/// the right failure: a human decides whether it belongs here.
///
/// The `api-ms-win-crt-*` family is matched by prefix because it is genuinely
/// open-ended — MSVC splits the CRT across a dozen apiset stubs and adds more
/// between releases. `api-ms-win-core-*` is NOT matched: those are the OS
/// apisets, i.e. kernel32 under another name.
const ALLOWED_MODULE_PREFIXES: &[&str] = &["api-ms-win-crt-"];

const ALLOWED_MODULES: &[&str] = &[
    "msvcrt",
    "ucrtbase",
    "ucrtbased",
    "vcruntime140",
    "vcruntime140d",
    "vcruntime140_1",
    "msvcp140",
];

/// What a binary is allowed to import.
///
/// Constructed with [`ImportPolicy::carbon_plugin`] for the real policy. The
/// two builder methods exist for the trust TIER above it — see the note on
/// [`ImportPolicy::allow_module`].
#[derive(Debug, Clone, Default)]
pub struct ImportPolicy {
    /// Extra modules this particular artifact may import, beyond the C
    /// runtime. Lowercased on insertion.
    extra_allowed: BTreeSet<String>,
    /// When set, imports from this module are allowed outright. This is how a
    /// plugin that statically links against the host executable's export
    /// library would be judged — the `carbon_js_*` symbols are the SDK, and
    /// importing them is the intended path, not a violation.
    host_module: Option<String>,
}

impl ImportPolicy {
    /// The policy Layer 3 describes: nothing but the C runtime.
    pub fn carbon_plugin() -> Self {
        Self::default()
    }

    /// Allow one more module by name.
    ///
    /// Deliberately a method rather than a constant, because the roadmap's
    /// escape hatch is real: "none of steps 1–7 apply to a developer's own
    /// first-party plugin in their own app". A first-party plugin with a
    /// legitimate OS-API need — `carbon-hotkey`'s `RegisterHotKey` is the
    /// worked example — is a DIFFERENT TRUST TIER, not a reason to loosen the
    /// published-plugin policy. Widening it per-artifact, explicitly, at the
    /// call site, is what keeps the two tiers from collapsing into one.
    #[must_use]
    pub fn allow_module(mut self, module: &str) -> Self {
        self.extra_allowed.insert(module.to_ascii_lowercase());
        self
    }

    /// Name the host executable, whose exports are the SDK.
    #[must_use]
    pub fn with_host_module(mut self, module: &str) -> Self {
        self.host_module = Some(module.to_ascii_lowercase());
        self
    }

    fn module_allowed(&self, module: &str) -> bool {
        let stem = module_stem(module);
        if self.host_module.as_deref() == Some(module) {
            return true;
        }
        if self.extra_allowed.contains(module) || self.extra_allowed.contains(stem) {
            return true;
        }
        if ALLOWED_MODULES.contains(&stem) {
            return true;
        }
        ALLOWED_MODULE_PREFIXES
            .iter()
            .any(|prefix| stem.starts_with(prefix))
    }

    fn module_denied(&self, module: &str) -> Option<&'static str> {
        let stem = module_stem(module);
        DENIED_MODULES
            .iter()
            .find(|d| d.name == stem)
            .map(|d| d.reason)
    }

    /// Judge one import.
    ///
    /// Order matters. The symbol denylist runs FIRST and unconditionally, so
    /// `GetProcAddress` is reported as the dynamic-resolution loophole it is
    /// no matter which module carries it — including a module the caller has
    /// explicitly allowed. An allowlisted module cannot buy its way past the
    /// symbol rule; that is the whole reason the two rules are separate.
    pub fn judge(&self, import: &Import) -> Option<Violation> {
        if let Some(reason) = denied_symbol(&import.symbol) {
            return Some(Violation::DeniedSymbol {
                import: import.clone(),
                reason,
            });
        }
        if is_crt_scaffolding(&import.module, &import.symbol) {
            return None;
        }
        if let Some(reason) = self.module_denied(&import.module) {
            return Some(Violation::DeniedModule {
                import: import.clone(),
                reason,
            });
        }
        if self.module_allowed(&import.module) {
            return None;
        }
        if import.ordinal.is_some() && import.symbol.is_empty() {
            return Some(Violation::OrdinalImport {
                import: import.clone(),
            });
        }
        Some(Violation::UnknownModule {
            import: import.clone(),
        })
    }

    /// Judge a whole import table.
    pub fn check(&self, imports: Vec<Import>) -> ImportReport {
        let violations = imports.iter().filter_map(|i| self.judge(i)).collect();
        ImportReport { imports, violations }
    }
}

fn is_crt_scaffolding(module: &str, symbol: &str) -> bool {
    let stem = module_stem(module);
    CRT_SCAFFOLDING
        .iter()
        .any(|(m, s)| *m == stem && *s == symbol)
}

fn denied_symbol(symbol: &str) -> Option<&'static str> {
    DENIED_SYMBOLS
        .iter()
        .find(|(name, _)| *name == symbol)
        .map(|(_, reason)| *reason)
}

/// `KERNEL32.dll` -> `kernel32`. Already-lowercased input assumed; the parser
/// lowercases as it reads.
fn module_stem(module: &str) -> &str {
    module.strip_suffix(".dll").unwrap_or(module)
}

/// The outcome of checking one artifact.
#[derive(Debug, Clone)]
pub struct ImportReport {
    pub imports: Vec<Import>,
    pub violations: Vec<Violation>,
}

impl ImportReport {
    pub fn passed(&self) -> bool {
        self.violations.is_empty()
    }

    /// The distinct modules imported, in a stable order — what a human wants
    /// to see first when a check fails.
    pub fn modules(&self) -> Vec<String> {
        let set: BTreeSet<&str> = self.imports.iter().map(|i| i.module.as_str()).collect();
        set.into_iter().map(str::to_owned).collect()
    }
}

/// Errors reading an artifact.
#[derive(Debug)]
pub enum ImportScanError {
    Io(std::io::Error),
    /// The bytes are not a PE image, or the import table is malformed.
    Parse(String),
}

impl fmt::Display for ImportScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImportScanError::Io(e) => write!(f, "{e}"),
            ImportScanError::Parse(m) => write!(f, "not a readable PE image: {m}"),
        }
    }
}

impl std::error::Error for ImportScanError {}

impl From<std::io::Error> for ImportScanError {
    fn from(e: std::io::Error) -> Self {
        ImportScanError::Io(e)
    }
}

/// Parse a PE image's import table from bytes already in hand.
///
/// Both the ordinary import directory and the DELAY-LOAD directory are read.
/// Delay-loaded imports are resolved by the CRT calling `LoadLibrary` +
/// `GetProcAddress` on first use, so a checker that reads only the ordinary
/// table would let `__delayLoadHelper2` walk straight through it — the same
/// loophole the symbol denylist exists to close, one layer down.
pub fn parse_pe_imports(bytes: &[u8]) -> Result<Vec<Import>, ImportScanError> {
    let pe = goblin::pe::PE::parse(bytes).map_err(|e| ImportScanError::Parse(e.to_string()))?;

    let mut out = Vec::new();
    for import in &pe.imports {
        out.push(Import {
            module: import.dll.to_ascii_lowercase(),
            symbol: import.name.to_string(),
            // goblin reports 0 for a by-name import; only a non-zero ordinal
            // on a nameless import means "imported by ordinal".
            ordinal: (import.ordinal != 0 && import.name.is_empty()).then_some(import.ordinal),
        });
    }

    // goblin folds delay-load entries into `pe.imports` when it can parse
    // them; when it cannot, the delay-load descriptor table still names the
    // modules. Adding the module names alone is enough to fail the check —
    // an unknown or denied module is a violation whatever symbol follows it.
    for dll in &pe.libraries {
        let lowered = dll.to_ascii_lowercase();
        if !out.iter().any(|i| i.module == lowered) {
            out.push(Import {
                module: lowered,
                symbol: String::new(),
                ordinal: None,
            });
        }
    }

    out.sort();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import(module: &str, symbol: &str) -> Import {
        Import {
            module: module.to_string(),
            symbol: symbol.to_string(),
            ordinal: None,
        }
    }

    #[test]
    fn every_denied_module_is_denied_whatever_symbol_it_carries() {
        let policy = ImportPolicy::carbon_plugin();
        for module in ["kernel32.dll", "user32.dll", "ntdll.dll", "ws2_32.dll", "wininet.dll", "winhttp.dll"] {
            let v = policy
                .judge(&import(module, "SomethingHarmless"))
                .unwrap_or_else(|| panic!("{module} should be denied"));
            assert!(matches!(v, Violation::DeniedModule { .. }), "{v}");
        }
    }

    #[test]
    fn casing_does_not_smuggle_a_denied_module_through() {
        // The parser lowercases, so this is really a check that the policy
        // never compares against a mixed-case literal by accident.
        let policy = ImportPolicy::carbon_plugin();
        assert!(policy.judge(&import("kernel32.dll", "Sleep")).is_some());
        assert!(policy.judge(&import("kernel32", "Sleep")).is_some());
    }

    #[test]
    fn dynamic_resolution_is_denied_from_a_module_that_is_otherwise_allowed() {
        // The point of the symbol rule: allowlisting a module must not buy
        // GetProcAddress with it.
        let policy = ImportPolicy::carbon_plugin().allow_module("innocent.dll");
        let v = policy
            .judge(&import("innocent.dll", "GetProcAddress"))
            .expect("GetProcAddress is denied from any module");
        assert!(matches!(v, Violation::DeniedSymbol { .. }), "{v}");

        for symbol in [
            "LoadLibraryA",
            "LoadLibraryW",
            "LoadLibraryExA",
            "LoadLibraryExW",
            "GetModuleHandleA",
            "GetModuleHandleW",
        ] {
            assert!(
                policy.judge(&import("innocent.dll", symbol)).is_some(),
                "{symbol} should be denied from any module"
            );
        }
    }

    #[test]
    fn the_c_runtime_zig_needs_passes() {
        let policy = ImportPolicy::carbon_plugin();
        for module in [
            "msvcrt.dll",
            "ucrtbase.dll",
            "vcruntime140.dll",
            "api-ms-win-crt-runtime-l1-1-0.dll",
            "api-ms-win-crt-heap-l1-1-0.dll",
        ] {
            assert!(
                policy.judge(&import(module, "memcpy")).is_none(),
                "{module} should pass"
            );
        }
    }

    #[test]
    fn an_os_apiset_is_not_mistaken_for_the_crt_apiset() {
        // api-ms-win-CORE-* is kernel32 under another name. Only the -crt-
        // family is allowed, and this is the test that says so.
        let policy = ImportPolicy::carbon_plugin();
        let v = policy
            .judge(&import("api-ms-win-core-synch-l1-2-0.dll", "WaitOnAddress"))
            .expect("core apisets are not the CRT");
        assert!(matches!(v, Violation::UnknownModule { .. }), "{v}");
    }

    #[test]
    fn the_crt_scaffolding_kernel32_imports_pass_and_nothing_else_from_kernel32_does() {
        let policy = ImportPolicy::carbon_plugin();
        for symbol in [
            "GetCurrentProcess",
            "IsProcessorFeaturePresent",
            "RtlCaptureContext",
            "RtlLookupFunctionEntry",
            "RtlVirtualUnwind",
            "SetUnhandledExceptionFilter",
            "TerminateProcess",
            "UnhandledExceptionFilter",
        ] {
            assert!(
                policy.judge(&import("kernel32.dll", symbol)).is_none(),
                "kernel32!{symbol} is CRT scaffolding and must pass"
            );
        }
        // The floor is a pair list, not a module-wide relaxation.
        for symbol in ["CreateFileW", "CreateProcessW", "VirtualAlloc", "Sleep"] {
            assert!(
                policy.judge(&import("kernel32.dll", symbol)).is_some(),
                "kernel32!{symbol} is not scaffolding and must still fail"
            );
        }
    }

    #[test]
    fn the_crt_floor_does_not_extend_to_the_dynamic_resolution_symbols() {
        // The SDK resolves the carbon_js_* operations through struct fields
        // on CarbonApp as of ABI 1.1 (see the note at the top of this file),
        // so this is the case that decides whether the policy means anything
        // for real plugins: a plugin has no legitimate reason left to import
        // either symbol, from any module.
        let policy = ImportPolicy::carbon_plugin();
        for symbol in ["GetProcAddress", "GetModuleHandleW"] {
            let v = policy
                .judge(&import("kernel32.dll", symbol))
                .unwrap_or_else(|| panic!("kernel32!{symbol} must be denied"));
            assert!(matches!(v, Violation::DeniedSymbol { .. }), "{v}");
        }
    }

    #[test]
    fn an_unheard_of_module_fails_rather_than_passing_by_omission() {
        let policy = ImportPolicy::carbon_plugin();
        let v = policy
            .judge(&import("shell32.dll", "ShellExecuteW"))
            .expect("shell32 is on neither list");
        assert!(matches!(v, Violation::UnknownModule { .. }), "{v}");
    }

    #[test]
    fn an_ordinal_only_import_from_an_unknown_module_fails() {
        let policy = ImportPolicy::carbon_plugin();
        let by_ordinal = Import {
            module: "mystery.dll".into(),
            symbol: String::new(),
            ordinal: Some(42),
        };
        let v = policy.judge(&by_ordinal).expect("ordinals hide the symbol");
        assert!(matches!(v, Violation::OrdinalImport { .. }), "{v}");
        assert_eq!(by_ordinal.to_string(), "mystery.dll!#42");
    }

    #[test]
    fn the_host_module_is_where_carbon_js_symbols_would_come_from() {
        let policy = ImportPolicy::carbon_plugin().with_host_module("carbon-mini.exe");
        assert!(policy
            .judge(&import("carbon-mini.exe", "carbon_js_set_global_string"))
            .is_none());
    }

    #[test]
    fn a_report_with_no_violations_passes() {
        let policy = ImportPolicy::carbon_plugin();
        let report = policy.check(vec![import("ucrtbase.dll", "memcpy")]);
        assert!(report.passed());
        assert_eq!(report.modules(), vec!["ucrtbase.dll".to_string()]);
    }

    #[test]
    fn bytes_that_are_not_a_pe_image_are_an_error_not_a_pass() {
        // The failure mode that would quietly disable the whole check.
        let err = parse_pe_imports(b"not a PE at all").expect_err("must not parse");
        assert!(matches!(err, ImportScanError::Parse(_)), "{err}");
    }
}
