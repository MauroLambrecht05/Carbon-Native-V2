// The negative fixture for the import-table check: a plugin that reaches the
// operating system directly, for no reason the SDK could not have served.
//
// `Sleep` is the smallest honest example. It is not dangerous in itself —
// that is the point. What makes it a violation is the SHAPE: a `.dll` that
// carries `kernel32.dll` in its import table has an unmediated call into the
// OS, and nothing about the import table says whether the next release of the
// same plugin calls `CreateProcessW` through the same door.
//
// Deliberately does NOT `@import("std")`. A Zig artifact that pulls in std
// imports ~85 kernel32/ntdll entry points before its own first line of code
// (measured — see the trust package's README), so a fixture built on std
// would fail the check whether or not it contained this `extern`, and would
// prove nothing. With std out of the picture the ONLY thing in this binary's
// import table is what this file asks for, which is what makes the negative
// test a real test.
//
// Build it with the zig this repo pins:
//
//   zig build
//   carbon-import-check zig-out/bin/denied_plugin.dll     # must FAIL

extern "kernel32" fn Sleep(dwMilliseconds: u32) callconv(.winapi) void;

/// Named like a real extension point so the fixture is a plausible plugin,
/// not obviously synthetic. The registry's `lifecycle.register` symbol is
/// `carbon_plugin_register`; this takes the host pointer opaquely because the
/// fixture does not link the SDK.
export fn carbon_plugin_register(app: ?*anyopaque) callconv(.c) void {
    _ = app;
    Sleep(1);
}
