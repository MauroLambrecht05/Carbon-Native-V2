// A gitignore-style ignore matcher, written from scratch.
//
// WHY THIS EXISTS: replaces the `ignore` crate (ripgrep's own walker,
// ~133 KiB measured via cargo-bloat on this binary, not counting the
// regex/glob machinery it also pulls in). This is a genuinely reduced
// reimplementation, not a port — full gitignore semantics have real edge
// cases (see the KNOWN SIMPLIFICATIONS note below) that `ignore` handles and
// this does not attempt to.
//
// SUPPORTED: comments (`#`), blank lines, negation (`!pattern`),
// directory-only patterns (trailing `/`), root-anchored patterns (leading
// `/`), patterns with a `/` in the middle (anchored to their `.gitignore`'s
// own directory, per real git semantics), plain basename patterns (matched
// at any depth below their `.gitignore`'s directory), and `*`/`**`/`?`/
// `[...]` via glob.zig. Rules from nested `.gitignore` files are appended
// after their parent's and can override them (last match wins), matching
// git's real precedence.
//
// KNOWN SIMPLIFICATIONS: git has a subtle rule where a file inside an
// already-excluded DIRECTORY generally can't be re-included by a later `!`
// rule (because git never even descends into the excluded directory to look
// for one) — this implementation evaluates rules per-path independently and
// does not model that directory-level short-circuit. `\`-escaped
// metacharacters and `.gitignore`'s trailing-whitespace-trim-unless-escaped
// rule are not implemented — trailing whitespace is trimmed unconditionally.
// No support for `$GIT_DIR/info/exclude` or the global gitignore.

const std = @import("std");
const glob = @import("glob.zig");

const Rule = struct {
    /// Path of the directory this rule's `.gitignore` lives in, relative to
    /// the search root, forward-slash separated, no leading/trailing slash
    /// ("" for the root itself).
    base_dir: []const u8,
    negate: bool,
    dir_only: bool,
    /// Has a '/' at the start or in the middle (not just trailing) — matched
    /// against the full path relative to `base_dir` rather than just the
    /// basename.
    anchored: bool,
    /// The glob pattern itself, with any leading '/' and the dir-only
    /// trailing '/' already stripped.
    pattern: []const u8,
};

pub const RuleSet = struct {
    rules: std.ArrayList(Rule),
    arena: std.heap.ArenaAllocator,

    pub fn init(allocator: std.mem.Allocator) RuleSet {
        return .{ .rules = .empty, .arena = std.heap.ArenaAllocator.init(allocator) };
    }

    pub fn deinit(self: *RuleSet) void {
        self.arena.deinit();
    }

    /// Parse one `.gitignore`'s contents and append its rules. `base_dir` is
    /// that file's directory, relative to the search root ("" for root),
    /// forward-slash separated, no leading/trailing slash.
    pub fn addFile(self: *RuleSet, base_dir: []const u8, contents: []const u8) !void {
        const a = self.arena.allocator();
        const owned_base = try a.dupe(u8, base_dir);
        var lines = std.mem.splitScalar(u8, contents, '\n');
        while (lines.next()) |raw_line| {
            var line = std.mem.trimEnd(u8, raw_line, " \t\r");
            line = std.mem.trimStart(u8, line, " \t");
            if (line.len == 0) continue;
            if (line[0] == '#') continue;

            var negate = false;
            if (line[0] == '!') {
                negate = true;
                line = line[1..];
            }
            if (line.len == 0) continue;

            var dir_only = false;
            if (line[line.len - 1] == '/') {
                dir_only = true;
                line = line[0 .. line.len - 1];
            }
            if (line.len == 0) continue;

            var anchored = false;
            if (line[0] == '/') {
                anchored = true;
                line = line[1..];
            } else if (std.mem.indexOfScalar(u8, line, '/') != null) {
                // A '/' anywhere else in the pattern (not counting the
                // dir-only trailing one, already stripped) also anchors it —
                // git's real rule.
                anchored = true;
            }
            if (line.len == 0) continue;

            try self.rules.append(a, .{
                .base_dir = owned_base,
                .negate = negate,
                .dir_only = dir_only,
                .anchored = anchored,
                .pattern = try a.dupe(u8, line),
            });
        }
    }

    /// Is `path` (relative to the search root, forward-slash separated, no
    /// leading slash) ignored? `is_dir` gates directory-only rules.
    pub fn isIgnored(self: *const RuleSet, path: []const u8, is_dir: bool) bool {
        var ignored = false;
        for (self.rules.items) |rule| {
            if (rule.dir_only and !is_dir) continue;
            const rel = stripBase(rule.base_dir, path) orelse continue;
            if (rel.len == 0) continue; // the base directory itself, not an entry in it

            const hit = if (rule.anchored)
                glob.matches(rule.pattern, rel)
            else
                glob.matches(rule.pattern, basename(rel));

            if (hit) ignored = !rule.negate;
        }
        return ignored;
    }
};

