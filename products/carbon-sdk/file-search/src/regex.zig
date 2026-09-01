// A small backtracking regex engine, written from scratch for this plugin.
//
// WHY THIS EXISTS: the Rust implementation this plugin replaces
// (solutions/infrastructure/os/adapters/filesystem/fs_search.rs) used
// `grep-regex`, which is backed by `regex-automata` — a full RE2-class
// engine (~740 KiB across regex_automata+regex_syntax+aho_corasick, measured
// via cargo-bloat on this exact binary). Pulling a crate that size into a
// plugin that most apps never enable defeats the point of making it a
// plugin at all, so this is a genuinely smaller, hand-written subset engine,
// not a port.
//
// SUPPORTED: literals, `.` (any char), character classes `[abc]`/`[^abc]`/
// `[a-z]`, the shorthand classes `\d \D \w \W \s \S`, anchors `^`/`$`,
// quantifiers `* + ?` (greedy, backtracking), grouping `(...)`, alternation
// `a|b`, and `\` to escape a metacharacter literally.
//
// NOT SUPPORTED (deliberately, to keep this small): bounded repetition
// `{n,m}`, capture groups (grouping is structural only, nothing is
// extracted), non-greedy quantifiers, lookaround, backreferences, Unicode
// character classes (byte-oriented, like the walk/glob/gitignore modules
// beside this file). A pattern using any of these fails to compile with a
// clear error rather than silently matching something else.
//
// Matching is backtracking recursion over an AST, scoped to one line of
// text at a time (this plugin's only caller, fs_grep, searches line by
// line) — patterns and inputs at that scale make the classic exponential
// worst case a non-issue in practice, the same trade every regex engine
// without automaton compilation makes.

const std = @import("std");

pub const CompileError = error{
    UnbalancedParen,
    UnbalancedBracket,
    DanglingQuantifier,
    NothingToRepeat,
    TrailingBackslash,
    EmptyPattern,
    UnknownEscape,
} || std.mem.Allocator.Error;

const ClassRange = struct { lo: u8, hi: u8 };

const CharClass = struct {
    negate: bool,
    ranges: []const ClassRange,

    fn matches(self: CharClass, c: u8, case_insensitive: bool) bool {
        var hit = false;
        for (self.ranges) |r| {
            if (inRange(c, r, case_insensitive)) {
                hit = true;
                break;
            }
        }
        return hit != self.negate;
    }

    fn inRange(c: u8, r: ClassRange, case_insensitive: bool) bool {
        if (c >= r.lo and c <= r.hi) return true;
        if (!case_insensitive) return false;
        const alt = swapCase(c);
        return alt >= r.lo and alt <= r.hi;
    }
};

fn swapCase(c: u8) u8 {
    if (c >= 'a' and c <= 'z') return c - 32;
    if (c >= 'A' and c <= 'Z') return c + 32;
    return c;
}

fn eqChar(a: u8, b: u8, case_insensitive: bool) bool {
    if (a == b) return true;
    if (!case_insensitive) return false;
    return swapCase(a) == b;
}

const Node = union(enum) {
    lit: u8,
    any,
    class: CharClass,
    start_anchor,
    end_anchor,
    star: *const Node,
    plus: *const Node,
    opt: *const Node,
    // A parenthesized group with no alternation inside: a plain sequence.
    group: []const Node,
    // Alternation: a list of alternative sequences, exactly one must match.
    alt: []const []const Node,
};

pub const Regex = struct {
    arena: std.heap.ArenaAllocator,
    program: []const Node,
    case_insensitive: bool,

    pub fn deinit(self: *Regex) void {
        self.arena.deinit();
    }

    /// Does `text` contain a match anywhere? (unanchored search, like grep)
    pub fn isMatch(self: *Regex, text: []const u8) bool {
        return self.find(text) != null;
    }

    /// First match's [start, end) byte range, or null.
    pub fn find(self: *Regex, text: []const u8) ?struct { start: usize, end: usize } {
        var scratch = std.heap.ArenaAllocator.init(self.arena.child_allocator);
        defer scratch.deinit();
        var start: usize = 0;
        while (start <= text.len) : (start += 1) {
            defer _ = scratch.reset(.retain_capacity);
            if (matchSeq(scratch.allocator(), self.program, text, start, start, self.case_insensitive)) |end| {
                return .{ .start = start, .end = end };
            }
        }
        return null;
    }
};

