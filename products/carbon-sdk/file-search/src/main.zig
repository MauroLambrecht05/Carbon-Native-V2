// file-search — in-app gitignore-aware grep/glob/search, as an opt-in
// plugin instead of an always-on runtime capability.
//
//   carbon plugin add file-search
//
//   import { grep, glob, search, listSubdirs } from "carbon:file-search";
//
// Ported from solutions/infrastructure/os/adapters/filesystem/fs_search.rs
// (itself ported from a Tauri backend — see that file's own header), with
// one real difference: that version leaned on three mature Rust crates
// (`ignore`, `globset`, `grep-regex` — ~1.2 MiB combined per this repo's own
// cargo-bloat measurements) that always shipped in every app's runtime
// regardless of whether the app used file search at all. This plugin
// reimplements the matching logic itself (see regex.zig/glob.zig/
// gitignore.zig's own header comments for exactly what's a reduced subset
// vs. those crates), so an app that doesn't enable it pays nothing, and one
// that does pays only for this, not for ripgrep's full feature set.
//
//   zig build                      build it
//   carbon plugin add file-search  fetch + build + install into the current app
//   carbon plugin check            verify this file against the registry

const std = @import("std");
const sdk = @import("carbon_sdk");
const regex = @import("regex.zig");
const glob = @import("glob.zig");
const gitignore = @import("gitignore.zig");

// Zig 0.16 threads an explicit `Io` context through every filesystem call
// (no more implicit `std.fs.cwd()`/global runtime) — see std/Io.zig and
// std/Io/Dir.zig. `newIo`/`Dir` below are this file's one place naming that
// API, so every other function just takes `io: std.Io` as a parameter.
const Dir = std.Io.Dir;

/// A blocking Io backend for this synchronous plugin (no async/concurrent
/// use anywhere in this file). One per top-level JS call, matching the
/// existing arena-per-call convention — see each `js*` function.
fn newIo(allocator: std.mem.Allocator) std.Io.Threaded {
    return std.Io.Threaded.init(allocator, .{});
}

// ── Manifest ────────────────────────────────────────────────────────────────

pub const CFG = sdk.manifest.Config{
    .name = "file-search",
    .version = "0.1.0",
    .points = &.{ "lifecycle.register", "lifecycle.after_reload" },
    .modules = &.{"carbon:file-search"},
    .exports = &.{
        .{ .name = "grep" },
        .{ .name = "glob" },
        .{ .name = "search" },
        .{ .name = "listSubdirs" },
    },
    .abi_version_major = sdk.ABI_VERSION_MAJOR,
    .abi_version_minor = sdk.ABI_VERSION_MINOR,
};

const MANIFEST = sdk.manifest.build(CFG);

pub fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}
comptime {
    sdk.ext.implementManifest(carbon_plugin_manifest);
}

var g_app: ?sdk.CarbonApp = null;

pub fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    g_app = app;
    installGlobals(app);
}
comptime {
    sdk.ext.implement("lifecycle.register", carbon_plugin_register);
}

pub fn carbon_plugin_after_reload(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    g_app = app;
    installGlobals(app);
}
comptime {
    sdk.ext.implement("lifecycle.after_reload", carbon_plugin_after_reload);
}

fn installGlobals(app: sdk.CarbonApp) void {
    _ = app.setGlobalFunction("grep", jsGrep);
    _ = app.setGlobalFunction("glob", jsGlob);
    _ = app.setGlobalFunction("search", jsSearch);
    _ = app.setGlobalFunction("listSubdirs", jsListSubdirs);
}

// ── Limits — same numbers fs_search.rs used ─────────────────────────────────

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_GREP_MAX_RESULTS: usize = 200;
const DEFAULT_GLOB_MAX_RESULTS: usize = 500;
const DEFAULT_SEARCH_LIMIT: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;
const MAX_SCANNED: usize = 50_000;

// ── Result helpers (same shape as clipboard.zig's) ──────────────────────────

fn writeResult(buf: [*c]u8, cap: usize, json: []const u8) void {
    if (buf == null or cap == 0) return;
    if (json.len + 1 > cap) return;
    @memcpy(buf[0..json.len], json);
    buf[json.len] = 0;
}

