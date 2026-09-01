// The generic "post a UserEvent back onto the main event loop" mechanism.
//
// Pulled out of net.rs (which otherwise owned it) because it has nothing to
// do with networking — invoke.rs's window-control commands
// (window_op/window_set_title/window_set_fullscreen) use it too, and net's
// own fetch/WebSocket code is the thing that should become optional behind
// the `network` Cargo feature, not this. No reqwest/tokio dependency here at
// all, so this stays compiled in unconditionally.

use std::sync::{Mutex, OnceLock};
use tao::event_loop::EventLoopProxy;

use carbon_runtime_contract::UserEvent;

fn proxy_slot() -> &'static Mutex<Option<EventLoopProxy<UserEvent>>> {
    static P: OnceLock<Mutex<Option<EventLoopProxy<UserEvent>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

pub fn post(ev: UserEvent) {
    if let Some(p) = proxy_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        let _ = p.send_event(ev);
    }
}

pub fn set_proxy(proxy: EventLoopProxy<UserEvent>) {
    *proxy_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(proxy);
}
