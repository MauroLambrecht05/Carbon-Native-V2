// HTTP fetch + WebSocket host imports. The JS-facing shim that wraps
// these into a Web-compatible `fetch()` / `WebSocket` is in
// `carbon/host/native/net_shim.js` (string-included into the
// binary and eval'd at startup).
//
// Architecture:
//   - One tokio runtime lives for the app's lifetime, behind a OnceLock.
//   - Each fetch / ws connection gets a u32 handle id.
//   - The tokio task drives the HTTP/WS protocol asynchronously and
//     posts UserEvent::Fetch*/Ws* back via the EventLoopProxy.
//   - The main-thread event loop receives those events and eval's the
//     JS dispatcher (`__cm_fetch_dispatch_*` / `__cm_ws_dispatch_*`)
//     which then resolves the matching Promise / fires the right
//     event handler.
//   - Cancellation: each fetch task has a tokio AbortHandle; abort()
//     drops the future. WebSockets have a per-id mpsc::Sender that
//     receives close commands.

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use rquickjs::{Context as JsContext, Function};
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tao::event_loop::EventLoopProxy;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message as WsMsg;

use carbon_runtime_contract::UserEvent;

// ─── Globals ──────────────────────────────────────────────────────────────

pub(crate) fn rt() -> &'static Runtime {
    static R: OnceLock<Runtime> = OnceLock::new();
    R.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("carbon-mini-net")
            .build()
            .expect("tokio runtime build")
    })
}

pub(crate) fn http_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("carbon-mini/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client build")
    })
}

fn proxy_slot() -> &'static Mutex<Option<EventLoopProxy<UserEvent>>> {
    static P: OnceLock<Mutex<Option<EventLoopProxy<UserEvent>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

pub(crate) fn post(ev: UserEvent) {
    if let Some(p) = proxy_slot().lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = p.send_event(ev);
    }
}

fn next_id() -> u32 {
    static N: OnceLock<Mutex<u32>> = OnceLock::new();
    let m = N.get_or_init(|| Mutex::new(1));
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    let id = *g;
    *g = g.wrapping_add(1);
    id
}

fn fetch_registry() -> &'static Mutex<HashMap<u32, AbortHandle>> {
    static R: OnceLock<Mutex<HashMap<u32, AbortHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

struct WsHandle {
    tx: mpsc::UnboundedSender<WsCommand>,
    #[allow(dead_code)]
    abort: AbortHandle,
}

enum WsCommand {
    SendText(String),
    SendBinary(Vec<u8>),
    Close { code: u16, reason: String },
}

fn ws_registry() -> &'static Mutex<HashMap<u32, WsHandle>> {
    static R: OnceLock<Mutex<HashMap<u32, WsHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

// ─── Init ─────────────────────────────────────────────────────────────────

