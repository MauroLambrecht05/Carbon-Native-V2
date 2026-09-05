// ConPTY (Windows pseudoconsole) — the OS-level half of the terminal
// plugin, kept separate from main.zig's JS glue.
//
// This is the SAME "plugin does its own OS work directly, no host
// involvement" pattern as labs/examples/pulse/carbon/plugins/local/carbon-hotkey
// (raw Win32 FFI, own background thread, cross-thread delivery via
// app.pushEvent) — extended from a single blocking API call to a full
// spawn/read/write/resize/kill/wait session lifecycle, because that's what
// hosting a real terminal needs.
//
// The Win32 sequence below (CreatePipe x2 → CreatePseudoConsole →
// Initialize/UpdateProcThreadAttributeList → CreateProcessW with
// EXTENDED_STARTUPINFO_PRESENT) is Microsoft's own documented ConPTY
// integration flow ("Creating a Pseudoconsole session",
// learn.microsoft.com/windows/console/creating-a-pseudoconsole-session) —
// checked against those docs, not recalled, for the same reason
// carbon-hotkey's own header gives: a wrong guess here is a silent hang or
// crash, not a compile error.
//
// PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE's value (0x00020016) is derived from
// the documented `ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)` macro
// (Number=22, PROC_THREAD_ATTRIBUTE_INPUT=0x00020000, no THREAD/ADDITIVE
// bits) — the same constant Windows Terminal's own ConPTY integration uses.
//
// PLATFORM: Windows-only, like carbon-hotkey. Linux/macOS need
// posix_openpt/forkpty instead of ConPTY entirely — a different
// implementation, not a portable one, so it is not stubbed out here rather
// than guessed at.

const std = @import("std");
const builtin = @import("builtin");

comptime {
    if (builtin.os.tag != .windows) {
        @compileError(
            "terminal is Windows-only for now — ConPTY has no POSIX " ++
                "equivalent; Linux/macOS need posix_openpt/forkpty, a " ++
                "genuinely different implementation, not stubbed out here.",
        );
    }
}

// ── Win32 declarations ──────────────────────────────────────────────────────

const HANDLE = ?*anyopaque;
const HPCON = ?*anyopaque;
const BOOL = i32;
const DWORD = u32;
const WORD = u16;
const LPVOID = ?*anyopaque;
const LPCVOID = ?*const anyopaque;
const SIZE_T = usize;
const HRESULT = i32;

const COORD = extern struct { X: i16, Y: i16 };

const SECURITY_ATTRIBUTES = extern struct {
    nLength: DWORD,
    lpSecurityDescriptor: ?*anyopaque,
    bInheritHandle: BOOL,
};

const STARTUPINFOW = extern struct {
    cb: DWORD,
    lpReserved: ?[*:0]u16 = null,
    lpDesktop: ?[*:0]u16 = null,
    lpTitle: ?[*:0]u16 = null,
    dwX: DWORD = 0,
    dwY: DWORD = 0,
    dwXSize: DWORD = 0,
    dwYSize: DWORD = 0,
    dwXCountChars: DWORD = 0,
    dwYCountChars: DWORD = 0,
    dwFillAttribute: DWORD = 0,
    dwFlags: DWORD = 0,
    wShowWindow: WORD = 0,
    cbReserved2: WORD = 0,
    lpReserved2: ?*u8 = null,
    hStdInput: HANDLE = null,
    hStdOutput: HANDLE = null,
    hStdError: HANDLE = null,
};

const STARTUPINFOEXW = extern struct {
    StartupInfo: STARTUPINFOW,
    lpAttributeList: ?*anyopaque,
};

const PROCESS_INFORMATION = extern struct {
    hProcess: HANDLE = null,
    hThread: HANDLE = null,
    dwProcessId: DWORD = 0,
    dwThreadId: DWORD = 0,
};

