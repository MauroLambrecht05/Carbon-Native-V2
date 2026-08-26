// The event vocabulary between the host layer and the event loop.
//
// ── WHY THIS IS A CONTRACT ──────────────────────────────────────────────────
// Both backends carried their own copy of these two enums. V1's
// carbon/runtime/mod.rs explains why they were not shared:
//
//     `UserEvent`, `tlog`, and `json_escape` are NOT here — mini's and blitz's
//     implementations of those differ (different UserEvent variants, different
//     tlog verbosity), so each binary keeps its own.
//
// That is true of tlog. It is NOT true of UserEvent: diffing the two
// definitions with comments stripped shows them byte-identical, all eighteen
// variants and every payload type. The stated reason for the duplication does
// not hold, and the duplication is the kind a contract exists to remove —
// exactly what contracts/update was created for when signing and updating held
// the same struct twice.
//
// The events themselves are a boundary, not an implementation detail: they are
// how a background thread — the tokio runtime in net.rs, a PTY reader, a
// plugin's worker — reaches the event loop. Every producer and the single
// consumer have to agree on the payloads, and they are in different crates.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// `tlog` is not. mini emits a full phase trace with per-phase deltas, gated
// OUT by CARBON_NO_TIMING; blitz emits one line per phase, gated IN by
// CARBON_MINI_TIMING. Those are genuinely different implementations of one
// idea, which makes tlog a port — the host layer takes it as a parameter and
// each composition root supplies its own. See carbon-os's `register_all`.

#[derive(Debug, Clone, Copy)]
pub enum WindowOp {
    Show,
    Hide,
    Minimize,
    Maximize,
    Unmaximize,
    Restore,
    ToggleMaximize,
    Close,
    Focus,
}

#[derive(Debug, Clone)]
pub enum UserEvent {
    RequestPaint,
    /// Bundle file changed on disk — re-eval it in the same JS context and
    /// rebuild the scene. Only fired when --dev is passed AND the bundle
    /// file watcher has detected an mtime change.
    ReloadBundle,
    /// A native plugin pushed an event from a worker thread via
    /// `app->push_event(...)`. The main loop forwards it to the JS-side
    /// `__carbon_on_event(name, payloadJson)` dispatcher (installed at
    /// startup, see `install_carbon_event_dispatcher`).
    PluginEvent {
        name: String,
        payload: String,
    },
    // ── Networking events (from native/net.rs's tokio runtime) ──
    /// HTTP response headers received. Resolves the fetch() Promise.
    FetchHeaders {
        id: u32,
        status: u16,
        headers_json: String,
    },
    /// HTTP response body chunk. Pushed to the Response's stream reader.
    FetchChunk {
        id: u32,
        data: Vec<u8>,
    },
    /// HTTP response stream ended cleanly.
    FetchEnd {
        id: u32,
    },
    /// HTTP request failed (network error, TLS, parse, abort).
    FetchError {
        id: u32,
        message: String,
    },
    /// A native command pushed a chunk to a JS-side Channel (see
    /// stdlib/api/src/invoke.ts's `Channel`/`__cm_channel_dispatch`).
    /// `json` is a JSON-encoded event object, delivered to the Channel as-is
    /// — used by `ai_http_stream` (native/net.rs) to stream headers/chunk/
    /// end/error events without needing a dedicated UserEvent per command.
    ChannelMessage {
        channel_id: u32,
        json: String,
    },
    /// WebSocket connection established.
    WsOpen {
        id: u32,
    },
    /// WebSocket text or binary message received.
    WsMessage {
        id: u32,
        data: Vec<u8>,
        is_text: bool,
    },
    /// WebSocket closed (clean or otherwise).
    WsClose {
        id: u32,
        code: u16,
        reason: String,
    },
    /// WebSocket connection error.
    WsError {
        id: u32,
        message: String,
    },
    // ── PTY events (from native/pty.rs reader threads) ──
    /// New PTY output bytes have been buffered. JS drains them via
    /// `__cm_pty_read(id)` (base64). The main loop's handler eval's
    /// a JS dispatcher so push-mode apps don't have to poll.
    PtyOutput {
        id: u32,
    },
    /// PTY child exited (EOF on the master read). JS-side terminal
    /// emulators flip their session state to "closed" here.
    PtyExit {
        id: u32,
    },
    // ── Window control (invoke channel forwards to these) ──
    /// Show, hide, minimize, maximize, restore, toggle-maximize, close.
    WindowOp(WindowOp),
    /// Set the window title.
    WindowSetTitle(String),
    /// Fullscreen toggle. true = enter, false = exit.
    WindowSetFullscreen(bool),
    /// Begin a drag-move from the current cursor position. tao only
    /// allows drag_window() from the event loop thread, so JS-side
    /// `data-carbon-drag-region` mousedown handlers post this instead of
    /// calling directly.
    WindowStartDrag,
    /// Test-only hook: eval an arbitrary script on the JS thread, then run
    /// the exact same post-dispatch step a real click/pointer event does
    /// (drain_and_flush_react) — see CARBON_TEST_EVAL_AFTER_MS in mini.rs.
    /// Lets a test drive the JS side through the real event-loop dispatch
    /// path instead of racing it from a JS-side microtask, which has no way
    /// to land at the same point in the loop a native event does.
    TestEval(String),
}