fn writeErr(buf: [*c]u8, cap: usize, arena: std.mem.Allocator, msg: []const u8) void {
    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(arena, "{\"error\":") catch return;
    jsonQuoteAppend(arena, &out, msg) catch return;
    out.append(arena, '}') catch return;
    writeResult(buf, cap, out.items);
}

fn jsonQuoteAppend(a: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    try out.append(a, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(a, "\\\""),
            '\\' => try out.appendSlice(a, "\\\\"),
            '\n' => try out.appendSlice(a, "\\n"),
            '\r' => try out.appendSlice(a, "\\r"),
            '\t' => try out.appendSlice(a, "\\t"),
            0x00...0x08, 0x0b...0x0c, 0x0e...0x1f => {
                var tmp: [6]u8 = undefined;
                const w = std.fmt.bufPrint(&tmp, "\\u{x:0>4}", .{c}) catch continue;
                try out.appendSlice(a, w);
            },
            else => try out.append(a, c),
        }
    }
    try out.append(a, '"');
}

fn parseArgs(a: std.mem.Allocator, args_json: [*c]const u8) ?std.json.Value {
    if (args_json == null) return null;
    const raw = std.mem.span(@as([*:0]const u8, @ptrCast(args_json)));
    const parsed = std.json.parseFromSlice(std.json.Value, a, raw, .{}) catch return null;
    const arr = switch (parsed.value) {
        .array => |ar| ar.items,
        else => return null,
    };
    if (arr.len == 0) return null;
    return arr[0];
}