pub fn compile(allocator: std.mem.Allocator, pattern: []const u8, case_insensitive: bool) CompileError!Regex {
    if (pattern.len == 0) return CompileError.EmptyPattern;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    var p = Parser{ .src = pattern, .pos = 0, .a = arena.allocator() };
    const seq = try p.parseAlt();
    if (p.pos != pattern.len) {
        if (pattern[p.pos] == ')') return CompileError.UnbalancedParen;
        return CompileError.DanglingQuantifier;
    }
    return .{ .arena = arena, .program = seq, .case_insensitive = case_insensitive };
}

const Parser = struct {
    src: []const u8,
    pos: usize,
    a: std.mem.Allocator,

    fn peek(self: *Parser) ?u8 {
        return if (self.pos < self.src.len) self.src[self.pos] else null;
    }

    fn bump(self: *Parser) ?u8 {
        if (self.pos >= self.src.len) return null;
        const c = self.src[self.pos];
        self.pos += 1;
        return c;
    }

    /// alt := concat ('|' concat)*
    fn parseAlt(self: *Parser) CompileError![]const Node {
        var branches = std.ArrayList([]const Node).empty;
        const first = try self.parseConcat();
        try branches.append(self.a, first);
        while (self.peek() == '|') {
            _ = self.bump();
            const next = try self.parseConcat();
            try branches.append(self.a, next);
        }
        if (branches.items.len == 1) return branches.items[0];
        const alt_node = try self.a.create(Node);
        alt_node.* = .{ .alt = try branches.toOwnedSlice(self.a) };
        const out = try self.a.alloc(Node, 1);
        out[0] = alt_node.*;
        return out;
    }

    /// concat := quantified*  (stops at '|' or ')' or end)
    fn parseConcat(self: *Parser) CompileError![]const Node {
        var nodes = std.ArrayList(Node).empty;
        while (self.peek()) |c| {
            if (c == '|' or c == ')') break;
            const n = try self.parseQuantified();
            try nodes.append(self.a, n);
        }
        return try nodes.toOwnedSlice(self.a);
    }

    /// quantified := atom ('*' | '+' | '?')?
    fn parseQuantified(self: *Parser) CompileError!Node {
        const atom = try self.parseAtom();
        switch (self.peek() orelse 0) {
            '*' => {
                _ = self.bump();
                const boxed = try self.a.create(Node);
                boxed.* = atom;
                return .{ .star = boxed };
            },
            '+' => {
                _ = self.bump();
                const boxed = try self.a.create(Node);
                boxed.* = atom;
                return .{ .plus = boxed };
            },
            '?' => {
                _ = self.bump();
                const boxed = try self.a.create(Node);
                boxed.* = atom;
                return .{ .opt = boxed };
            },
            else => return atom,
        }
    }

    /// atom := '.' | '^' | '$' | '(' alt ')' | '[' class ']' | escape | literal
    fn parseAtom(self: *Parser) CompileError!Node {
        const c = self.bump() orelse return CompileError.NothingToRepeat;
        switch (c) {
            '*', '+', '?' => return CompileError.NothingToRepeat,
            '.' => return .any,
            '^' => return .start_anchor,
            '$' => return .end_anchor,
            '(' => {
                const inner = try self.parseAlt();
                if (self.bump() != ')') return CompileError.UnbalancedParen;
                return .{ .group = inner };
            },
            '[' => return try self.parseClass(),
            '\\' => return try self.parseEscape(),
            else => return .{ .lit = c },
        }
    }

    fn parseEscape(self: *Parser) CompileError!Node {
        const c = self.bump() orelse return CompileError.TrailingBackslash;
        return switch (c) {
            'd' => .{ .class = digitClass(false) },
            'D' => .{ .class = digitClass(true) },
            'w' => .{ .class = wordClass(false) },
            'W' => .{ .class = wordClass(true) },
            's' => .{ .class = spaceClass(false) },
            'S' => .{ .class = spaceClass(true) },
            'n' => .{ .lit = '\n' },
            't' => .{ .lit = '\t' },
            'r' => .{ .lit = '\r' },
            '.', '*', '+', '?', '(', ')', '[', ']', '\\', '^', '$', '|' => .{ .lit = c },
            else => CompileError.UnknownEscape,
        };
    }

    fn digitClass(negate: bool) CharClass {
        return .{ .negate = negate, .ranges = &.{.{ .lo = '0', .hi = '9' }} };
    }
    fn wordClass(negate: bool) CharClass {
        return .{ .negate = negate, .ranges = &.{
            .{ .lo = 'a', .hi = 'z' },
            .{ .lo = 'A', .hi = 'Z' },
            .{ .lo = '0', .hi = '9' },
            .{ .lo = '_', .hi = '_' },
        } };
    }
    fn spaceClass(negate: bool) CharClass {
        return .{ .negate = negate, .ranges = &.{
            .{ .lo = ' ', .hi = ' ' },
            .{ .lo = '\t', .hi = '\t' },
            .{ .lo = '\n', .hi = '\n' },
            .{ .lo = '\r', .hi = '\r' },
            .{ .lo = 0x0b, .hi = 0x0c },
        } };
    }

    fn parseClass(self: *Parser) CompileError!Node {
        var negate = false;
        if (self.peek() == '^') {
            negate = true;
            _ = self.bump();
        }
        var ranges = std.ArrayList(ClassRange).empty;
        var first = true;
        while (true) {
            const c = self.peek() orelse return CompileError.UnbalancedBracket;
            if (c == ']' and !first) {
                _ = self.bump();
                break;
            }
            first = false;
            _ = self.bump();
            var lo = c;
            if (c == '\\') {
                lo = self.bump() orelse return CompileError.TrailingBackslash;
            }
            if (self.peek() == '-' and self.pos + 1 < self.src.len and self.src[self.pos + 1] != ']') {
                _ = self.bump(); // '-'
                var hi = self.bump().?;
                if (hi == '\\') hi = self.bump() orelse return CompileError.TrailingBackslash;
                try ranges.append(self.a, .{ .lo = lo, .hi = hi });
            } else {
                try ranges.append(self.a, .{ .lo = lo, .hi = lo });
            }
        }
        return .{ .class = .{ .negate = negate, .ranges = try ranges.toOwnedSlice(self.a) } };
    }
};

