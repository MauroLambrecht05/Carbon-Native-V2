// push.zig — convenience helpers around `pushEvent`.
//
// The Zig SDK is intentionally small: a plugin can do everything via the
// CarbonApp methods on carbon_sdk.zig. This module exists to mirror the
// shape of the Rust SDK (where push.rs is its own module) and to give
// us a place for future buffer-formatting helpers.

const std = @import("std");
const sdk = @import("carbon_sdk.zig");

/// Push a JSON-stringified payload to the JS event handler.
/// Returns the C ABI status code (0 on success).
pub fn pushJson(app: sdk.CarbonApp, name: [*:0]const u8, json_payload: [*:0]const u8) i32 {
    return app.pushEvent(name, json_payload);
}