fn getStr(obj: std.json.Value, key: []const u8) ?[]const u8 {
    const o = switch (obj) {
        .object => |m| m,
        else => return null,
    };
    const v = o.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

fn getBool(obj: std.json.Value, key: []const u8, default: bool) bool {
    const o = switch (obj) {
        .object => |m| m,
        else => return default,
    };
    const v = o.get(key) orelse return default;
    return switch (v) {
        .bool => |b| b,
        else => default,
    };
}

fn getUsize(obj: std.json.Value, key: []const u8, default: usize) usize {
    const o = switch (obj) {
        .object => |m| m,
        else => return default,
    };
    const v = o.get(key) orelse return default;
    return switch (v) {
        .integer => |n| if (n < 0) default else @intCast(n),
        .float => |f| if (f < 0) default else @intFromFloat(f),
        else => default,
    };
}

fn getStrArray(a: std.mem.Allocator, obj: std.json.Value, key: []const u8) [][]const u8 {
    const o = switch (obj) {
        .object => |m| m,
        else => return &.{},
    };
    const v = o.get(key) orelse return &.{};
    const arr = switch (v) {
        .array => |ar| ar.items,
        else => return &.{},
    };
    var out = a.alloc([]const u8, arr.len) catch return &.{};
    var n: usize = 0;
    for (arr) |item| {
        switch (item) {
            .string => |s| {
                out[n] = s;
                n += 1;
            },
            else => {},
        }
    }
    return out[0..n];
}

/// Backslashes to forward slashes — mirrors fs_search.rs's `to_canon`.
fn toCanon(a: std.mem.Allocator, path: []const u8) ![]u8 {
    const out = try a.dupe(u8, path);
    for (out) |*c| {
        if (c.* == '\\') c.* = '/';
    }
    return out;
}

fn toLowerAlloc(a: std.mem.Allocator, s: []const u8) ![]u8 {
    const out = try a.dupe(u8, s);
    for (out) |*c| c.* = std.ascii.toLower(c.*);
    return out;
}

// ── The shared walker ────────────────────────────────────────────────────────
//
// Depth-first, gitignore-aware, hidden-file-aware. `Ctx`/`visit` follow the
// same shape a callback closure would in a language with real closures —
// Zig doesn't have those, so the visitor is a comptime function plus an
// explicit context pointer instead.

const WalkAction = enum { keep_going, stop };

const WalkOptions = struct {
    show_hidden: bool,
    scanned: *usize,
    max_scanned: usize,
};

fn walk(
    comptime Ctx: type,
    ctx: *Ctx,
    comptime visit: fn (*Ctx, rel: []const u8, is_dir: bool) WalkAction,
    io: std.Io,
    a: std.mem.Allocator,
    root_dir: Dir,
    rel_buf: *std.ArrayList(u8),
    rules: *gitignore.RuleSet,
    opts: WalkOptions,
) !WalkAction {
    // Pick up this directory's own .gitignore, if any, scoped to this
    // subtree only (truncated back off before returning).
    const rules_mark = rules.rules.items.len;
    defer rules.rules.items.len = rules_mark;
    if (root_dir.readFileAlloc(io, ".gitignore", a, std.Io.Limit.limited(1024 * 1024))) |contents| {
        rules.addFile(rel_buf.items, contents) catch {};
    } else |_| {}

    var it = root_dir.iterate();
    while (try it.next(io)) |entry| {
        if (!opts.show_hidden and entry.name.len > 0 and entry.name[0] == '.') continue;
        if (gitignore.isAlwaysPruned(entry.name)) continue;
        if (entry.kind == .sym_link) continue; // follow_links(false), matching fs_search.rs

        const base_len = rel_buf.items.len;
        if (rel_buf.items.len != 0) try rel_buf.append(a, '/');
        try rel_buf.appendSlice(a, entry.name);
        defer rel_buf.items.len = base_len;

        const is_dir = entry.kind == .directory;
        if (rules.isIgnored(rel_buf.items, is_dir)) continue;

        opts.scanned.* += 1;
        if (opts.scanned.* > opts.max_scanned) return .stop;

        if (is_dir) {
            var sub = root_dir.openDir(io, entry.name, .{ .iterate = true }) catch continue;
            defer sub.close(io);
            const action = try walk(Ctx, ctx, visit, io, a, sub, rel_buf, rules, opts);
            if (action == .stop) return .stop;
        } else {
            if (visit(ctx, rel_buf.items, false) == .stop) return .stop;
        }
    }
    return .keep_going;
}

fn openRoot(io: std.Io, root: []const u8) ?Dir {
    return Dir.cwd().openDir(io, root, .{ .iterate = true }) catch null;
}

// ── grep(pattern, opts) → { hits, truncated, files_scanned } ────────────────

const GrepHit = struct { path: []const u8, rel: []const u8, line: usize, text: []const u8 };

const GrepCtx = struct {
    a: std.mem.Allocator,
    io: std.Io,
    root: []const u8,
    root_dir: Dir,
    re: *regex.Regex,
    globs: []const []const u8,
    cap: usize,
    hits: std.ArrayList(GrepHit),
    truncated: bool,
};

fn grepVisit(ctx: *GrepCtx, rel: []const u8, is_dir: bool) WalkAction {
    if (is_dir) return .keep_going;
    if (ctx.globs.len > 0) {
        var any = false;
        for (ctx.globs) |g| {
            if (glob.matches(g, rel)) {
                any = true;
                break;
            }
        }
        if (!any) return .keep_going;
    }
    const stat = ctx.root_dir.statFile(ctx.io, rel, .{}) catch return .keep_going;
    if (stat.size > FILE_SIZE_CAP) return .keep_going;
    const contents = ctx.root_dir.readFileAlloc(ctx.io, rel, ctx.a, std.Io.Limit.limited(FILE_SIZE_CAP)) catch return .keep_going;
    if (std.mem.indexOfScalar(u8, contents, 0) != null) return .keep_going; // binary

    var line_no: usize = 0;
    var lines = std.mem.splitScalar(u8, contents, '\n');
    while (lines.next()) |line_raw| {
        line_no += 1;
        const line = std.mem.trimEnd(u8, line_raw, "\r");
        if (ctx.re.isMatch(line)) {
            if (ctx.hits.items.len >= ctx.cap) {
                ctx.truncated = true;
                return .stop;
            }
            const abs = std.fmt.allocPrint(ctx.a, "{s}/{s}", .{ ctx.root, rel }) catch continue;
            ctx.hits.append(ctx.a, .{
                .path = toCanon(ctx.a, abs) catch abs,
                .rel = rel,
                .line = line_no,
                .text = ctx.a.dupe(u8, line) catch line,
            }) catch return .stop;
        }
    }
    return .keep_going;
}

fn jsGrep(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const args = parseArgs(a, args_json) orelse {
        writeErr(result_buf, result_buf_len, a, "expected (pattern, opts)");
        return;
    };
    const pattern = getStr(args, "pattern") orelse "";
    if (pattern.len == 0) {
        writeErr(result_buf, result_buf_len, a, "empty pattern");
        return;
    }
    const root = getStr(args, "root") orelse "";
    var threaded = newIo(a);
    defer threaded.deinit();
    const io = threaded.io();

    var root_dir = openRoot(io, root) orelse {
        writeErr(result_buf, result_buf_len, a, "not a directory");
        return;
    };
    defer root_dir.close(io);

    const case_insensitive = getBool(args, "caseInsensitive", false);
    const cap = @min(@max(getUsize(args, "maxResults", DEFAULT_GREP_MAX_RESULTS), 1), HARD_MAX_RESULTS);
    const glob_patterns = getStrArray(a, args, "glob");

    var re = regex.compile(a, pattern, case_insensitive) catch {
        writeErr(result_buf, result_buf_len, a, "bad regex");
        return;
    };
    defer re.deinit();

    var rules = gitignore.RuleSet.init(a);
    defer rules.deinit();
    var rel_buf: std.ArrayList(u8) = .empty;
    var scanned: usize = 0;

    var ctx = GrepCtx{
        .a = a,
        .io = io,
        .root = root,
        .root_dir = root_dir,
        .re = &re,
        .globs = glob_patterns,
        .cap = cap,
        .hits = .empty,
        .truncated = false,
    };
    _ = walk(GrepCtx, &ctx, grepVisit, io, a, root_dir, &rel_buf, &rules, .{
        .show_hidden = false,
        .scanned = &scanned,
        .max_scanned = MAX_SCANNED,
    }) catch {};

    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(a, "{\"hits\":[") catch return;
    for (ctx.hits.items, 0..) |h, i| {
        if (i > 0) out.append(a, ',') catch return;
        out.appendSlice(a, "{\"path\":") catch return;
        jsonQuoteAppend(a, &out, h.path) catch return;
        out.appendSlice(a, ",\"rel\":") catch return;
        jsonQuoteAppend(a, &out, h.rel) catch return;
        const line_frag = std.fmt.allocPrint(a, ",\"line\":{d},\"text\":", .{h.line}) catch continue;
        out.appendSlice(a, line_frag) catch return;
        jsonQuoteAppend(a, &out, h.text) catch return;
        out.append(a, '}') catch return;
    }
    const tail = std.fmt.allocPrint(a, "],\"truncated\":{s},\"files_scanned\":{d}}}", .{
        if (ctx.truncated) "true" else "false",
        scanned,
    }) catch return;
    out.appendSlice(a, tail) catch return;
    writeResult(result_buf, result_buf_len, out.items);
}

// ── glob(pattern, opts) → { hits, truncated } ───────────────────────────────

const GlobHit = struct { path: []const u8, rel: []const u8 };

const GlobCtx = struct {
    a: std.mem.Allocator,
    root: []const u8,
    pattern: []const u8,
    cap: usize,
    hits: std.ArrayList(GlobHit),
    truncated: bool,
};

fn globVisit(ctx: *GlobCtx, rel: []const u8, is_dir: bool) WalkAction {
    if (is_dir) return .keep_going;
    if (!glob.matches(ctx.pattern, rel)) return .keep_going;
    if (ctx.hits.items.len >= ctx.cap) {
        ctx.truncated = true;
        return .stop;
    }
    const abs = std.fmt.allocPrint(ctx.a, "{s}/{s}", .{ ctx.root, rel }) catch return .keep_going;
    ctx.hits.append(ctx.a, .{
        .path = toCanon(ctx.a, abs) catch abs,
        .rel = ctx.a.dupe(u8, rel) catch rel,
    }) catch return .stop;
    return .keep_going;
}

fn jsGlob(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const args = parseArgs(a, args_json) orelse {
        writeErr(result_buf, result_buf_len, a, "expected (pattern, opts)");
        return;
    };
    const pattern = getStr(args, "pattern") orelse "";
    if (pattern.len == 0) {
        writeErr(result_buf, result_buf_len, a, "empty pattern");
        return;
    }
    const root = getStr(args, "root") orelse "";
    var threaded = newIo(a);
    defer threaded.deinit();
    const io = threaded.io();

    var root_dir = openRoot(io, root) orelse {
        writeErr(result_buf, result_buf_len, a, "not a directory");
        return;
    };
    defer root_dir.close(io);
    const cap = @min(@max(getUsize(args, "maxResults", DEFAULT_GLOB_MAX_RESULTS), 1), HARD_MAX_RESULTS);

    var rules = gitignore.RuleSet.init(a);
    defer rules.deinit();
    var rel_buf: std.ArrayList(u8) = .empty;
    var scanned: usize = 0;

    var ctx = GlobCtx{ .a = a, .root = root, .pattern = pattern, .cap = cap, .hits = .empty, .truncated = false };
    _ = walk(GlobCtx, &ctx, globVisit, io, a, root_dir, &rel_buf, &rules, .{
        .show_hidden = false,
        .scanned = &scanned,
        .max_scanned = MAX_SCANNED,
    }) catch {};

    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(a, "{\"hits\":[") catch return;
    for (ctx.hits.items, 0..) |h, i| {
        if (i > 0) out.append(a, ',') catch return;
        out.appendSlice(a, "{\"path\":") catch return;
        jsonQuoteAppend(a, &out, h.path) catch return;
        out.appendSlice(a, ",\"rel\":") catch return;
        jsonQuoteAppend(a, &out, h.rel) catch return;
        out.append(a, '}') catch return;
    }
    const tail = std.fmt.allocPrint(a, "],\"truncated\":{s}}}", .{if (ctx.truncated) "true" else "false"}) catch return;
    out.appendSlice(a, tail) catch return;
    writeResult(result_buf, result_buf_len, out.items);
}

// ── search(query, opts) → { hits, truncated } (fuzzy path search, ranked) ──

const SearchHit = struct { path: []const u8, rel: []const u8, name: []const u8, is_dir: bool, name_matches: bool };

const SearchCtx = struct {
    a: std.mem.Allocator,
    root: []const u8,
    query_lower: []const u8,
    cap: usize,
    hits: std.ArrayList(SearchHit),
    truncated: bool,
};

fn searchVisit(ctx: *SearchCtx, rel: []const u8, is_dir: bool) WalkAction {
    if (ctx.hits.items.len >= ctx.cap) {
        ctx.truncated = true;
        return .stop;
    }
    const rel_lower = toLowerAlloc(ctx.a, rel) catch return .keep_going;
    if (std.mem.indexOf(u8, rel_lower, ctx.query_lower) == null) return .keep_going;

    const name = if (std.mem.lastIndexOfScalar(u8, rel, '/')) |i| rel[i + 1 ..] else rel;
    const name_lower = toLowerAlloc(ctx.a, name) catch name;
    const name_matches = std.mem.indexOf(u8, name_lower, ctx.query_lower) != null;

    const abs = std.fmt.allocPrint(ctx.a, "{s}/{s}", .{ ctx.root, rel }) catch return .keep_going;
    ctx.hits.append(ctx.a, .{
        .path = toCanon(ctx.a, abs) catch abs,
        .rel = ctx.a.dupe(u8, rel) catch rel,
        .name = ctx.a.dupe(u8, name) catch name,
        .is_dir = is_dir,
        .name_matches = name_matches,
    }) catch return .stop;
    return .keep_going;
}

fn jsSearch(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const args = parseArgs(a, args_json) orelse {
        writeErr(result_buf, result_buf_len, a, "expected (query, opts)");
        return;
    };
    const query_raw = getStr(args, "query") orelse "";
    const query = std.mem.trim(u8, query_raw, " \t\r\n");
    if (query.len == 0) {
        writeResult(result_buf, result_buf_len, "{\"hits\":[],\"truncated\":false}");
        return;
    }
    const root = getStr(args, "root") orelse "";
    var threaded = newIo(a);
    defer threaded.deinit();
    const io = threaded.io();

    var root_dir = openRoot(io, root) orelse {
        writeErr(result_buf, result_buf_len, a, "not a directory");
        return;
    };
    defer root_dir.close(io);
    const cap = @min(getUsize(args, "limit", DEFAULT_SEARCH_LIMIT), 1000);
    const show_hidden = getBool(args, "showHidden", false);
    const query_lower = toLowerAlloc(a, query) catch query;

    var rules = gitignore.RuleSet.init(a);
    defer rules.deinit();
    var rel_buf: std.ArrayList(u8) = .empty;
    var scanned: usize = 0;

    var ctx = SearchCtx{ .a = a, .root = root, .query_lower = query_lower, .cap = cap, .hits = .empty, .truncated = false };
    _ = walk(SearchCtx, &ctx, searchVisit, io, a, root_dir, &rel_buf, &rules, .{
        .show_hidden = show_hidden,
        .scanned = &scanned,
        .max_scanned = MAX_SCANNED,
    }) catch {};

    // Rank: filename matches first, then shorter relative paths — matches
    // fs_search.rs's `sort_by(|a,b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)))`.
    const Sorter = struct {
        fn lessThan(_: void, x: SearchHit, y: SearchHit) bool {
            if (x.name_matches != y.name_matches) return x.name_matches and !y.name_matches;
            return x.rel.len < y.rel.len;
        }
    };
    std.mem.sort(SearchHit, ctx.hits.items, {}, Sorter.lessThan);

    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(a, "{\"hits\":[") catch return;
    for (ctx.hits.items, 0..) |h, i| {
        if (i > 0) out.append(a, ',') catch return;
        out.appendSlice(a, "{\"path\":") catch return;
        jsonQuoteAppend(a, &out, h.path) catch return;
        out.appendSlice(a, ",\"rel\":") catch return;
        jsonQuoteAppend(a, &out, h.rel) catch return;
        out.appendSlice(a, ",\"name\":") catch return;
        jsonQuoteAppend(a, &out, h.name) catch return;
        const dir_frag = std.fmt.allocPrint(a, ",\"is_dir\":{s}}}", .{if (h.is_dir) "true" else "false"}) catch continue;
        out.appendSlice(a, dir_frag) catch return;
    }
    const tail = std.fmt.allocPrint(a, "],\"truncated\":{s}}}", .{if (ctx.truncated) "true" else "false"}) catch return;
    out.appendSlice(a, tail) catch return;
    writeResult(result_buf, result_buf_len, out.items);
}

// ── listSubdirs(path, opts) → string[] ──────────────────────────────────────
//
// One level only, symlinks-to-directories included (matches shell `cd`),
// no gitignore involvement — mirrors fs_search.rs's `list_subdirs` exactly.

fn jsListSubdirs(_: ?*sdk.RawJsContext, args_json: [*c]const u8, result_buf: [*c]u8, result_buf_len: usize) callconv(.c) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const args = parseArgs(a, args_json) orelse {
        writeErr(result_buf, result_buf_len, a, "expected (path, opts)");
        return;
    };
    const path = getStr(args, "path") orelse "";
    const show_hidden = getBool(args, "showHidden", false);

    var threaded = newIo(a);
    defer threaded.deinit();
    const io = threaded.io();

    var dir = Dir.cwd().openDir(io, path, .{ .iterate = true }) catch {
        writeErr(result_buf, result_buf_len, a, "cannot read directory");
        return;
    };
    defer dir.close(io);

    var names: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while ((it.next(io) catch null)) |entry| {
        if (!show_hidden and entry.name.len > 0 and entry.name[0] == '.') continue;
        var is_dir = entry.kind == .directory;
        if (!is_dir and entry.kind == .sym_link) {
            const st = dir.statFile(io, entry.name, .{}) catch continue;
            is_dir = st.kind == .directory;
        }
        if (!is_dir) continue;
        names.append(a, a.dupe(u8, entry.name) catch continue) catch continue;
    }
    const Sorter = struct {
        fn lessThan(_: void, x: []const u8, y: []const u8) bool {
            // Case-insensitive, byte-wise — matches fs_search.rs's
            // `sort_by_key(|a| a.to_lowercase())` closely enough for ASCII
            // directory names, which is what this ever sees in practice.
            var i: usize = 0;
            while (i < x.len and i < y.len) : (i += 1) {
                const cx = std.ascii.toLower(x[i]);
                const cy = std.ascii.toLower(y[i]);
                if (cx != cy) return cx < cy;
            }
            return x.len < y.len;
        }
    };
    std.mem.sort([]const u8, names.items, {}, Sorter.lessThan);

    var out: std.ArrayList(u8) = .empty;
    out.append(a, '[') catch return;
    for (names.items, 0..) |n, i| {
        if (i > 0) out.append(a, ',') catch return;
        jsonQuoteAppend(a, &out, n) catch return;
    }
    out.append(a, ']') catch return;
    writeResult(result_buf, result_buf_len, out.items);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "the manifest declares the plugin's identity and lifecycle points" {
    // The runtime manifest doesn't carry export names at all — see
    // manifest.zig's own doc comment ("the ONE piece... the runtime's
    // embedded JSON never carries"); that only lives in carbon-plugin.toml
    // via toToml(), generated separately by `zig build gen-manifest`.
    const json = std.mem.span(MANIFEST);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"name\":\"file-search\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.register") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "lifecycle.after_reload") != null);
}