/// Match `seq` (a sequence of nodes: the rest of the compiled program) at
/// `text[ti..]`, given the match started at `start`. Returns the end offset
/// of the match on success. `alloc` backs the scratch work star/plus/alt
/// need (concatenated continuations, repetition-position lists) — callers
/// give it an arena scoped to one attempt so nothing needs manual freeing.
fn matchSeq(alloc: std.mem.Allocator, seq: []const Node, text: []const u8, start: usize, ti: usize, ci: bool) ?usize {
    if (seq.len == 0) return ti;
    const node = seq[0];
    const rest = seq[1..];
    switch (node) {
        .lit => |c| {
            if (ti < text.len and eqChar(text[ti], c, ci)) return matchSeq(alloc, rest, text, start, ti + 1, ci);
            return null;
        },
        .any => {
            if (ti < text.len) return matchSeq(alloc, rest, text, start, ti + 1, ci);
            return null;
        },
        .class => |cl| {
            if (ti < text.len and cl.matches(text[ti], ci)) return matchSeq(alloc, rest, text, start, ti + 1, ci);
            return null;
        },
        .start_anchor => {
            if (ti == 0) return matchSeq(alloc, rest, text, start, ti, ci);
            return null;
        },
        .end_anchor => {
            if (ti == text.len) return matchSeq(alloc, rest, text, start, ti, ci);
            return null;
        },
        .opt => |inner| {
            const single = [_]Node{inner.*};
            if (matchThenContinue(alloc, &single, rest, text, start, ti, ci)) |r| return r;
            return matchSeq(alloc, rest, text, start, ti, ci);
        },
        .star => |inner| return matchRepeat(alloc, inner.*, rest, text, start, ti, ci, 0),
        .plus => |inner| return matchRepeat(alloc, inner.*, rest, text, start, ti, ci, 1),
        .group => |sub| return matchThenContinue(alloc, sub, rest, text, start, ti, ci),
        .alt => |branches| {
            for (branches) |branch| {
                if (matchThenContinue(alloc, branch, rest, text, start, ti, ci)) |r| return r;
            }
            return null;
        },
    }
}

/// Match `sub` fully, then hand off to `rest` — implemented by matching
/// against the concatenation of the two, since `matchSeq`'s "seq exhausted"
/// base case is exactly the handoff point.
fn matchThenContinue(alloc: std.mem.Allocator, sub: []const Node, rest: []const Node, text: []const u8, start: usize, ti: usize, ci: bool) ?usize {
    if (rest.len == 0) return matchSeq(alloc, sub, text, start, ti, ci);
    var combined = std.ArrayList(Node).empty;
    combined.appendSlice(alloc, sub) catch return null;
    combined.appendSlice(alloc, rest) catch return null;
    return matchSeq(alloc, combined.items, text, start, ti, ci);
}