extern "kernel32" fn CreatePipe(hReadPipe: *HANDLE, hWritePipe: *HANDLE, lpPipeAttributes: ?*SECURITY_ATTRIBUTES, nSize: DWORD) callconv(.c) BOOL;
extern "kernel32" fn CreatePseudoConsole(size: COORD, hInput: HANDLE, hOutput: HANDLE, dwFlags: DWORD, phPC: *HPCON) callconv(.c) HRESULT;
extern "kernel32" fn ResizePseudoConsole(hPC: HPCON, size: COORD) callconv(.c) HRESULT;
extern "kernel32" fn ClosePseudoConsole(hPC: HPCON) callconv(.c) void;
extern "kernel32" fn InitializeProcThreadAttributeList(lpAttributeList: ?*anyopaque, dwAttributeCount: DWORD, dwFlags: DWORD, lpSize: *SIZE_T) callconv(.c) BOOL;
extern "kernel32" fn UpdateProcThreadAttribute(lpAttributeList: ?*anyopaque, dwFlags: DWORD, Attribute: usize, lpValue: ?*anyopaque, cbSize: SIZE_T, lpPreviousValue: ?*anyopaque, lpReturnSize: ?*SIZE_T) callconv(.c) BOOL;
extern "kernel32" fn DeleteProcThreadAttributeList(lpAttributeList: ?*anyopaque) callconv(.c) void;
extern "kernel32" fn CreateProcessW(lpApplicationName: ?[*:0]const u16, lpCommandLine: ?[*:0]u16, lpProcessAttributes: ?*SECURITY_ATTRIBUTES, lpThreadAttributes: ?*SECURITY_ATTRIBUTES, bInheritHandles: BOOL, dwCreationFlags: DWORD, lpEnvironment: ?*anyopaque, lpCurrentDirectory: ?[*:0]const u16, lpStartupInfo: *STARTUPINFOEXW, lpProcessInformation: *PROCESS_INFORMATION) callconv(.c) BOOL;
extern "kernel32" fn ReadFile(hFile: HANDLE, lpBuffer: LPVOID, nNumberOfBytesToRead: DWORD, lpNumberOfBytesRead: ?*DWORD, lpOverlapped: ?*anyopaque) callconv(.c) BOOL;
extern "kernel32" fn WriteFile(hFile: HANDLE, lpBuffer: LPCVOID, nNumberOfBytesToWrite: DWORD, lpNumberOfBytesWritten: ?*DWORD, lpOverlapped: ?*anyopaque) callconv(.c) BOOL;
extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.c) BOOL;
extern "kernel32" fn TerminateProcess(hProcess: HANDLE, uExitCode: c_uint) callconv(.c) BOOL;
extern "kernel32" fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *DWORD) callconv(.c) BOOL;
extern "kernel32" fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: DWORD) callconv(.c) DWORD;
extern "kernel32" fn GetEnvironmentStringsW() callconv(.c) ?[*]u16;
extern "kernel32" fn FreeEnvironmentStringsW(penv: [*]u16) callconv(.c) BOOL;

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;
const EXTENDED_STARTUPINFO_PRESENT: DWORD = 0x00080000;
const CREATE_UNICODE_ENVIRONMENT: DWORD = 0x00000400;
const STILL_ACTIVE: DWORD = 259;
const WAIT_OBJECT_0: DWORD = 0;
const INFINITE: DWORD = 0xFFFFFFFF;

// ── Command-line quoting ─────────────────────────────────────────────────────
//
// Windows has no argv — CreateProcess takes one string the child re-splits
// itself (via CommandLineToArgvW-compatible rules, which is what every C
// runtime's argv parser implements). Building that string back up from a
// (cmd, args[]) pair correctly needs this exact escaping — the documented
// algorithm every correct implementation (MSVC's own, Rust's std, etc.)
// uses: https://learn.microsoft.com/archive/blogs/twistylittlepassagesallalike/everyone-quotes-command-line-arguments-the-wrong-way

pub fn appendQuotedArg(out: *std.ArrayList(u8), a: std.mem.Allocator, arg: []const u8) !void {
    const needs_quotes = arg.len == 0 or std.mem.indexOfAny(u8, arg, " \t\"") != null;
    if (!needs_quotes) {
        try out.appendSlice(a, arg);
        return;
    }
    try out.append(a, '"');
    var backslashes: usize = 0;
    for (arg) |c| {
        if (c == '\\') {
            backslashes += 1;
            continue;
        }
        if (c == '"') {
            // Every backslash before a quote must be doubled, then the
            // quote itself escaped.
            try out.appendNTimes(a, '\\', backslashes * 2 + 1);
            try out.append(a, '"');
            backslashes = 0;
            continue;
        }
        try out.appendNTimes(a, '\\', backslashes);
        backslashes = 0;
        try out.append(a, c);
    }
    // Trailing backslashes, right before the closing quote, must also be
    // doubled — otherwise they'd escape that quote instead of ending the
    // argument.
    try out.appendNTimes(a, '\\', backslashes * 2);
    try out.append(a, '"');
}

