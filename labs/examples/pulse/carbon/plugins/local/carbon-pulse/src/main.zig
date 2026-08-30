// carbon_pulse — a status indicator painted directly on the real framebuffer:
// a soft coral ring around the window edge that breathes while a capture is
// active, driven by the native paint pipeline rather than CSS or JS.
//
// Why this needs a plugin: QuickJS here is a plain interpreter — no JIT, one
// thread, shared with everything else the app's JS does. A CSS/JS animation
// is at the mercy of whatever else that thread is doing that frame; a busy
// tick can visibly stall it. `paint.before` runs after the frame is already
// rasterized and writes the exact bytes about to hit the screen, so the
// pulse is frame-perfect regardless of how busy JS is — the one guarantee
// nothing running inside the JS engine itself can give.
//
//   zig build                 build it
//   carbon plugin install     copy it into the app and declare it
//   carbon plugin check       verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");

// ── The manifest ────────────────────────────────────────────────────────────
//
// paint.before contributes paint.pixmap on its own — this plugin writes no
// `required` capability by hand, same as carbon-crt.
const MANIFEST = sdk.manifest.build(.{
    .name = "carbon_pulse",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "paint.before" },
    .modules = &.{"carbon:carbon-pulse"},
});

export fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}

// Set from JS (any thread QuickJS calls a host function on — which is always
// the JS thread) and read from paint.before (also the JS thread, per
// products/carbon's single-threaded run loop: JS ticks, then paints,
// sequentially, every frame). Atomic anyway — the two points making that
// assumption is cheaper to get wrong than the store/load are to make safe.
var g_active = std.atomic.Value(bool).init(false);

comptime {
    const point = sdk.ext.expect("lifecycle.register");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_register"));
}

export fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    _ = app.setGlobalFunction("__carbon_pulse_set_active", jsSetActive);
}

fn jsSetActive(
    _: ?*sdk.RawJsContext,
    args_json: [*c]const u8,
    result_buf: [*c]u8,
    result_buf_len: usize,
) callconv(.c) void {
    const active = parseFirstBool(args_json) catch {
        return writeResult(result_buf, result_buf_len, "false");
    };
    g_active.store(active, .release);
    writeResult(result_buf, result_buf_len, "null");
}

fn parseFirstBool(args_json: [*c]const u8) !bool {
    if (args_json == null) return error.NoArguments;
    var buf: [64]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, fba.allocator(), raw, .{}) catch
        return error.BadArgumentsJson;
    const array = switch (parsed.value) {
        .array => |a| a,
        else => return error.ArgumentsNotAnArray,
    };
    if (array.items.len == 0) return error.MissingBoolArgument;
    return switch (array.items[0]) {
        .bool => |b| b,
        else => error.ArgumentNotABool,
    };
}

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

// ── paint.before ─────────────────────────────────────────────────────────────

comptime {
    const point = sdk.ext.expect("paint.before");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_before_paint"));
}

// Ring thickness. Wide enough to read clearly, narrow enough to leave every
// bit of app content untouched — unlike carbon-crt, this plugin never
// touches a pixel that isn't within BORDER_PX of an edge.
const BORDER_PX: u32 = 6;
// One full breath (dim -> bright -> dim) every 90 frames — about 1.5s at
// 60fps. A frame counter rather than a wall clock: paint.before gets no
// timestamp, and a monotonic frame count is exactly as smooth for a
// perceptual pulse while staying a pure function of plain data, which is
// what keeps this testable without a real clock.
const PERIOD_FRAMES: u64 = 90;

const ACCENT_R: u8 = 255;
const ACCENT_G: u8 = 90;
const ACCENT_B: u8 = 95;

var g_frame: u64 = 0;

export fn carbon_plugin_before_paint(
    app_raw: *sdk.RawApp,
    pixmap: [*]u8,
    width: u32,
    height: u32,
    stride_bytes: u32,
) callconv(.c) void {
    _ = app_raw;
    if (!g_active.load(.acquire)) return;
    g_frame +%= 1;
    applyPulse(pixmap[0 .. @as(usize, stride_bytes) * height], width, height, stride_bytes, g_frame);
}