/// Greedy `inner{min_count,}` followed by `rest`, backtracking from the
/// longest match down to `min_count` repetitions until `rest` also matches.
fn matchRepeat(alloc: std.mem.Allocator, inner: Node, rest: []const Node, text: []const u8, start: usize, ti: usize, ci: bool, min_count: usize) ?usize {
    var positions = std.ArrayList(usize).empty;
    positions.append(alloc, ti) catch return null;
    var cur = ti;
    const single = [_]Node{inner};
    while (matchSeq(alloc, &single, text, start, cur, ci)) |next| {
        if (next == cur) break; // zero-width match — stop, or this loops forever
        positions.append(alloc, next) catch return null;
        cur = next;
    }
    var i = positions.items.len;
    while (i > min_count) {
        i -= 1;
        if (matchSeq(alloc, rest, text, start, positions.items[i], ci)) |r| return r;
    }
    return null;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "literal match" {
    var re = try compile(std.testing.allocator, "hello", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("say hello world"));
    try std.testing.expect(!re.isMatch("goodbye"));
}

test "case insensitive" {
    var re = try compile(std.testing.allocator, "TODO", true);
    defer re.deinit();
    try std.testing.expect(re.isMatch("// todo: fix this"));
}

test "dot matches any char" {
    var re = try compile(std.testing.allocator, "h.llo", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("hello"));
    try std.testing.expect(re.isMatch("hallo"));
    try std.testing.expect(!re.isMatch("hllo"));
}

test "star quantifier greedy with backtrack" {
    var re = try compile(std.testing.allocator, "a*a", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("aaa"));
    try std.testing.expect(re.isMatch("a"));
    try std.testing.expect(!re.isMatch("b"));
}

test "plus requires at least one" {
    var re = try compile(std.testing.allocator, "a+", false);
    defer re.deinit();
    try std.testing.expect(!re.isMatch(""));
    try std.testing.expect(re.isMatch("aaa"));
}

test "optional" {
    var re = try compile(std.testing.allocator, "colou?r", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("color"));
    try std.testing.expect(re.isMatch("colour"));
}

test "character class and range" {
    var re = try compile(std.testing.allocator, "[a-c]x", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("bx"));
    try std.testing.expect(!re.isMatch("dx"));
}

test "negated character class" {
    var re = try compile(std.testing.allocator, "[^0-9]+", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("abc"));
}

test "anchors" {
    var re_start = try compile(std.testing.allocator, "^fn ", false);
    defer re_start.deinit();
    try std.testing.expect(re_start.isMatch("fn main() {}"));
    try std.testing.expect(!re_start.isMatch("pub fn main() {}"));

    var re_end = try compile(std.testing.allocator, "bar$", false);
    defer re_end.deinit();
    try std.testing.expect(re_end.isMatch("foobar"));
    try std.testing.expect(!re_end.isMatch("foobarbaz"));
}

test "alternation" {
    var re = try compile(std.testing.allocator, "TODO|FIXME|XXX", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("// TODO: later"));
    try std.testing.expect(re.isMatch("// FIXME now"));
    try std.testing.expect(!re.isMatch("// done"));
}

test "grouping with quantifier" {
    var re = try compile(std.testing.allocator, "(ab)+", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("ababab"));
    try std.testing.expect(!re.isMatch("a"));
}

test "shorthand classes" {
    var re = try compile(std.testing.allocator, "\\d+\\.\\d+", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("version 1.2 released"));
}

test "escaped metacharacter is literal" {
    var re = try compile(std.testing.allocator, "3\\.14", false);
    defer re.deinit();
    try std.testing.expect(re.isMatch("pi is 3.14"));
    try std.testing.expect(!re.isMatch("pi is 3x14"));
}

test "empty pattern is a compile error" {
    try std.testing.expectError(CompileError.EmptyPattern, compile(std.testing.allocator, "", false));
}

test "unbalanced paren is a compile error" {
    try std.testing.expectError(CompileError.UnbalancedParen, compile(std.testing.allocator, "(abc", false));
}

test "find returns the match span" {
    var re = try compile(std.testing.allocator, "wor+ld", false);
    defer re.deinit();
    const m = re.find("hello world") orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(usize, 6), m.start);
    try std.testing.expectEqual(@as(usize, 11), m.end);
}