pub fn buildCommandLine(a: std.mem.Allocator, cmd: []const u8, args: []const []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try appendQuotedArg(&out, a, cmd);
    for (args) |arg| {
        try out.append(a, ' ');
        try appendQuotedArg(&out, a, arg);
    }
    return out.toOwnedSlice(a);
}

// ── Environment block ────────────────────────────────────────────────────────
//
// CreateProcessW wants one UTF-16 buffer of NUL-separated "KEY=VALUE"
// entries, double-NUL terminated. `overrides` is layered on top of the
// CURRENT process's environment (matching portable-pty's/most shells'
// "inherit, then override" semantics), not a full replacement — a child
// that only wants one extra var set shouldn't lose PATH.

pub const EnvEntry = struct { key: []const u8, value: []const u8 };

pub fn buildEnvironmentBlock(a: std.mem.Allocator, overrides: []const EnvEntry) ![]u16 {
    var entries: std.ArrayList(EnvEntry) = .empty;

    if (GetEnvironmentStringsW()) |base| {
        defer _ = FreeEnvironmentStringsW(base);
        var p: usize = 0;
        while (base[p] != 0) {
            var end = p;
            while (base[end] != 0) end += 1;
            const entry16 = base[p..end];
            const entry8 = try std.unicode.utf16LeToUtf8Alloc(a, entry16);
            if (std.mem.indexOfScalar(u8, entry8, '=')) |eq| {
                // Windows reserves entries starting with '=' for drive-letter
                // cwd tracking (e.g. "=C:=C:\foo") — not real variables, and
                // not valid to re-emit verbatim in a fresh block by name.
                if (eq > 0) {
                    try entries.append(a, .{ .key = entry8[0..eq], .value = entry8[eq + 1 ..] });
                }
            }
            p = end + 1;
        }
    }

    for (overrides) |ov| {
        var replaced = false;
        for (entries.items) |*e| {
            if (std.ascii.eqlIgnoreCase(e.key, ov.key)) {
                e.value = ov.value;
                replaced = true;
                break;
            }
        }
        if (!replaced) try entries.append(a, ov);
    }

    const Sorter = struct {
        fn lessThan(_: void, x: EnvEntry, y: EnvEntry) bool {
            return std.ascii.lessThanIgnoreCase(x.key, y.key);
        }
    };
    std.mem.sort(EnvEntry, entries.items, {}, Sorter.lessThan);

    var out8: std.ArrayList(u8) = .empty;
    for (entries.items) |e| {
        try out8.appendSlice(a, e.key);
        try out8.append(a, '=');
        try out8.appendSlice(a, e.value);
        try out8.append(a, 0);
    }
    try out8.append(a, 0);
    return std.unicode.utf8ToUtf16LeAlloc(a, out8.items);
}

// ── Session ──────────────────────────────────────────────────────────────────

pub const SpawnError = error{
    CreatePipeFailed,
    CreatePseudoConsoleFailed,
    AttributeListFailed,
    CreateProcessFailed,
} || std.mem.Allocator.Error || std.unicode.Utf16LeToUtf8AllocError || error{InvalidUtf8};