fn applyPulse(pixmap: []u8, width: u32, height: u32, stride_bytes: u32, frame: u64) void {
    if (width == 0 or height == 0) return;

    const period_f: f32 = @floatFromInt(PERIOD_FRAMES);
    const t: f32 = @as(f32, @floatFromInt(frame % PERIOD_FRAMES)) / period_f;
    // 0 at the dimmest point of the breath, 1 at the brightest.
    const weight: f32 = 0.5 + 0.5 * @sin(t * std.math.tau);

    var y: u32 = 0;
    while (y < height) : (y += 1) {
        const on_h_border = y < BORDER_PX or (height > BORDER_PX and y >= height - BORDER_PX);
        const row_start = @as(usize, y) * @as(usize, stride_bytes);
        const row = pixmap[row_start..][0 .. @as(usize, width) * 4];

        var x: u32 = 0;
        while (x < width) : (x += 1) {
            const on_v_border = x < BORDER_PX or (width > BORDER_PX and x >= width - BORDER_PX);
            if (!on_h_border and !on_v_border) continue;

            const i = @as(usize, x) * 4;
            const alpha = row[i + 3];
            row[i] = blendChannel(row[i], ACCENT_R, alpha, weight);
            row[i + 1] = blendChannel(row[i + 1], ACCENT_G, alpha, weight);
            row[i + 2] = blendChannel(row[i + 2], ACCENT_B, alpha, weight);
            // Alpha untouched — this only recolors existing coverage, never
            // paints over what was fully transparent.
        }
    }
}

/// Mix `orig` (premultiplied) toward `accent` (a straight-alpha color) by
/// `weight`, at the pixel's own alpha. `accent` is scaled by alpha/255
/// first so the result stays a valid premultiplied value consistent with
/// the pixel it's replacing — the same reasoning carbon-crt's scaleChannel
/// comment works through for a pure darken; this is a blend instead.
fn blendChannel(orig_premul: u8, accent_straight: u8, alpha: u8, weight: f32) u8 {
    const accent_premul: f32 = @as(f32, @floatFromInt(accent_straight)) *
        (@as(f32, @floatFromInt(alpha)) / 255.0);
    const o: f32 = @floatFromInt(orig_premul);
    const mixed = o * (1.0 - weight) + accent_premul * weight;
    return @intFromFloat(std.math.clamp(mixed, 0.0, 255.0));
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares both points and the carbon:carbon-pulse module" {
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"carbon_pulse\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "paint.before") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "carbon:carbon-pulse") != null);
}

test "the manifest is valid JSON" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        arena.allocator(),
        std.mem.span(MANIFEST),
        .{},
    );
    try std.testing.expect(parsed.value == .object);
}

test "the interior is never touched" {
    const width: u32 = 100;
    const height: u32 = 100;
    const stride = width * 4;
    var buf = [_]u8{ 10, 20, 30, 255 } ** (width * height);

    applyPulse(&buf, width, height, stride, 0);

    const center = 50 * stride + 50 * 4;
    try std.testing.expectEqual(@as(u8, 10), buf[center]);
    try std.testing.expectEqual(@as(u8, 20), buf[center + 1]);
    try std.testing.expectEqual(@as(u8, 30), buf[center + 2]);
}

test "the border shifts toward the accent color, and alpha never moves" {
    const width: u32 = 100;
    const height: u32 = 100;
    const stride = width * 4;
    // frame chosen so weight = 1.0 exactly (t = 0.25 -> sin(tau*0.25) = 1).
    const frame: u64 = PERIOD_FRAMES / 4;
    var buf = [_]u8{ 10, 10, 10, 200 } ** (width * height);

    applyPulse(&buf, width, height, stride, frame);

    const top_left = 0;
    // At weight 1.0 the pixel becomes fully the (alpha-scaled) accent color.
    const expected_r = blendChannel(10, ACCENT_R, 200, 1.0);
    try std.testing.expectEqual(expected_r, buf[top_left]);
    try std.testing.expectEqual(@as(u8, 200), buf[top_left + 3]);
}

test "a fully transparent border pixel stays black, not a phantom color" {
    const width: u32 = 20;
    const height: u32 = 20;
    const stride = width * 4;
    var buf = [_]u8{ 0, 0, 0, 0 } ** (width * height); // alpha 0 everywhere

    applyPulse(&buf, width, height, stride, PERIOD_FRAMES / 4);

    // accent_premul is scaled by alpha/255 = 0, so the mix collapses to 0
    // regardless of weight — nothing appears where nothing was drawn.
    try std.testing.expectEqual(@as(u8, 0), buf[0]);
    try std.testing.expectEqual(@as(u8, 0), buf[3]);
}

test "a zero-sized pixmap does not divide by zero or crash" {
    var buf = [_]u8{};
    applyPulse(&buf, 0, 0, 0, 0);
}
