// The positive fixture: a plugin whose import table is clean enough to sign.
//
// It exists because the negative fixture alone proves only that the checker
// says no to something. What matters more is that there is something it says
// YES to — a strict policy nothing can satisfy is a policy that will be
// switched off the first time it blocks a release.
//
// ── THE THREE THINGS THAT MAKE IT PASS ──────────────────────────────────────
// All three were found by measurement (`carbon-import-check --list` against
// real builds), not by reasoning, and each one is worth ~60-80 import entries:
//
//   1. The MSVC ABI, not zig's default `-gnu` on Windows. Linking libc for
//      `x86_64-windows-gnu` pulls in mingw-w64's CRT glue, which statically
//      imports the whole of kernel32 AND ntdll before the plugin's own first
//      line of code. Same source at `x86_64-windows-msvc`: 1 import.
//
//   2. A panic handler that traps instead of dumping a stack trace. Zig's
//      default handler reads the binary's own debug info off disk and walks
//      the loaded-module list, which is where every `NtCreateFile`,
//      `NtReadFile` and `Ldr*` in a plugin's import table comes from. This
//      matters MORE under the mandatory-`ReleaseSafe` rule, not less: safety
//      checks are exactly what keeps the panic path reachable.
//
//   3. No `carbon_js_*` call. Those are the ones the SDK resolves with
//      `GetModuleHandleW` + `GetProcAddress` at load time — which the symbol
//      denylist refuses unconditionally, and rightly: a plugin that can call
//      `GetProcAddress` can reach anything, and no static import-table check
//      means anything after that. `push_event` is reached through a function
//      pointer the host already put in `CarbonApp`, so it needs no dynamic
//      resolution at all. See the trust package README for what this implies
//      for the SDK.
//
//   zig build -Drelease=true -Dtarget=x86_64-windows-msvc
//   carbon-import-check zig-out/bin/allowed_plugin.dll     # must PASS

const std = @import("std");

/// Trap rather than dump. See (2) above.
pub const panic = std.debug.FullPanic(trapOnPanic);

fn trapOnPanic(msg: []const u8, first_trace_addr: ?usize) noreturn {
    _ = msg;
    _ = first_trace_addr;
    @trap();
}

/// The prefix of `CarbonApp` from products/carbon-ext/presentation/include/
/// carbon_plugin.h, mirrored by hand.
///
/// A FIXTURE may do this; the SDK may not, and does not — it `@cImport`s the
/// header so there is one declaration. Mirroring here keeps the fixture free
/// of an SDK dependency, so what its import table contains is a statement
/// about this file and nothing else. Only the fields up to `push_event`
/// matter; the layout above it has to be exact for the pointer to land in the
/// right place, which is why they are all here.
const CarbonApp = extern struct {
    abi_version_major: u32,
    abi_version_minor: u32,
    js_ctx: ?*anyopaque,
    window_width: u32,
    window_height: u32,
    raw_window_handle: ?*anyopaque,
    raw_display_handle: ?*anyopaque,
    app_name: ?[*:0]const u8,
    app_version: ?[*:0]const u8,
    project_dir: ?[*:0]const u8,
    window_id: u32,
    push_event: ?*const fn (*CarbonApp, [*:0]const u8, [*:0]const u8) callconv(.c) i32,
};

const MANIFEST: [*:0]const u8 =
    \\{"name":"allowed_plugin","version":"0.1.0","abi_version_major":1,"abi_version_minor":1,"capabilities":{"required":[],"optional":[]},"modules":[],"lifecycle_hooks":["register"]}
;

export fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}

export fn carbon_plugin_register(app: *CarbonApp) callconv(.c) void {
    // Effects as data, over a pointer the host already handed us: the whole
    // point of Layer 3 step 5, and the reason this file needs no OS import.
    if (app.push_event) |push| {
        _ = push(app, "allowed.registered", "{}");
    }
}

var scratch: [16]u8 = @splat(0);

/// Deliberately bounds-checkable, and deliberately reachable.
///
/// A `ReleaseSafe` build keeps the check on this index, and the check keeps
/// the panic path — and with it the MSVC CRT's fast-fail and unwind
/// scaffolding (`SetUnhandledExceptionFilter`, `RtlVirtualUnwind`,
/// `TerminateProcess`, …) — in the import table. That is the floor every
/// realistic plugin sits on, so the fixture that is supposed to pass has to
/// sit on it too. A fixture with no safety check anywhere would pass for a
/// reason no real plugin could reproduce.
export fn carbon_ext_fixture_read(index: u32) callconv(.c) u8 {
    return scratch[index];
}