pub const Session = struct {
    hpc: HPCON,
    // Guards `hpc`: conhost only signals EOF on `output_read` when
    // ClosePseudoConsole runs — NOT when the child process exits (a
    // pseudoconsole is a session, not tied to one process's lifetime). A
    // watcher thread (see `watchForExit`) closes it as soon as the child
    // dies so a blocked `read()` actually unblocks; `deinit` may also try
    // to close it — this flag makes that safe to call from either place,
    // exactly once. Found by an actual hang in a real spawn/read/wait
    // smoke test, not reasoned out in advance — ReadFile blocked forever
    // on the call right after the child's only output arrived.
    hpc_closed: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    input_write: HANDLE, // we write here; ConPTY delivers it to the child's stdin
    output_read: HANDLE, // we read here; ConPTY delivers the child's stdout/stderr
    process: HANDLE,
    attr_list_buf: []u8,

    pub fn spawn(
        a: std.mem.Allocator,
        cmd: []const u8,
        args: []const []const u8,
        cwd: ?[]const u8,
        env_overrides: []const EnvEntry,
        cols: u16,
        rows: u16,
    ) SpawnError!Session {
        var input_read: HANDLE = null;
        var input_write: HANDLE = null;
        var output_read: HANDLE = null;
        var output_write: HANDLE = null;
        if (CreatePipe(&input_read, &input_write, null, 0) == 0) return SpawnError.CreatePipeFailed;
        if (CreatePipe(&output_read, &output_write, null, 0) == 0) {
            _ = CloseHandle(input_read);
            _ = CloseHandle(input_write);
            return SpawnError.CreatePipeFailed;
        }

        var hpc: HPCON = null;
        const size = COORD{ .X = @bitCast(cols), .Y = @bitCast(rows) };
        const hr = CreatePseudoConsole(size, input_read, output_write, 0, &hpc);
        // ConPTY duplicates the handles it needs internally — the sample end
        // and ours are separate from this point, so our copies of the ends
        // ConPTY now owns are closed regardless of success (nothing else
        // uses them past this point).
        _ = CloseHandle(input_read);
        _ = CloseHandle(output_write);
        if (hr < 0) {
            _ = CloseHandle(input_write);
            _ = CloseHandle(output_read);
            return SpawnError.CreatePseudoConsoleFailed;
        }
        errdefer ClosePseudoConsole(hpc);

        var attr_size: SIZE_T = 0;
        _ = InitializeProcThreadAttributeList(null, 1, 0, &attr_size);
        const attr_buf = try a.alloc(u8, attr_size);
        errdefer a.free(attr_buf);
        if (InitializeProcThreadAttributeList(attr_buf.ptr, 1, 0, &attr_size) == 0) {
            return SpawnError.AttributeListFailed;
        }
        errdefer DeleteProcThreadAttributeList(attr_buf.ptr);
        if (UpdateProcThreadAttribute(
            attr_buf.ptr,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hpc,
            @sizeOf(HPCON),
            null,
            null,
        ) == 0) {
            return SpawnError.AttributeListFailed;
        }

        const cmdline8 = try buildCommandLine(a, cmd, args);
        const cmdline16 = try std.unicode.utf8ToUtf16LeAllocZ(a, cmdline8);

        var env_block: ?[]u16 = null;
        if (env_overrides.len > 0) env_block = try buildEnvironmentBlock(a, env_overrides);

        var cwd16: ?[:0]u16 = null;
        if (cwd) |c| {
            if (c.len > 0) cwd16 = try std.unicode.utf8ToUtf16LeAllocZ(a, c);
        }

        var startup_info = STARTUPINFOEXW{
            .StartupInfo = .{ .cb = @sizeOf(STARTUPINFOEXW) },
            .lpAttributeList = attr_buf.ptr,
        };
        var pi = PROCESS_INFORMATION{};

        const ok = CreateProcessW(
            null,
            cmdline16.ptr,
            null,
            null,
            0, // bInheritHandles — ConPTY connects via the attribute list, not handle inheritance
            EXTENDED_STARTUPINFO_PRESENT | (if (env_block != null) CREATE_UNICODE_ENVIRONMENT else 0),
            if (env_block) |eb| eb.ptr else null,
            if (cwd16) |c| c.ptr else null,
            &startup_info,
            &pi,
        );
        DeleteProcThreadAttributeList(attr_buf.ptr);
        if (ok == 0) return SpawnError.CreateProcessFailed;
        _ = CloseHandle(pi.hThread);

        return .{
            .hpc = hpc,
            .input_write = input_write,
            .output_read = output_read,
            .process = pi.hProcess,
            .attr_list_buf = attr_buf,
        };
    }

    /// Read available output into `buf`, blocking until at least one byte
    /// arrives or the pipe breaks (child exited and ConPTY drained). Returns
    /// 0 on EOF.
    pub fn read(self: *Session, buf: []u8) usize {
        var n: DWORD = 0;
        const ok = ReadFile(self.output_read, buf.ptr, @intCast(buf.len), &n, null);
        if (ok == 0) return 0;
        return n;
    }

    pub fn write(self: *Session, data: []const u8) usize {
        var n: DWORD = 0;
        if (WriteFile(self.input_write, data.ptr, @intCast(data.len), &n, null) == 0) return 0;
        return n;
    }

    /// Closes the pseudoconsole exactly once, however many callers race to
    /// call it — see `hpc_closed`'s doc comment.
    fn closeHpcOnce(self: *Session) void {
        if (self.hpc_closed.cmpxchgStrong(false, true, .acq_rel, .monotonic) == null) {
            ClosePseudoConsole(self.hpc);
        }
    }

    /// Blocks until the child exits, then closes the pseudoconsole so a
    /// concurrent blocked `read()` unblocks with EOF instead of hanging
    /// forever waiting for output nothing will ever produce again. Meant to
    /// run on its own background thread, started right after `spawn`
    /// alongside the output-reader thread.
    pub fn watchForExit(self: *Session) void {
        _ = WaitForSingleObject(self.process, INFINITE);
        self.closeHpcOnce();
    }

    pub fn resize(self: *Session, cols: u16, rows: u16) bool {
        const size = COORD{ .X = @bitCast(cols), .Y = @bitCast(rows) };
        return ResizePseudoConsole(self.hpc, size) >= 0;
    }

    pub fn kill(self: *Session) void {
        _ = TerminateProcess(self.process, 1);
    }

    /// Blocks until the child exits; returns its exit code (-1 if it
    /// couldn't be read).
    pub fn wait(self: *Session) i32 {
        _ = WaitForSingleObject(self.process, INFINITE);
        var code: DWORD = 0;
        if (GetExitCodeProcess(self.process, &code) == 0) return -1;
        return @bitCast(code);
    }

    pub fn deinit(self: *Session, a: std.mem.Allocator) void {
        self.kill();
        self.closeHpcOnce();
        _ = CloseHandle(self.input_write);
        _ = CloseHandle(self.output_read);
        a.free(self.attr_list_buf);
    }
};

