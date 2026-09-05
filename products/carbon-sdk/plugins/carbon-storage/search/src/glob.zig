// A small glob matcher for path strings, written from scratch.
//
// WHY THIS EXISTS: replaces the `globset` crate (~73 KiB measured via
// cargo-bloat) the Rust fs_search.rs used. Paths are always forward-slash
// canonicalized before matching (mirroring the old `to_canon` helper), so
// this only ever has to handle `/`, never `\`.
//
// Supports: `*` (any run of chars except `/`), `**` (any run of chars
// INCLUDING `/`, i.e. crosses path segments), `?` (one char except `/`),
// `[abc]` / `[^abc]` / `[a-z]` character classes, and literal characters.
// Not supported: brace expansion (`{a,b}`), extglob. A pattern using them is
// matched literally against those characters rather than expanded — no
// crash, just no match on the intended set.

const std = @import("std");

/// Does `path` match `pattern`? Both are plain byte slices — no allocation.
pub fn matches(pattern: []const u8, path: []const u8) bool {
    return matchRec(pattern, 0, path, 0);
}

fn matchRec(pat: []const u8, pi0: usize, path: []const u8, si0: usize) bool {
    var pi = pi0;
    var si = si0;
    while (true) {
        if (pi == pat.len) return si == path.len;
        const pc = pat[pi];
        if (pc == '*') {
            const double = pi + 1 < pat.len and pat[pi + 1] == '*';
            var np = pi + @as(usize, if (double) 2 else 1);
            while (np < pat.len and pat[np] == '*') np += 1;
            if (double) {
                // "**" followed by "/" also matches zero directories
                // entirely — "**/foo" must match "foo" with no leading
                // path segment, not just "a/foo". Try skipping the slash
                // outright before falling back to the general per-split
                // search (which handles "**" consuming a real prefix that
                // ends right before an actual '/' in the path).
                if (np < pat.len and pat[np] == '/') {
                    if (matchRec(pat, np + 1, path, si)) return true;
                }
                var k = si;
                while (true) : (k += 1) {
                    if (matchRec(pat, np, path, k)) return true;
                    if (k >= path.len) return false;
                }
            } else {
                var k = si;
                while (true) {
                    if (matchRec(pat, np, path, k)) return true;
                    if (k >= path.len or path[k] == '/') return false;
                    k += 1;
                }
            }
        } else if (pc == '?') {
            if (si >= path.len or path[si] == '/') return false;
            pi += 1;
            si += 1;
        } else if (pc == '[') {
            const end = findClassEnd(pat, pi) orelse {
                // Unterminated class — treat '[' as a literal char.
                if (si >= path.len or path[si] != '[') return false;
                pi += 1;
                si += 1;
                continue;
            };
            if (si >= path.len or path[si] == '/') return false;
            if (!classMatches(pat[pi + 1 .. end], path[si])) return false;
            pi = end + 1;
            si += 1;
        } else {
            if (si >= path.len or path[si] != pc) return false;
            pi += 1;
            si += 1;
        }
    }
}

/// `pat[start] == '['`. Returns the index of the matching ']', or null if
/// unterminated.
fn findClassEnd(pat: []const u8, start: usize) ?usize {
    var i = start + 1;
    if (i < pat.len and pat[i] == '^') i += 1;
    // A ']' immediately after '[' or '[^' is a literal member, not the close.
    if (i < pat.len and pat[i] == ']') i += 1;
    while (i < pat.len and pat[i] != ']') i += 1;
    if (i >= pat.len) return null;
    return i;
}

/// `body` is the class content between `[`/`[^` and `]`, e.g. "a-z0-9".
fn classMatches(body_in: []const u8, c: u8) bool {
    var body = body_in;
    var negate = false;
    if (body.len > 0 and body[0] == '^') {
        negate = true;
        body = body[1..];
    }
    var hit = false;
    var i: usize = 0;
    while (i < body.len) {
        if (i + 2 < body.len and body[i + 1] == '-') {
            if (c >= body[i] and c <= body[i + 2]) hit = true;
            i += 3;
        } else {
            if (c == body[i]) hit = true;
            i += 1;
        }
    }
    return hit != negate;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test "literal match" {
    try std.testing.expect(matches("main.rs", "main.rs"));
    try std.testing.expect(!matches("main.rs", "main.ts"));
}

test "star does not cross slash" {
    try std.testing.expect(matches("*.ts", "index.ts"));
    try std.testing.expect(!matches("*.ts", "src/index.ts"));
}

test "double star crosses slashes" {
    try std.testing.expect(matches("**/*.ts", "src/deep/index.ts"));
    try std.testing.expect(matches("**/*.ts", "index.ts"));
    try std.testing.expect(matches("src/**", "src/a/b/c.ts"));
}

test "question mark matches one char" {
    try std.testing.expect(matches("a?c", "abc"));
    try std.testing.expect(!matches("a?c", "ac"));
    try std.testing.expect(!matches("a?c", "abbc"));
}

test "character class" {
    try std.testing.expect(matches("file[0-9].ts", "file3.ts"));
    try std.testing.expect(!matches("file[0-9].ts", "filex.ts"));
}

test "negated character class" {
    try std.testing.expect(matches("file[^0-9].ts", "filex.ts"));
    try std.testing.expect(!matches("file[^0-9].ts", "file3.ts"));
}

test "star does not match a leading slash into another segment" {
    try std.testing.expect(!matches("*.ts", "a/b.ts"));
}

test "unterminated class falls back to literal bracket" {
    try std.testing.expect(matches("[abc", "[abc"));
}