pub fn set_proxy(proxy: EventLoopProxy<UserEvent>) {
    *proxy_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(proxy);
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
struct FetchInit {
    #[serde(default)]
    method: Option<String>,
    /// Headers as a flat [[name, value], ...] array — keeps duplicate
    /// names ordered (Set-Cookie etc.). Headers/Map from JS is converted
    /// to this shape by the shim before stringifying.
    #[serde(default)]
    headers: Vec<(String, String)>,
    /// Request body as a UTF-8 string. Binary bodies (Uint8Array,
    /// FormData) are converted to base64 by the shim and prefixed with
    /// `__b64:` so we know to decode.
    #[serde(default)]
    body: Option<String>,
}

fn start_fetch(id: u32, url: String, init_json: String) {
    let init: FetchInit = serde_json::from_str(&init_json).unwrap_or_default();
    let method = init.method.as_deref().unwrap_or("GET").to_string();
    let task = rt().spawn(async move {
        // Build the request
        let method_parsed = match reqwest::Method::from_bytes(method.as_bytes()) {
            Ok(m) => m,
            Err(e) => {
                post(UserEvent::FetchError { id, message: format!("bad method: {e}") });
                return;
            }
        };
        let mut req = http_client().request(method_parsed, &url);
        for (k, v) in &init.headers {
            req = req.header(k, v);
        }
        if let Some(b) = init.body {
            if let Some(b64) = b.strip_prefix("__b64:") {
                use base64::Engine;
                match base64::engine::general_purpose::STANDARD.decode(b64) {
                    Ok(bytes) => req = req.body(bytes),
                    Err(e) => {
                        post(UserEvent::FetchError { id, message: format!("body base64: {e}") });
                        return;
                    }
                }
            } else {
                req = req.body(b);
            }
        }

        // Send + stream the response
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                post(UserEvent::FetchError { id, message: e.to_string() });
                fetch_registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                return;
            }
        };
        let status = resp.status().as_u16();
        let mut headers_pairs: Vec<(String, String)> = Vec::new();
        for (k, v) in resp.headers().iter() {
            if let Ok(vs) = v.to_str() {
                headers_pairs.push((k.as_str().to_string(), vs.to_string()));
            }
        }
        let headers_json = serde_json::to_string(&headers_pairs).unwrap_or("[]".to_string());
        post(UserEvent::FetchHeaders { id, status, headers_json });

        // Stream body chunks
        let mut stream = resp.bytes_stream();
        while let Some(item) = stream.next().await {
            match item {
                Ok(chunk) => {
                    post(UserEvent::FetchChunk { id, data: chunk.to_vec() });
                }
                Err(e) => {
                    post(UserEvent::FetchError { id, message: e.to_string() });
                    fetch_registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                    return;
                }
            }
        }
        post(UserEvent::FetchEnd { id });
        fetch_registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    });
    fetch_registry().lock().unwrap_or_else(|e| e.into_inner()).insert(id, task.abort_handle());
}

fn abort_fetch(id: u32) {
    if let Some(h) = fetch_registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        h.abort();
    }
}

// ─── WebSocket ────────────────────────────────────────────────────────────

fn start_ws(id: u32, url: String) {
    let (tx, mut rx) = mpsc::unbounded_channel::<WsCommand>();
    let task = rt().spawn(async move {
        let stream = match tokio_tungstenite::connect_async(&url).await {
            Ok((s, _resp)) => s,
            Err(e) => {
                post(UserEvent::WsError { id, message: e.to_string() });
                ws_registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                return;
            }
        };
        post(UserEvent::WsOpen { id });

        let (mut sink, mut source) = stream.split();

        // Two cooperating loops via tokio::select! — one reads incoming
        // frames, the other receives outbound commands from JS.
        let close_code = Mutex::new(1000u16);
        let close_reason = Mutex::new(String::new());
        loop {
            tokio::select! {
                msg = source.next() => {
                    match msg {
                        Some(Ok(WsMsg::Text(s))) => {
                            post(UserEvent::WsMessage { id, data: s.into_bytes(), is_text: true });
                        }
                        Some(Ok(WsMsg::Binary(b))) => {
                            post(UserEvent::WsMessage { id, data: b.to_vec(), is_text: false });
                        }
                        Some(Ok(WsMsg::Close(frame))) => {
                            let (code, reason) = match frame {
                                Some(f) => (u16::from(f.code), f.reason.to_string()),
                                None => (1005, String::new()),
                            };
                            post(UserEvent::WsClose { id, code, reason });
                            break;
                        }
                        Some(Ok(WsMsg::Ping(p))) => {
                            let _ = sink.send(WsMsg::Pong(p)).await;
                        }
                        Some(Ok(_)) => { /* Pong / frame — ignore */ }
                        Some(Err(e)) => {
                            post(UserEvent::WsError { id, message: e.to_string() });
                            break;
                        }
                        None => {
                            let code = *close_code.lock().unwrap_or_else(|e| e.into_inner());
                            let reason = close_reason.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            post(UserEvent::WsClose { id, code, reason });
                            break;
                        }
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(WsCommand::SendText(s)) => {
                            if sink.send(WsMsg::Text(s.into())).await.is_err() { break; }
                        }
                        Some(WsCommand::SendBinary(b)) => {
                            if sink.send(WsMsg::Binary(b)).await.is_err() { break; }
                        }
                        Some(WsCommand::Close { code, reason }) => {
                            *close_code.lock().unwrap_or_else(|e| e.into_inner()) = code;
                            *close_reason.lock().unwrap_or_else(|e| e.into_inner()) = reason.clone();
                            let frame = tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                code: code.into(),
                                reason: reason.into(),
                            };
                            let _ = sink.send(WsMsg::Close(Some(frame))).await;
                            // Loop continues, source will see the Close
                            // and we'll exit cleanly above.
                        }
                        None => break, // sender dropped — client gone
                    }
                }
            }
        }
        ws_registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    });
    ws_registry().lock().unwrap_or_else(|e| e.into_inner()).insert(id, WsHandle { tx, abort: task.abort_handle() });
}