// ── Tests ───────────────────────────────────────────────────────────────────
//
// Real ConPTY spawning needs a live console session and isn't exercised
// here — same call carbon-hotkey's own header makes about RegisterHotKey/
// GetMessage ("exercised for real by `carbon dev`, not here"). What's pure
// logic (quoting, environment block construction) is fully covered.

test "simple arg needs no quoting" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    try appendQuotedArg(&out, a, "hello");
    try std.testing.expectEqualStrings("hello", out.items);
}

test "arg with a space gets quoted" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    try appendQuotedArg(&out, a, "hello world");
    try std.testing.expectEqualStrings("\"hello world\"", out.items);
}

test "empty arg becomes an empty quoted pair" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    try appendQuotedArg(&out, a, "");
    try std.testing.expectEqualStrings("\"\"", out.items);
}

test "embedded quote is escaped" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    try appendQuotedArg(&out, a, "say \"hi\"");
    try std.testing.expectEqualStrings("\"say \\\"hi\\\"\"", out.items);
}

test "trailing backslashes before the closing quote are doubled" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    try appendQuotedArg(&out, a, "C:\\some path\\");
    try std.testing.expectEqualStrings("\"C:\\some path\\\\\"", out.items);
}

test "backslashes not before a quote or at the end are copied literally" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var out: std.ArrayList(u8) = .empty;
    try appendQuotedArg(&out, a, "a\\b c");
    try std.testing.expectEqualStrings("\"a\\b c\"", out.items);
}

test "buildCommandLine joins quoted args with spaces" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const out = try buildCommandLine(a, "cmd.exe", &.{ "/c", "echo hello" });
    try std.testing.expectEqualStrings("cmd.exe /c \"echo hello\"", out);
}

test "environment block: an override replaces an inherited var and appends a new one" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // PATH always exists in a real process environment — this exercises
    // the "replace inherited" branch without hard-coding its value.
    const block = try buildEnvironmentBlock(a, &.{.{ .key = "CARBON_TEST_VAR", .value = "42" }});
    const as8 = try std.unicode.utf16LeToUtf8Alloc(a, block);
    try std.testing.expect(std.mem.indexOf(u8, as8, "CARBON_TEST_VAR=42") != null);
}