test "carbon-plugin.toml generation lists all four exports" {
    const toml = comptime sdk.manifest.toToml(CFG);
    try std.testing.expect(std.mem.indexOf(u8, toml, "\"grep\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, toml, "\"glob\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, toml, "\"search\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, toml, "\"listSubdirs\"") != null);
}

test "toCanon replaces backslashes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const out = try toCanon(arena.allocator(), "a\\b\\c.ts");
    try std.testing.expectEqualStrings("a/b/c.ts", out);
}

test "jsonQuoteAppend escapes control characters" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var out: std.ArrayList(u8) = .empty;
    try jsonQuoteAppend(arena.allocator(), &out, "he said \"hi\"\n");
    try std.testing.expectEqualStrings("\"he said \\\"hi\\\"\\n\"", out.items);
}

test "walk finds files respecting gitignore and always-pruned dirs" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    const tio = std.testing.io;
    try tmp.dir.writeFile(tio, .{ .sub_path = "keep.ts", .data = "hello" });
    try tmp.dir.writeFile(tio, .{ .sub_path = "skip.log", .data = "bye" });
    try tmp.dir.writeFile(tio, .{ .sub_path = ".gitignore", .data = "*.log\n" });
    (try tmp.dir.createDirPathOpen(tio, "node_modules", .{})).close(tio);
    try tmp.dir.writeFile(tio, .{ .sub_path = "node_modules/x.ts", .data = "nope" });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const Collector = struct {
        a: std.mem.Allocator,
        found: std.ArrayList([]const u8) = .empty,
        fn visit(self: *@This(), rel: []const u8, is_dir: bool) WalkAction {
            if (!is_dir) self.found.append(self.a, self.a.dupe(u8, rel) catch rel) catch {};
            return .keep_going;
        }
    };
    var collector = Collector{ .a = a };
    var rules = gitignore.RuleSet.init(a);
    defer rules.deinit();
    var rel_buf: std.ArrayList(u8) = .empty;
    var scanned: usize = 0;
    _ = try walk(Collector, &collector, Collector.visit, tio, a, tmp.dir, &rel_buf, &rules, .{
        .show_hidden = false,
        .scanned = &scanned,
        .max_scanned = MAX_SCANNED,
    });

    var saw_keep = false;
    var saw_skip = false;
    var saw_nested = false;
    for (collector.found.items) |f| {
        if (std.mem.eql(u8, f, "keep.ts")) saw_keep = true;
        if (std.mem.eql(u8, f, "skip.log")) saw_skip = true;
        if (std.mem.indexOf(u8, f, "node_modules") != null) saw_nested = true;
    }
    try std.testing.expect(saw_keep);
    try std.testing.expect(!saw_skip);
    try std.testing.expect(!saw_nested);
}