fn ws_send_text(id: u32, text: String) -> bool {
    if let Some(h) = ws_registry().lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
        h.tx.send(WsCommand::SendText(text)).is_ok()
    } else { false }
}

fn ws_send_binary_b64(id: u32, b64: String) -> bool {
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&b64) {
        Ok(b) => b,
        Err(_) => return false,
    };
    if let Some(h) = ws_registry().lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
        h.tx.send(WsCommand::SendBinary(bytes)).is_ok()
    } else { false }
}

fn ws_close(id: u32, code: u16, reason: String) {
    if let Some(h) = ws_registry().lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
        let _ = h.tx.send(WsCommand::Close { code, reason });
    }
}

// ─── AI HTTP proxy + lm_ping (invoke-channel commands) ─────────────────────
//
// Ported from the app's original Tauri backend (modules/net.rs). Lets JS
// talk to AI-provider / local-model-server HTTP endpoints without going
// through a browser fetch() (there's no webview here, so no CORS problem
// either way, but the SSRF hardening below is worth keeping regardless —
// the caller can be an AI-agent tool result or a compromised dependency,
// and this process has full OS network access, not a sandboxed renderer).
//
// `lm_ping` and `ai_http_stream` both run with `allow_private = true`
// (unlike the Tauri original's `unwrap_or(false)` default): their entire
// purpose is reaching local model servers (LM Studio, Ollama, vLLM) on
// loopback/private addresses, and the ported frontend never passes an
// opt-in flag for it. Cloud-metadata endpoints (169.254.169.254 etc.) stay
// blocked unconditionally either way — see `ip_kind`.

const HEADER_BLOCKLIST: &[&str] = &[
    "host", "content-length", "connection", "proxy-authorization",
    "proxy-connection", "te", "transfer-encoding", "upgrade", "trailer", "expect",
];

fn is_blocked_host_name(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    matches!(host.as_str(), "metadata.google.internal" | "metadata" | "metadata.azure.com")
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum IpKind {
    Public,
    Private,
    Loopback,
    BlockedMetadata,
}

fn ip_kind(ip: IpAddr) -> IpKind {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            if v.is_link_local() {
                return IpKind::BlockedMetadata; // 169.254.169.254 cloud metadata
            }
            if v.is_loopback() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() {
                return IpKind::Loopback;
            }
            if o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
            {
                return IpKind::Private;
            }
            IpKind::Public
        }
        IpAddr::V6(v) => {
            if v.is_loopback() || v.is_unspecified() || v.is_multicast() {
                return IpKind::Loopback;
            }
            let segs = v.segments();
            if segs[0] == 0xfd00 && segs[1] == 0xec2 {
                return IpKind::BlockedMetadata; // AWS IPv6 metadata
            }
            if segs[0] & 0xffc0 == 0xfe80 {
                return IpKind::BlockedMetadata; // link-local
            }
            if segs[0] & 0xfe00 == 0xfc00 {
                return IpKind::Private; // unique-local
            }
            IpKind::Public
        }
    }
}

