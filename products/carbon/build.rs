// One build.rs for the package (Cargo allows exactly one per package, not
// one per [[bin]]), covering both carbon-mini and carbon-blitz. Each
// binary's flags are emitted via `rustc-link-arg-bin=<name>=<flag>` (not the
// blanket `-bins` variant) so mini's flags never leak onto blitz's link line
// or vice versa, even if both get linked in the same `cargo build` session
// (e.g. `--features mini,blitz`).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // ─── carbon-mini ──────────────────────────────────────────────────────
    // Emit linker args so the executable EXPORTS the `carbon_js_*` host
    // helpers as resolvable symbols. Plugin DLLs resolve them at runtime via
    // GetProcAddress(GetModuleHandle(NULL), …) on Windows or
    // dlsym(RTLD_DEFAULT, …) on POSIX (see ecosystem/users/sdk/rust/src/ffi.rs
    // for the resolver code).
    //
    // On Windows, executables don't normally export ANY symbols by default;
    // the linker only exports what's listed in a `.def` file or via /EXPORT
    // switches. We emit one `/EXPORT:<sym>` per host helper. The MSVC linker
    // mangles names minimally for `extern "C" fn` (no leading underscore on
    // x64), so we list them verbatim.
    //
    // On POSIX, executable symbols are visible to dlsym(RTLD_DEFAULT) only
    // when the binary was linked with `-rdynamic` (gcc) / `-Wl,--export-dynamic`
    // (ld). We emit that flag for non-Windows targets.
    //
    // After building, verify with:
    //     dumpbin /EXPORTS target/release/carbon-mini.exe | findstr carbon_js
    // (Linux/macOS):
    //     nm -D target/release/carbon-mini | grep carbon_js
    {
        const HOST_SYMS: &[&str] = &[
            "carbon_js_get_context",
            "carbon_js_set_global_string",
            "carbon_js_set_global_number",
            "carbon_js_set_global_function",
            "carbon_js_eval",
        ];
        let snapshot = std::env::var_os("CARGO_FEATURE_SNAPSHOT").is_some();

        if target_os == "windows" {
            for sym in HOST_SYMS {
                println!("cargo:rustc-link-arg-bin=carbon-mini=/EXPORT:{sym}");
            }
            if snapshot {
                // The heap snapshot stores absolute code pointers (allocator
                // fns, class methods, every built-in) into THIS executable.
                // They are only valid across processes if the IMAGE always
                // loads at the same base — so disable image ASLR. Without
                // this, restore would map a heap full of pointers to the
                // wrong code and crash.
                //
                // NOTE: only /DYNAMICBASE:NO (image base). We deliberately do
                // NOT pass /HIGHENTROPYVA:NO — that pushes the thread stack
                // into the low address space, which underflows QuickJS's
                // `stack_top - stack_size` overflow check (stack_top <
                // stack_size) and makes every JS eval spuriously report
                // "Maximum call stack size exceeded". The stack location is
                // irrelevant to the snapshot (only code+heap addresses
                // matter), so we leave high-entropy VA on.
                println!("cargo:rustc-link-arg-bin=carbon-mini=/DYNAMICBASE:NO");
                // With image ASLR off (and the zig linker), the main-thread
                // stack lands very low (~1.4 MB). QuickJS's overflow guard
                // computes `stack_top - stack_size`; if stack_top < stack_size
                // that underflows and every eval falsely trips "Maximum call
                // stack size exceeded". Reserve a large (64 MiB) stack so its
                // top sits well above the JS stack budget. Reserve is address
                // space only — pages commit on use, so this costs ~nothing in
                // RAM but gives deep React trees headroom.
                println!("cargo:rustc-link-arg-bin=carbon-mini=/STACK:67108864");
            }
        } else {
            println!("cargo:rustc-link-arg-bin=carbon-mini=-rdynamic");
        }
    }

    // ─── carbon-blitz ─────────────────────────────────────────────────────
    // Blitz's style resolution / taffy layout / paint are deeply recursive
    // (one stack frame per DOM depth, several passes). The default 1 MB
    // Windows main-thread stack overflows on a deep tree like terax's. The
    // event loop must stay on the main thread (winit/tao requirement on
    // Windows), so we can't just move work to a big-stack worker thread —
    // instead reserve a large main-thread stack in the PE header. 256 MB is
    // address-space reserve (committed lazily), so it's effectively free.
    if target_os == "windows" {
        println!("cargo:rustc-link-arg-bin=carbon-blitz=/STACK:268435456");
    }

    // ─── static-linked plugins (release builds) ──────────────────────────
    // `carbon-plugin-host`'s `static-plugins` feature (see its Cargo.toml)
    // swaps in adapters/plugin_loader_static.rs, whose `extern "C"` block
    // expects a real definition of `carbon_plugin_register` and friends to
    // exist somewhere in the final link — normally satisfied by a plugin's
    // OWN `export fn`, but here by ONE generated umbrella static lib that
    // `StaticLinkPluginsUseCase.ts` builds per-app (it `@import`s every
    // enabled plugin's src/main.zig as a distinct module and fans out to
    // them — see that file and extension_points.zig's `sdk.ext.implement`
    // for the mechanism). `cargo build` cannot discover that generated file
    // on its own, hence the explicit env vars and `rerun-if-changed` below.
    //
    // Both env vars are set by `StaticLinkPluginsUseCase.ts` before it
    // invokes `cargo build --features static-plugins`; a bare `cargo build`
    // never sets `static-plugins` at all, so this block is inert for every
    // other build (`carbon dev`, `carbon run`, a plain `cargo build`/
    // `cargo check`).
    if std::env::var_os("CARGO_FEATURE_STATIC_PLUGINS").is_some() {
        let lib_dir = std::env::var("CARBON_STATIC_PLUGINS_LIB_DIR").unwrap_or_else(|_| {
            panic!(
                "carbon-runtime built with --features static-plugins but \
                 CARBON_STATIC_PLUGINS_LIB_DIR is not set. This build is meant to be \
                 invoked by `carbon build --release` (via StaticLinkPluginsUseCase.ts), \
                 which generates the per-app umbrella static lib and points this env var \
                 at it — a bare `cargo build --features static-plugins` has nothing to \
                 link `carbon_plugin_register` and the other extension-point symbols \
                 against."
            )
        });
        let lib_name = std::env::var("CARBON_STATIC_PLUGINS_LIB_NAME")
            .unwrap_or_else(|_| "carbon_plugins_umbrella".to_string());
        println!("cargo:rustc-link-search=native={lib_dir}");
        println!("cargo:rustc-link-lib=static={lib_name}");
        // The env vars themselves, not just their target paths: a rebuild
        // with a DIFFERENT umbrella (different app, different enabled
        // plugins) must not reuse a cached link against the old one.
        println!("cargo:rerun-if-env-changed=CARBON_STATIC_PLUGINS_LIB_DIR");
        println!("cargo:rerun-if-env-changed=CARBON_STATIC_PLUGINS_LIB_NAME");
        println!("cargo:rerun-if-changed={lib_dir}");
    }
}