/// `path` with `base` stripped as a path-segment prefix, or null if `path`
/// isn't under `base` at all. `base == ""` strips nothing.
fn stripBase(base: []const u8, path: []const u8) ?[]const u8 {
    if (base.len == 0) return path;
    if (path.len <= base.len) return null;
    if (!std.mem.eql(u8, path[0..base.len], base)) return null;
    if (path[base.len] != '/') return null;
    return path[base.len + 1 ..];
}

fn basename(path: []const u8) []const u8 {
    if (std.mem.lastIndexOfScalar(u8, path, '/')) |i| return path[i + 1 ..];
    return path;
}

/// Directory names always pruned, independent of any `.gitignore` — mirrors
/// fs_search.rs's PRUNE_DIRS: these dominate scan time on roots with no
/// gitignore of their own (e.g. searching from $HOME).
pub const ALWAYS_PRUNED = [_][]const u8{
    "node_modules", ".git", "target", "dist", "build",
    ".next",        ".turbo", ".cache", ".venv", "__pycache__",
};

pub fn isAlwaysPruned(name: []const u8) bool {
    for (ALWAYS_PRUNED) |p| {
        if (std.mem.eql(u8, name, p)) return true;
    }
    return false;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "basic ignore" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("", "*.log\n");
    try std.testing.expect(rs.isIgnored("debug.log", false));
    try std.testing.expect(rs.isIgnored("a/b/debug.log", false));
    try std.testing.expect(!rs.isIgnored("debug.txt", false));
}

test "comments and blank lines are skipped" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("",
        \\# a comment
        \\
        \\*.log
        \\
    );
    try std.testing.expect(rs.isIgnored("debug.log", false));
}

test "negation re-includes" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("", "*.log\n!important.log\n");
    try std.testing.expect(rs.isIgnored("debug.log", false));
    try std.testing.expect(!rs.isIgnored("important.log", false));
}

test "directory-only pattern does not match a file of the same name" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("", "build/\n");
    try std.testing.expect(rs.isIgnored("build", true));
    try std.testing.expect(!rs.isIgnored("build", false));
}

test "root-anchored pattern only matches at the root" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("", "/config.json\n");
    try std.testing.expect(rs.isIgnored("config.json", false));
    try std.testing.expect(!rs.isIgnored("a/config.json", false));
}

test "unanchored basename pattern matches at any depth" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("", "*.o\n");
    try std.testing.expect(rs.isIgnored("a/b/c.o", false));
}

test "middle-slash pattern is anchored to its gitignore's directory" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("", "src/gen/*.ts\n");
    try std.testing.expect(rs.isIgnored("src/gen/output.ts", false));
    try std.testing.expect(!rs.isIgnored("other/src/gen/output.ts", false));
}

test "nested gitignore rules apply only under their own directory and can override the parent" {
    var rs = RuleSet.init(std.testing.allocator);
    defer rs.deinit();
    try rs.addFile("", "*.log\n");
    try rs.addFile("keep", "!*.log\n");
    try std.testing.expect(rs.isIgnored("a.log", false));
    try std.testing.expect(rs.isIgnored("other/a.log", false));
    try std.testing.expect(!rs.isIgnored("keep/a.log", false));
}

test "always-pruned directories" {
    try std.testing.expect(isAlwaysPruned("node_modules"));
    try std.testing.expect(!isAlwaysPruned("src"));
}