async fn classify_host(host: &str) -> Result<IpKind, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip_kind(ip));
    }
    let host = host.to_string();
    let lookup = tokio::task::spawn_blocking(move || {
        (host.as_str(), 0u16).to_socket_addrs().map(|it| it.map(|a| a.ip()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("dns: {e}"))?;
    if lookup.is_empty() {
        return Err("dns: no addresses".into());
    }
    let mut worst = IpKind::Public;
    for ip in lookup {
        let k = ip_kind(ip);
        worst = match (worst, k) {
            (_, IpKind::BlockedMetadata) => IpKind::BlockedMetadata,
            (IpKind::BlockedMetadata, _) => IpKind::BlockedMetadata,
            (IpKind::Public, x) => x,
            (x, IpKind::Public) => x,
            (a, _) => a,
        };
    }
    Ok(worst)
}

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("userinfo in url is not allowed".into());
    }
    let host = parsed.host_str().ok_or_else(|| "missing host".to_string())?;
    if is_blocked_host_name(host) {
        return Err(format!("host not allowed: {host}"));
    }
    Ok(parsed)
}

async fn enforce_host_policy(parsed: &reqwest::Url, allow_private: bool) -> Result<(), String> {
    let host = parsed.host_str().ok_or_else(|| "missing host".to_string())?;
    match classify_host(host).await? {
        IpKind::BlockedMetadata => Err(format!("host not allowed: {host}")),
        IpKind::Loopback | IpKind::Private if !allow_private => {
            Err(format!("host {host} resolves to a private/loopback address; not allowed"))
        }
        _ => Ok(()),
    }
}

fn sanitize_headers(headers: &[(String, String)]) -> Result<reqwest::header::HeaderMap, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let lower = k.to_ascii_lowercase();
        if HEADER_BLOCKLIST.contains(&lower.as_str()) {
            return Err(format!("header not allowed: {k}"));
        }
        if v.as_bytes().iter().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return Err(format!("header value contains control bytes: {k}"));
        }
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
        let value = HeaderValue::from_str(v).map_err(|e| e.to_string())?;
        map.insert(name, value);
    }
    Ok(map)
}

/// Redirect-following client that re-validates every hop against the same
/// host policy as the initial request (a redirect to a metadata/private
/// address is exactly as dangerous as a direct request to one).
fn build_safe_client(allow_private: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 10 {
                return attempt.error("too many redirects");
            }
            let next = attempt.url();
            if !matches!(next.scheme(), "http" | "https") {
                return attempt.stop();
            }
            if !next.username().is_empty() || next.password().is_some() {
                return attempt.stop();
            }
            let Some(host) = next.host_str() else { return attempt.stop() };
            if is_blocked_host_name(host) {
                return attempt.stop();
            }
            if let Ok(ip) = host.parse::<IpAddr>() {
                let k = ip_kind(ip);
                if k == IpKind::BlockedMetadata {
                    return attempt.stop();
                }
                if !allow_private && matches!(k, IpKind::Loopback | IpKind::Private) {
                    return attempt.stop();
                }
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn header_map_to_pairs(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(headers.len());
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    out
}

fn headers_from_args(args: &Value) -> Vec<(String, String)> {
    args.get("headers")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn body_from_args(args: &Value) -> Option<Vec<u8>> {
    args.get("body").and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|n| n.as_u64().map(|b| b as u8)).collect()
    })
}

/// `lm_ping({ baseUrl })` → HTTP status code of `GET {baseUrl}/models`, used
/// by the settings UI to test a local-model-server connection. Blocking
/// (like `__cm_proc_wait`) — the 5s client timeout below bounds the worst
/// case for what's a "click Test Connection" interaction.
pub(crate) fn lm_ping(args: &Value) -> Result<Value, String> {
    let base_url = args.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("empty base url".into());
    }
    let probe = format!("{trimmed}/models");
    let parsed = validate_url(&probe)?;

    rt().block_on(async {
        enforce_host_policy(&parsed, true).await?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        client.get(parsed).send().await
            .map(|r| Value::Number(r.status().as_u16().into()))
            .map_err(|e| e.to_string())
    })
}

/// `ai_http_stream({ url, method, headers?, body?, onEvent: { id } })` —
/// starts a streaming HTTP request on the background tokio runtime and
/// delivers `{kind:"headers"|"chunk"|"end"|"error", ...}` events to the
/// JS-side Channel identified by `onEvent.id` (see
/// stdlib/api/src/invoke.ts's `Channel`/`__cm_channel_dispatch`).
/// The invoke() call itself just reports whether the request *started*;
/// resolves immediately, matching `proxyFetch.ts`'s expectations.
pub(crate) fn ai_http_stream_invoke(args: &Value) -> Result<Value, String> {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if url.is_empty() {
        return Err("ai_http_stream: missing url".into());
    }
    let method = args.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string();
    let headers = headers_from_args(args);
    let body = body_from_args(args);
    let channel_id = args
        .get("onEvent")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "ai_http_stream: missing onEvent.id".to_string())? as u32;

    let parsed = match validate_url(&url) {
        Ok(p) => p,
        Err(e) => {
            emit_channel(channel_id, &serde_json::json!({"kind":"error","message":e}));
            return Err(e);
        }
    };
    let headers_map = match sanitize_headers(&headers) {
        Ok(h) => h,
        Err(e) => {
            emit_channel(channel_id, &serde_json::json!({"kind":"error","message":e}));
            return Err(e);
        }
    };

    rt().spawn(async move {
        if let Err(e) = enforce_host_policy(&parsed, true).await {
            emit_channel(channel_id, &serde_json::json!({"kind":"error","message":e}));
            return;
        }
        let client = match build_safe_client(true) {
            Ok(c) => c,
            Err(e) => {
                emit_channel(channel_id, &serde_json::json!({"kind":"error","message":e}));
                return;
            }
        };
        let method_parsed = match reqwest::Method::from_bytes(method.as_bytes()) {
            Ok(m) => m,
            Err(e) => {
                emit_channel(channel_id, &serde_json::json!({"kind":"error","message":format!("bad method: {e}")}));
                return;
            }
        };
        let mut req = client.request(method_parsed, parsed).headers(headers_map);
        if let Some(b) = body {
            req = req.body(b);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                emit_channel(channel_id, &serde_json::json!({"kind":"error","message":e.to_string()}));
                return;
            }
        };
        let status = resp.status().as_u16();
        let headers_out = header_map_to_pairs(resp.headers());
        emit_channel(channel_id, &serde_json::json!({"kind":"headers","status":status,"headers":headers_out}));

        let mut stream = resp.bytes_stream();
        while let Some(item) = stream.next().await {
            match item {
                Ok(chunk) => {
                    emit_channel(channel_id, &serde_json::json!({"kind":"chunk","bytes":chunk.to_vec()}));
                }
                Err(e) => {
                    emit_channel(channel_id, &serde_json::json!({"kind":"error","message":e.to_string()}));
                    return;
                }
            }
        }
        emit_channel(channel_id, &serde_json::json!({"kind":"end"}));
    });

    Ok(Value::Null)
}

fn emit_channel(channel_id: u32, event: &Value) {
    let json = event.to_string();
    post(UserEvent::ChannelMessage { channel_id, json });
}

// ─── Register ─────────────────────────────────────────────────────────────

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set("__cm_fetch_start", Function::new(ctx.clone(), |url: String, init_json: String| -> u32 {
            let id = next_id();
            start_fetch(id, url, init_json);
            id
        })?)?;

        g.set("__cm_fetch_abort", Function::new(ctx.clone(), |id: u32| -> () {
            abort_fetch(id);
        })?)?;

        g.set("__cm_ws_connect", Function::new(ctx.clone(), |url: String| -> u32 {
            let id = next_id();
            start_ws(id, url);
            id
        })?)?;

        g.set("__cm_ws_send_text", Function::new(ctx.clone(), |id: u32, text: String| -> bool {
            ws_send_text(id, text)
        })?)?;

        g.set("__cm_ws_send_binary_b64", Function::new(ctx.clone(), |id: u32, b64: String| -> bool {
            ws_send_binary_b64(id, b64)
        })?)?;

        g.set("__cm_ws_close", Function::new(ctx.clone(), |id: u32, code: u16, reason: String| -> () {
            ws_close(id, code, reason);
        })?)?;

        Ok(())
    })?;
    Ok(())
}
